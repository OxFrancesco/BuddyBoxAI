import { describe, expect, test } from "bun:test";

import { XChatEngine } from "../src/chat-engine";
import { UserContextTokenProvider } from "../src/oauth";
import { MemoryVault } from "../src/vault";
import { XApiClient } from "../src/x-api";

function apiFor(body: unknown, observeRequest?: (request: Request) => void): XApiClient {
  const tokens = new UserContextTokenProvider({
    accessToken: "fresh-user-context-token",
    vault: new MemoryVault(),
  });
  return new XApiClient({
    baseUrl: "https://api.x.test",
    tokens,
    fetcher: async (input, init) => {
      observeRequest?.(new Request(input, init));
      return Response.json(body);
    },
  });
}

function keyRecord(options: {
  version: string;
  publicKey: string;
  realm: string;
  token: string;
  address?: string;
}): Record<string, unknown> {
  return {
    public_key_version: options.version,
    public_key: options.publicKey,
    signing_public_key: `signing-${options.version}`,
    identity_public_key_signature: `signature-${options.version}`,
    juicebox_config: {
      key_store_token_map_json: JSON.stringify({
        realms: [{ id: options.realm, address: options.address ?? "https://realm.example" }],
        register_threshold: 1,
        recover_threshold: 1,
        pin_hashing_mode: "Standard2019",
      }),
      token_map: [{
        key: options.realm,
        value: {
          address: options.address ?? "https://realm.example",
          token: options.token,
        },
      }],
    },
  };
}

describe("dynamic X Chat Juicebox recovery", () => {
  test("extracts normalized realm tokens from the newest public-key config", async () => {
    let requestUrl: string | undefined;
    const api = apiFor({
      data: [
        keyRecord({ version: "9", publicKey: "older-public", realm: "AABB", token: "older-token" }),
        keyRecord({ version: "11", publicKey: "newest-public", realm: "CCDD", token: "fresh-token" }),
        keyRecord({ version: "10", publicKey: "middle-public", realm: "EEFF", token: "middle-token" }),
      ],
    }, (request) => { requestUrl = request.url; });

    const material = await api.getXChatRecoveryMaterial("2244994945");

    expect(material.configKeyVersion).toBe("11");
    expect(requestUrl).toBe("https://api.x.test/2/users/2244994945/public_keys");
    expect(material.realmTokens).toEqual({ ccdd: "fresh-token" });
    expect(JSON.parse(material.juiceboxConfig)).toMatchObject({
      token_map: [{ key: "CCDD", value: { token: "fresh-token" } }],
    });
  });

  test.each([
    ["missing token map", { key_store_token_map_json: "{}" }],
    ["empty token map", { key_store_token_map_json: "{}", token_map: [] }],
    ["missing token", {
      key_store_token_map_json: "{}",
      token_map: [{ key: "aabb", value: { address: "https://realm.example" } }],
    }],
    ["malformed token", {
      key_store_token_map_json: "{}",
      token_map: [{ key: "aabb", value: { token: 42 } }],
    }],
    ["malformed realm", {
      key_store_token_map_json: "{}",
      token_map: [{ key: "not-hex", value: { address: "https://realm.example", token: "secret" } }],
    }],
  ])("rejects %s instead of accepting unusable recovery material", async (_name, juiceboxConfig) => {
    const record = keyRecord({ version: "11", publicKey: "registered-public", realm: "aabb", token: "secret" });
    record.juicebox_config = juiceboxConfig;
    const api = apiFor({ data: [record] });

    await expect(api.getXChatRecoveryMaterial("2244994945")).rejects.toThrow(
      "X public-key response is invalid",
    );
  });

  test("unlocks from the newest config and adopts the registered version matching the recovered key", async () => {
    const api = apiFor({
      data: [
        keyRecord({ version: "8", publicKey: "recovered-public", realm: "aabb", token: "older-token" }),
        keyRecord({ version: "9", publicKey: "newest-public", realm: "ccdd", token: "fresh-token" }),
      ],
    });
    const observed: {
      config?: string;
      realmToken?: string;
      identity?: { userId: string; version: string };
      checkedKeys: string[];
      pin?: string;
    } = { checkedKeys: [] };

    const engine = await XChatEngine.create({
      juiceboxPin: "private-pin",
      botUserId: "2244994945",
      api,
      vault: new MemoryVault(),
      chatFactory: async (options) => {
        if (!options.juiceboxConfig) throw new Error("runtime must pass the fresh Juicebox config");
        observed.config = options.juiceboxConfig;
        observed.realmToken = await options.getAuthToken("CCDD");
        return {
          unlock: async (pin) => { observed.pin = String(pin); },
          matchesRegisteredKey: (publicKey) => {
            observed.checkedKeys.push(publicKey);
            return publicKey === "recovered-public";
          },
          setIdentity: (userId, version) => { observed.identity = { userId, version }; },
          setRejectUnverified: () => undefined,
          setCacheKeys: () => undefined,
          setSigningKeys: () => undefined,
          verifyKeyBinding: () => true,
          decryptEvents: () => { throw new Error("not used"); },
          decryptEvent: () => { throw new Error("not used"); },
          encryptMessage: () => { throw new Error("not used"); },
          lock: () => undefined,
          free: () => undefined,
        };
      },
    });

    expect(JSON.parse(observed.config ?? "null")).toMatchObject({
      token_map: [{ key: "ccdd", value: { token: "fresh-token" } }],
    });
    expect(observed.realmToken).toBe("fresh-token");
    expect(observed.pin).toBe("private-pin");
    expect(observed.checkedKeys).toEqual(["recovered-public"]);
    expect(observed.identity).toEqual({ userId: "2244994945", version: "8" });
    engine.lock();
  });
});
