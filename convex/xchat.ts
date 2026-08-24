import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { assertOwner, requireCurrentUser } from "./lib/auth";
import {
  DELIVERY_RETENTION_MS,
  MAX_PAGE_SIZE,
  requireBoundedString,
} from "./lib/bounds";
import { writeAudit } from "./lib/audit";
import {
  encryptedPayloadValidator,
  xchatConnectionStatusValidator,
} from "./modelValidators";

const MAX_OUTBOUND_CIPHERTEXT_BYTES = 32_000;

const acceptedInboundValidator = v.object({
  deliveryId: v.id("channelDeliveries"),
  connectionId: v.id("xchatConnections"),
  ownerId: v.id("users"),
  projectId: v.union(v.null(), v.id("projects")),
  conversationId: v.id("conversations"),
  duplicate: v.boolean(),
});

const admissionResultValidator = v.union(
  v.object({
    status: v.literal("duplicate"),
    deliveryId: v.id("channelDeliveries"),
    claimRequired: v.boolean(),
  }),
  v.object({
    status: v.literal("accepted"),
    deliveryId: v.id("channelDeliveries"),
    connectionId: v.id("xchatConnections"),
    ownerId: v.id("users"),
    projectId: v.union(v.null(), v.id("projects")),
    conversationId: v.id("conversations"),
  }),
  v.object({
    status: v.literal("unbound"),
    deliveryId: v.id("channelDeliveries"),
  }),
);

const leasedOutboundValidator = v.object({
  deliveryId: v.id("channelDeliveries"),
  connectionId: v.id("xchatConnections"),
  providerConversationIdHash: v.string(),
  messageHash: v.string(),
  encryptedPayload: encryptedPayloadValidator,
  payloadAad: v.string(),
  occurredAt: v.number(),
  attempt: v.number(),
  leaseExpiresAt: v.number(),
});

function assertValidHash(value: string, field: string): string {
  return requireBoundedString(value, field, 256);
}

function assertEnvelope(envelope: {
  algorithm: "AES-256-GCM";
  keyVersion: number;
  iv: string;
  ciphertext: string;
}): void {
  if (!Number.isSafeInteger(envelope.keyVersion) || envelope.keyVersion < 1) {
    throw new ConvexError({
      code: "INVALID_ENCRYPTION_ENVELOPE",
      message: "Encryption key version must be a positive integer",
    });
  }
  if (envelope.iv.length < 12 || envelope.iv.length > 128) {
    throw new ConvexError({
      code: "INVALID_ENCRYPTION_ENVELOPE",
      message: "Encryption IV is invalid",
    });
  }
  if (
    envelope.ciphertext.length === 0 ||
    new TextEncoder().encode(envelope.ciphertext).byteLength >
      MAX_OUTBOUND_CIPHERTEXT_BYTES
  ) {
    throw new ConvexError({
      code: "INVALID_ENCRYPTION_ENVELOPE",
      message: "Encrypted outbound payload is empty or too large",
    });
  }
}

async function findInboundDuplicate(
  ctx: MutationCtx,
  eventUuid: string,
  providerMessageId: string,
): Promise<Doc<"channelDeliveries"> | null> {
  const byEvent = await ctx.db
    .query("channelDeliveries")
    .withIndex("by_provider_and_provider_event_id", (q) =>
      q.eq("provider", "xchat").eq("providerEventId", eventUuid),
    )
    .unique();
  if (byEvent) return byEvent;
  return await ctx.db
    .query("channelDeliveries")
    .withIndex("by_provider_and_provider_message_id", (q) =>
      q.eq("provider", "xchat").eq("providerMessageId", providerMessageId),
    )
    .unique();
}

function assertMatchingInbound(
  delivery: Doc<"channelDeliveries">,
  args: {
    senderIdHash: string;
    providerConversationIdHash: string;
    providerMessageId: string;
    messageHash: string;
  },
  connectionId?: Id<"xchatConnections">,
): void {
  if (
    delivery.direction !== "inbound" ||
    delivery.providerSenderIdHash !== args.senderIdHash ||
    delivery.providerMessageId !== args.providerMessageId ||
    delivery.messageHash !== args.messageHash ||
    delivery.providerConversationIdHash !== args.providerConversationIdHash ||
    (connectionId !== undefined && delivery.xchatConnectionId !== connectionId)
  ) {
    throw new ConvexError({
      code: "DELIVERY_ID_CONFLICT",
      message: "X Chat event or message identity was reused with different content",
    });
  }
}

async function acceptVerifiedInbound(
  ctx: MutationCtx,
  connection: Doc<"xchatConnections">,
  args: {
    eventUuid: string;
    providerMessageId: string;
    messageHash: string;
    encryptedPayload?: {
      algorithm: "AES-256-GCM";
      keyVersion: number;
      iv: string;
      ciphertext: string;
    };
    occurredAt: number;
  },
) {
  let conversation = await ctx.db
    .query("conversations")
    .withIndex("by_xchat_connection_id_and_updated_at", (q) =>
      q.eq("xchatConnectionId", connection._id),
    )
    .order("desc")
    .first();
  const now = Date.now();
  if (!conversation || conversation.status !== "open") {
    const conversationId = await ctx.db.insert("conversations", {
      ownerId: connection.ownerId,
      projectId: connection.activeProjectId,
      xchatConnectionId: connection._id,
      channel: "xchat",
      providerConversationIdHash: connection.providerConversationIdHash,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
    conversation = await ctx.db.get(conversationId);
    if (!conversation) throw new Error("Inserted Conversation could not be read");
  } else {
    await ctx.db.patch(conversation._id, {
      projectId: connection.activeProjectId,
      updatedAt: now,
    });
  }
  const deliveryId = await ctx.db.insert("channelDeliveries", {
    ownerId: connection.ownerId,
    xchatConnectionId: connection._id,
    conversationId: conversation._id,
    provider: "xchat",
    providerSenderIdHash: connection.senderIdHash,
    providerConversationIdHash: connection.providerConversationIdHash,
    direction: "inbound",
    providerEventId: args.eventUuid,
    providerMessageId: args.providerMessageId,
    commandKey: `xchat:${args.providerMessageId}`,
    messageHash: args.messageHash,
    encryptedPayload: args.encryptedPayload,
    payloadAad: `xchat:inbound:${args.eventUuid}`,
    status: "accepted",
    occurredAt: args.occurredAt,
    updatedAt: now,
    expiresAt: now + DELIVERY_RETENTION_MS,
  });
  return {
    deliveryId,
    connectionId: connection._id,
    ownerId: connection.ownerId,
    projectId: connection.activeProjectId ?? null,
    conversationId: conversation._id,
  };
}

export const admitInbound = internalMutation({
  args: {
    senderIdHash: v.string(),
    providerConversationIdHash: v.string(),
    eventUuid: v.string(),
    providerMessageId: v.string(),
    messageHash: v.string(),
    encryptedPayload: v.optional(encryptedPayloadValidator),
    claimTokenHash: v.string(),
    claimExpiresAt: v.number(),
    occurredAt: v.number(),
  },
  returns: admissionResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const senderIdHash = assertValidHash(args.senderIdHash, "senderIdHash");
    const providerConversationIdHash = assertValidHash(
      args.providerConversationIdHash,
      "providerConversationIdHash",
    );
    const eventUuid = assertValidHash(args.eventUuid, "eventUuid");
    const providerMessageId = assertValidHash(
      args.providerMessageId,
      "providerMessageId",
    );
    const messageHash = assertValidHash(args.messageHash, "messageHash");
    const duplicate = await findInboundDuplicate(
      ctx,
      eventUuid,
      providerMessageId,
    );
    if (duplicate) {
      assertMatchingInbound(duplicate, {
        senderIdHash,
        providerConversationIdHash,
        providerMessageId,
        messageHash,
      });
      return {
        status: "duplicate" as const,
        deliveryId: duplicate._id,
        claimRequired: duplicate.ownerId === undefined,
      };
    }
    const connection = await ctx.db
      .query("xchatConnections")
      .withIndex("by_sender_id_hash", (q) => q.eq("senderIdHash", senderIdHash))
      .unique();
    if (
      connection?.status === "verified" &&
      connection.providerConversationIdHash === providerConversationIdHash
    ) {
      const accepted = await acceptVerifiedInbound(ctx, connection, {
        eventUuid,
        providerMessageId,
        messageHash,
        encryptedPayload: args.encryptedPayload,
        occurredAt: args.occurredAt,
      });
      return { status: "accepted" as const, ...accepted };
    }
    if (
      args.claimExpiresAt <= now ||
      args.claimExpiresAt > now + 15 * 60_000
    ) {
      throw new ConvexError({
        code: "INVALID_EXPIRY",
        message: "X Chat claim expiry must be within 15 minutes",
      });
    }
    const pending = await ctx.db
      .query("xchatClaims")
      .withIndex("by_sender_id_hash_and_status", (q) =>
        q.eq("senderIdHash", senderIdHash).eq("status", "pending"),
      )
      .take(20);
    for (const stale of pending) {
      await ctx.db.patch(stale._id, { status: "expired", updatedAt: now });
    }
    await ctx.db.insert("xchatClaims", {
      senderIdHash,
      providerConversationIdHash,
      tokenHash: assertValidHash(args.claimTokenHash, "claimTokenHash"),
      status: "pending",
      expiresAt: args.claimExpiresAt,
      createdAt: now,
      updatedAt: now,
    });
    const deliveryId = await ctx.db.insert("channelDeliveries", {
      provider: "xchat",
      providerSenderIdHash: senderIdHash,
      providerConversationIdHash,
      direction: "inbound",
      providerEventId: eventUuid,
      providerMessageId,
      messageHash,
      status: "received",
      payloadAad: `xchat:inbound:${eventUuid}`,
      occurredAt: args.occurredAt,
      updatedAt: now,
      expiresAt: now + DELIVERY_RETENTION_MS,
    });
    return { status: "unbound" as const, deliveryId };
  },
});

export const attachClaim = internalMutation({
  args: {
    tokenHash: v.string(),
    authSubject: v.string(),
    challengeHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.object({
    connectionId: v.id("xchatConnections"),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_subject", (q) => q.eq("authSubject", args.authSubject))
      .unique();
    if (!user || user.status !== "active") {
      throw new ConvexError({
        code: "USER_NOT_READY",
        message: "Authenticated User is not ready",
      });
    }
    const claim = await ctx.db
      .query("xchatClaims")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!claim || claim.status !== "pending") {
      throw new ConvexError({
        code: "CLAIM_NOT_FOUND",
        message: "X Chat claim is invalid or already used",
      });
    }
    if (
      claim.expiresAt <= now ||
      args.expiresAt <= now ||
      args.expiresAt > now + 15 * 60_000
    ) {
      await ctx.db.patch(claim._id, { status: "expired", updatedAt: now });
      throw new ConvexError({ code: "CLAIM_EXPIRED", message: "X Chat claim expired" });
    }
    const existing = await ctx.db
      .query("xchatConnections")
      .withIndex("by_sender_id_hash", (q) =>
        q.eq("senderIdHash", claim.senderIdHash),
      )
      .unique();
    if (existing && existing.ownerId !== user._id && existing.status !== "revoked") {
      throw new ConvexError({
        code: "SENDER_ALREADY_CLAIMED",
        message: "This X Chat sender belongs to another User",
      });
    }
    const connectionValue = {
      ownerId: user._id,
      providerConversationIdHash: claim.providerConversationIdHash,
      maskedSender: `X Chat •${claim.senderIdHash.slice(-6)}`,
      status: "challenge_sent" as const,
      challengeHash: assertValidHash(args.challengeHash, "challengeHash"),
      challengeExpiresAt: args.expiresAt,
      verifiedAt: undefined,
      revokedAt: undefined,
      updatedAt: now,
    };
    let connectionId: Id<"xchatConnections">;
    if (existing) {
      connectionId = existing._id;
      await ctx.db.patch(existing._id, connectionValue);
    } else {
      connectionId = await ctx.db.insert("xchatConnections", {
        senderIdHash: claim.senderIdHash,
        ...connectionValue,
        createdAt: now,
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

export const completeChallenge = internalMutation({
  args: { senderIdHash: v.string(), challengeHash: v.string() },
  returns: v.object({
    connectionId: v.id("xchatConnections"),
    ownerId: v.id("users"),
    alreadyVerified: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("xchatConnections")
      .withIndex("by_sender_id_hash", (q) =>
        q.eq("senderIdHash", args.senderIdHash),
      )
      .unique();
    if (!connection) {
      throw new ConvexError({
        code: "CHALLENGE_NOT_FOUND",
        message: "X Chat challenge not found",
      });
    }
    if (connection.status === "verified") {
      throw new ConvexError({
        code: "SENDER_ALREADY_VERIFIED",
        message: "X Chat sender is already verified",
      });
    }
    const now = Date.now();
    if (
      connection.status !== "challenge_sent" ||
      connection.challengeHash !== args.challengeHash ||
      !connection.challengeExpiresAt ||
      connection.challengeExpiresAt <= now
    ) {
      throw new ConvexError({
        code: "INVALID_CHALLENGE",
        message: "X Chat challenge is invalid or expired",
      });
    }
    const attachedClaims = await ctx.db
      .query("xchatClaims")
      .withIndex("by_connection_id", (q) =>
        q.eq("connectionId", connection._id),
      )
      .take(20);
    const claim = attachedClaims.find(
      (candidate) =>
        candidate.status === "attached" &&
        candidate.challengeHash === args.challengeHash &&
        candidate.expiresAt > now,
    );
    if (!claim || claim.ownerId !== connection.ownerId) {
      throw new ConvexError({
        code: "CLAIM_NOT_ATTACHED",
        message: "A valid Clerk-bound X Chat claim is required",
      });
    }
    await ctx.db.patch(connection._id, {
      status: "verified",
      challengeHash: undefined,
      challengeExpiresAt: undefined,
      verifiedAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(claim._id, {
      status: "verified",
      challengeHash: undefined,
      updatedAt: now,
    });
    await writeAudit(ctx, {
      ownerId: connection.ownerId,
      actor: "xchat",
      action: "xchat_connection.verified",
      targetType: "xchat_connection",
      targetId: connection._id,
      outcome: "succeeded",
      now,
    });
    return {
      connectionId: connection._id,
      ownerId: connection.ownerId,
      alreadyVerified: false,
    };
  },
});

export const selectActiveProject = mutation({
  args: {
    connectionId: v.id("xchatConnections"),
    projectId: v.id("projects"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const [connection, project] = await Promise.all([
      ctx.db.get(args.connectionId),
      ctx.db.get(args.projectId),
    ]);
    if (!connection || !project) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "X Chat Connection or Project not found",
      });
    }
    assertOwner(user._id, connection.ownerId);
    assertOwner(user._id, project.ownerId);
    if (connection.status !== "verified" || project.status !== "active") {
      throw new ConvexError({
        code: "INVALID_STATE",
        message: "Connection and Project must be active",
      });
    }
    await ctx.db.patch(connection._id, {
      activeProjectId: project._id,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const acceptInbound = internalMutation({
  args: {
    senderIdHash: v.string(),
    providerConversationIdHash: v.string(),
    eventUuid: v.string(),
    providerMessageId: v.string(),
    messageHash: v.string(),
    encryptedPayload: v.optional(encryptedPayloadValidator),
    occurredAt: v.number(),
  },
  returns: acceptedInboundValidator,
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("xchatConnections")
      .withIndex("by_sender_id_hash", (q) =>
        q.eq("senderIdHash", args.senderIdHash),
      )
      .unique();
    if (!connection || connection.status !== "verified") {
      throw new ConvexError({
        code: "UNVERIFIED_XCHAT_SENDER",
        message: "A verified X Chat Connection is required",
      });
    }
    if (
      connection.providerConversationIdHash !==
      args.providerConversationIdHash
    ) {
      throw new ConvexError({
        code: "CONVERSATION_MISMATCH",
        message: "X Chat conversation does not match the verified claim",
      });
    }
    const eventUuid = assertValidHash(args.eventUuid, "eventUuid");
    const providerMessageId = assertValidHash(
      args.providerMessageId,
      "providerMessageId",
    );
    const messageHash = assertValidHash(args.messageHash, "messageHash");
    const existing = await findInboundDuplicate(ctx, eventUuid, providerMessageId);
    if (existing) {
      assertMatchingInbound(
        existing,
        {
          senderIdHash: connection.senderIdHash,
          providerConversationIdHash: connection.providerConversationIdHash,
          providerMessageId,
          messageHash,
        },
        connection._id,
      );
      if (!existing.conversationId) {
        throw new ConvexError({
          code: "DELIVERY_NOT_BOUND",
          message: "The original X Chat delivery has not been bound",
        });
      }
      return {
        deliveryId: existing._id,
        connectionId: connection._id,
        ownerId: connection.ownerId,
        projectId: connection.activeProjectId ?? null,
        conversationId: existing.conversationId,
        duplicate: true,
      };
    }
    return {
      ...(await acceptVerifiedInbound(ctx, connection, {
        eventUuid,
        providerMessageId,
        messageHash,
        encryptedPayload: args.encryptedPayload,
        occurredAt: args.occurredAt,
      })),
      duplicate: false,
    };
  },
});

export const enqueueOutbound = internalMutation({
  args: {
    ownerId: v.id("users"),
    connectionId: v.id("xchatConnections"),
    conversationId: v.optional(v.id("conversations")),
    runId: v.optional(v.id("runs")),
    idempotencyKey: v.string(),
    messageHash: v.string(),
    encryptedPayload: encryptedPayloadValidator,
    availableAt: v.optional(v.number()),
  },
  returns: v.id("channelDeliveries"),
  handler: async (ctx, args) => {
    assertEnvelope(args.encryptedPayload);
    const connection = await ctx.db.get(args.connectionId);
    if (
      !connection ||
      connection.ownerId !== args.ownerId ||
      connection.status !== "verified"
    ) {
      throw new ConvexError({
        code: "INVALID_XCHAT_CONNECTION",
        message: "Verified X Chat Connection required",
      });
    }
    if (args.conversationId) {
      const conversation = await ctx.db.get(args.conversationId);
      if (
        !conversation ||
        conversation.ownerId !== args.ownerId ||
        conversation.xchatConnectionId !== connection._id
      ) {
        throw new ConvexError({
          code: "INVALID_CONVERSATION",
          message: "Conversation does not match X Chat Connection",
        });
      }
    }
    if (args.runId) {
      const run = await ctx.db.get(args.runId);
      if (!run || run.ownerId !== args.ownerId) {
        throw new ConvexError({ code: "INVALID_RUN", message: "Run not found" });
      }
    }
    const idempotencyKey = assertValidHash(
      args.idempotencyKey,
      "idempotencyKey",
    );
    const providerMessageId = `outbound:${idempotencyKey}`;
    const existing = await ctx.db
      .query("channelDeliveries")
      .withIndex("by_provider_and_provider_message_id", (q) =>
        q.eq("provider", "xchat").eq("providerMessageId", providerMessageId),
      )
      .unique();
    if (existing) {
      if (
        existing.direction !== "outbound" ||
        existing.messageHash !== args.messageHash ||
        existing.xchatConnectionId !== connection._id
      ) {
        throw new ConvexError({
          code: "DELIVERY_ID_CONFLICT",
          message: "Outbound idempotency key was reused with different content",
        });
      }
      return existing._id;
    }
    const now = Date.now();
    return await ctx.db.insert("channelDeliveries", {
      ownerId: args.ownerId,
      xchatConnectionId: connection._id,
      conversationId: args.conversationId,
      runId: args.runId,
      provider: "xchat",
      providerSenderIdHash: connection.senderIdHash,
      providerConversationIdHash: connection.providerConversationIdHash,
      direction: "outbound",
      providerMessageId,
      messageHash: assertValidHash(args.messageHash, "messageHash"),
      encryptedPayload: args.encryptedPayload,
      payloadAad: `xchat:outbound:${idempotencyKey}`,
      status: "queued",
      availableAt: args.availableAt ?? now,
      attemptCount: 0,
      occurredAt: now,
      updatedAt: now,
      expiresAt: now + DELIVERY_RETENTION_MS,
    });
  },
});

export const attachRun = internalMutation({
  args: {
    deliveryId: v.id("channelDeliveries"),
    runId: v.id("runs"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const [delivery, run] = await Promise.all([
      ctx.db.get(args.deliveryId),
      ctx.db.get(args.runId),
    ]);
    if (
      !delivery ||
      delivery.provider !== "xchat" ||
      delivery.direction !== "inbound" ||
      !run ||
      delivery.ownerId !== run.ownerId ||
      delivery.conversationId !== run.conversationId
    ) {
      throw new ConvexError({
        code: "DELIVERY_RUN_MISMATCH",
        message: "Inbound X Chat delivery cannot be attached to this Run",
      });
    }
    if (delivery.runId && delivery.runId !== run._id) {
      throw new ConvexError({
        code: "DELIVERY_ALREADY_ROUTED",
        message: "Inbound X Chat delivery is already attached to another Run",
      });
    }
    await ctx.db.patch(delivery._id, { runId: run._id, updatedAt: Date.now() });
    return null;
  },
});

export const getInboundPayload = internalQuery({
  args: {
    deliveryId: v.id("channelDeliveries"),
    runId: v.id("runs"),
  },
  returns: v.union(
    v.null(),
    v.object({
      messageHash: v.string(),
      encryptedPayload: encryptedPayloadValidator,
      payloadAad: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (
      !delivery ||
      delivery.provider !== "xchat" ||
      delivery.direction !== "inbound" ||
      delivery.runId !== args.runId ||
      !delivery.encryptedPayload ||
      !delivery.payloadAad
    ) return null;
    return {
      messageHash: delivery.messageHash,
      encryptedPayload: delivery.encryptedPayload,
      payloadAad: delivery.payloadAad,
    };
  },
});

function leasableRows(
  rows: Doc<"channelDeliveries">[],
): Doc<"channelDeliveries">[] {
  return rows.filter(
    (row) =>
      row.xchatConnectionId !== undefined &&
      row.encryptedPayload !== undefined &&
      row.payloadAad !== undefined,
  );
}

export const leaseOutbound = internalMutation({
  args: {
    leaseIdHash: v.string(),
    now: v.number(),
    leaseExpiresAt: v.number(),
    limit: v.number(),
  },
  returns: v.array(leasedOutboundValidator),
  handler: async (ctx, args) => {
    const leaseIdHash = assertValidHash(args.leaseIdHash, "leaseIdHash");
    if (
      !Number.isSafeInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > MAX_PAGE_SIZE
    ) {
      throw new ConvexError({ code: "INVALID_LIMIT", message: "Invalid outbound lease limit" });
    }
    if (
      args.leaseExpiresAt <= args.now ||
      args.leaseExpiresAt > args.now + 2 * 60_000
    ) {
      throw new ConvexError({
        code: "INVALID_LEASE_EXPIRY",
        message: "Outbound lease must expire within two minutes",
      });
    }
    const queued = await ctx.db
      .query("channelDeliveries")
      .withIndex(
        "by_provider_and_direction_and_status_and_available_at",
        (q) =>
          q
            .eq("provider", "xchat")
            .eq("direction", "outbound")
            .eq("status", "queued")
            .lte("availableAt", args.now),
      )
      .take(args.limit);
    let candidates = leasableRows(queued);
    if (candidates.length < args.limit) {
      const abandoned = await ctx.db
        .query("channelDeliveries")
        .withIndex(
          "by_provider_and_direction_and_status_and_lease_expires_at",
          (q) =>
            q
              .eq("provider", "xchat")
              .eq("direction", "outbound")
              .eq("status", "leased")
              .lte("leaseExpiresAt", args.now),
        )
        .take(args.limit - candidates.length);
      candidates = candidates.concat(leasableRows(abandoned));
    }
    const result = [];
    for (const delivery of candidates) {
      if (!delivery.xchatConnectionId || !delivery.encryptedPayload || !delivery.payloadAad) continue;
      const attempt = (delivery.attemptCount ?? 0) + 1;
      await ctx.db.patch(delivery._id, {
        status: "leased",
        leaseIdHash,
        leaseExpiresAt: args.leaseExpiresAt,
        attemptCount: attempt,
        updatedAt: args.now,
      });
      result.push({
        deliveryId: delivery._id,
        connectionId: delivery.xchatConnectionId,
        providerConversationIdHash:
          delivery.providerConversationIdHash ?? "",
        messageHash: delivery.messageHash,
        encryptedPayload: delivery.encryptedPayload,
        payloadAad: delivery.payloadAad,
        occurredAt: delivery.occurredAt,
        attempt,
        leaseExpiresAt: args.leaseExpiresAt,
      });
    }
    return result;
  },
});

export const settleOutbound = internalMutation({
  args: {
    deliveryId: v.id("channelDeliveries"),
    leaseIdHash: v.string(),
    outcome: v.union(
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("failed_retryable"),
    ),
    externalMessageIdHash: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const leaseIdHash = assertValidHash(args.leaseIdHash, "leaseIdHash");
    const externalMessageIdHash = args.externalMessageIdHash
      ? assertValidHash(args.externalMessageIdHash, "externalMessageIdHash")
      : undefined;
    const errorCode = args.errorCode
      ? requireBoundedString(args.errorCode, "errorCode", 128)
      : undefined;
    const delivery = await ctx.db.get(args.deliveryId);
    if (
      !delivery ||
      delivery.provider !== "xchat" ||
      delivery.direction !== "outbound"
    ) {
      throw new ConvexError({
        code: "DELIVERY_NOT_FOUND",
        message: "X Chat outbound delivery not found",
      });
    }
    if (delivery.status === args.outcome) return null;
    if (
      delivery.status !== "leased" ||
      delivery.leaseIdHash !== leaseIdHash ||
      !delivery.leaseExpiresAt ||
      delivery.leaseExpiresAt <= Date.now()
    ) {
      throw new ConvexError({
        code: "INVALID_OUTBOUND_LEASE",
        message: "Outbound lease is missing, expired, or owned by another worker",
      });
    }
    if (args.outcome === "failed_retryable") {
      const attempt = delivery.attemptCount ?? 1;
      await ctx.db.patch(delivery._id, {
        status: "queued",
        availableAt:
          Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6)),
        errorCode,
        leaseIdHash: undefined,
        leaseExpiresAt: undefined,
        updatedAt: Date.now(),
      });
      return null;
    }
    if (
      (args.outcome === "sent" || args.outcome === "delivered") &&
      !externalMessageIdHash
    ) {
      throw new ConvexError({
        code: "INVALID_OUTBOUND_SETTLEMENT",
        message: "A successful terminal settlement requires the external message hash",
      });
    }
    await ctx.db.patch(delivery._id, {
      status: args.outcome,
      externalMessageIdHash,
      errorCode,
      encryptedPayload: undefined,
      leaseIdHash: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});
