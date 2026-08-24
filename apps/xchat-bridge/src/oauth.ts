import type { SecureVault } from "./vault";

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export class UserContextTokenProvider {
  #token: StoredToken;
  readonly #clientId: string | undefined;
  readonly #clientSecret: string | undefined;
  readonly #vault: SecureVault;
  #refreshing: Promise<string> | undefined;

  constructor(options: {
    accessToken: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    vault: SecureVault;
  }) {
    this.#token = {
      accessToken: options.accessToken,
      ...(options.refreshToken ? { refreshToken: options.refreshToken } : {}),
    };
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#vault = options.vault;
  }

  async initialize(): Promise<void> {
    const stored = await this.#vault.get<StoredToken>("oauth_token", "x_user");
    if (stored?.accessToken) this.#token = stored;
  }

  async token(forceRefresh = false): Promise<string> {
    const nearExpiry = this.#token.expiresAt !== undefined && this.#token.expiresAt < Date.now() + 60_000;
    if (!forceRefresh && !nearExpiry) return this.#token.accessToken;
    if (!this.#token.refreshToken || !this.#clientId) {
      if (forceRefresh) throw new Error("X OAuth token cannot be refreshed");
      return this.#token.accessToken;
    }
    if (!this.#refreshing) {
      this.#refreshing = (async () => {
        try {
          return await this.#refresh();
        } finally {
          this.#refreshing = undefined;
        }
      })();
    }
    return await this.#refreshing;
  }

  async #refresh(): Promise<string> {
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    if (this.#clientSecret) {
      headers.set("authorization", `Basic ${Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString("base64")}`);
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.#token.refreshToken!,
      client_id: this.#clientId!,
    });
    const response = await fetch("https://api.x.com/2/oauth2/token", { method: "POST", headers, body });
    if (!response.ok) throw new Error("X OAuth refresh failed");
    const value: unknown = await response.json();
    if (!isRecord(value) || typeof value.access_token !== "string") throw new Error("X OAuth refresh response is invalid");
    const refreshToken = typeof value.refresh_token === "string" ? value.refresh_token : this.#token.refreshToken;
    this.#token = {
      accessToken: value.access_token,
      ...(refreshToken ? { refreshToken } : {}),
      ...(typeof value.expires_in === "number" ? { expiresAt: Date.now() + value.expires_in * 1_000 } : {}),
    };
    await this.#vault.put("oauth_token", "x_user", this.#token);
    return this.#token.accessToken;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
