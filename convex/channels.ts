import { ConvexError, v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { DELIVERY_RETENTION_MS, requireBoundedString } from "./lib/bounds";
import { deliveryDirectionValidator, deliveryStatusValidator } from "./modelValidators";
import { channelProviderValidator, encryptedPayloadValidator } from "./modelValidators";

export const recordDelivery = internalMutation({
  args: {
    ownerId: v.optional(v.id("users")),
    imessageConnectionId: v.optional(v.id("imessageConnections")),
    xchatConnectionId: v.optional(v.id("xchatConnections")),
    conversationId: v.optional(v.id("conversations")),
    runId: v.optional(v.id("runs")),
    direction: deliveryDirectionValidator,
    provider: v.optional(channelProviderValidator),
    providerSenderIdHash: v.optional(v.string()),
    providerConversationIdHash: v.optional(v.string()),
    providerEventId: v.optional(v.string()),
    providerMessageId: v.string(),
    commandKey: v.optional(v.string()),
    messageHash: v.string(),
    encryptedPayload: v.optional(encryptedPayloadValidator),
    payloadAad: v.optional(v.string()),
    status: deliveryStatusValidator,
    occurredAt: v.number(),
  },
  returns: v.object({ deliveryId: v.id("channelDeliveries"), duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    const provider = args.provider ?? "spectrum";
    const providerMessageId = requireBoundedString(args.providerMessageId, "providerMessageId", 300);
    const existing = await ctx.db.query("channelDeliveries")
      .withIndex("by_provider_and_provider_message_id", (q) =>
        q.eq("provider", provider).eq("providerMessageId", providerMessageId),
      ).unique();
    if (existing) {
      if (
        existing.messageHash !== args.messageHash ||
        existing.direction !== args.direction ||
        (args.ownerId !== undefined && existing.ownerId !== args.ownerId) ||
        (args.imessageConnectionId !== undefined &&
          existing.imessageConnectionId !== args.imessageConnectionId) ||
        (args.xchatConnectionId !== undefined &&
          existing.xchatConnectionId !== args.xchatConnectionId) ||
        (args.providerSenderIdHash !== undefined &&
          existing.providerSenderIdHash !== args.providerSenderIdHash) ||
        (args.providerConversationIdHash !== undefined &&
          existing.providerConversationIdHash !== args.providerConversationIdHash) ||
        (args.providerEventId !== undefined &&
          existing.providerEventId !== args.providerEventId)
      ) {
        throw new ConvexError({ code: "DELIVERY_ID_CONFLICT", message: "Provider message identity was reused" });
      }
      return { deliveryId: existing._id, duplicate: true };
    }
    if (args.imessageConnectionId) {
      const connection = await ctx.db.get(args.imessageConnectionId);
      if (!connection || (args.ownerId && connection.ownerId !== args.ownerId)) {
        throw new ConvexError({ code: "INVALID_CONNECTION", message: "iMessage Connection does not match owner" });
      }
    }
    if (args.xchatConnectionId) {
      const connection = await ctx.db.get(args.xchatConnectionId);
      if (!connection || (args.ownerId && connection.ownerId !== args.ownerId)) {
        throw new ConvexError({ code: "INVALID_CONNECTION", message: "X Chat Connection does not match owner" });
      }
    }
    if (args.conversationId) {
      const conversation = await ctx.db.get(args.conversationId);
      if (!conversation || (args.ownerId && conversation.ownerId !== args.ownerId)) {
        throw new ConvexError({ code: "INVALID_CONVERSATION", message: "Conversation does not match owner" });
      }
    }
    if (args.runId) {
      const run = await ctx.db.get(args.runId);
      if (!run || (args.ownerId && run.ownerId !== args.ownerId)) {
        throw new ConvexError({ code: "INVALID_RUN", message: "Run does not match owner" });
      }
    }
    const now = Date.now();
    const deliveryId = await ctx.db.insert("channelDeliveries", {
      ownerId: args.ownerId,
      imessageConnectionId: args.imessageConnectionId,
      xchatConnectionId: args.xchatConnectionId,
      conversationId: args.conversationId,
      runId: args.runId,
      provider,
      providerSenderIdHash: args.providerSenderIdHash,
      providerConversationIdHash: args.providerConversationIdHash,
      providerEventId: args.providerEventId,
      direction: args.direction,
      providerMessageId,
      commandKey: args.commandKey,
      messageHash: args.messageHash,
      encryptedPayload: args.encryptedPayload,
      payloadAad: args.payloadAad,
      status: args.status,
      occurredAt: args.occurredAt,
      updatedAt: now,
      expiresAt: args.occurredAt + DELIVERY_RETENTION_MS,
    });
    return { deliveryId, duplicate: false };
  },
});

export const updateDelivery = internalMutation({
  args: {
    deliveryId: v.id("channelDeliveries"),
    status: deliveryStatusValidator,
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery) throw new ConvexError({ code: "DELIVERY_NOT_FOUND", message: "Delivery not found" });
    await ctx.db.patch(delivery._id, { status: args.status, errorCode: args.errorCode, updatedAt: Date.now() });
    return null;
  },
});
