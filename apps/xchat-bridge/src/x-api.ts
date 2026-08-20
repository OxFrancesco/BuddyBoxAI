import { z } from "zod";

import type { UserContextTokenProvider } from "./oauth";
import type { PreparedSend } from "./types";

const publicKeySchema = z.object({
  public_key_version: z.string().min(1),
  public_key: z.string().min(1),
  signing_public_key: z.string().min(1),
  identity_public_key_signature: z.string().min(1),
});

export interface SigningKeyRecord {
  userId: string;
  publicKeyVersion: string;
  publicKey: string;
  identityPublicKey: string;
  identityPublicKeySignature: string;
}

export class XApiClient {
  readonly #baseUrl: string;
  readonly #tokens: UserContextTokenProvider;
  readonly #fetcher: typeof fetch;

  constructor(options: { baseUrl: string; tokens: UserContextTokenProvider; fetcher?: typeof fetch }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#tokens = options.tokens;
    this.#fetcher = options.fetcher ?? fetch;
  }

  async getSigningKeys(userId: string): Promise<SigningKeyRecord[]> {
    const url = new URL(`${this.#baseUrl}/2/users/${encodeURIComponent(userId)}/public_keys`);
    url.searchParams.set(
      "public_key.fields",
      "public_key_version,public_key,signing_public_key,identity_public_key_signature",
    );
    const response = await this.#authorizedFetch(url, { method: "GET" });
    if (!response.ok) throw new Error("X public-key lookup failed");
    const body: unknown = await response.json();
    const parsed = z.object({ data: z.array(publicKeySchema).min(1) }).safeParse(body);
    if (!parsed.success) throw new Error("X public-key response is invalid");
    return parsed.data.data.map((row) => ({
      userId,
      publicKeyVersion: row.public_key_version,
      publicKey: row.signing_public_key,
      identityPublicKey: row.public_key,
      identityPublicKeySignature: row.identity_public_key_signature,
    }));
  }

  async sendPrepared(prepared: PreparedSend): Promise<string> {
    const conversationId = canonicalPathId(prepared.conversationId);
    const response = await this.#authorizedFetch(
      `${this.#baseUrl}/2/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message_id: prepared.messageId,
          encoded_message_create_event: prepared.encodedMessageCreateEvent,
          encoded_message_event_signature: prepared.encodedMessageEventSignature,
        }),
      },
    );
    if (!response.ok) throw new XApiError(response.status);
    return prepared.messageId;
  }

  async #authorizedFetch(input: string | URL, init: RequestInit): Promise<Response> {
    let token = await this.#tokens.token();
    let response = await this.#fetcher(input, withBearer(init, token));
    if (response.status !== 401) return response;
    token = await this.#tokens.token(true);
    response = await this.#fetcher(input, withBearer(init, token));
    return response;
  }
}

export class XApiError extends Error {
  constructor(readonly status: number) {
    super("X Chat API request failed");
    this.name = "XApiError";
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}

function withBearer(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15_000) };
}

function canonicalPathId(value: string): string {
  if (!/^(?:g?[0-9-]{1,64}|[0-9:]{3,64})$/.test(value)) throw new TypeError("Invalid X Chat conversation ID");
  return value.replaceAll(":", "-");
}
