import { createChat, type ChatWithJuicebox, type PublicKeyRegistrationPayload } from "@xdevplatform/chat-xdk";
import { z } from "zod";

import type { SecureVault } from "./vault";
import type { XProvisioningHttp } from "./provision";

const publicKeyRecordSchema = z.object({
  public_key_version: z.string().regex(/^[1-9]\d*$/),
  public_key: z.string().min(1),
  juicebox_config: z.record(z.string(), z.unknown()).nullish(),
}).catchall(z.unknown());
const publicKeysResponseSchema = z.object({ data: z.array(publicKeyRecordSchema) });
const addPublicKeyResponseSchema = z.object({
  data: z.union([
    z.object({ public_key_version: z.string().regex(/^[1-9]\d*$/) }),
    z.array(z.object({ public_key_version: z.string().regex(/^[1-9]\d*$/) })).min(1),
  ]),
});
const realmTokenSchema = z.object({
  key: z.string().min(1),
  value: z.object({ token: z.string().min(1) }).catchall(z.unknown()),
});
const juiceboxConfigSchema = z.object({
  token_map: z.array(realmTokenSchema).min(1),
}).catchall(z.unknown());
const markerSchema = z.discriminatedUnion("state", [
  z.object({
    format: z.literal(1),
    state: z.literal("pending"),
    userId: z.string().regex(/^\d{1,19}$/),
    publicKey: z.string().min(1),
    createdAt: z.string().datetime(),
  }),
  z.object({
    format: z.literal(1),
    state: z.literal("stranded"),
    userId: z.string().regex(/^\d{1,19}$/),
    publicKeyVersion: z.string().regex(/^[1-9]\d*$/),
    publicKey: z.string().min(1),
    createdAt: z.string().datetime(),
  }),
  z.object({
    format: z.literal(1),
    state: z.literal("ready"),
    userId: z.string().regex(/^\d{1,19}$/),
    publicKeyVersion: z.string().regex(/^[1-9]\d*$/),
    publicKey: z.string().min(1),
    registeredAt: z.string().datetime(),
  }),
]);

type RegistrationChat = Pick<ChatWithJuicebox,
  "free" | "generateKeypairs" | "lock" | "matchesRegisteredKey" | "setIdentity" | "setup" | "unlock" | "updateConfig"
>;

export type XChatRegistrationFactory = (
  options: Parameters<typeof createChat>[0],
) => Promise<RegistrationChat>;

export interface RegisterXChatIdentityOptions {
  userId: string;
  pin: string;
  accessToken: string;
  fetcher: XProvisioningHttp;
  vault: SecureVault;
  chatFactory?: XChatRegistrationFactory;
  retryDelay?: (attempt: number) => Promise<void>;
  forceRotation?: boolean;
}

export type VerifyXChatIdentityOptions = Omit<RegisterXChatIdentityOptions, "retryDelay">;

export interface RegisteredXChatIdentity {
  publicKeyVersion: string;
  status: "ready" | "created";
}

export async function verifyXChatIdentity(
  options: VerifyXChatIdentityOptions,
): Promise<{ publicKeyVersion: string } | undefined> {
  try {
    validatePin(options.pin);
    const records = await getPublicKeys(options);
    if (records.length === 0) return undefined;
    const markerValue = await options.vault.get<unknown>("xchat_identity", options.userId);
    let expectedPublicKey: string | undefined;
    if (markerValue !== undefined) {
      const marker = markerSchema.safeParse(markerValue);
      if (!marker.success) return undefined;
      expectedPublicKey = marker.data.publicKey;
      if (!records.some((record) => record.public_key === expectedPublicKey)) return undefined;
    }
    const recovered = await recoverIdentity(options, records, expectedPublicKey);
    return { publicKeyVersion: recovered.publicKeyVersion };
  } catch {
    return undefined;
  }
}

export async function registerXChatIdentity(
  options: RegisterXChatIdentityOptions,
): Promise<RegisteredXChatIdentity> {
  validatePin(options.pin);
  const markerValue = await options.vault.get<unknown>("xchat_identity", options.userId);
  const records = await getPublicKeys(options);
  if (markerValue !== undefined && !options.forceRotation) {
    const marker = markerSchema.safeParse(markerValue);
    if (!marker.success) throw new Error("X Chat identity marker is invalid");
    const registered = records.find((record) => record.public_key === marker.data.publicKey);
    if (!registered) {
      throw new Error("X Chat identity registration is pending operator recovery");
    }
    const recovered = await recoverIdentity(options, records, marker.data.publicKey);
    await storeReadyMarker(options, recovered);
    return { publicKeyVersion: recovered.publicKeyVersion, status: "ready" };
  }

  if (records.length > 0 && !options.forceRotation) {
    const recovered = await recoverIdentity(options, records);
    await storeReadyMarker(options, recovered);
    return { publicKeyVersion: recovered.publicKeyVersion, status: "ready" };
  }

  const realmTokens = new Map<string, string>();
  const chatFactory = options.chatFactory ?? createChat;
  const chat = await chatFactory({
    getAuthToken: async (realmId) => realmTokens.get(realmId.toLowerCase()) ?? "",
  });
  try {
    const registration = chat.generateKeypairs();
    const body = registrationBody(registration);
    const identityPublicKey = body.public_key.public_key;
    const createdAt = new Date().toISOString();
    await options.vault.put("xchat_identity", options.userId, {
      format: 1,
      state: "pending",
      userId: options.userId,
      publicKey: identityPublicKey,
      createdAt,
    });
    let currentRecords = records;
    let registered: (typeof records)[number] | undefined;
    let publicKeyVersion: string;
      try {
        publicKeyVersion = await addPublicKey(options, body);
      } catch (postError: unknown) {
        if (postError instanceof XIdentityRequestError && postError.definitelyRejected) {
          await options.vault.delete("xchat_identity", options.userId);
          throw postError;
        }
      for (let attempt = 1; attempt <= 3 && !registered; attempt += 1) {
        if (attempt > 1) await (options.retryDelay ?? defaultRetryDelay)(attempt - 1);
        try {
          currentRecords = await getPublicKeys(options);
          registered = currentRecords.find((record) => record.public_key === identityPublicKey);
        } catch {
          // Keep reconciling the same in-memory identity within this process.
        }
      }
      if (!registered) throw postError;
      publicKeyVersion = registered.public_key_version;
    }
    await options.vault.put("xchat_identity", options.userId, {
      format: 1,
      state: "stranded",
      userId: options.userId,
      publicKeyVersion,
      publicKey: identityPublicKey,
      createdAt,
    });

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        currentRecords = await getPublicKeys(options);
        registered = currentRecords.find((record) => record.public_key === identityPublicKey);
        if (!registered) throw new Error("Registered X Chat identity is not visible");
        publicKeyVersion = registered.public_key_version;
        const configured = newestConfiguredRecord(currentRecords);
        const config = juiceboxConfigSchema.parse(configured.juicebox_config);
        realmTokens.clear();
        for (const entry of config.token_map) {
          realmTokens.set(entry.key.toLowerCase(), entry.value.token);
        }
        chat.updateConfig(JSON.stringify(configured.juicebox_config));
        await chat.setup(options.pin);
        chat.setIdentity(options.userId, publicKeyVersion);
        await storeReadyMarker(options, {
          publicKeyVersion,
          publicKey: identityPublicKey,
        });
        return { publicKeyVersion, status: "created" };
      } catch (error: unknown) {
        lastError = error;
        if (attempt < 3) await (options.retryDelay ?? defaultRetryDelay)(attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("X Chat identity persistence failed");
  } finally {
    chat.lock();
    chat.free();
  }
}

async function recoverIdentity(
  options: RegisterXChatIdentityOptions,
  records: z.infer<typeof publicKeyRecordSchema>[],
  expectedPublicKey?: string,
): Promise<{ publicKeyVersion: string; publicKey: string }> {
  const configured = newestConfiguredRecord(records);
  const config = juiceboxConfigSchema.parse(configured.juicebox_config);
  const realmTokens = new Map(config.token_map.map((entry) => [entry.key.toLowerCase(), entry.value.token]));
  const chatFactory = options.chatFactory ?? createChat;
  const chat = await chatFactory({
    juiceboxConfig: JSON.stringify(configured.juicebox_config),
    getAuthToken: async (realmId) => realmTokens.get(realmId.toLowerCase()) ?? "",
  });
  try {
    await chat.unlock(options.pin);
    const registered = records.find((record) =>
      (!expectedPublicKey || record.public_key === expectedPublicKey)
      && chat.matchesRegisteredKey(record.public_key)
    );
    if (!registered) throw new Error("Recovered X Chat identity does not match the account");
    chat.setIdentity(options.userId, registered.public_key_version);
    return {
      publicKeyVersion: registered.public_key_version,
      publicKey: registered.public_key,
    };
  } finally {
    chat.lock();
    chat.free();
  }
}

async function storeReadyMarker(
  options: RegisterXChatIdentityOptions,
  identity: { publicKeyVersion: string; publicKey: string },
): Promise<void> {
  await options.vault.put("xchat_identity", options.userId, {
    format: 1,
    state: "ready",
    userId: options.userId,
    publicKeyVersion: identity.publicKeyVersion,
    publicKey: identity.publicKey,
    registeredAt: new Date().toISOString(),
  });
}

interface RegistrationBody {
  public_key: {
    identity_public_key_signature: string;
    public_key: string;
    public_key_fingerprint?: string;
    registration_method: string;
    signing_public_key: string;
    signing_public_key_signature?: string;
  };
  version?: string;
  generate_version: boolean;
}

function registrationBody(registration: PublicKeyRegistrationPayload): RegistrationBody {
  return {
    public_key: {
      identity_public_key_signature: registration.publicKey.identityPublicKeySignature,
      public_key: registration.publicKey.publicKey,
      ...(registration.publicKey.publicKeyFingerprint
        ? { public_key_fingerprint: registration.publicKey.publicKeyFingerprint }
        : {}),
      registration_method: registration.publicKey.registrationMethod,
      signing_public_key: registration.publicKey.signingPublicKey,
      ...(registration.publicKey.signingPublicKeySignature
        ? { signing_public_key_signature: registration.publicKey.signingPublicKeySignature }
        : {}),
    },
    ...(registration.version ? { version: registration.version } : {}),
    generate_version: registration.generateVersion,
  };
}

async function getPublicKeys(options: RegisterXChatIdentityOptions) {
  return (await requestJson(
    options,
    `https://api.x.com/2/users/${options.userId}/public_keys`,
    { method: "GET" },
    publicKeysResponseSchema,
  )).data;
}

async function addPublicKey(
  options: RegisterXChatIdentityOptions,
  body: RegistrationBody,
): Promise<string> {
  const response = await requestJson(
    options,
    `https://api.x.com/2/users/${options.userId}/public_keys`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    addPublicKeyResponseSchema,
  );
  return Array.isArray(response.data)
    ? response.data[0]!.public_key_version
    : response.data.public_key_version;
}

async function requestJson<T>(
  options: RegisterXChatIdentityOptions,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${options.accessToken}`);
  const response = await options.fetcher(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new XIdentityRequestError(response.status);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new Error("X Chat identity response is invalid");
  return parsed.data;
}

class XIdentityRequestError extends Error {
  constructor(readonly status: number) {
    super("X Chat identity request failed");
  }

  get definitelyRejected(): boolean {
    return this.status === 400 || this.status === 401 || this.status === 403 ||
      this.status === 404 || this.status === 422 || this.status === 429;
  }
}

function newestConfiguredRecord(records: z.infer<typeof publicKeyRecordSchema>[]) {
  const configured = records.filter((record) => record.juicebox_config != null);
  const newest = configured.reduce<(typeof configured)[number] | undefined>((current, candidate) => {
    if (!current || compareVersions(candidate.public_key_version, current.public_key_version) > 0) return candidate;
    return current;
  }, undefined);
  if (!newest) throw new Error("X Chat Juicebox config is unavailable");
  return newest;
}

function compareVersions(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function validatePin(pin: string): void {
  const bytes = new TextEncoder().encode(pin);
  if (bytes.length < 4) throw new Error("X_CHAT_PIN is too short");
  if (bytes.every((byte) => byte === bytes[0])) throw new Error("X_CHAT_PIN is too weak");
  const allDigits = bytes.every((byte) => byte >= 0x30 && byte <= 0x39);
  let ascending = true;
  let descending = true;
  for (let index = 1; index < bytes.length; index += 1) {
    if (bytes[index] !== bytes[index - 1]! + 1) ascending = false;
    if (bytes[index] !== bytes[index - 1]! - 1) descending = false;
  }
  if (allDigits && (ascending || descending)) throw new Error("X_CHAT_PIN is too weak");
}

async function defaultRetryDelay(attempt: number): Promise<void> {
  await Bun.sleep(attempt * 2_000);
}
