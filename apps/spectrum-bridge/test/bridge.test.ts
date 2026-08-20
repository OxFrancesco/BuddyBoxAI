import { describe, expect, test } from "bun:test";

import { createBridge, type ControlPlane, type OutboundTransport } from "../src/bridge";
import type { NormalizedInbound, OutboundMessage } from "../src/types";

const inbound: NormalizedInbound = {
  source: "imessage",
  idempotencyKey: "spectrum:imessage:spc-msg-1",
  providerMessageId: "spc-msg-1",
  providerWebhookId: "webhook-1",
  addressHash: `addr_${"a".repeat(64)}`,
  spaceId: "opaque-space",
  sentAt: "2026-05-14T19:06:32.000Z",
  text: "Build the landing page",
  attachments: [],
};

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    outboundId: "delivery-out-1",
    idempotencyKey: "outbound:delivery-out-1",
    spaceId: "opaque-space",
    text: "Connect your iChef account at https://example.test/connect/token",
    ...overrides,
  };
}

function fakeControlPlane(overrides: Partial<ControlPlane> = {}): ControlPlane {
  return {
    acceptInbound: async () => ({ status: "accepted", deliveryId: "delivery-in-1" }),
    completeChallenge: async () => ({ status: "invalid" }),
    claimOutbound: async () => ({ status: "claimed", leaseToken: "lease-token-1" }),
    settleOutbound: async () => undefined,
    ...overrides,
  };
}

describe("iMessage bridge seam", () => {
  test("turns an exact prefixed return challenge into a Clerk-bound verification call", async () => {
    let challenge = "";
    const bridge = createBridge({
      controlPlane: fakeControlPlane({
        completeChallenge: async (attempt) => {
          challenge = attempt.challengeCode;
          return { status: "verified", connectionId: "imessage-1", outbound: outbound() };
        },
      }),
      transport: { sendText: async () => ({ providerMessageId: "sent-1" }) },
      sleep: async () => undefined,
    });

    await bridge.acceptInbound({ ...inbound, text: "ICHEF-KM7Q2P" });
    expect(challenge).toBe("KM7Q2P");
  });

  test("retries outbound delivery and records one truthful terminal outcome", async () => {
    let attempts = 0;
    const settlements: unknown[] = [];
    const transport: OutboundTransport = {
      sendText: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary provider failure");
        return { providerMessageId: "sent-3" };
      },
    };
    const bridge = createBridge({
      controlPlane: fakeControlPlane({ settleOutbound: async (result) => void settlements.push(result) }),
      transport,
      sleep: async () => undefined,
      random: () => 0,
    });

    const result = await bridge.deliverOutbound(outbound());
    expect(result).toEqual({ status: "delivered", attempts: 3, providerMessageId: "sent-3" });
    expect(settlements).toEqual([
      {
        outboundId: "delivery-out-1",
        leaseToken: "lease-token-1",
        status: "delivered",
        attempts: 3,
        providerMessageId: "sent-3",
      },
    ]);
  });

  test("does not redeliver an outbound message already claimed by another worker", async () => {
    let sends = 0;
    const bridge = createBridge({
      controlPlane: fakeControlPlane({ claimOutbound: async () => ({ status: "already_delivered" }) }),
      transport: { sendText: async () => (sends += 1, { providerMessageId: "unexpected" }) },
      sleep: async () => undefined,
    });

    expect(await bridge.deliverOutbound(outbound())).toEqual({ status: "duplicate" });
    expect(sends).toBe(0);
  });

  test("does not send an outbound message whose expired lease requires reconciliation", async () => {
    let sends = 0;
    const bridge = createBridge({
      controlPlane: fakeControlPlane({
        claimOutbound: async () => ({ status: "reconciliation_required" }),
      }),
      transport: { sendText: async () => (sends += 1, { providerMessageId: "unexpected" }) },
      sleep: async () => undefined,
    });

    expect(await bridge.deliverOutbound(outbound())).toEqual({
      status: "reconciliation_required",
    });
    expect(sends).toBe(0);
  });

  test("does not send the provider message twice when only settlement is unavailable", async () => {
    let sends = 0;
    const bridge = createBridge({
      controlPlane: fakeControlPlane({
        settleOutbound: async () => {
          throw new Error("control plane unavailable");
        },
      }),
      transport: {
        sendText: async () => {
          sends += 1;
          return { providerMessageId: "sent-once" };
        },
      },
      sleep: async () => undefined,
    });

    expect(await bridge.deliverOutbound(outbound())).toEqual({
      status: "settlement_pending",
      attempts: 1,
      providerMessageId: "sent-once",
    });
    expect(sends).toBe(1);
  });

  test("settles only with the lease returned by the successful claim", async () => {
    const settlements: unknown[] = [];
    const bridge = createBridge({
      controlPlane: fakeControlPlane({
        claimOutbound: async () => ({
          status: "claimed",
          leaseToken: "fresh-high-entropy-lease-token",
        }),
        settleOutbound: async (settlement) => void settlements.push(settlement),
      }),
      transport: { sendText: async () => ({ providerMessageId: "sent-with-lease" }) },
      sleep: async () => undefined,
    });

    await bridge.deliverOutbound(outbound());
    expect(settlements).toEqual([{
      outboundId: "delivery-out-1",
      leaseToken: "fresh-high-entropy-lease-token",
      status: "delivered",
      attempts: 1,
      providerMessageId: "sent-with-lease",
    }]);
  });
});
