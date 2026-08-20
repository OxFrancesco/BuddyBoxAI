import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireCurrentUser } from "./lib/auth";
import { boundedLimit, DEFAULT_APPROVAL_TTL_MS, MAX_APPROVAL_TTL_MS } from "./lib/bounds";
import { writeAudit } from "./lib/audit";
import { approvalOperationValidator, approvalStatusValidator } from "./modelValidators";

const approvalValidator = v.object({
  _id: v.id("approvals"),
  _creationTime: v.number(),
  projectId: v.optional(v.id("projects")),
  runId: v.optional(v.id("runs")),
  releaseId: v.optional(v.id("releases")),
  operation: approvalOperationValidator,
  bindingHash: v.string(),
  status: approvalStatusValidator,
  expiresAt: v.number(),
  consumedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export async function consumeApproval(
  ctx: MutationCtx,
  args: {
    ownerId: Id<"users">;
    approvalId: Id<"approvals">;
    bindingHash: string;
    deliveryId?: Id<"channelDeliveries">;
  },
) {
  const approval = await ctx.db.get(args.approvalId);
  if (!approval || approval.ownerId !== args.ownerId) {
    throw new ConvexError({ code: "APPROVAL_NOT_FOUND", message: "Approval not found" });
  }
  if (approval.bindingHash !== args.bindingHash) {
    throw new ConvexError({ code: "APPROVAL_BINDING_MISMATCH", message: "Approval does not authorize this payload" });
  }
  if (approval.status === "consumed") {
    if (args.deliveryId && approval.consumedByDeliveryId === args.deliveryId) {
      return { approvalId: approval._id, alreadyConsumed: true };
    }
    throw new ConvexError({ code: "APPROVAL_ALREADY_CONSUMED", message: "Approval was already consumed" });
  }
  if (approval.status !== "pending" || approval.expiresAt <= Date.now()) {
    throw new ConvexError({ code: "APPROVAL_UNAVAILABLE", message: "Approval is expired or unavailable" });
  }
  let actor: "user" | "imessage" | "xchat" = "user";
  if (args.deliveryId) {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.ownerId !== args.ownerId) {
      throw new ConvexError({
        code: "DELIVERY_NOT_FOUND",
        message: "Channel delivery not found",
      });
    }
    actor = delivery.provider === "xchat" ? "xchat" : "imessage";
  }
  const now = Date.now();
  await ctx.db.patch(approval._id, {
    status: "consumed",
    consumedAt: now,
    consumedByDeliveryId: args.deliveryId,
    updatedAt: now,
  });
  await writeAudit(ctx, {
    ownerId: approval.ownerId,
    actor,
    action: "approval.consumed",
    targetType: "approval",
    targetId: approval._id,
    outcome: "succeeded",
    metadataJson: JSON.stringify({ operation: approval.operation }),
    now,
  });
  return { approvalId: approval._id, alreadyConsumed: false };
}

export const create = internalMutation({
  args: {
    ownerId: v.id("users"),
    projectId: v.optional(v.id("projects")),
    runId: v.optional(v.id("runs")),
    releaseId: v.optional(v.id("releases")),
    operation: approvalOperationValidator,
    bindingHash: v.string(),
    ttlMs: v.optional(v.number()),
  },
  returns: v.id("approvals"),
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.ownerId);
    if (!owner || owner.status !== "active") throw new ConvexError({ code: "USER_NOT_FOUND", message: "User not found" });
    if (args.projectId) {
      const project = await ctx.db.get(args.projectId);
      if (!project || project.ownerId !== owner._id) throw new ConvexError({ code: "NOT_FOUND", message: "Project not found" });
    }
    if (args.runId) {
      const run = await ctx.db.get(args.runId);
      if (!run || run.ownerId !== owner._id || (args.projectId && run.projectId !== args.projectId)) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Run not found" });
      }
    }
    if (args.releaseId) {
      const release = await ctx.db.get(args.releaseId);
      if (!release || release.ownerId !== owner._id || (args.projectId && release.projectId !== args.projectId)) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Release not found" });
      }
    }
    const ttl = args.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 10_000 || ttl > MAX_APPROVAL_TTL_MS) {
      throw new ConvexError({ code: "INVALID_APPROVAL_TTL", message: "Approval TTL is outside the allowed range" });
    }
    const now = Date.now();
    const latest = await ctx.db.query("approvals")
      .withIndex("by_owner_id_and_binding_hash", (q) =>
        q.eq("ownerId", owner._id).eq("bindingHash", args.bindingHash),
      ).order("desc").first();
    if (
      latest && latest.status === "pending" && latest.expiresAt > now &&
      latest.operation === args.operation && latest.projectId === args.projectId &&
      latest.runId === args.runId && latest.releaseId === args.releaseId
    ) return latest._id;
    return await ctx.db.insert("approvals", {
      ownerId: owner._id,
      projectId: args.projectId,
      runId: args.runId,
      releaseId: args.releaseId,
      operation: args.operation,
      bindingHash: args.bindingHash,
      status: "pending",
      expiresAt: now + ttl,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const consume = mutation({
  args: { approvalId: v.id("approvals"), bindingHash: v.string() },
  returns: v.object({ approvalId: v.id("approvals"), alreadyConsumed: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    return await consumeApproval(ctx, { ownerId: user._id, ...args });
  },
});

export const consumeForChannel = internalMutation({
  args: {
    ownerId: v.id("users"),
    approvalId: v.id("approvals"),
    bindingHash: v.string(),
    deliveryId: v.id("channelDeliveries"),
  },
  returns: v.object({ approvalId: v.id("approvals"), alreadyConsumed: v.boolean() }),
  handler: consumeApproval,
});

export const listPendingMine = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(approvalValidator),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const rows = await ctx.db.query("approvals")
      .withIndex("by_owner_id_and_status_and_expires_at", (q) =>
        q.eq("ownerId", user._id).eq("status", "pending").gt("expiresAt", Date.now()),
      ).take(boundedLimit(args.limit));
    return rows.map(({ _id, _creationTime, projectId, runId, releaseId, operation, bindingHash, status, expiresAt, consumedAt, createdAt, updatedAt }) => ({
      _id, _creationTime, projectId, runId, releaseId, operation, bindingHash, status, expiresAt, consumedAt, createdAt, updatedAt,
    }));
  },
});
