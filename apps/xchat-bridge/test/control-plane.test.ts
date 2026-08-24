import { describe, expect, test } from "bun:test";

import { ConvexXChatControlPlane } from "../src/control-plane";

describe("Convex broker adapter", () => {
  test("uses the authenticated first-class X Chat operation envelope", async () => {
    let observed: unknown;
    const client = new ConvexXChatControlPlane({
      url: "https://example.convex.site/v1/xchat/broker",
      secret: "bridge_secret_long_enough",
      fetcher: (async (_input, init) => {
        observed = {
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        };
        return Response.json({ ok: true, result: [] });
      }) as typeof fetch,
    });
    expect(await client.leaseOutbound({ leaseIdHash: "abc", now: 1, leaseExpiresAt: 2, limit: 10 })).toEqual([]);
    expect(observed).toEqual({
      authorization: "Bearer bridge_secret_long_enough",
      body: { operation: "lease_outbound", input: { leaseIdHash: "abc", now: 1, leaseExpiresAt: 2, limit: 10 } },
    });
  });

  test("submits only the bridge-owned claim hash and expiry", async () => {
    let observedBody: unknown;
    const client = new ConvexXChatControlPlane({
      url: "https://example.convex.site/v1/xchat/broker",
      secret: "bridge_secret_long_enough",
      fetcher: (async (_input, init) => {
        observedBody = JSON.parse(String(init?.body));
        return Response.json({ ok: true, result: { status: "unbound", deliveryId: "delivery-1" } });
      }) as typeof fetch,
    });
    expect(await client.admitInbound({
      senderIdHash: "sender-hash",
      providerConversationIdHash: "conversation-hash",
      eventUuid: "event-hash",
      providerMessageId: "message-id-hash",
      messageHash: "message-hash",
      encryptedPayload: {
        algorithm: "AES-256-GCM",
        keyVersion: 1,
        iv: "base64-iv-value",
        ciphertext: "encrypted-message",
      },
      claimTokenHash: "bridge-owned-token-hash",
      claimExpiresAt: 1_900_000_000_000,
      occurredAt: 1_800_000_000_000,
    })).toEqual({ status: "unbound", deliveryId: "delivery-1" });
    expect(observedBody).toEqual({
      operation: "admit_inbound",
      input: expect.objectContaining({
        claimTokenHash: "bridge-owned-token-hash",
        claimExpiresAt: 1_900_000_000_000,
      }),
    });
    expect(JSON.stringify(observedBody)).not.toContain("claim=bridge-owned");
  });
});
