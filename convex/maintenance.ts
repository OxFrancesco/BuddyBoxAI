import { v } from "convex/values";

import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";

const BATCH_SIZE = 50;

async function deleteRows(ctx: MutationCtx, rows: Array<{ _id: any }>): Promise<number> {
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

export const sweepExpired = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({
    runEvents: v.number(),
    deliveries: v.number(),
    channelMessages: v.number(),
    outboundDeliveries: v.number(),
    imessageClaims: v.number(),
    xchatClaims: v.number(),
    providerOAuthStates: v.number(),
    auditRows: v.number(),
    usageBuckets: v.number(),
    approvalsExpired: v.number(),
    previewsExpired: v.number(),
    leasesLost: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const runEvents = await deleteRows(ctx, await ctx.db.query("runEvents")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", now)).take(BATCH_SIZE));
    const deliveries = await deleteRows(ctx, await ctx.db.query("channelDeliveries")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", now)).take(BATCH_SIZE));
    const channelMessages = await deleteRows(ctx, await ctx.db.query("channelMessages")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", now)).take(BATCH_SIZE));
    const outboundDeliveries = await deleteRows(ctx, await ctx.db.query("outboundDeliveries")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", now)).take(BATCH_SIZE));
    const imessageClaims = await deleteRows(ctx, await ctx.db.query("imessageClaims")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", now)).take(BATCH_SIZE));
    const xchatClaims = await deleteRows(ctx, await ctx.db.query("xchatClaims")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", now)).take(BATCH_SIZE));
    const expiredPendingOAuthStates = await deleteRows(ctx, await ctx.db.query("providerOAuthStates")
      .withIndex("by_status_and_expires_at", (q) => q.eq("status", "pending").lt("expiresAt", now)).take(BATCH_SIZE));
    const expiredConsumedOAuthStates = await deleteRows(ctx, await ctx.db.query("providerOAuthStates")
      .withIndex("by_status_and_expires_at", (q) => q.eq("status", "consumed").lt("expiresAt", now)).take(BATCH_SIZE));
    const providerOAuthStates = expiredPendingOAuthStates + expiredConsumedOAuthStates;
    const auditRows = await deleteRows(ctx, await ctx.db.query("auditHistory")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", now)).take(BATCH_SIZE));
    const usageBuckets = await deleteRows(ctx, await ctx.db.query("usageBuckets")
      .withIndex("by_bucket_end", (q) => q.lt("bucketEnd", now - 30 * 24 * 60 * 60 * 1_000)).take(BATCH_SIZE));

    const approvals = await ctx.db.query("approvals")
      .withIndex("by_status_and_expires_at", (q) => q.eq("status", "pending").lt("expiresAt", now))
      .take(BATCH_SIZE);
    for (const approval of approvals) await ctx.db.patch(approval._id, { status: "expired", updatedAt: now });

    const previews = await ctx.db.query("previews")
      .withIndex("by_status_and_expires_at", (q) => q.eq("status", "ready").lt("expiresAt", now))
      .take(BATCH_SIZE);
    for (const preview of previews) await ctx.db.patch(preview._id, { status: "expired", url: undefined, updatedAt: now });

    const leases = await ctx.db.query("sandboxLeases")
      .withIndex("by_status_and_expires_at", (q) => q.eq("status", "active").lt("expiresAt", now))
      .take(BATCH_SIZE);
    for (const lease of leases) await ctx.db.patch(lease._id, { status: "lost", releasedAt: now });

    return {
      runEvents,
      deliveries,
      channelMessages,
      outboundDeliveries,
      imessageClaims,
      xchatClaims,
      providerOAuthStates,
      auditRows,
      usageBuckets,
      approvalsExpired: approvals.length,
      previewsExpired: previews.length,
      leasesLost: leases.length,
    };
  },
});
