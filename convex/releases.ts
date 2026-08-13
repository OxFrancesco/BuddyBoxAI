import { ConvexError, v } from "convex/values";

import { internalMutation, query } from "./_generated/server";
import { requireCurrentUser } from "./lib/auth";
import { boundedLimit } from "./lib/bounds";
import { writeAudit } from "./lib/audit";
import { releaseStatusValidator } from "./modelValidators";

const releaseValidator = v.object({
  _id: v.id("releases"),
  _creationTime: v.number(),
  projectId: v.id("projects"),
  sourceRunId: v.id("runs"),
  version: v.number(),
  status: releaseStatusValidator,
  commitSha: v.string(),
  liveUrl: v.optional(v.string()),
  previousReleaseId: v.optional(v.id("releases")),
  publishedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const create = internalMutation({
  args: {
    ownerId: v.id("users"),
    projectId: v.id("projects"),
    sourceRunId: v.id("runs"),
    approvalId: v.id("approvals"),
    bindingHash: v.string(),
    commitSha: v.string(),
    deploymentRef: v.optional(v.string()),
  },
  returns: v.id("releases"),
  handler: async (ctx, args) => {
    const [project, run, approval] = await Promise.all([
      ctx.db.get(args.projectId), ctx.db.get(args.sourceRunId), ctx.db.get(args.approvalId),
    ]);
    if (!project || project.ownerId !== args.ownerId || project.status !== "active") throw new ConvexError({ code: "PROJECT_NOT_FOUND", message: "Project not found" });
    if (!run || run.ownerId !== args.ownerId || run.projectId !== project._id || run.outcome !== "succeeded") {
      throw new ConvexError({ code: "RUN_NOT_RELEASABLE", message: "Only a verified successful Run can be released" });
    }
    if (
      !approval || approval.ownerId !== args.ownerId || approval.projectId !== project._id ||
      approval.runId !== run._id || approval.operation !== "publish_release" ||
      approval.bindingHash !== args.bindingHash || approval.status !== "consumed"
    ) throw new ConvexError({ code: "APPROVAL_REQUIRED", message: "Matching consumed Approval required" });
    const existing = await ctx.db.query("releases")
      .withIndex("by_approval_id", (q) => q.eq("approvalId", approval._id)).unique();
    if (existing) return existing._id;
    const previous = await ctx.db.query("releases")
      .withIndex("by_project_id_and_version", (q) => q.eq("projectId", project._id))
      .order("desc").first();
    const now = Date.now();
    const releaseId = await ctx.db.insert("releases", {
      ownerId: args.ownerId,
      projectId: project._id,
      sourceRunId: run._id,
      approvalId: approval._id,
      version: (previous?.version ?? 0) + 1,
      status: "deploying",
      commitSha: args.commitSha,
      deploymentRef: args.deploymentRef,
      previousReleaseId: project.liveReleaseId,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, {
      ownerId: args.ownerId, actor: "gateway", action: "release.created",
      targetType: "release", targetId: releaseId, outcome: "accepted",
      metadataJson: JSON.stringify({ projectId: project._id, version: (previous?.version ?? 0) + 1 }), now,
    });
    return releaseId;
  },
});

export const markLive = internalMutation({
  args: { releaseId: v.id("releases"), liveUrl: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    if (!release || release.status !== "deploying") throw new ConvexError({ code: "RELEASE_NOT_DEPLOYING", message: "Release is not deploying" });
    const project = await ctx.db.get(release.projectId);
    if (!project || project.ownerId !== release.ownerId) throw new ConvexError({ code: "PROJECT_NOT_FOUND", message: "Project not found" });
    const now = Date.now();
    if (project.liveReleaseId) {
      const previous = await ctx.db.get(project.liveReleaseId);
      if (previous?.status === "live") await ctx.db.patch(previous._id, { status: "superseded", updatedAt: now });
    }
    await ctx.db.patch(release._id, { status: "live", liveUrl: args.liveUrl, publishedAt: now, completedAt: now, updatedAt: now });
    await ctx.db.patch(project._id, { liveReleaseId: release._id, updatedAt: now });
    await writeAudit(ctx, {
      ownerId: release.ownerId, actor: "gateway", action: "release.published",
      targetType: "release", targetId: release._id, outcome: "succeeded",
      metadataJson: JSON.stringify({ projectId: release.projectId }), now,
    });
    return null;
  },
});

export const listMine = query({
  args: { projectId: v.id("projects"), limit: v.optional(v.number()) },
  returns: v.array(releaseValidator),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.ownerId !== user._id) return [];
    const rows = await ctx.db.query("releases")
      .withIndex("by_project_id_and_created_at", (q) => q.eq("projectId", project._id))
      .order("desc").take(boundedLimit(args.limit));
    return rows.map(({ _id, _creationTime, projectId, sourceRunId, version, status, commitSha, liveUrl, previousReleaseId, publishedAt, completedAt, createdAt, updatedAt }) => ({
      _id, _creationTime, projectId, sourceRunId, version, status, commitSha, liveUrl, previousReleaseId, publishedAt, completedAt, createdAt, updatedAt,
    }));
  },
});
