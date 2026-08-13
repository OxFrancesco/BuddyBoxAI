import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, query } from "./_generated/server";
import { requireCurrentUser } from "./lib/auth";
import { boundedLimit } from "./lib/bounds";
import { usageKindValidator } from "./modelValidators";
import { quotaDecision } from "./domainPolicy";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const PILOT_DAILY_RUN_LIMIT = 20;

export function utcDay(now: number): { start: number; end: number } {
  const start = Math.floor(now / DAY_MS) * DAY_MS;
  return { start, end: start + DAY_MS };
}

export async function chargeUsage(
  ctx: MutationCtx,
  input: {
    ownerId: Id<"users">;
    kind: "runs" | "sandbox_seconds" | "model_tokens" | "preview_minutes" | "messages";
    amount: number;
    limit: number;
    now: number;
  },
): Promise<{ consumed: number; limit: number; remaining: number }> {
  const bucket = utcDay(input.now);
  const existing = await ctx.db.query("usageBuckets")
    .withIndex("by_owner_id_and_bucket_start_and_kind", (q) =>
      q.eq("ownerId", input.ownerId).eq("bucketStart", bucket.start).eq("kind", input.kind),
    ).unique();
  const consumed = existing?.consumed ?? 0;
  const decision = quotaDecision(consumed, input.limit, input.amount);
  if (!decision.allowed) {
    throw new ConvexError({
      code: "QUOTA_EXCEEDED",
      message: `${input.kind} quota exceeded`,
      kind: input.kind,
      limit: input.limit,
      consumed,
      requested: input.amount,
      resetsAt: bucket.end,
    });
  }
  const nextConsumed = consumed + input.amount;
  if (existing) {
    await ctx.db.patch(existing._id, { consumed: nextConsumed, limit: input.limit, updatedAt: input.now });
  } else {
    await ctx.db.insert("usageBuckets", {
      ownerId: input.ownerId,
      bucketStart: bucket.start,
      bucketEnd: bucket.end,
      kind: input.kind,
      consumed: nextConsumed,
      limit: input.limit,
      updatedAt: input.now,
    });
  }
  return { consumed: nextConsumed, limit: input.limit, remaining: decision.remaining };
}

export const charge = internalMutation({
  args: {
    ownerId: v.id("users"),
    kind: usageKindValidator,
    amount: v.number(),
    limit: v.number(),
  },
  returns: v.object({ consumed: v.number(), limit: v.number(), remaining: v.number() }),
  handler: async (ctx, args) => chargeUsage(ctx, { ...args, now: Date.now() }),
});

export const listMine = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.object({
    _id: v.id("usageBuckets"),
    _creationTime: v.number(),
    bucketStart: v.number(),
    bucketEnd: v.number(),
    kind: usageKindValidator,
    consumed: v.number(),
    limit: v.number(),
    updatedAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const rows = await ctx.db.query("usageBuckets")
      .withIndex("by_owner_id_and_bucket_start_and_kind", (q) => q.eq("ownerId", user._id))
      .order("desc").take(boundedLimit(args.limit));
    return rows.map(({ _id, _creationTime, bucketStart, bucketEnd, kind, consumed, limit, updatedAt }) => ({
      _id, _creationTime, bucketStart, bucketEnd, kind, consumed, limit, updatedAt,
    }));
  },
});
