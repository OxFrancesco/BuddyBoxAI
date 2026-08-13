import { ConvexError, v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

export const ownerForToken = internalQuery({
  args: { tokenIdentifier: v.string() },
  returns: v.object({ ownerId: v.id("users") }),
  handler: async (ctx, args) => {
    const user = await ctx.db.query("users")
      .withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", args.tokenIdentifier))
      .unique();
    if (!user || user.status !== "active") {
      throw new ConvexError({ code: "USER_NOT_READY", message: "Authenticated User is not ready" });
    }
    return { ownerId: user._id };
  },
});

export const load = internalQuery({
  args: { ownerId: v.id("users") },
  returns: v.union(v.null(), v.object({ revision: v.number(), valueJson: v.string() })),
  handler: async (ctx, args) => {
    const document = await ctx.db.query("codexConnections")
      .withIndex("by_owner_id", (q) => q.eq("ownerId", args.ownerId)).unique();
    return document ? { revision: document.revision, valueJson: document.valueJson } : null;
  },
});

export const commit = internalMutation({
  args: {
    ownerId: v.id("users"),
    expectedRevision: v.union(v.null(), v.number()),
    valueJson: v.union(v.null(), v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("codexConnections")
      .withIndex("by_owner_id", (q) => q.eq("ownerId", args.ownerId)).unique();
    if ((existing?.revision ?? null) !== args.expectedRevision) return false;
    if (args.valueJson === null) {
      if (existing) await ctx.db.delete(existing._id);
      return true;
    }
    if (new TextEncoder().encode(args.valueJson).byteLength > 48_000) {
      throw new ConvexError({ code: "CONNECTION_TOO_LARGE", message: "Codex connection state is too large" });
    }
    JSON.parse(args.valueJson);
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        revision: existing.revision + 1,
        valueJson: args.valueJson,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("codexConnections", {
        ownerId: args.ownerId,
        revision: 1,
        valueJson: args.valueJson,
        updatedAt: now,
      });
    }
    return true;
  },
});
