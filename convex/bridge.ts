import { ConvexError, v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { DELIVERY_RETENTION_MS, requireBoundedString } from "./lib/bounds";
import { writeAudit } from "./lib/audit";

const CLAIM_TTL_MS = 15 * 60 * 1_000;

const admissionResult = v.union(
  v.object({ status: v.literal("duplicate"), deliveryId: v.id("channelDeliveries") }),
  v.object({
    status: v.literal("accepted"),
    deliveryId: v.id("channelDeliveries"),
    ownerId: v.id("users"),
    activeProjectId: v.optional(v.id("projects")),
  }),
  v.object({ status: v.literal("unbound"), deliveryId: v.id("channelDeliveries") }),
);

export const admitInbound = internalMutation({
  args: {
    providerMessageId: v.string(),
    messageHash: v.string(),
    addressHash: v.string(),
    sentAt: v.number(),
    payloadCiphertext: v.string(),
    claimTokenHash: v.string(),
    claimExpiresAt: v.number(),
    outboundId: v.string(),
    outboundIdempotencyKey: v.string(),
    outboundPayloadCiphertext: v.string(),
  },
  returns: admissionResult,
  handler: async (ctx, args) => {
    const providerMessageId = requireBoundedString(args.providerMessageId, "providerMessageId", 300);
    const existing = await ctx.db.query("channelDeliveries")
      .withIndex("by_provider_and_provider_message_id", (q) =>
        q.eq("provider", "spectrum").eq("providerMessageId", providerMessageId),
      ).unique();
    if (existing) return { status: "duplicate" as const, deliveryId: existing._id };

    const now = Date.now();
    const connection = await ctx.db.query("imessageConnections")
      .withIndex("by_address_hash", (q) => q.eq("addressHash", args.addressHash))
      .unique();

    if (connection?.status === "verified") {
      const deliveryId = await ctx.db.insert("channelDeliveries", {
        ownerId: connection.ownerId,
        imessageConnectionId: connection._id,
        provider: "spectrum",
        direction: "inbound",
        providerMessageId,
        commandKey: `spectrum:imessage:${providerMessageId}`,
        messageHash: args.messageHash,
        status: "accepted",
        occurredAt: args.sentAt,
        updatedAt: now,
        expiresAt: now + DELIVERY_RETENTION_MS,
      });
      await ctx.db.insert("channelMessages", {
        deliveryId,
        ownerId: connection.ownerId,
        payloadCiphertext: requireBoundedString(args.payloadCiphertext, "payloadCiphertext", 128_000),
        createdAt: now,
        expiresAt: now + DELIVERY_RETENTION_MS,
      });
      return {
        status: "accepted" as const,
        deliveryId,
        ownerId: connection.ownerId,
        activeProjectId: connection.activeProjectId,
      };
    }

    if (args.claimExpiresAt <= now || args.claimExpiresAt > now + CLAIM_TTL_MS) {
      throw new ConvexError({ code: "INVALID_EXPIRY", message: "Claim expiry is invalid" });
    }
    const pending = await ctx.db.query("imessageClaims")
      .withIndex("by_address_hash_and_status", (q) =>
        q.eq("addressHash", args.addressHash).eq("status", "pending"),
      ).collect();
    for (const stale of pending) await ctx.db.patch(stale._id, { status: "expired", updatedAt: now });

    await ctx.db.insert("imessageClaims", {
      addressHash: args.addressHash,
      tokenHash: args.claimTokenHash,
      status: "pending",
      expiresAt: args.claimExpiresAt,
      createdAt: now,
      updatedAt: now,
    });
    const deliveryId = await ctx.db.insert("channelDeliveries", {
      provider: "spectrum",
      direction: "inbound",
      providerMessageId,
      messageHash: args.messageHash,
      status: "received",
      occurredAt: args.sentAt,
      updatedAt: now,
      expiresAt: now + DELIVERY_RETENTION_MS,
    });
    await ctx.db.insert("outboundDeliveries", {
      outboundId: args.outboundId,
      idempotencyKey: args.outboundIdempotencyKey,
      payloadCiphertext: requireBoundedString(args.outboundPayloadCiphertext, "outboundPayloadCiphertext", 32_000),
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + DELIVERY_RETENTION_MS,
    });
    return { status: "unbound" as const, deliveryId };
  },
});

export const attachClaim = internalMutation({
  args: {
    tokenHash: v.string(),
    tokenIdentifier: v.string(),
    challengeHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.object({
    connectionId: v.id("imessageConnections"),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const user = await ctx.db.query("users")
      .withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", args.tokenIdentifier))
      .unique();
    if (!user || user.status !== "active") {
      throw new ConvexError({ code: "USER_NOT_READY", message: "Authenticated User is not ready" });
    }
    const claim = await ctx.db.query("imessageClaims")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!claim || claim.status !== "pending") {
      throw new ConvexError({ code: "CLAIM_NOT_FOUND", message: "Claim is invalid or already used" });
    }
    if (claim.expiresAt <= now || args.expiresAt <= now || args.expiresAt > now + CLAIM_TTL_MS) {
      await ctx.db.patch(claim._id, { status: "expired", updatedAt: now });
      throw new ConvexError({ code: "CLAIM_EXPIRED", message: "Claim has expired" });
    }
    const claimedConnection = await ctx.db.query("imessageConnections")
      .withIndex("by_address_hash", (q) => q.eq("addressHash", claim.addressHash))
      .unique();
    if (claimedConnection && claimedConnection.ownerId !== user._id && claimedConnection.status !== "revoked") {
      throw new ConvexError({ code: "ADDRESS_ALREADY_CLAIMED", message: "Address is already claimed" });
    }
    let connectionId;
    if (claimedConnection) {
      connectionId = claimedConnection._id;
      await ctx.db.patch(connectionId, {
        ownerId: user._id,
        status: "challenge_sent",
        challengeHash: args.challengeHash,
        challengeExpiresAt: args.expiresAt,
        verifiedAt: undefined,
        revokedAt: undefined,
        updatedAt: now,
      });
    } else {
      connectionId = await ctx.db.insert("imessageConnections", {
        ownerId: user._id,
        addressHash: claim.addressHash,
        maskedAddress: `iMessage •${claim.addressHash.slice(-6)}`,
        status: "challenge_sent",
        challengeHash: args.challengeHash,
        challengeExpiresAt: args.expiresAt,
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(claim._id, {
      ownerId: user._id,
      connectionId,
      status: "attached",
      challengeHash: args.challengeHash,
      expiresAt: args.expiresAt,
      updatedAt: now,
    });
    return { connectionId, expiresAt: args.expiresAt };
  },
});

export const consumeChallenge = internalMutation({
  args: {
    addressHash: v.string(),
    challengeHash: v.string(),
    providerMessageId: v.string(),
    messageHash: v.string(),
    sentAt: v.number(),
    outboundId: v.string(),
    outboundIdempotencyKey: v.string(),
    outboundPayloadCiphertext: v.string(),
  },
  returns: v.object({
    status: v.union(
      v.literal("verified"),
      v.literal("already_verified"),
      v.literal("invalid"),
      v.literal("expired"),
      v.literal("duplicate"),
    ),
    connectionId: v.optional(v.id("imessageConnections")),
  }),
  handler: async (ctx, args) => {
    const duplicate = await ctx.db.query("channelDeliveries")
      .withIndex("by_provider_and_provider_message_id", (q) =>
        q.eq("provider", "spectrum").eq("providerMessageId", args.providerMessageId),
      ).unique();
    if (duplicate) return { status: "duplicate" as const, connectionId: duplicate.imessageConnectionId };

    const connection = await ctx.db.query("imessageConnections")
      .withIndex("by_address_hash", (q) => q.eq("addressHash", args.addressHash))
      .unique();
    if (!connection) return { status: "invalid" as const };
    if (connection.status === "verified") {
      return { status: "already_verified" as const, connectionId: connection._id };
    }
    const now = Date.now();
    const expired = !connection.challengeExpiresAt || connection.challengeExpiresAt <= now;
    const valid = connection.status === "challenge_sent" && connection.challengeHash === args.challengeHash;
    if (expired || !valid) return { status: expired ? "expired" as const : "invalid" as const };

    const claims = await ctx.db.query("imessageClaims")
      .withIndex("by_address_hash_and_status", (q) =>
        q.eq("addressHash", args.addressHash).eq("status", "attached"),
      ).collect();
    const claim = claims.find((candidate) =>
      candidate.connectionId === connection._id && candidate.challengeHash === args.challengeHash,
    );
    if (!claim || claim.expiresAt <= now) return { status: "expired" as const };

    await ctx.db.patch(connection._id, {
      status: "verified",
      challengeHash: undefined,
      challengeExpiresAt: undefined,
      verifiedAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(claim._id, { status: "verified", challengeHash: undefined, updatedAt: now });
    await ctx.db.insert("channelDeliveries", {
      ownerId: connection.ownerId,
      imessageConnectionId: connection._id,
      provider: "spectrum",
      direction: "inbound",
      providerMessageId: args.providerMessageId,
      messageHash: args.messageHash,
      status: "accepted",
      occurredAt: args.sentAt,
      updatedAt: now,
      expiresAt: now + DELIVERY_RETENTION_MS,
    });
    await ctx.db.insert("outboundDeliveries", {
      outboundId: args.outboundId,
      idempotencyKey: args.outboundIdempotencyKey,
      ownerId: connection.ownerId,
      payloadCiphertext: args.outboundPayloadCiphertext,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + DELIVERY_RETENTION_MS,
    });
    await writeAudit(ctx, {
      ownerId: connection.ownerId,
      actor: "imessage",
      action: "imessage_connection.verified",
      targetType: "imessage_connection",
      targetId: connection._id,
      outcome: "succeeded",
      now,
    });
    return { status: "verified" as const, connectionId: connection._id };
  },
});

export const claimOutbound = internalMutation({
  args: { outboundId: v.string(), idempotencyKey: v.string() },
  returns: v.object({ status: v.union(v.literal("claimed"), v.literal("already_delivered"), v.literal("in_flight")) }),
  handler: async (ctx, args) => {
    const outbound = await ctx.db.query("outboundDeliveries")
      .withIndex("by_outbound_id", (q) => q.eq("outboundId", args.outboundId)).unique();
    if (!outbound || outbound.idempotencyKey !== args.idempotencyKey) {
      throw new ConvexError({ code: "OUTBOUND_NOT_FOUND", message: "Outbound delivery not found" });
    }
    if (outbound.status === "delivered") return { status: "already_delivered" as const };
    if (outbound.status === "in_flight") return { status: "in_flight" as const };
    await ctx.db.patch(outbound._id, { status: "in_flight", updatedAt: Date.now() });
    return { status: "claimed" as const };
  },
});

export const settleOutbound = internalMutation({
  args: {
    outboundId: v.string(),
    status: v.union(v.literal("delivered"), v.literal("failed_retryable")),
    attempts: v.number(),
    providerMessageId: v.optional(v.string()),
    errorCode: v.optional(v.literal("spectrum_unavailable")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const outbound = await ctx.db.query("outboundDeliveries")
      .withIndex("by_outbound_id", (q) => q.eq("outboundId", args.outboundId)).unique();
    if (!outbound) throw new ConvexError({ code: "OUTBOUND_NOT_FOUND", message: "Outbound delivery not found" });
    if (outbound.status === "delivered") return null;
    if (args.status === "delivered" && !args.providerMessageId) {
      throw new ConvexError({ code: "INVALID_SETTLEMENT", message: "Delivered settlement needs providerMessageId" });
    }
    await ctx.db.patch(outbound._id, {
      status: args.status,
      attempts: Math.max(outbound.attempts, args.attempts),
      providerMessageId: args.providerMessageId,
      lastErrorCode: args.errorCode,
      updatedAt: Date.now(),
    });
    return null;
  },
});
