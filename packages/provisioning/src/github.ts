import { createSign } from "node:crypto";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const SAFE_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function encoded(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createGitHubAppJwt(input: {
  appId: string;
  privateKeyPem: string;
  now?: number;
}) {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const header = encoded({ alg: "RS256", typ: "JWT" });
  const payload = encoded({ iat: now - 60, exp: now + 9 * 60, iss: input.appId });
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).end().sign(input.privateKeyPem, "base64url");
  return `${unsigned}.${signature}`;
}

export function githubInstallationUrl(appSlug: string, state: string) {
  if (!/^[a-z0-9-]+$/.test(appSlug) || !state) throw new Error("invalid GitHub App installation request");
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

type InstallationToken = { token: string; expiresAt: string };
type RefreshedUserAccessToken = {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
};
type GitHubRepository = { id: number; fullName: string; htmlUrl: string; defaultBranch: string };
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class GitHubProvisioningError extends Error {
  constructor(
    readonly code: "invalid-input" | "unauthorized" | "forbidden" | "conflict" | "upstream",
    message: string,
  ) {
    super(message);
    this.name = "GitHubProvisioningError";
  }
}

export class GitHubAppProvisioner {
  private readonly fetcher: Fetcher;

  constructor(
    private readonly options: {
      appId: string;
      privateKeyPem: string;
      fetcher?: Fetcher;
    },
  ) {
    this.fetcher = options.fetcher ?? fetch;
  }

  private async request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": API_VERSION,
        ...init.headers,
      },
    });
    if (!response.ok) {
      const code = response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 409 || response.status === 422 ? "conflict" : "upstream";
      throw new GitHubProvisioningError(code, `GitHub request failed (${response.status})`);
    }
    return (await response.json()) as T;
  }

  async createInstallationToken(
    installationId: number,
    scope: {
      repositoryIds?: number[];
      permissions?: { administration?: "read" | "write"; contents?: "read" | "write"; metadata?: "read" };
    } = {},
  ): Promise<InstallationToken> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new GitHubProvisioningError("invalid-input", "invalid installation id");
    if (scope.repositoryIds?.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new GitHubProvisioningError("invalid-input", "invalid repository id");
    }
    const jwt = createGitHubAppJwt(this.options);
    const body = {
      ...(scope.repositoryIds?.length ? { repository_ids: scope.repositoryIds } : {}),
      permissions: scope.permissions ?? { administration: "write", contents: "write", metadata: "read" },
    };
    const result = await this.request<{ token?: string; expires_at?: string }>(
      `/app/installations/${installationId}/access_tokens`,
      jwt,
      { method: "POST", body: JSON.stringify(body) },
    );
    if (!result.token || !result.expires_at) throw new GitHubProvisioningError("upstream", "GitHub returned an invalid installation token");
    return { token: result.token, expiresAt: result.expires_at };
  }

  async refreshUserAccessToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    now?: number;
  }): Promise<RefreshedUserAccessToken> {
    if (!input.clientId || !input.clientSecret || !input.refreshToken.startsWith("ghr_")) {
      throw new GitHubProvisioningError("invalid-input", "invalid GitHub refresh request");
    }
    const body = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    });
    const response = await this.fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "BuddyBox/0.1",
      },
      body,
      redirect: "manual",
    });
    const result = await response.json() as Record<string, unknown>;
    if (
      !response.ok ||
      typeof result.access_token !== "string" || !result.access_token.startsWith("ghu_") ||
      typeof result.refresh_token !== "string" || !result.refresh_token.startsWith("ghr_") ||
      typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) ||
      typeof result.refresh_token_expires_in !== "number" || !Number.isFinite(result.refresh_token_expires_in)
    ) {
      throw new GitHubProvisioningError(response.status === 401 ? "unauthorized" : "upstream", "GitHub returned an invalid refreshed credential");
    }
    const now = input.now ?? Date.now();
    return {
      accessToken: result.access_token,
      accessTokenExpiresAt: now + result.expires_in * 1_000,
      refreshToken: result.refresh_token,
      refreshTokenExpiresAt: now + result.refresh_token_expires_in * 1_000,
    };
  }

  async createOwnedRepository(input: {
    installationId: number;
    owner: { kind: "user" | "organization"; login: string };
    userAccessToken?: string;
    name: string;
    description?: string;
    visibility: "public" | "private";
  }): Promise<GitHubRepository> {
    if (!SAFE_REPOSITORY.test(input.name)) throw new GitHubProvisioningError("invalid-input", "invalid repository name");
    if (!SAFE_LOGIN.test(input.owner.login)) throw new GitHubProvisioningError("invalid-input", "invalid GitHub owner");

    let token: string;
    let path: string;
    if (input.owner.kind === "user") {
      if (!input.userAccessToken?.startsWith("ghu_")) {
        throw new GitHubProvisioningError("unauthorized", "a connected GitHub User token is required for personal repositories");
      }
      token = input.userAccessToken;
      path = "/user/repos";
    } else {
      token = (await this.createInstallationToken(input.installationId)).token;
      path = `/orgs/${input.owner.login}/repos`;
    }

    const result = await this.request<{
      id?: number;
      full_name?: string;
      html_url?: string;
      default_branch?: string;
    }>(path, token, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        private: input.visibility === "private",
        auto_init: false,
        has_issues: true,
        has_projects: false,
        has_wiki: false,
      }),
    });
    if (!result.id || !result.full_name || !result.html_url) {
      throw new GitHubProvisioningError("upstream", "GitHub returned an invalid repository");
    }
    return {
      id: result.id,
      fullName: result.full_name,
      htmlUrl: result.html_url,
      defaultBranch: result.default_branch ?? "main",
    };
  }
}
