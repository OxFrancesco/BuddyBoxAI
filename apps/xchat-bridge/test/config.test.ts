import { describe, expect, test } from "bun:test";

import { readConfig } from "../src/config";

const env = {
  X_API_CONSUMER_SECRET: "consumer_secret_long_enough",
  X_OAUTH_ACCESS_TOKEN: "user_access_token",
  X_CHAT_USER_ID: "123456",
  X_CHAT_KEY_VERSION: "42",
  X_CHAT_JUICEBOX_CONFIG: '{"token_map":[]}',
  X_CHAT_PIN: "safe-pin-value",
  X_CHAT_REALM_TOKENS_JSON: '{"abcd":"realm-token"}',
  CONVEX_XCHAT_BROKER_URL: "https://example.convex.site/v1/xchat/broker",
  ICHEF_BRIDGE_SECRET: "bridge_secret_long_enough",
  ICHEF_ROUTE_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  XCHAT_VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
  ICHEF_ADDRESS_PEPPER: "address_pepper_long_enough",
};

describe("configuration", () => {
  test("reads strict production defaults", () => {
    expect(readConfig(env)).toMatchObject({
      port: 3000,
      botUserId: "123456",
      pollIntervalMs: 2000,
      portalUrl: "https://ichef.buddytools.org",
    });
  });

  test("rejects malformed encryption material and insecure remote URLs", () => {
    expect(() => readConfig({ ...env, ICHEF_ROUTE_ENCRYPTION_KEY: "bad" })).toThrow();
    expect(() => readConfig({ ...env, CONVEX_XCHAT_BROKER_URL: "http://example.com" })).toThrow();
    expect(() => readConfig({ ...env, PUBLIC_PORTAL_URL: "http://example.com" })).toThrow();
  });
});
