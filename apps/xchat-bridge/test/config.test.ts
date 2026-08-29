import { describe, expect, test } from "bun:test";

import { readConfig } from "../src/config";

const env = {
  X_OAUTH_ACCESS_TOKEN: "user_access_token",
  X_APP_BEARER_TOKEN: "app_bearer_token",
  X_CHAT_USER_ID: "123456",
  X_CHAT_PIN: "safe-pin-value",
  CONVEX_XCHAT_BROKER_URL: "https://example.convex.site/v1/xchat/broker",
  BUDDYBOX_BRIDGE_SECRET: "bridge_secret_long_enough",
  BUDDYBOX_ROUTE_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  XCHAT_VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
  BUDDYBOX_ADDRESS_PEPPER: "address_pepper_long_enough",
};

describe("configuration", () => {
  test("reads strict production defaults", () => {
    expect(readConfig(env)).toMatchObject({
      port: 3000,
      botUserId: "123456",
      appBearerToken: "app_bearer_token",
      pollIntervalMs: 2000,
      portalUrl: "https://buddybox.buddytools.org",
    });
  });

  test("does not require stale static Juicebox material", () => {
    expect(() => readConfig(env)).not.toThrow();
    expect(readConfig(env)).not.toHaveProperty("realmTokens");
    expect(readConfig(env)).not.toHaveProperty("juiceboxConfig");
    expect(readConfig(env)).not.toHaveProperty("botKeyVersion");
  });

  test("does not require an Account Activity webhook secret", () => {
    expect(() => readConfig(env)).not.toThrow();
    expect(readConfig(env)).not.toHaveProperty("consumerSecret");
  });

  test("rejects malformed encryption material and insecure remote URLs", () => {
    expect(() => readConfig({ ...env, BUDDYBOX_ROUTE_ENCRYPTION_KEY: "bad" })).toThrow();
    expect(() => readConfig({ ...env, CONVEX_XCHAT_BROKER_URL: "http://example.com" })).toThrow();
    expect(() => readConfig({ ...env, PUBLIC_PORTAL_URL: "http://example.com" })).toThrow();
  });
});
