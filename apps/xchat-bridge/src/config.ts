export interface BridgeConfig {
  port: number;
  consumerSecret: string;
  botUserId: string;
  botKeyVersion: string;
  juiceboxConfig: string;
  juiceboxPin: string;
  realmTokens: Readonly<Record<string, string>>;
  accessToken: string;
  refreshToken?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  apiBaseUrl: string;
  brokerUrl: string;
  portalUrl: string;
  bridgeSecret: string;
  routeEncryptionKey: string;
  vaultEncryptionKey: string;
  addressPepper: string;
  vaultPath: string;
  pollIntervalMs: number;
}

export function readConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const refreshToken = optional(env.X_OAUTH_REFRESH_TOKEN);
  const oauthClientId = optional(env.X_OAUTH_CLIENT_ID);
  const oauthClientSecret = optional(env.X_OAUTH_CLIENT_SECRET);
  if (refreshToken && !oauthClientId) throw new Error("X_OAUTH_CLIENT_ID is required with a refresh token");
  const apiBaseUrl = secureUrl(optional(env.X_API_BASE_URL) ?? "https://api.x.com");
  const brokerUrl = secureUrl(required(env, "CONVEX_XCHAT_BROKER_URL"));
  const portalUrl = secureUrl(optional(env.PUBLIC_PORTAL_URL) ?? "https://ichef.buddytools.org");
  const realmTokens = parseSecretMap(required(env, "X_CHAT_REALM_TOKENS_JSON"));
  const routeEncryptionKey = required(env, "ICHEF_ROUTE_ENCRYPTION_KEY");
  const vaultEncryptionKey = required(env, "XCHAT_VAULT_ENCRYPTION_KEY");
  if (decodeBase64(routeEncryptionKey).byteLength !== 32 || decodeBase64(vaultEncryptionKey).byteLength !== 32) {
    throw new Error("Encryption keys must decode to 32 bytes");
  }
  const consumerSecret = required(env, "X_API_CONSUMER_SECRET");
  const bridgeSecret = required(env, "ICHEF_BRIDGE_SECRET");
  const addressPepper = required(env, "ICHEF_ADDRESS_PEPPER");
  if ([consumerSecret, bridgeSecret, addressPepper].some((value) => value.length < 16)) {
    throw new Error("Bridge secrets must be at least 16 characters");
  }
  return {
    port: integer(env.PORT, 3000, 1, 65_535),
    consumerSecret,
    botUserId: snowflake(required(env, "X_CHAT_USER_ID")),
    botKeyVersion: required(env, "X_CHAT_KEY_VERSION"),
    juiceboxConfig: parseJsonObject(required(env, "X_CHAT_JUICEBOX_CONFIG")),
    juiceboxPin: required(env, "X_CHAT_PIN"),
    realmTokens,
    accessToken: required(env, "X_OAUTH_ACCESS_TOKEN"),
    ...(refreshToken ? { refreshToken } : {}),
    ...(oauthClientId ? { oauthClientId } : {}),
    ...(oauthClientSecret ? { oauthClientSecret } : {}),
    apiBaseUrl,
    brokerUrl,
    portalUrl,
    bridgeSecret,
    routeEncryptionKey,
    vaultEncryptionKey,
    addressPepper,
    vaultPath: optional(env.XCHAT_VAULT_PATH) ?? "/data/xchat-vault.json",
    pollIntervalMs: integer(env.XCHAT_POLL_INTERVAL_MS, 2_000, 500, 60_000),
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = optional(env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error("Expected an integer environment value");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error("Integer environment value is out of bounds");
  return parsed;
}

function secureUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("Service URLs must use HTTPS outside localhost");
  }
  return url.toString().replace(/\/$/, "");
}

function snowflake(value: string): string {
  if (!/^\d{1,19}$/.test(value)) throw new Error("X_CHAT_USER_ID must be an X user ID");
  return value;
}

function parseJsonObject(value: string): string {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return JSON.stringify(parsed);
}

function parseSecretMap(value: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a realm-token JSON object");
  const result: Record<string, string> = {};
  for (const [realm, token] of Object.entries(parsed)) {
    if (!/^[0-9a-f]+$/i.test(realm) || typeof token !== "string" || token.length < 1) throw new Error("Invalid realm-token entry");
    result[realm.toLowerCase()] = token;
  }
  if (!Object.keys(result).length) throw new Error("At least one realm token is required");
  return result;
}

function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(Buffer.from(value, "base64"));
  } catch {
    return new Uint8Array();
  }
}
