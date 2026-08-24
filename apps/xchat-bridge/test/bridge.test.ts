import { describe, expect, test } from "bun:test";

import { XChatBridge } from "../src/bridge";
import { EnvelopeProtector } from "../src/crypto";
import { MemoryVault } from "../src/vault";
import type { InboundAdmission, PreparedSend, VerifiedInboundText } from "../src/types";

const KEY = Buffer.alloc(32, 3).toString("base64");

function verifiedMessage(): VerifiedInboundText {
  return {
    eventUuid: "event-secret-id",
    providerMessageId: "signed-message-secret-id",
    senderId: "123456789",
    conversationId: "123456789-987654321",
    occurredAt: 1_800_000_000_000,
    text: "Build me a site",
  };
}

class FailFirstDirectReplyWriteVault extends MemoryVault {
  #failed = false;

  override async put(namespace: string, id: string, value: unknown): Promise<void> {
    if (namespace === "direct_reply" && !this.#failed) {
      this.#failed = true;
      throw new Error("vault temporarily unavailable");
    }
    await super.put(namespace, id, value);
  }
}

class FailFirstPreparedReplyWriteVault extends MemoryVault {
  #failed = false;

  override async put(namespace: string, id: string, value: unknown): Promise<void> {
    if (
      namespace === "direct_reply" &&
      !this.#failed &&
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "prepared"
    ) {
      this.#failed = true;
      throw new Error("prepared reply persistence unavailable");
    }
    await super.put(namespace, id, value);
  }
}

describe("X Chat orchestration", () => {
  test("admits only pseudonymous routing and encrypted text", async () => {
    const protector = new EnvelopeProtector(KEY);
    let admission: InboundAdmission | undefined;
    const bridge = new XChatBridge({
      protector,
      vault: new MemoryVault(),
      addressPepper: "address_pepper_long_enough",
      engine: {
        decryptLive: async () => verifiedMessage(),
        prepareText: async () => { throw new Error("not used"); },
        send: async () => { throw new Error("not used"); },
      },
      control: {
        admitInbound: async (input) => {
          admission = input;
          return { status: "accepted", deliveryId: "d1", connectionId: "c1", ownerId: "u1", projectId: null, conversationId: "chat1" };
        },
        completeChallenge: async () => ({ connectionId: "c1", ownerId: "u1", alreadyVerified: false }),
        leaseOutbound: async () => [],
        settleOutbound: async () => undefined,
      },
    });
    expect(await bridge.acceptWebhookPayload({})).toBe("accepted");
    const serialized = JSON.stringify(admission);
    expect(serialized).not.toContain("123456789-987654321");
    expect(serialized).not.toContain("Build me a site");
    expect(serialized).not.toContain("event-secret-id");
    expect(admission?.senderIdHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("persists one SDK payload and reuses it byte-for-byte across send retries", async () => {
    const protector = new EnvelopeProtector(KEY);
    const vault = new MemoryVault();
    const aad = "xchat:outbound:idem-1";
    const encryptedPayload = await protector.seal({ conversationId: "123-456", text: "Ready" }, aad);
    const prepared: PreparedSend = {
      messageId: "sdk-message-id",
      conversationId: "123-456",
      encodedMessageCreateEvent: "ciphertext",
      encodedMessageEventSignature: "signature",
    };
    const sends: PreparedSend[] = [];
    const settlements: unknown[] = [];
    let prepareCount = 0;
    const bridge = new XChatBridge({
      protector,
      vault,
      addressPepper: "address_pepper_long_enough",
      engine: {
        decryptLive: async () => undefined,
        prepareText: async () => { prepareCount += 1; return prepared; },
        send: async (value) => {
          sends.push(structuredClone(value));
          if (sends.length === 1) throw new Error("transient");
          return value.messageId;
        },
      },
      control: {
        admitInbound: async () => ({ status: "duplicate", deliveryId: "d1", claimRequired: true }),
        completeChallenge: async () => ({ connectionId: "c1", ownerId: "u1", alreadyVerified: false }),
        leaseOutbound: async () => [{
          deliveryId: "delivery-1",
          connectionId: "connection-1",
          providerConversationIdHash: "hash",
          messageHash: "message-hash",
          encryptedPayload,
          payloadAad: aad,
          occurredAt: 1,
          attempt: 1,
          leaseExpiresAt: Date.now() + 90_000,
        }],
        settleOutbound: async (value) => { settlements.push(value); },
      },
    });
    expect(await bridge.deliverLeasedBatch()).toBe(1);
    expect(prepareCount).toBe(1);
    expect(sends).toEqual([prepared, prepared]);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ outcome: "delivered", externalMessageIdHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  test("recovers the exact claim reply after preparation fails and Convex reports a duplicate", async () => {
    const protector = new EnvelopeProtector(KEY);
    const vault = new MemoryVault();
    const prepared: PreparedSend = {
      messageId: "claim-message-id",
      conversationId: verifiedMessage().conversationId,
      encodedMessageCreateEvent: "claim-ciphertext",
      encodedMessageEventSignature: "claim-signature",
    };
    const preparedTexts: string[] = [];
    const sends: PreparedSend[] = [];
    let admissions = 0;
    let preparations = 0;
    const bridge = new XChatBridge({
      protector,
      vault,
      addressPepper: "address_pepper_long_enough",
      claimTokenFactory: () => "exact-token-value",
      engine: {
        decryptLive: async () => verifiedMessage(),
        prepareText: async (_conversationId, text) => {
          preparedTexts.push(text);
          preparations += 1;
          if (preparations === 1) throw new Error("x sdk temporarily unavailable");
          return prepared;
        },
        send: async (value) => {
          sends.push(structuredClone(value));
          return value.messageId;
        },
      },
      control: {
        admitInbound: async () => {
          admissions += 1;
          return admissions === 1
            ? { status: "unbound", deliveryId: "d-claim" }
            : { status: "duplicate", deliveryId: "d-claim", claimRequired: true };
        },
        completeChallenge: async () => ({ connectionId: "c1", ownerId: "u1", alreadyVerified: false }),
        leaseOutbound: async () => [],
        settleOutbound: async () => undefined,
      },
    });

    await expect(bridge.acceptWebhookPayload({})).rejects.toThrow("temporarily unavailable");
    expect(await bridge.acceptWebhookPayload({})).toBe("duplicate");
    expect(preparedTexts).toEqual([
      "Welcome to BuddyBox. Securely connect this X Chat account: https://buddybox.buddytools.org/connect/xchat?claim=exact-token-value",
      "Welcome to BuddyBox. Securely connect this X Chat account: https://buddybox.buddytools.org/connect/xchat?claim=exact-token-value",
    ]);
    expect(sends).toEqual([prepared]);
  });

  test("persists and reuses one bridge-owned claim token before Convex admission", async () => {
    const admissionInputs: Array<{ claimTokenHash: string; claimExpiresAt: number }> = [];
    const preparedTexts: string[] = [];
    let preparations = 0;
    let tokenCreations = 0;
    const bridge = new XChatBridge({
      protector: new EnvelopeProtector(KEY),
      vault: new FailFirstDirectReplyWriteVault(),
      addressPepper: "address_pepper_long_enough",
      portalUrl: "https://buddybox.buddytools.org",
      claimTokenFactory: () => {
        tokenCreations += 1;
        return "same-bridge-owned-token";
      },
      engine: {
        decryptLive: async () => verifiedMessage(),
        prepareText: async (conversationId, text) => {
          preparations += 1;
          preparedTexts.push(text);
          return {
            messageId: "claim-message",
            conversationId,
            encodedMessageCreateEvent: text,
            encodedMessageEventSignature: "claim-signature",
          };
        },
        send: async () => { throw new Error("must not send"); },
      },
      control: {
        admitInbound: async (input) => {
          admissionInputs.push({
            claimTokenHash: input.claimTokenHash,
            claimExpiresAt: input.claimExpiresAt,
          });
          return { status: "unbound", deliveryId: "d-vault" };
        },
        completeChallenge: async () => ({ connectionId: "c1", ownerId: "u1", alreadyVerified: false }),
        leaseOutbound: async () => [],
        settleOutbound: async () => undefined,
      },
    });

    await expect(bridge.acceptWebhookPayload({})).rejects.toThrow("vault temporarily unavailable");
    expect(admissionInputs).toHaveLength(0);
    expect(await bridge.acceptWebhookPayload({})).toBe("accepted");
    expect(admissionInputs).toHaveLength(1);
    expect(admissionInputs[0]?.claimTokenHash).toBe("e8c0924bed37962a0f743027765cf5db189b50db667372704fdfc4325dbddecb");
    expect(admissionInputs[0]?.claimExpiresAt).toBeGreaterThan(Date.now());
    expect(tokenCreations).toBe(1);
    expect(preparations).toBe(1);
    expect(preparedTexts).toEqual([
      "Welcome to BuddyBox. Securely connect this X Chat account: https://buddybox.buddytools.org/connect/xchat?claim=same-bridge-owned-token",
    ]);
  });

  test("rebuilds the exact claim reply after prepared-payload persistence fails", async () => {
    const claimText = "Welcome to BuddyBox. Securely connect this X Chat account: https://buddybox.buddytools.org/connect/xchat?claim=durable-token-value";
    const prepared: PreparedSend = {
      messageId: "rebuilt-claim-message",
      conversationId: verifiedMessage().conversationId,
      encodedMessageCreateEvent: "rebuilt-claim-ciphertext",
      encodedMessageEventSignature: "rebuilt-claim-signature",
    };
    const preparedTexts: string[] = [];
    const sends: PreparedSend[] = [];
    let admissions = 0;
    const bridge = new XChatBridge({
      protector: new EnvelopeProtector(KEY),
      vault: new FailFirstPreparedReplyWriteVault(),
      addressPepper: "address_pepper_long_enough",
      claimTokenFactory: () => "durable-token-value",
      engine: {
        decryptLive: async () => verifiedMessage(),
        prepareText: async (_conversationId, text) => {
          preparedTexts.push(text);
          return prepared;
        },
        send: async (value) => {
          sends.push(structuredClone(value));
          return value.messageId;
        },
      },
      control: {
        admitInbound: async () => {
          admissions += 1;
          return admissions === 1
            ? { status: "unbound", deliveryId: "d-prepared" }
            : { status: "duplicate", deliveryId: "d-prepared", claimRequired: true };
        },
        completeChallenge: async () => ({ connectionId: "c1", ownerId: "u1", alreadyVerified: false }),
        leaseOutbound: async () => [],
        settleOutbound: async () => undefined,
      },
    });

    await expect(bridge.acceptWebhookPayload({})).rejects.toThrow("prepared reply persistence unavailable");
    expect(await bridge.acceptWebhookPayload({})).toBe("duplicate");
    expect(preparedTexts).toEqual([claimText, claimText]);
    expect(sends).toEqual([prepared]);
  });

  test("reuses one vaulted claim payload byte-for-byte across duplicate send recovery", async () => {
    const prepared: PreparedSend = {
      messageId: "stable-claim-message",
      conversationId: verifiedMessage().conversationId,
      encodedMessageCreateEvent: "stable-claim-ciphertext",
      encodedMessageEventSignature: "stable-claim-signature",
    };
    const sends: PreparedSend[] = [];
    let admissions = 0;
    let preparations = 0;
    const bridge = new XChatBridge({
      protector: new EnvelopeProtector(KEY),
      vault: new MemoryVault(),
      addressPepper: "address_pepper_long_enough",
      claimTokenFactory: () => "stable-token-value",
      engine: {
        decryptLive: async () => verifiedMessage(),
        prepareText: async () => {
          preparations += 1;
          return prepared;
        },
        send: async (value) => {
          sends.push(structuredClone(value));
          if (sends.length <= 3) throw new Error("transient X send failure");
          return value.messageId;
        },
      },
      control: {
        admitInbound: async () => {
          admissions += 1;
          return admissions === 1
            ? { status: "unbound", deliveryId: "d-stable" }
            : { status: "duplicate", deliveryId: "d-stable", claimRequired: true };
        },
        completeChallenge: async () => ({ connectionId: "c1", ownerId: "u1", alreadyVerified: false }),
        leaseOutbound: async () => [],
        settleOutbound: async () => undefined,
      },
    });

    expect(await bridge.acceptWebhookPayload({})).toBe("accepted");
    expect(await bridge.flushDirectReplies()).toBe(1);
    expect(await bridge.flushDirectReplies()).toBe(1);
    expect(preparations).toBe(1);
    expect(sends).toEqual([prepared, prepared, prepared, prepared]);
  });

  test("does not send an onboarding claim for a duplicate of a bound delivery", async () => {
    const vault = new MemoryVault();
    let admissions = 0;
    let preparations = 0;
    const options = {
      protector: new EnvelopeProtector(KEY),
      vault,
      addressPepper: "address_pepper_long_enough",
      claimTokenFactory: () => "bound-duplicate-token",
      engine: {
        decryptLive: async () => verifiedMessage(),
        prepareText: async () => {
          preparations += 1;
          throw new Error("bound duplicate must not prepare a claim");
        },
        send: async () => { throw new Error("bound duplicate must not send a claim"); },
      },
      control: {
        admitInbound: async () => {
          admissions += 1;
          return admissions === 1
            ? {
                status: "accepted" as const,
                deliveryId: "d-bound",
                connectionId: "c-bound",
                ownerId: "u-bound",
                projectId: null,
                conversationId: "chat-bound",
              }
            : { status: "duplicate" as const, deliveryId: "d-bound", claimRequired: false };
        },
        completeChallenge: async () => ({ connectionId: "c1", ownerId: "u1", alreadyVerified: false }),
        leaseOutbound: async () => [],
        settleOutbound: async () => undefined,
      },
    };

    expect(await new XChatBridge(options).acceptWebhookPayload({})).toBe("accepted");
    expect(await new XChatBridge(options).acceptWebhookPayload({})).toBe("duplicate");
    expect(preparations).toBe(0);
    expect(await vault.listIds("direct_reply")).toEqual([]);
  });
});
