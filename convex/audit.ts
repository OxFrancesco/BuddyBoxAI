import { v } from "convex/values";

import { query } from "./_generated/server";
import { requireCurrentUser } from "./lib/auth";
import { boundedLimit } from "./lib/bounds";
import { auditActorValidator, auditOutcomeValidator } from "./modelValidators";

export const listMine = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.object({
    _id: v.id("auditHistory"),
    _creationTime: v.number(),
    actor: auditActorValidator,
    action: v.string(),
    targetType: v.string(),
    targetId: v.optional(v.string()),
    outcome: auditOutcomeValidator,
    metadataJson: v.optional(v.string()),
    occurredAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const rows = await ctx.db.query("auditHistory")
      .withIndex("by_owner_id_and_occurred_at", (q) => q.eq("ownerId", user._id))
      .order("desc").take(boundedLimit(args.limit));
    return rows.map(({ _id, _creationTime, actor, action, targetType, targetId, outcome, metadataJson, occurredAt }) => ({
      _id, _creationTime, actor, action, targetType, targetId, outcome, metadataJson, occurredAt,
    }));
  },
});
