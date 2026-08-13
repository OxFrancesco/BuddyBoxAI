import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { canTransitionRun, isActiveRunStatus, type RunStatus } from "./domainPolicy";
import { assertOwner, requireCurrentUser } from "./lib/auth";
import { boundedLimit, requireBoundedString } from "./lib/bounds";
import { writeAudit } from "./lib/audit";
import { projectReadiness } from "./lib/readiness";
import { runOutcomeValidator, runStatusValidator } from "./modelValidators";
import { chargeUsage, PILOT_DAILY_RUN_LIMIT } from "./usage";

const runValidator = v.object({
  _id: v.id("runs"),
  _creationTime: v.number(),
  projectId: v.id("projects"),
  conversationId: v.optional(v.id("conversations")),
  commandKey: v.string(),
  status: runStatusValidator,
  outcome: v.optional(runOutcomeValidator),
  branchName: v.optional(v.string()),
  checkpointRef: v.optional(v.string()),
  summary: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  cancelRequestedAt: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  lastHeartbeatAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function publicRun(run: Doc<"runs">) {
  const {
    _id, _creationTime, projectId, conversationId, commandKey, status, outcome,
    branchName, checkpointRef, summary, errorCode, cancelRequestedAt, startedAt,
    completedAt, lastHeartbeatAt, createdAt, updatedAt,
  } = run;
  return { _id, _creationTime, projectId, conversationId, commandKey, status, outcome, branchName, checkpointRef, summary, errorCode, cancelRequestedAt, startedAt, completedAt, lastHeartbeatAt, createdAt, updatedAt };
}

export const admit = internalMutation({
  args: {
    ownerId: v.id("users"),
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    commandKey: v.string(),
    instructionHash: v.string(),
  },
  returns: v.object({ runId: v.id("runs"), duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    const commandKey = requireBoundedString(args.commandKey, "commandKey", 200);
    const existing = await ctx.db.query("runs")
      .withIndex("by_owner_id_and_command_key", (q) =>
        q.eq("ownerId", args.ownerId).eq("commandKey", commandKey),
      ).unique();
    if (existing) return { runId: existing._id, duplicate: true };

    const [owner, project] = await Promise.all([ctx.db.get(args.ownerId), ctx.db.get(args.projectId)]);
    if (!owner || owner.status !== "active") throw new ConvexError({ code: "USER_NOT_FOUND", message: "User not found" });
    if (!project || project.status !== "active") throw new ConvexError({ code: "PROJECT_NOT_FOUND", message: "Active Project not found" });
    assertOwner(owner._id, project.ownerId);
    if (owner.activeRunId) {
      const active = await ctx.db.get(owner.activeRunId);
      if (active && isActiveRunStatus(active.status)) {
        throw new ConvexError({ code: "RUN_ALREADY_ACTIVE", message: "A User may have only one active Run", runId: active._id });
      }
    }
    if (args.conversationId) {
      const conversation = await ctx.db.get(args.conversationId);
      if (!conversation) throw new ConvexError({ code: "NOT_FOUND", message: "Conversation not found" });
      assertOwner(owner._id, conversation.ownerId);
      if (conversation.projectId && conversation.projectId !== project._id) {
        throw new ConvexError({ code: "PROJECT_MISMATCH", message: "Conversation belongs to another Project" });
      }
    }
    const readiness = await projectReadiness(ctx, owner._id);
    if (!readiness.ready) throw new ConvexError({ code: "USER_NOT_PROJECT_READY", message: "Required connections are unavailable" });

    const now = Date.now();
    await chargeUsage(ctx, { ownerId: owner._id, kind: "runs", amount: 1, limit: PILOT_DAILY_RUN_LIMIT, now });
    const runId = await ctx.db.insert("runs", {
      ownerId: owner._id,
      projectId: project._id,
      conversationId: args.conversationId,
      commandKey,
      instructionHash: args.instructionHash,
      status: "queued",
      activeLeaseKey: `user:${owner._id}`,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(owner._id, { activeRunId: runId, updatedAt: now });
    await writeAudit(ctx, {
      ownerId: owner._id,
      actor: "gateway",
      action: "run.admitted",
      targetType: "run",
      targetId: runId,
      outcome: "accepted",
      metadataJson: JSON.stringify({ projectId: project._id }),
      now,
    });
    return { runId, duplicate: false };
  },
});

export const transition = internalMutation({
  args: {
    runId: v.id("runs"),
    status: runStatusValidator,
    outcome: v.optional(runOutcomeValidator),
    summary: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    branchName: v.optional(v.string()),
    checkpointRef: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new ConvexError({ code: "RUN_NOT_FOUND", message: "Run not found" });
    if (!canTransitionRun(run.status as RunStatus, args.status as RunStatus)) {
      throw new ConvexError({ code: "INVALID_RUN_TRANSITION", message: `Cannot transition Run from ${run.status} to ${args.status}` });
    }
    const active = isActiveRunStatus(args.status as RunStatus);
    const terminalOutcome = !active ? args.status : undefined;
    if (!active && args.outcome !== terminalOutcome) {
      throw new ConvexError({ code: "UNTRUTHFUL_OUTCOME", message: "Terminal Run status and outcome must match" });
    }
    if (active && args.outcome !== undefined) {
      throw new ConvexError({ code: "UNTRUTHFUL_OUTCOME", message: "An active Run cannot have an outcome" });
    }
    const now = Date.now();
    await ctx.db.patch(run._id, {
      status: args.status,
      outcome: args.outcome,
      summary: args.summary ? requireBoundedString(args.summary, "summary", 2_000) : run.summary,
      errorCode: args.errorCode,
      branchName: args.branchName ?? run.branchName,
      checkpointRef: args.checkpointRef ?? run.checkpointRef,
      activeLeaseKey: active ? run.activeLeaseKey : undefined,
      startedAt: args.status === "running" ? run.startedAt ?? now : run.startedAt,
      completedAt: active ? undefined : now,
      updatedAt: now,
    });
    if (!active) {
      const owner = await ctx.db.get(run.ownerId);
      if (owner?.activeRunId === run._id) {
        await ctx.db.patch(owner._id, { activeRunId: undefined, updatedAt: now });
      }
    }
    await writeAudit(ctx, {
      ownerId: run.ownerId,
      actor: "gateway",
      action: "run.status_changed",
      targetType: "run",
      targetId: run._id,
      outcome: args.status === "failed" ? "failed" : "succeeded",
      metadataJson: JSON.stringify({ from: run.status, to: args.status }),
      now,
    });
    return null;
  },
});

export const heartbeat = internalMutation({
  args: { runId: v.id("runs"), at: v.number() },
  returns: v.object({ cancelRequested: v.boolean() }),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || !isActiveRunStatus(run.status)) {
      throw new ConvexError({ code: "RUN_NOT_ACTIVE", message: "Run is not active" });
    }
    await ctx.db.patch(run._id, { lastHeartbeatAt: args.at, updatedAt: args.at });
    return { cancelRequested: run.cancelRequestedAt !== undefined };
  },
});

export const requestCancel = mutation({
  args: { runId: v.id("runs"), reason: v.optional(v.string()) },
  returns: v.object({ status: runStatusValidator, alreadyRequested: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run) throw new ConvexError({ code: "NOT_FOUND", message: "Run not found" });
    assertOwner(user._id, run.ownerId);
    if (!isActiveRunStatus(run.status)) return { status: run.status as RunStatus, alreadyRequested: true };
    if (run.cancelRequestedAt !== undefined) return { status: run.status as RunStatus, alreadyRequested: true };
    const now = Date.now();
    if (run.status === "queued") {
      await ctx.db.patch(run._id, {
        status: "cancelled", outcome: "cancelled", activeLeaseKey: undefined,
        cancelRequestedAt: now, cancelReason: args.reason, completedAt: now, updatedAt: now,
      });
      if (user.activeRunId === run._id) await ctx.db.patch(user._id, { activeRunId: undefined, updatedAt: now });
      await writeAudit(ctx, {
        ownerId: user._id, actor: "user", action: "run.cancelled",
        targetType: "run", targetId: run._id, outcome: "succeeded", now,
      });
      return { status: "cancelled" as const, alreadyRequested: false };
    }
    await ctx.db.patch(run._id, {
      cancelRequestedAt: now,
      cancelReason: args.reason ? requireBoundedString(args.reason, "reason", 500) : undefined,
      updatedAt: now,
    });
    await writeAudit(ctx, {
      ownerId: user._id, actor: "user", action: "run.cancel_requested",
      targetType: "run", targetId: run._id, outcome: "accepted", now,
    });
    return { status: run.status as RunStatus, alreadyRequested: false };
  },
});

export const getMine = query({
  args: { runId: v.id("runs") },
  returns: v.union(v.null(), runValidator),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const run = await ctx.db.get(args.runId);
    return !run || run.ownerId !== user._id ? null : publicRun(run);
  },
});

export const listMine = query({
  args: { projectId: v.optional(v.id("projects")), limit: v.optional(v.number()) },
  returns: v.array(runValidator),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const limit = boundedLimit(args.limit);
    if (args.projectId) {
      const project = await ctx.db.get(args.projectId);
      if (!project || project.ownerId !== user._id) return [];
    }
    const rows = args.projectId
      ? await ctx.db.query("runs").withIndex("by_project_id_and_created_at", (q) => q.eq("projectId", args.projectId!)).order("desc").take(limit)
      : await ctx.db.query("runs").withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", user._id)).order("desc").take(limit);
    return rows.map(publicRun);
  },
});
