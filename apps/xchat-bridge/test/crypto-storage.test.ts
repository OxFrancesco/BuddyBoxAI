import { describe, expect, test } from "bun:test";

import { EncryptedStateStore, MemoryBlobStore, PayloadProtector } from "../src/crypto-storage";

const key = Buffer.alloc(32, 7).toString("base64");

describe("encrypted bridge storage", () => {
  test("persists state as authenticated ciphertext and binds its purpose", async () => {
    const blobs = new MemoryBlobStore();
    const store = new EncryptedStateStore(blobs, key);
    await store.set("conversation:abc", { versions: { "1": "c2VjcmV0" } });
    const raw = await blobs.get("conversation:abc");
    expect(raw).not.toContain("c2VjcmV0");
    expect(await store.get("conversation:abc")).toEqual({ versions: { "1": "c2VjcmV0" } });
    await expect(store.get("conversation:def")).resolves.toBeUndefined();
  });

  test("round trips an outbound provider payload without exposing plaintext", async () => {
    const protector = new PayloadProtector(key);
    const envelope = await protector.seal("outbound:delivery-1", { messageId: "x-message-1", body: "ciphertext" });
    expect(envelope.algorithm).toBe("AES-256-GCM");
    expect(JSON.stringify(envelope)).not.toContain("x-message-1");
    expect(await protector.open("outbound:delivery-1", envelope)).toEqual({
      messageId: "x-message-1",
      body: "ciphertext",
    });
    await expect(protector.open("outbound:delivery-2", envelope)).rejects.toThrow();
  });
});
