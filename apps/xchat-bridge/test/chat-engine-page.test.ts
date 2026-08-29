import { describe, expect, test } from "bun:test";

import { XChatEngine } from "../src/chat-engine";
import type { XApiClient } from "../src/x-api";
import { MemoryVault } from "../src/vault";

describe("X Chat event-page decryption", () => {
  test("applies verified key history before admitting a signed text event", async () => {
    let encryptedWith: Uint8Array | undefined;
    const api = {
      getXChatRecoveryMaterial: async () => ({
        configKeyVersion: "7",
        juiceboxConfig: "{}",
        realmTokens: { aabb: "realm-token" },
        registeredKeys: [{ publicKeyVersion: "7", identityPublicKey: "bot-identity" }],
      }),
      getSigningKeys: async (userId: string) => [{
        userId,
        publicKeyVersion: "7",
        publicKey: `signing-${userId}`,
        identityPublicKey: `identity-${userId}`,
        identityPublicKeySignature: `binding-${userId}`,
      }],
      sendPrepared: async () => "sent",
    } as unknown as XApiClient;
    const engine = await XChatEngine.create({
      juiceboxPin: "private-pin",
      botUserId: "456",
      api,
      vault: new MemoryVault(),
      chatFactory: async () => ({
        unlock: async () => undefined,
        matchesRegisteredKey: (key: string) => key === "bot-identity",
        setIdentity: () => undefined,
        setRejectUnverified: () => undefined,
        setCacheKeys: () => undefined,
        setSigningKeys: () => undefined,
        verifyKeyBinding: () => true,
        decryptEvents: () => ({
          messages: [],
          conversationKeys: { keys: { "42": Uint8Array.from([1, 2, 3]) }, latestVersion: "42" },
          errors: {},
        }),
        decryptEvent: () => ({
          type: "message",
          verified: true,
          id: "signed-message-1",
          senderId: "123",
          conversationId: "123-456",
          createdAtMsec: Date.parse("2026-08-28T12:00:00Z"),
          content: { contentType: "text", text: "Build it" },
        }),
        encryptMessage: (input: { conversationKey?: Uint8Array }) => {
          encryptedWith = input.conversationKey;
          return {
            messageId: "outbound-1",
            encryptedContent: "ciphertext",
            encodedEventSignature: "signature",
          };
        },
        lock: () => undefined,
        free: () => undefined,
      } as never),
    });

    expect(await engine.decryptPage({
      events: [{
        id: "outer-event-1",
        senderId: "123",
        conversationId: "123-456",
        createdAt: "2026-08-28T12:00:00Z",
        encodedEvent: "message-ciphertext",
      }],
      conversationKeyEvents: ["key-change-ciphertext"],
    })).toEqual([{
      eventUuid: "outer-event-1",
      providerMessageId: "signed-message-1",
      senderId: "123",
      conversationId: "123-456",
      occurredAt: Date.parse("2026-08-28T12:00:00Z"),
      text: "Build it",
    }]);

    await engine.prepareText("123-456", "Reply");
    expect(encryptedWith).toEqual(Uint8Array.from([1, 2, 3]));
  });
});
