import { describe, expect, mock, spyOn, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";

mock.module("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected env: unknown;

    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const { createCredentialBroker, GitHubSigner, testables } = await import("./index");

describe("credential broker boundaries", () => {
  test("accepts only run-scoped authority", () => {
    expect(testables.isRunAuthority({ userId: "u", projectId: "p", action: "run" })).toBe(true);
    expect(testables.isRunAuthority({ userId: "u", projectId: "p", action: "preview" })).toBe(false);
  });

  test("preserves the legacy iChef run-capability header", () => {
    const request = new Request("https://broker.example/v1/egress/openai-codex/backend-api/codex/responses", {
      headers: { "x-ichef-run-capability": "legacy-run-capability" },
    });

    expect(testables.runCapability(request, "openai-codex")).toBe("legacy-run-capability");
  });

  test("extracts the owner account without exposing the token", () => {
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account_123" },
    })).toString("base64url");
    expect(testables.accountIdFromAccessToken(`header.${payload}.signature`)).toBe("account_123");
    expect(testables.accountIdFromAccessToken("not-a-token")).toBeNull();
  });

  test("copies only explicitly allowed headers", () => {
    const source = new Headers({ authorization: "secret", accept: "text/event-stream", cookie: "private" });
    expect(Object.fromEntries(testables.selectedHeaders(source, ["accept"]))).toEqual({ accept: "text/event-stream" });
  });

  test("signs an App JWT from GitHub's RSA private-key PEM format", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = await testables.createGitHubAppJwt({
      appId: "1234",
      privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      nowSeconds: 1_800_000_000,
    });
    const [header, payload, signature] = token.split(".") as [string, string, string];

    expect(verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    )).toBe(true);
  });

  test("rejects a lengthless Codex body that exceeds the streaming limit", async () => {
    let codexCalled = false;
    const accountPayload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account_123" },
    })).toString("base64url");
    const handler = createCredentialBroker({
      fetcher: async (input) => {
        const url = String(input);
        if (url === "https://convex.example/v1/credentials/codex") {
          return Response.json({ ok: true, result: {
            status: "ok",
            accessToken: `header.${accountPayload}.signature`,
            expiresAt: Date.now() + 60_000,
          } });
        }
        codexCalled = true;
        return new Response(null, { status: 200 });
      },
    });
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    const request = new Request(
      "https://broker.example/v1/egress/openai-codex/backend-api/codex/responses",
      {
        method: "POST",
        headers: { "x-buddybox-run-capability": "run-capability" },
        body: new Blob([oversized]).stream(),
      },
    );
    expect(request.headers.get("content-length")).toBeNull();

    const response = await handler.fetch(request, githubEnv());

    expect(response.status).toBe(413);
    expect(codexCalled).toBe(false);
  });
});

describe("GitHub egress", () => {
  test("preserves legacy fetch traffic with the ICHEF broker secret", async () => {
    const authorizations: Array<string | null> = [];
    const handler = createCredentialBroker({
      fetcher: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return Response.json({ ok: true, result: {
          status: "ok", installationId: 42, repositoryId: 77, repositoryFullName: "octocat/menu",
        } });
      },
    });
    const response = await handler.fetch(new Request(
      "https://broker.example/v1/egress/github/octocat/other.git/info/refs?service=git-upload-pack",
      { headers: { authorization: "Bearer run-capability" } },
    ), githubEnv({
      BUDDYBOX_CREDENTIAL_BROKER_SECRET: undefined,
      ICHEF_CREDENTIAL_BROKER_SECRET: "legacy-broker-secret-at-least-thirty-two-characters",
    }));

    expect(response.status).toBe(404);
    expect(authorizations).toEqual(["Bearer legacy-broker-secret-at-least-thirty-two-characters"]);
  });

  test("injects a repository-scoped installation token for Git smart HTTP", async () => {
    const upstream: Array<{ url: string; authorization: string; cookie: string | null }> = [];
    const handler = createCredentialBroker({
      now: () => 1_800_000_000_000,
      signAppJwt: async () => "app-jwt",
      fetcher: async (input, init) => {
        const url = String(input);
        if (url === "https://convex.example/v1/credentials/github") {
          return Response.json({ ok: true, result: {
            status: "ok",
            installationId: 42,
            repositoryId: 77,
            repositoryFullName: "octocat/menu",
          } });
        }
        if (url === "https://api.github.com/app/installations/42/access_tokens") {
          expect(JSON.parse(String(init?.body))).toEqual({
            repository_ids: [77],
            permissions: { contents: "write", metadata: "read" },
          });
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer app-jwt");
          return Response.json({ token: "ghs_short_lived", expires_at: "2027-01-15T08:59:00.000Z" });
        }
        upstream.push({
          url,
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          cookie: new Headers(init?.headers).get("cookie"),
        });
        return new Response("git-response", { headers: { "content-type": "application/x-git-upload-pack-result" } });
      },
    });
    const response = await handler.fetch(new Request(
      "https://broker.example/v1/egress/github/octocat/menu.git/info/refs?service=git-upload-pack",
      { headers: { authorization: "Bearer run-capability", cookie: "sandbox-secret" } },
    ), githubEnv({
      GITHUB_SIGNER: {
        mintInstallationToken: async () => {
          throw new Error("RPC signer must not run when the local private key exists");
        },
      },
    }));

    expect(response.status).toBe(200);
    expect(upstream).toEqual([{
      url: "https://github.com/octocat/menu.git/info/refs?service=git-upload-pack",
      authorization: `Basic ${btoa("x-access-token:ghs_short_lived")}`,
      cookie: null,
    }]);
  });

  test("fails closed before minting when the requested repository is not project-bound", async () => {
    let minted = false;
    const handler = createCredentialBroker({
      now: () => 1_800_000_000_000,
      signAppJwt: async () => "app-jwt",
      fetcher: async (input) => {
        const url = String(input);
        if (url === "https://convex.example/v1/credentials/github") {
          return Response.json({ ok: true, result: {
            status: "ok", installationId: 42, repositoryId: 77, repositoryFullName: "octocat/menu",
          } });
        }
        minted = true;
        return Response.json({});
      },
    });
    const response = await handler.fetch(new Request(
      "https://broker.example/v1/egress/github/octocat/other.git/info/refs?service=git-upload-pack",
      { headers: { authorization: "Bearer run-capability" } },
    ), githubEnv());

    expect(response.status).toBe(404);
    expect(minted).toBe(false);
  });

  test("does not follow GitHub redirects with an injected credential", async () => {
    const handler = createCredentialBroker({
      now: () => 1_800_000_000_000,
      signAppJwt: async () => "app-jwt",
      fetcher: async (input) => {
        const url = String(input);
        if (url === "https://convex.example/v1/credentials/github") {
          return Response.json({ ok: true, result: {
            status: "ok", installationId: 42, repositoryId: 77, repositoryFullName: "octocat/menu",
          } });
        }
        if (url.includes("/access_tokens")) {
          return Response.json({ token: "ghs_short_lived", expires_at: "2027-01-15T08:59:00.000Z" });
        }
        return new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } });
      },
    });
    const response = await handler.fetch(new Request(
      "https://broker.example/v1/egress/github/api/repos/octocat/menu/contents/package.json",
      { headers: { authorization: "Bearer run-capability" } },
    ), githubEnv());

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  });

  test("falls back to the legacy signer RPC and keeps the token cache in the BuddyBox broker", async () => {
    const now = 1_800_000_000_000;
    let signerCalls = 0;
    let upstreamCalls = 0;
    const handler = createCredentialBroker({
      now: () => now,
      fetcher: async (input) => {
        const url = String(input);
        if (url === "https://convex.example/v1/credentials/github") {
          return Response.json({ ok: true, result: {
            status: "ok", installationId: 42, repositoryId: 77, repositoryFullName: "octocat/menu",
          } });
        }
        if (url.includes("/access_tokens")) throw new Error("BuddyBox must not mint with a missing private key");
        upstreamCalls += 1;
        return new Response("git-response");
      },
    });
    const env = githubEnv({
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_SIGNER: {
        mintInstallationToken: async (input: unknown) => {
          signerCalls += 1;
          expect(input).toEqual({ installationId: 42, repositoryId: 77 });
          return { token: "ghs_from_legacy_signer", expiresAt: now + 60 * 60_000 };
        },
      },
    });

    for (let request = 0; request < 2; request++) {
      const response = await handler.fetch(new Request(
        "https://broker.example/v1/egress/github/octocat/menu.git/info/refs?service=git-upload-pack",
        { headers: { authorization: "Bearer run-capability" } },
      ), env);
      expect(response.status).toBe(200);
    }

    expect(signerCalls).toBe(1);
    expect(upstreamCalls).toBe(2);
  });

  test("fails closed when the signer RPC rejects or returns an invalid credential", async () => {
    for (const mintInstallationToken of [
      async () => Promise.reject(new Error("legacy signer unavailable")),
      async () => ({ token: "not-an-installation-token", expiresAt: 1_800_003_600_000 }),
      async () => ({ token: "ghs_already_expired", expiresAt: 1_800_000_030_000 }),
    ]) {
      let upstreamCalled = false;
      const handler = createCredentialBroker({
        now: () => 1_800_000_000_000,
        fetcher: async (input) => {
          const url = String(input);
          if (url === "https://convex.example/v1/credentials/github") {
            return Response.json({ ok: true, result: {
              status: "ok", installationId: 42, repositoryId: 77, repositoryFullName: "octocat/menu",
            } });
          }
          upstreamCalled = true;
          return new Response("unexpected");
        },
      });
      const response = await handler.fetch(new Request(
        "https://broker.example/v1/egress/github/octocat/menu.git/info/refs?service=git-upload-pack",
        { headers: { authorization: "Bearer run-capability" } },
      ), githubEnv({ GITHUB_APP_PRIVATE_KEY: undefined, GITHUB_SIGNER: { mintInstallationToken } }));

      expect(response.status).toBe(503);
      expect(upstreamCalled).toBe(false);
    }
  });
});

describe("GitHub signer RPC", () => {
  test("validates positive safe installation and repository IDs before calling GitHub", async () => {
    let githubCalled = false;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fetchImplementation(async () => {
      githubCalled = true;
      return Response.json({});
    }));
    try {
      const signer = new GitHubSigner({} as never, githubSignerEnv());
      for (const input of [
        { installationId: 0, repositoryId: 77 },
        { installationId: 42.5, repositoryId: 77 },
        { installationId: 42, repositoryId: Number.MAX_SAFE_INTEGER + 1 },
        { installationId: "42", repositoryId: 77 },
      ]) {
        await expect(signer.mintInstallationToken(input)).rejects.toThrow("Invalid GitHub installation token request");
      }
      expect(githubCalled).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("mints a repository-restricted token and rejects GitHub redirects", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const env = githubSignerEnv({
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    });
    const fetchMock = spyOn(globalThis, "fetch");
    try {
      fetchMock.mockImplementation(fetchImplementation(async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        expect(JSON.parse(String(init?.body))).toEqual({
          repository_ids: [77],
          permissions: { contents: "write", metadata: "read" },
        });
        return Response.json({
          token: "ghs_from_named_signer",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }));
      const signer = new GitHubSigner({} as never, env);
      const credential = await signer.mintInstallationToken({ installationId: 42, repositoryId: 77 });
      expect(credential.token).toBe("ghs_from_named_signer");

      fetchMock.mockImplementation(fetchImplementation(async () => new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/collect" },
      })));
      await expect(signer.mintInstallationToken({ installationId: 42, repositoryId: 77 }))
        .rejects.toThrow("GitHub installation token unavailable");
    } finally {
      fetchMock.mockRestore();
    }
  });
});

function githubEnv(overrides: Record<string, unknown> = {}) {
  return {
    CONTROL_PLANE: {
      fetch: async () => Response.json({ userId: "user_1", projectId: "project_1", action: "run" }),
    },
    CONVEX_CREDENTIAL_URL: "https://convex.example/v1/credentials/codex",
    CONVEX_GITHUB_CREDENTIAL_URL: "https://convex.example/v1/credentials/github",
    BUDDYBOX_CREDENTIAL_BROKER_SECRET: "broker-secret-at-least-thirty-two-characters",
    GITHUB_APP_ID: "1234",
    GITHUB_APP_PRIVATE_KEY: "test-private-key",
    ...overrides,
  } as never;
}

function githubSignerEnv(overrides: Record<string, unknown> = {}) {
  return {
    GITHUB_APP_ID: "1234",
    GITHUB_APP_PRIVATE_KEY: "test-private-key",
    ...overrides,
  } as never;
}

function fetchImplementation(
  implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: globalThis.fetch.preconnect });
}
