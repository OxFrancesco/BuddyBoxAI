import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./bridge.ts": () => import("./bridge"),
  "./connections.ts": () => import("./connections"),
  "./users.ts": () => import("./users"),
};

function identity(subject: string) {
  return { subject, tokenIdentifier: `https://issuer.buddybox.test|${subject}` };
}

describe("Spectrum trust broker", () => {
  test("an unbound address reveals no message body and requires a one-use Clerk claim", async () => {
    const t = convexTest(schema, modules);
    const authenticated = t.withIdentity(identity("bridge-user"));
    const user = await authenticated.mutation(api.users.syncCurrent, { displayName: "Bridge User" });
    const now = Date.now();
    const admitted = await t.mutation(internal.bridge.admitInbound, {
      providerMessageId: "provider-inbound-1",
      messageHash: "message-hash-1",
      addressHash: "address-hash-1",
      sentAt: now,
      payloadCiphertext: "v1.inbound-secret",
      claimTokenHash: "claim-token-hash-1",
      claimExpiresAt: now + 10 * 60_000,
      outboundId: "outbound-onboarding-1",
      outboundIdempotencyKey: "onboarding:inbound-1",
      outboundPayloadCiphertext: "v1.onboarding-secret",
    });
    expect(admitted.status).toBe("unbound");
    expect(await t.run(async (ctx) => ctx.db.query("channelMessages").collect())).toHaveLength(0);

    const attached = await t.mutation(internal.bridge.attachClaim, {
      tokenHash: "claim-token-hash-1",
      tokenIdentifier: identity("bridge-user").tokenIdentifier,
      challengeHash: "challenge-hash-1",
      expiresAt: now + 8 * 60_000,
    });
    expect(attached.connectionId).toBeTruthy();
    await expect(t.mutation(internal.bridge.attachClaim, {
      tokenHash: "claim-token-hash-1",
      tokenIdentifier: identity("bridge-user").tokenIdentifier,
      challengeHash: "other",
      expiresAt: now + 8 * 60_000,
    })).rejects.toThrow("already used");

    expect((await t.mutation(internal.bridge.consumeChallenge, {
      addressHash: "address-hash-1",
      challengeHash: "wrong-hash",
      providerMessageId: "provider-challenge-wrong",
      messageHash: "wrong-message-hash",
      sentAt: now,
      outboundId: "outbound-wrong",
      outboundIdempotencyKey: "challenge:wrong",
      outboundPayloadCiphertext: "v1.wrong",
    })).status).toBe("invalid");

    const verified = await t.mutation(internal.bridge.consumeChallenge, {
      addressHash: "address-hash-1",
      challengeHash: "challenge-hash-1",
      providerMessageId: "provider-challenge-1",
      messageHash: "challenge-message-hash",
      sentAt: now,
      outboundId: "outbound-verified-1",
      outboundIdempotencyKey: "challenge:verified",
      outboundPayloadCiphertext: "v1.verified",
    });
    expect(verified).toEqual({ status: "verified", connectionId: attached.connectionId });
    const connection = await t.run(async (ctx) => ctx.db.get(attached.connectionId));
    expect(connection?.ownerId).toBe(user._id);
    expect(connection?.status).toBe("verified");
  });

  test("verified messages are encrypted at rest and outbound settlement is terminal", async () => {
    const t = convexTest(schema, modules);
    const authenticated = t.withIdentity(identity("verified-user"));
    const user = await authenticated.mutation(api.users.syncCurrent, {});
    const now = Date.now();
    await t.run(async (ctx) => ctx.db.insert("imessageConnections", {
      ownerId: user._id,
      addressHash: "verified-address",
      maskedAddress: "iMessage •123456",
      status: "verified",
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    }));
    const admitted = await t.mutation(internal.bridge.admitInbound, {
      providerMessageId: "provider-verified-1",
      messageHash: "verified-message-hash",
      addressHash: "verified-address",
      sentAt: now,
      payloadCiphertext: "v1.only-ciphertext-is-stored",
      claimTokenHash: "unused-claim",
      claimExpiresAt: now + 60_000,
      outboundId: "unused-outbound",
      outboundIdempotencyKey: "unused-key",
      outboundPayloadCiphertext: "v1.unused",
    });
    expect(admitted.status).toBe("accepted");
    const messages = await t.run(async (ctx) => ctx.db.query("channelMessages").collect());
    expect(messages.map((message) => message.payloadCiphertext)).toEqual(["v1.only-ciphertext-is-stored"]);

    const firstClaim = await t.mutation(internal.bridge.claimOutbound, {
      outboundId: "unused-outbound",
      idempotencyKey: "unused-key",
      leaseIdHash: "0".repeat(64),
      leaseExpiresAt: now + 60_000,
    }).catch(() => null);
    expect(firstClaim).toBeNull();

    await t.run(async (ctx) => ctx.db.insert("outboundDeliveries", {
      outboundId: "outbound-2",
      idempotencyKey: "outbound-key-2",
      payloadCiphertext: "v1.payload",
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    }));
    expect(await t.mutation(internal.bridge.claimOutbound, {
      outboundId: "outbound-2",
      idempotencyKey: "outbound-key-2",
      leaseIdHash: "a".repeat(64),
      leaseExpiresAt: now + 60_000,
    })).toEqual({ status: "claimed" });
    expect(await t.mutation(internal.bridge.claimOutbound, {
      outboundId: "outbound-2",
      idempotencyKey: "outbound-key-2",
      leaseIdHash: "b".repeat(64),
      leaseExpiresAt: now + 60_000,
    })).toEqual({ status: "in_flight" });
    await t.mutation(internal.bridge.settleOutbound, {
      outboundId: "outbound-2",
      leaseIdHash: "a".repeat(64),
      status: "delivered",
      attempts: 1,
      providerMessageId: "spectrum-sent-2",
    });
    expect(await t.mutation(internal.bridge.claimOutbound, {
      outboundId: "outbound-2",
      idempotencyKey: "outbound-key-2",
      leaseIdHash: "c".repeat(64),
      leaseExpiresAt: now + 60_000,
    })).toEqual({ status: "already_delivered" });
  });

  test("an expired outbound lease requires reconciliation and is never automatically reclaimed", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const outboundId = "outbound-reclaim-1";
    await t.run(async (ctx) => ctx.db.insert("outboundDeliveries", {
      outboundId,
      idempotencyKey: "outbound-reclaim-key-1",
      payloadCiphertext: "v1.payload",
      status: "in_flight",
      attempts: 0,
      leaseIdHash: "d".repeat(64),
      leaseExpiresAt: now - 1,
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
      expiresAt: now + 60_000,
    }));

    expect(await t.mutation(internal.bridge.claimOutbound, {
      outboundId,
      idempotencyKey: "outbound-reclaim-key-1",
      leaseIdHash: "e".repeat(64),
      leaseExpiresAt: now + 60_000,
    })).toEqual({ status: "reconciliation_required" });
    const ambiguous = await t.run(async (ctx) => ctx.db.query("outboundDeliveries")
      .withIndex("by_outbound_id", (q) => q.eq("outboundId", outboundId))
      .unique());
    expect(ambiguous?.status).toBe("reconciliation_required");
    expect(ambiguous?.leaseIdHash).toBe("d".repeat(64));

    await t.mutation(internal.bridge.settleOutbound, {
      outboundId,
      leaseIdHash: "d".repeat(64),
      status: "delivered",
      attempts: 1,
      providerMessageId: "stale-provider-message",
    });
    expect(await t.mutation(internal.bridge.claimOutbound, {
      outboundId,
      idempotencyKey: "outbound-reclaim-key-1",
      leaseIdHash: "f".repeat(64),
      leaseExpiresAt: now + 60_000,
    })).toEqual({ status: "already_delivered" });
  });

  test("a definitely failed settlement remains claimable with a fresh exact lease", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const outboundId = "outbound-definitely-failed-1";
    await t.run(async (ctx) => ctx.db.insert("outboundDeliveries", {
      outboundId,
      idempotencyKey: "outbound-definitely-failed-key-1",
      payloadCiphertext: "v1.payload",
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    }));

    expect(await t.mutation(internal.bridge.claimOutbound, {
      outboundId,
      idempotencyKey: "outbound-definitely-failed-key-1",
      leaseIdHash: "1".repeat(64),
      leaseExpiresAt: now + 60_000,
    })).toEqual({ status: "claimed" });
    await t.mutation(internal.bridge.settleOutbound, {
      outboundId,
      leaseIdHash: "1".repeat(64),
      status: "failed_retryable",
      attempts: 3,
      errorCode: "spectrum_unavailable",
    });

    expect(await t.mutation(internal.bridge.claimOutbound, {
      outboundId,
      idempotencyKey: "outbound-definitely-failed-key-1",
      leaseIdHash: "2".repeat(64),
      leaseExpiresAt: now + 60_000,
    })).toEqual({ status: "claimed" });
  });

  test("an operator can deliberately requeue an ambiguous outbound delivery", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const outboundId = "outbound-reconcile-requeue-1";
    await t.run(async (ctx) => ctx.db.insert("outboundDeliveries", {
      outboundId,
      idempotencyKey: "outbound-reconcile-requeue-key-1",
      payloadCiphertext: "v1.payload",
      status: "in_flight",
      attempts: 1,
      leaseIdHash: "3".repeat(64),
      leaseExpiresAt: now - 1,
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
      expiresAt: now + 60_000,
    }));
    expect(await t.mutation(internal.bridge.claimOutbound, {
      outboundId,
      idempotencyKey: "outbound-reconcile-requeue-key-1",
      leaseIdHash: "4".repeat(64),
      leaseExpiresAt: now + 60_000,
    })).toEqual({ status: "reconciliation_required" });

    expect(await t.mutation(internal.bridge.reconcileOutbound, {
      outboundId,
      disposition: "requeue",
    })).toEqual({ status: "requeued" });
    await expect(t.mutation(internal.bridge.settleOutbound, {
      outboundId,
      leaseIdHash: "3".repeat(64),
      status: "delivered",
      attempts: 1,
      providerMessageId: "late-stale-settlement",
    })).rejects.toThrow("lease");
    expect(await t.mutation(internal.bridge.claimOutbound, {
      outboundId,
      idempotencyKey: "outbound-reconcile-requeue-key-1",
      leaseIdHash: "4".repeat(64),
      leaseExpiresAt: now + 60_000,
    })).toEqual({ status: "claimed" });
  });

  test("an operator can mark verified provider acceptance delivered idempotently", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const outboundId = "outbound-reconcile-delivered-1";
    await t.run(async (ctx) => ctx.db.insert("outboundDeliveries", {
      outboundId,
      idempotencyKey: "outbound-reconcile-delivered-key-1",
      payloadCiphertext: "v1.payload",
      status: "in_flight",
      attempts: 1,
      leaseIdHash: "5".repeat(64),
      leaseExpiresAt: now - 1,
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
      expiresAt: now + 60_000,
    }));
    expect(await t.mutation(internal.bridge.claimOutbound, {
      outboundId,
      idempotencyKey: "outbound-reconcile-delivered-key-1",
      leaseIdHash: "6".repeat(64),
      leaseExpiresAt: now + 60_000,
    })).toEqual({ status: "reconciliation_required" });

    expect(await t.mutation(internal.bridge.reconcileOutbound, {
      outboundId,
      disposition: "mark_delivered",
      providerMessageId: "spectrum-confirmed-delivery-1",
    })).toEqual({ status: "delivered" });
    expect(await t.mutation(internal.bridge.reconcileOutbound, {
      outboundId,
      disposition: "mark_delivered",
      providerMessageId: "spectrum-confirmed-delivery-1",
    })).toEqual({ status: "already_delivered" });
    expect(await t.mutation(internal.bridge.claimOutbound, {
      outboundId,
      idempotencyKey: "outbound-reconcile-delivered-key-1",
      leaseIdHash: "6".repeat(64),
      leaseExpiresAt: now + 60_000,
    })).toEqual({ status: "already_delivered" });
  });

  test("rejects an outbound lease with an unbounded expiry", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => ctx.db.insert("outboundDeliveries", {
      outboundId: "outbound-unbounded-1",
      idempotencyKey: "outbound-unbounded-key-1",
      payloadCiphertext: "v1.payload",
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    }));

    await expect(t.mutation(internal.bridge.claimOutbound, {
      outboundId: "outbound-unbounded-1",
      idempotencyKey: "outbound-unbounded-key-1",
      leaseIdHash: "1".repeat(64),
      leaseExpiresAt: now + 5 * 60_000 + 10_000,
    })).rejects.toThrow("expiry");
  });
});
