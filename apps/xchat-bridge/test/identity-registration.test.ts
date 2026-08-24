import { describe, expect, test } from "bun:test";

import { registerXChatIdentity, verifyXChatIdentity } from "../src/identity-registration";
import { MemoryVault } from "../src/vault";

const userId = "2244994945";
const registration = {
  publicKey: {
    identityPublicKeySignature: "identity-signature",
    publicKey: "identity-public-key",
    publicKeyFingerprint: "fingerprint",
    registrationMethod: "CustomPin",
    signingPublicKey: "signing-public-key",
    signingPublicKeySignature: "signing-signature",
  },
  version: "1",
  generateVersion: true,
};
const juiceboxConfig = {
  key_store_token_map_json: "{}",
  token_map: [{ key: "AABB", value: { token: "fresh-realm-token" } }],
};

describe("durable X Chat identity registration", () => {
  test("registers once, loads fresh realm tokens, stores the key, then writes an encrypted-vault marker", async () => {
    const vault = new MemoryVault();
    const requests: Array<{ method: string; body?: unknown }> = [];
    let publicKeys: unknown[] = [];
    const observed: Record<string, unknown> = {};

    const result = await registerXChatIdentity({
      userId,
      pin: "2580",
      accessToken: "user-token-secret",
      vault,
      retryDelay: async () => undefined,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get("authorization")).toBe("Bearer user-token-secret");
        requests.push({
          method: request.method,
          ...(request.body ? { body: JSON.parse(await request.text()) } : {}),
        });
        if (request.method === "POST") {
          publicKeys = [{
            public_key_version: "7",
            public_key: "identity-public-key",
            juicebox_config: juiceboxConfig,
          }];
          return Response.json({ data: { public_key_version: "7" } });
        }
        return Response.json({ data: publicKeys });
      },
      chatFactory: async (options) => ({
        generateKeypairs: () => registration,
        unlock: async () => undefined,
        matchesRegisteredKey: () => true,
        updateConfig: (config) => { observed.config = JSON.parse(config); },
        setup: async (pin) => {
          observed.pin = pin;
          observed.realmToken = await options.getAuthToken("aabb");
          return { identity: "identity-public-key", signing: "signing-public-key", version: "" };
        },
        setIdentity: (id, version) => { observed.identity = { id, version }; },
        lock: () => { observed.locked = true; },
        free: () => { observed.freed = true; },
      }),
    });

    expect(result).toEqual({ publicKeyVersion: "7", status: "created" });
    expect(requests).toEqual([
      { method: "GET" },
      {
        method: "POST",
        body: {
          public_key: {
            identity_public_key_signature: "identity-signature",
            public_key: "identity-public-key",
            public_key_fingerprint: "fingerprint",
            registration_method: "CustomPin",
            signing_public_key: "signing-public-key",
            signing_public_key_signature: "signing-signature",
          },
          version: "1",
          generate_version: true,
        },
      },
      { method: "GET" },
    ]);
    expect(observed).toMatchObject({
      config: juiceboxConfig,
      pin: "2580",
      realmToken: "fresh-realm-token",
      identity: { id: userId, version: "7" },
      locked: true,
      freed: true,
    });
    expect(await vault.get("xchat_identity", userId)).toMatchObject({
      state: "ready",
      userId,
      publicKeyVersion: "7",
      publicKey: "identity-public-key",
    });
  });

  test("proves a matching durable marker is recoverable without minting or posting another key", async () => {
    const vault = new MemoryVault();
    await vault.put("xchat_identity", userId, {
      format: 1,
      state: "ready",
      userId,
      publicKeyVersion: "7",
      publicKey: "identity-public-key",
      registeredAt: "2026-08-24T12:00:00.000Z",
    });
    let factoryCalls = 0;
    const result = await registerXChatIdentity({
      userId,
      pin: "2580",
      accessToken: "user-token-secret",
      vault,
      fetcher: async () => Response.json({ data: [{
        public_key_version: "7",
        public_key: "identity-public-key",
        juicebox_config: juiceboxConfig,
      }] }),
      chatFactory: async (options) => {
        factoryCalls += 1;
        expect(await options.getAuthToken("aabb")).toBe("fresh-realm-token");
        return {
          generateKeypairs: () => { throw new Error("must not mint"); },
          unlock: async (pin) => { expect(pin).toBe("2580"); },
          matchesRegisteredKey: (key) => key === "identity-public-key",
          updateConfig: () => undefined,
          setup: async () => { throw new Error("must not set up"); },
          setIdentity: () => undefined,
          lock: () => undefined,
          free: () => undefined,
        };
      },
    });

    expect(result).toEqual({ publicKeyVersion: "7", status: "ready" });
    expect(factoryCalls).toBe(1);
  });

  test("refuses to mint when a prior first boot left an unresolved pending identity", async () => {
    const vault = new MemoryVault();
    await vault.put("xchat_identity", userId, {
      format: 1,
      state: "pending",
      userId,
      publicKey: "uncertain-public-key",
      createdAt: "2026-08-24T12:00:00.000Z",
    });
    let factoryCalls = 0;
    await expect(registerXChatIdentity({
      userId,
      pin: "2580",
      accessToken: "user-token-secret",
      vault,
      fetcher: async () => Response.json({ data: [] }),
      chatFactory: async () => {
        factoryCalls += 1;
        throw new Error("must not mint");
      },
    })).rejects.toThrow("pending operator recovery");
    expect(factoryCalls).toBe(0);
  });

  test("adopts a pre-existing account identity only after proving PIN recovery and key match", async () => {
    const vault = new MemoryVault();
    let generated = false;
    const result = await registerXChatIdentity({
      userId,
      pin: "2580",
      accessToken: "user-token-secret",
      vault,
      fetcher: async () => Response.json({ data: [{
        public_key_version: "12",
        public_key: "recoverable-public-key",
        juicebox_config: juiceboxConfig,
      }] }),
      chatFactory: async () => ({
        generateKeypairs: () => {
          generated = true;
          return registration;
        },
        unlock: async () => undefined,
        matchesRegisteredKey: (key) => key === "recoverable-public-key",
        updateConfig: () => undefined,
        setup: async () => { throw new Error("must not set up"); },
        setIdentity: () => undefined,
        lock: () => undefined,
        free: () => undefined,
      }),
    });

    expect(result).toEqual({ publicKeyVersion: "12", status: "ready" });
    expect(generated).toBe(false);
    expect(await vault.get("xchat_identity", userId)).toMatchObject({
      state: "ready",
      publicKeyVersion: "12",
      publicKey: "recoverable-public-key",
    });
  });

  test("reconciles the same in-memory identity after an ambiguous public-key POST failure", async () => {
    const vault = new MemoryVault();
    let visible = false;
    const result = await registerXChatIdentity({
      userId,
      pin: "2580",
      accessToken: "user-token-secret",
      vault,
      retryDelay: async () => undefined,
      fetcher: async (_input, init) => {
        if ((init?.method ?? "GET") === "POST") {
          visible = true;
          return new Response("upstream timeout", { status: 504 });
        }
        return Response.json({ data: visible ? [{
          public_key_version: "7",
          public_key: "identity-public-key",
          juicebox_config: juiceboxConfig,
        }] : [] });
      },
      chatFactory: async () => ({
        generateKeypairs: () => registration,
        unlock: async () => undefined,
        matchesRegisteredKey: (key) => key === "identity-public-key",
        updateConfig: () => undefined,
        setup: async () => ({ identity: "identity-public-key", signing: "signing-public-key", version: "" }),
        setIdentity: () => undefined,
        lock: () => undefined,
        free: () => undefined,
      }),
    });

    expect(result).toEqual({ publicKeyVersion: "7", status: "created" });
    expect(await vault.get("xchat_identity", userId)).toMatchObject({ state: "ready" });
  });

  test("clears the pending marker after a definite rate-limit rejection so a later window can retry", async () => {
    const vault = new MemoryVault();
    await expect(registerXChatIdentity({
      userId,
      pin: "2580",
      accessToken: "user-token-secret",
      vault,
      fetcher: async (_input, init) => (init?.method ?? "GET") === "POST"
        ? new Response("rate limited", { status: 429 })
        : Response.json({ data: [] }),
      chatFactory: async () => ({
        generateKeypairs: () => registration,
        unlock: async () => undefined,
        matchesRegisteredKey: () => false,
        updateConfig: () => undefined,
        setup: async () => { throw new Error("must not set up"); },
        setIdentity: () => undefined,
        lock: () => undefined,
        free: () => undefined,
      }),
    })).rejects.toThrow("X Chat identity request failed");
    expect(await vault.get("xchat_identity", userId)).toBeUndefined();
  });

  test("non-mutating verification proves PIN recovery for status and all", async () => {
    const vault = new MemoryVault();
    const verified = await verifyXChatIdentity({
      userId,
      pin: "2580",
      accessToken: "user-token-secret",
      vault,
      fetcher: async () => Response.json({ data: [{
        public_key_version: "14",
        public_key: "recoverable-public-key",
        juicebox_config: juiceboxConfig,
      }] }),
      chatFactory: async () => ({
        generateKeypairs: () => { throw new Error("must not mint"); },
        unlock: async () => undefined,
        matchesRegisteredKey: (key) => key === "recoverable-public-key",
        updateConfig: () => undefined,
        setup: async () => { throw new Error("must not set up"); },
        setIdentity: () => undefined,
        lock: () => undefined,
        free: () => undefined,
      }),
    });

    expect(verified).toEqual({ publicKeyVersion: "14" });
    expect(await vault.get("xchat_identity", userId)).toBeUndefined();
  });

  test.each(["1", "1111", "1234", "4321"])("rejects weak PIN %s before creating keys or calling X", async (pin) => {
    let calls = 0;
    await expect(registerXChatIdentity({
      userId,
      pin,
      accessToken: "user-token-secret",
      vault: new MemoryVault(),
      fetcher: async () => {
        calls += 1;
        return Response.json({});
      },
      chatFactory: async () => {
        calls += 1;
        throw new Error("must not create chat");
      },
    })).rejects.toThrow("X_CHAT_PIN");
    expect(calls).toBe(0);
  });
});
