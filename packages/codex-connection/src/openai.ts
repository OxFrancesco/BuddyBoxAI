import type {
  CodexAuthClient,
  CodexCredentials,
  DeviceAuthorization,
  DevicePollResult,
} from "./types.ts";

export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_AUTH_BASE_URL = "https://auth.openai.com";
export const OPENAI_CODEX_VERIFICATION_URI =
  `${OPENAI_CODEX_AUTH_BASE_URL}/codex/device`;

const DEVICE_USER_CODE_URL =
  `${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL =
  `${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/oauth/token`;
const DEVICE_REDIRECT_URI =
  `${OPENAI_CODEX_AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_TTL_MS = 15 * 60_000;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const SAFE_MESSAGES: Record<string, string> = {
  authorization_rejected: "ChatGPT authorization was rejected.",
  cancelled: "ChatGPT authorization was cancelled.",
  device_auth_disabled: "ChatGPT device authorization is unavailable.",
  invalid_device_response: "ChatGPT returned an invalid device authorization response.",
  invalid_poll_response: "ChatGPT returned an invalid authorization status.",
  invalid_token_response: "ChatGPT returned an invalid credential response.",
  missing_account_id: "The ChatGPT account could not be identified.",
  network_error: "ChatGPT authorization could not reach OpenAI.",
  rate_limited: "ChatGPT authorization is temporarily rate limited.",
  upstream_unavailable: "ChatGPT authorization is temporarily unavailable.",
};

export class CodexAuthError extends Error {
  readonly name = "CodexAuthError";

  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(SAFE_MESSAGES[code] ?? "ChatGPT authorization failed.");
  }

  toJSON(): { name: string; code: string; retryable: boolean; message: string } {
    return {
      name: this.name,
      code: this.code,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

export type CodexFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type OpenAiCodexAuthClientOptions = Readonly<{
  fetch?: CodexFetch;
  now?: () => number;
}>;

type TokenPayload = {
  [JWT_CLAIM_PATH]?: { chatgpt_account_id?: unknown };
};

export function accountIdFromAccessToken(accessToken: string): string | null {
  try {
    const segments = accessToken.split(".");
    if (segments.length !== 3 || !segments[1]) return null;
    const payload = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    ) as TokenPayload;
    const accountId = payload[JWT_CLAIM_PATH]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0
      ? accountId
      : null;
  } catch {
    return null;
  }
}

async function responseErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as {
      error?: string | { code?: unknown };
    };
    const raw = typeof body.error === "string" ? body.error : body.error?.code;
    return typeof raw === "string" && /^[a-z0-9_]{1,64}$/.test(raw)
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}

async function upstreamError(response: Response): Promise<CodexAuthError> {
  if (response.status === 429) return new CodexAuthError("rate_limited", true);
  if (response.status >= 500) {
    return new CodexAuthError("upstream_unavailable", true);
  }
  const code = await responseErrorCode(response);
  if (code === "slow_down") return new CodexAuthError("rate_limited", true);
  return new CodexAuthError("authorization_rejected", false);
}

export class OpenAiCodexAuthClient implements CodexAuthClient {
  private readonly request: CodexFetch;
  private readonly now: () => number;

  constructor(options: OpenAiCodexAuthClientOptions = {}) {
    this.request = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  async startDeviceAuthorization(
    signal?: AbortSignal,
  ): Promise<DeviceAuthorization> {
    const response = await this.fetch(DEVICE_USER_CODE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
      signal,
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new CodexAuthError("device_auth_disabled", false);
      }
      throw await upstreamError(response);
    }
    const body = (await this.safeJson(response)) as {
      device_auth_id?: unknown;
      user_code?: unknown;
      interval?: unknown;
    };
    const intervalSeconds =
      typeof body.interval === "string" ? Number(body.interval) : body.interval;
    if (
      typeof body.device_auth_id !== "string" ||
      body.device_auth_id.length === 0 ||
      typeof body.user_code !== "string" ||
      body.user_code.length === 0 ||
      typeof intervalSeconds !== "number" ||
      !Number.isFinite(intervalSeconds) ||
      intervalSeconds < 0
    ) {
      throw new CodexAuthError("invalid_device_response", false);
    }
    return {
      deviceAuthId: body.device_auth_id,
      userCode: body.user_code,
      verificationUri: OPENAI_CODEX_VERIFICATION_URI,
      intervalMs: Math.max(1_000, intervalSeconds * 1_000),
      expiresAt: this.now() + DEVICE_TTL_MS,
    };
  }

  async pollDeviceAuthorization(
    deviceAuthId: string,
    userCode: string,
    signal?: AbortSignal,
  ): Promise<DevicePollResult> {
    const response = await this.fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      signal,
    });
    if (response.ok) {
      const body = (await this.safeJson(response)) as {
        authorization_code?: unknown;
        code_verifier?: unknown;
      };
      if (
        typeof body.authorization_code !== "string" ||
        !body.authorization_code ||
        typeof body.code_verifier !== "string" ||
        !body.code_verifier
      ) {
        throw new CodexAuthError("invalid_poll_response", false);
      }
      return {
        status: "complete",
        authorizationCode: body.authorization_code,
        codeVerifier: body.code_verifier,
      };
    }
    if (response.status === 403 || response.status === 404) {
      return { status: "pending" };
    }
    const code = await responseErrorCode(response);
    if (code === "deviceauth_authorization_pending") return { status: "pending" };
    if (code === "slow_down" || response.status === 429) {
      return { status: "slow_down" };
    }
    throw await upstreamError(response);
  }

  async exchangeDeviceAuthorization(
    authorizationCode: string,
    codeVerifier: string,
    signal?: AbortSignal,
  ): Promise<CodexCredentials> {
    return this.tokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI_CODEX_CLIENT_ID,
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: DEVICE_REDIRECT_URI,
      }),
      signal,
    );
  }

  async refreshCredentials(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<CodexCredentials> {
    return this.tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
      signal,
    );
  }

  private async tokenRequest(
    body: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<CodexCredentials> {
    const response = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal,
    });
    if (!response.ok) throw await upstreamError(response);
    const value = (await this.safeJson(response)) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof value.access_token !== "string" ||
      !value.access_token ||
      typeof value.refresh_token !== "string" ||
      !value.refresh_token ||
      typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0
    ) {
      throw new CodexAuthError("invalid_token_response", false);
    }
    const accountId = accountIdFromAccessToken(value.access_token);
    if (!accountId) throw new CodexAuthError("missing_account_id", false);
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: this.now() + value.expires_in * 1_000,
      accountId,
    };
  }

  private async fetch(input: string, init: RequestInit): Promise<Response> {
    try {
      return await this.request(input, init);
    } catch {
      if (init.signal?.aborted) throw new CodexAuthError("cancelled", false);
      throw new CodexAuthError("network_error", true);
    }
  }

  private async safeJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new CodexAuthError("invalid_token_response", false);
    }
  }
}
