import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireCurrentUser } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { deletionStageValidator, deletionStatusValidator } from "./modelValidators";

const BATCH_SIZE = 25;

const deletionJobValidator = v.object({
  _id: v.id("accountDeletionJobs"),
  _creationTime: v.number(),
  status: deletionStatusValidator,
  stage: deletionStageValidator,
  deletedDocuments: v.number(),
  externalCleanupJson: v.optional(v.string()),
  lastErrorCode: v.optional(v.string()),
  nextAttemptAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function publicJob(job: Doc<"accountDeletionJobs">) {
  const { _id, _creationTime, status, stage, deletedDocuments, externalCleanupJson, lastErrorCode, nextAttemptAt, completedAt, createdAt, updatedAt } = job;
  return { _id, _creationTime, status, stage, deletedDocuments, externalCleanupJson, lastErrorCode, nextAttemptAt, completedAt, createdAt, updatedAt };
}

export const request = mutation({
  args: { confirmationBindingHash: v.string() },
  returns: v.id("accountDeletionJobs"),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const existing = await ctx.db.query("accountDeletionJobs")
      .withIndex("by_owner_id", (q) => q.eq("ownerId", user._id)).unique();
    if (existing && existing.status !== "complete") return existing._id;
    const now = Date.now();
    const jobId = await ctx.db.insert("accountDeletionJobs", {
      ownerId: user._id,
      status: "awaiting_confirmation",
      stage: "approvals",
      deletedDocuments: 0,
      confirmationBindingHash: args.confirmationBindingHash,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, {
      ownerId: user._id, actor: "user", action: "account_deletion.requested",
      targetType: "account_deletion_job", targetId: jobId, outcome: "accepted", now,
    });
    return jobId;
  },
});

export const confirm = internalMutation({
  args: { jobId: v.id("accountDeletionJobs"), approvalId: v.id("approvals") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const [job, approval] = await Promise.all([ctx.db.get(args.jobId), ctx.db.get(args.approvalId)]);
    if (!job || job.status !== "awaiting_confirmation") throw new ConvexError({ code: "DELETION_NOT_CONFIRMABLE", message: "Deletion is not awaiting confirmation" });
    if (
      !approval || approval.ownerId !== job.ownerId || approval.operation !== "delete_account" ||
      approval.bindingHash !== job.confirmationBindingHash || approval.status !== "consumed"
    ) throw new ConvexError({ code: "APPROVAL_REQUIRED", message: "Matching consumed Approval required" });
    const owner = await ctx.db.get(job.ownerId);
    if (!owner) throw new ConvexError({ code: "USER_NOT_FOUND", message: "User not found" });
    if (owner.activeRunId) throw new ConvexError({ code: "ACTIVE_RUN", message: "Cancel the active Run before deleting the account" });
    const now = Date.now();
    await ctx.db.patch(owner._id, { status: "deleting", updatedAt: now });
    await ctx.db.patch(job._id, {
      status: "revoking_services",
      confirmedAt: now,
      externalCleanupJson: JSON.stringify({
        github: "pending", chatgpt: "pending", cloudflare: "pending",
        convex: "pending", clerk: "pending", spectrum: "pending",
      }),
      updatedAt: now,
    });
    return null;
  },
});

export const externalCleanupComplete = internalMutation({
  args: { jobId: v.id("accountDeletionJobs"), outcomeJson: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "revoking_services") throw new ConvexError({ code: "INVALID_DELETION_STATE", message: "Deletion is not revoking services" });
    if (args.outcomeJson.length > 8_000) throw new ConvexError({ code: "OUTCOME_TOO_LARGE", message: "Cleanup outcome is too large" });
    JSON.parse(args.outcomeJson);
    await ctx.db.patch(job._id, {
      status: "purging", stage: "approvals", cursor: undefined,
      externalCleanupJson: args.outcomeJson, updatedAt: Date.now(),
    });
    return null;
  },
});

async function deleteRows(ctx: MutationCtx, rows: Array<{ _id: any }>): Promise<number> {
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

async function deleteStageBatch(
  ctx: MutationCtx,
  job: Doc<"accountDeletionJobs">,
): Promise<{ deleted: number; nextStage?: Doc<"accountDeletionJobs">["stage"]; nextCursor?: string }> {
  const ownerId = job.ownerId;
  const cursor = job.cursor;
  if (job.stage === "approvals") {
    if (!cursor) {
      const rows = await ctx.db.query("approvals").withIndex("by_owner_id_and_binding_hash", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length > 0) return { deleted: await deleteRows(ctx, rows) };
      return { deleted: 0, nextCursor: "audit" };
    }
    const rows = await ctx.db.query("auditHistory").withIndex("by_owner_id_and_occurred_at", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
    if (rows.length > 0) return { deleted: await deleteRows(ctx, rows), nextCursor: "audit" };
    return { deleted: 0, nextStage: "runtime" };
  }
  if (job.stage === "runtime") {
    const step = cursor ?? "events";
    if (step === "events") {
      const rows = await ctx.db.query("runEvents").withIndex("by_owner_id_and_event_id", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "leases" };
    }
    if (step === "leases") {
      const rows = await ctx.db.query("sandboxLeases").withIndex("by_owner_id", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "previews" };
    }
    if (step === "previews") {
      const rows = await ctx.db.query("previews").withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "deliveries" };
    }
    if (step === "deliveries") {
      const rows = await ctx.db.query("channelDeliveries").withIndex("by_owner_id_and_occurred_at", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "channel_messages" };
    }
    if (step === "channel_messages") {
      const rows = await ctx.db.query("channelMessages").withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "outbound_deliveries" };
    }
    if (step === "outbound_deliveries") {
      const rows = await ctx.db.query("outboundDeliveries").withIndex("by_owner_id", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "usage" };
    }
    if (step === "usage") {
      const rows = await ctx.db.query("usageBuckets").withIndex("by_owner_id_and_bucket_start_and_kind", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "runs" };
    }
    const rows = await ctx.db.query("runs").withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
    if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: "runs" };
    return { deleted: 0, nextStage: "projects" };
  }
  if (job.stage === "projects") {
    const step = cursor ?? "releases";
    if (step === "releases") {
      const rows = await ctx.db.query("releases").withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "conversations" };
    }
    if (step === "conversations") {
      const rows = await ctx.db.query("conversations").withIndex("by_owner_id_and_updated_at", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "proposals" };
    }
    if (step === "proposals") {
      const rows = await ctx.db.query("proposedProjects").withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "projects" };
    }
    const rows = await ctx.db.query("projects").withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
    if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: "projects" };
    return { deleted: 0, nextStage: "connections" };
  }
  if (job.stage === "connections") {
    const step = cursor ?? "provider_oauth_states";
    if (step === "provider_oauth_states") {
      const rows = await ctx.db.query("providerOAuthStates").withIndex("by_owner_id_and_provider", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "provider_credentials" };
    }
    if (step === "provider_credentials") {
      const rows = await ctx.db.query("providerCredentials").withIndex("by_owner_id_and_provider", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "codex" };
    }
    if (step === "codex") {
      const rows = await ctx.db.query("codexConnections").withIndex("by_owner_id", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "claims" };
    }
    if (step === "claims") {
      const rows = await ctx.db.query("imessageClaims").withIndex("by_owner_id", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "services" };
    }
    if (step === "services") {
      const rows = await ctx.db.query("serviceConnections").withIndex("by_owner_id_and_status", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
      if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: step };
      return { deleted: 0, nextCursor: "imessage" };
    }
    const rows = await ctx.db.query("imessageConnections").withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", ownerId)).take(BATCH_SIZE);
    if (rows.length) return { deleted: await deleteRows(ctx, rows), nextCursor: "imessage" };
    return { deleted: 0, nextStage: "account" };
  }
  return { deleted: 0, nextStage: "done" };
}

export const advance = internalMutation({
  args: { jobId: v.id("accountDeletionJobs") },
  returns: v.object({ status: deletionStatusValidator, stage: deletionStageValidator, deletedDocuments: v.number() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "purging") throw new ConvexError({ code: "INVALID_DELETION_STATE", message: "Deletion is not purging" });
    const now = Date.now();
    if (job.stage === "account" || job.stage === "done") {
      const owner = await ctx.db.get(job.ownerId);
      if (owner) {
        await ctx.db.patch(owner._id, {
          displayName: undefined, primaryEmail: undefined, imageUrl: undefined,
          activeRunId: undefined, status: "deleted", updatedAt: now,
        });
      }
      await ctx.db.patch(job._id, { status: "complete", stage: "done", completedAt: now, updatedAt: now });
      return { status: "complete" as const, stage: "done" as const, deletedDocuments: job.deletedDocuments };
    }
    const result = await deleteStageBatch(ctx, job);
    const nextStage = result.nextStage ?? job.stage;
    await ctx.db.patch(job._id, {
      stage: nextStage,
      cursor: result.nextStage ? undefined : result.nextCursor ?? job.cursor,
      deletedDocuments: job.deletedDocuments + result.deleted,
      updatedAt: now,
    });
    return { status: "purging" as const, stage: nextStage, deletedDocuments: job.deletedDocuments + result.deleted };
  },
});

export const getMine = query({
  args: {},
  returns: v.union(v.null(), deletionJobValidator),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Authentication required" });
    const user = await ctx.db.query("users").withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier)).unique();
    if (!user) return null;
    const job = await ctx.db.query("accountDeletionJobs").withIndex("by_owner_id", (q) => q.eq("ownerId", user._id)).unique();
    return job ? publicJob(job) : null;
  },
});
