import { ConvexError, v } from "convex/values";

import { internalMutation, query } from "./_generated/server";
import { requireCurrentUser } from "./lib/auth";
import { boundedLimit } from "./lib/bounds";
import { previewStatusValidator, sandboxLeaseStatusValidator } from "./modelValidators";

export const acquireSandboxLease = internalMutation({
  args: {
    ownerId: v.id("users"),
    projectId: v.id("projects"),
    runId: v.id("runs"),
    sandboxIdHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.id("sandboxLeases"),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.ownerId !== args.ownerId || run.projectId !== args.projectId) {
      throw new ConvexError({ code: "RUN_NOT_FOUND", message: "Run not found" });
    }
    const existing = await ctx.db.query("sandboxLeases")
      .withIndex("by_run_id", (q) => q.eq("runId", run._id)).unique();
    if (existing && existing.status !== "released" && existing.status !== "lost") {
      throw new ConvexError({ code: "SANDBOX_ALREADY_LEASED", message: "Run already has a Sandbox lease" });
    }
    const now = Date.now();
    return await ctx.db.insert("sandboxLeases", {
      ownerId: args.ownerId,
      projectId: args.projectId,
      runId: args.runId,
      sandboxIdHash: args.sandboxIdHash,
      status: "provisioning",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: args.expiresAt,
    });
  },
});

export const updateSandboxLease = internalMutation({
  args: {
    leaseId: v.id("sandboxLeases"),
    status: sandboxLeaseStatusValidator,
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lease = await ctx.db.get(args.leaseId);
    if (!lease) throw new ConvexError({ code: "LEASE_NOT_FOUND", message: "Sandbox lease not found" });
    const now = Date.now();
    await ctx.db.patch(lease._id, {
      status: args.status,
      heartbeatAt: now,
      expiresAt: args.expiresAt,
      releasedAt: args.status === "released" || args.status === "lost" ? now : undefined,
    });
    return null;
  },
});

export const upsertPreview = internalMutation({
  args: {
    ownerId: v.id("users"),
    projectId: v.id("projects"),
    runId: v.id("runs"),
    status: previewStatusValidator,
    url: v.optional(v.string()),
    externalDeploymentRef: v.optional(v.string()),
    commitSha: v.optional(v.string()),
    verificationJson: v.optional(v.string()),
    expiresAt: v.number(),
  },
  returns: v.id("previews"),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.ownerId !== args.ownerId || run.projectId !== args.projectId) {
      throw new ConvexError({ code: "RUN_NOT_FOUND", message: "Run not found" });
    }
    const existing = await ctx.db.query("previews").withIndex("by_run_id", (q) => q.eq("runId", run._id)).unique();
    const now = Date.now();
    const value = {
      status: args.status, url: args.url, externalDeploymentRef: args.externalDeploymentRef,
      commitSha: args.commitSha, verificationJson: args.verificationJson,
      expiresAt: args.expiresAt, updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, value);
      return existing._id;
    }
    return await ctx.db.insert("previews", {
      ownerId: args.ownerId, projectId: args.projectId, runId: args.runId,
      ...value, createdAt: now,
    });
  },
});

export const listPreviewsMine = query({
  args: { projectId: v.id("projects"), limit: v.optional(v.number()) },
  returns: v.array(v.object({
    _id: v.id("previews"),
    _creationTime: v.number(),
    runId: v.id("runs"),
    status: previewStatusValidator,
    url: v.optional(v.string()),
    commitSha: v.optional(v.string()),
    verificationJson: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.ownerId !== user._id) return [];
    const rows = await ctx.db.query("previews")
      .withIndex("by_project_id_and_created_at", (q) => q.eq("projectId", project._id))
      .order("desc").take(boundedLimit(args.limit));
    return rows.map(({ _id, _creationTime, runId, status, url, commitSha, verificationJson, expiresAt, createdAt, updatedAt }) => ({
      _id, _creationTime, runId, status, url, commitSha, verificationJson, expiresAt, createdAt, updatedAt,
    }));
  },
});
