export interface BridgeConfig {
  port: number;
  appBearerToken: string;
  consumerSecret?: string;
  botUserId: string;
  juiceboxPin: string;
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
  inboxPollIntervalMs: number;
}

export function readConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const refreshToken = optional(env.X_OAUTH_REFRESH_TOKEN);
  const oauthClientId = optional(env.X_OAUTH_CLIENT_ID);
  const oauthClientSecret = optional(env.X_OAUTH_CLIENT_SECRET);
  if (refreshToken && !oauthClientId) throw new Error("X_OAUTH_CLIENT_ID is required with a refresh token");
  const apiBaseUrl = secureUrl(optional(env.X_API_BASE_URL) ?? "https://api.x.com");
  const brokerUrl = secureUrl(required(env, "CONVEX_XCHAT_BROKER_URL"));
  const portalUrl = secureUrl(optional(env.PUBLIC_PORTAL_URL) ?? "https://buddybox.buddytools.org");
  const routeEncryptionKey = required(env, "BUDDYBOX_ROUTE_ENCRYPTION_KEY");
  const vaultEncryptionKey = required(env, "XCHAT_VAULT_ENCRYPTION_KEY");
  if (decodeBase64(routeEncryptionKey).byteLength !== 32 || decodeBase64(vaultEncryptionKey).byteLength !== 32) {
    throw new Error("Encryption keys must decode to 32 bytes");
  }
  const consumerSecret = optional(env.X_API_CONSUMER_SECRET);
  const appBearerToken = required(env, "X_APP_BEARER_TOKEN");
  const bridgeSecret = required(env, "BUDDYBOX_BRIDGE_SECRET");
  const addressPepper = required(env, "BUDDYBOX_ADDRESS_PEPPER");
  if ([bridgeSecret, addressPepper, ...(consumerSecret ? [consumerSecret] : [])].some((value) => value.length < 16)) {
    throw new Error("Bridge secrets must be at least 16 characters");
  }
  return {
    port: integer(env.PORT, 3000, 1, 65_535),
    appBearerToken,
    ...(consumerSecret ? { consumerSecret } : {}),
    botUserId: snowflake(required(env, "X_CHAT_USER_ID")),
    juiceboxPin: required(env, "X_CHAT_PIN"),
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
    inboxPollIntervalMs: integer(env.XCHAT_INBOX_POLL_INTERVAL_MS, 60_000, 5_000, 300_000),
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

function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(Buffer.from(value, "base64"));
  } catch {
    return new Uint8Array();
  }
}
