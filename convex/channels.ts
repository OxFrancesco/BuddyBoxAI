import { ConvexError, v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { DELIVERY_RETENTION_MS, requireBoundedString } from "./lib/bounds";
import { deliveryDirectionValidator, deliveryStatusValidator } from "./modelValidators";

export const recordDelivery = internalMutation({
  args: {
    ownerId: v.optional(v.id("users")),
    imessageConnectionId: v.optional(v.id("imessageConnections")),
    conversationId: v.optional(v.id("conversations")),
    runId: v.optional(v.id("runs")),
    direction: deliveryDirectionValidator,
    providerMessageId: v.string(),
    commandKey: v.optional(v.string()),
    messageHash: v.string(),
    status: deliveryStatusValidator,
    occurredAt: v.number(),
  },
  returns: v.object({ deliveryId: v.id("channelDeliveries"), duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    const providerMessageId = requireBoundedString(args.providerMessageId, "providerMessageId", 300);
    const existing = await ctx.db.query("channelDeliveries")
      .withIndex("by_provider_and_provider_message_id", (q) =>
        q.eq("provider", "spectrum").eq("providerMessageId", providerMessageId),
      ).unique();
    if (existing) {
      if (existing.messageHash !== args.messageHash || existing.direction !== args.direction) {
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
      conversationId: args.conversationId,
      runId: args.runId,
      provider: "spectrum",
      direction: args.direction,
      providerMessageId,
      commandKey: args.commandKey,
      messageHash: args.messageHash,
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
