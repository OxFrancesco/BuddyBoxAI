import { z } from "zod";

import type { UserContextTokenProvider } from "./oauth";
import type { PreparedSend } from "./types";

const publicKeySchema = z.object({
  public_key_version: z.string().regex(/^[1-9]\d*$/),
  public_key: z.string().min(1),
  signing_public_key: z.string().min(1),
  identity_public_key_signature: z.string().min(1),
});
const realmTokenEntrySchema = z.strictObject({
  key: z.string().regex(/^[0-9a-f]+$/i).max(1_024),
  value: z.object({
    token: z.string().min(1).max(131_072),
  }).catchall(z.unknown()),
});
const juiceboxConfigSchema = z.object({
  key_store_token_map_json: z.string().min(2).max(1_000_000).refine(isJsonObject),
  token_map: z.array(realmTokenEntrySchema).min(1).max(64),
}).catchall(z.unknown()).superRefine((config, context) => {
  const realms = new Set<string>();
  for (const entry of config.token_map) {
    const realm = entry.key.toLowerCase();
    if (realms.has(realm)) {
      context.addIssue({ code: "custom", message: "Duplicate Juicebox realm" });
      return;
    }
    realms.add(realm);
  }
});
const recoveryPublicKeySchema = publicKeySchema.extend({
  juicebox_config: juiceboxConfigSchema.nullish(),
});

export interface SigningKeyRecord {
  userId: string;
  publicKeyVersion: string;
  publicKey: string;
  identityPublicKey: string;
  identityPublicKeySignature: string;
}

export interface XChatRecoveryMaterial {
  configKeyVersion: string;
  juiceboxConfig: string;
  realmTokens: Readonly<Record<string, string>>;
  registeredKeys: ReadonlyArray<{
    publicKeyVersion: string;
    identityPublicKey: string;
  }>;
}

export type XApiHttp = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class XApiClient {
  readonly #baseUrl: string;
  readonly #tokens: UserContextTokenProvider;
  readonly #fetcher: XApiHttp;

  constructor(options: { baseUrl: string; tokens: UserContextTokenProvider; fetcher?: XApiHttp }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#tokens = options.tokens;
    this.#fetcher = options.fetcher ?? fetch;
  }

  async getSigningKeys(userId: string): Promise<SigningKeyRecord[]> {
    const url = new URL(`${this.#baseUrl}/2/users/${encodeURIComponent(userId)}/public_keys`);
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

  async getXChatRecoveryMaterial(userId: string): Promise<XChatRecoveryMaterial> {
    const url = new URL(`${this.#baseUrl}/2/users/${encodeURIComponent(userId)}/public_keys`);
    const response = await this.#authorizedFetch(url, { method: "GET" });
    if (!response.ok) throw new Error("X public-key lookup failed");
    const body: unknown = await response.json();
    const parsed = z.object({ data: z.array(recoveryPublicKeySchema).min(1) }).safeParse(body);
    if (!parsed.success) throw new Error("X public-key response is invalid");
    const configured = parsed.data.data.filter((record) => record.juicebox_config !== null && record.juicebox_config !== undefined);
    const latest = configured.reduce<(typeof configured)[number] | undefined>((current, candidate) => {
      if (!current || compareKeyVersions(candidate.public_key_version, current.public_key_version) > 0) return candidate;
      return current;
    }, undefined);
    if (!latest?.juicebox_config) throw new Error("X public-key response is invalid");
    const realmTokens: Record<string, string> = {};
    for (const entry of latest.juicebox_config.token_map) {
      realmTokens[entry.key.toLowerCase()] = entry.value.token;
    }
    return {
      configKeyVersion: latest.public_key_version,
      juiceboxConfig: JSON.stringify(latest.juicebox_config),
      realmTokens,
      registeredKeys: parsed.data.data.map((record) => ({
        publicKeyVersion: record.public_key_version,
        identityPublicKey: record.public_key,
      })),
    };
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

function compareKeyVersions(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
