import { ConvexError, v } from "convex/values";

import { internalMutation, internalQuery, query } from "./_generated/server";
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
    deploymentHostname: v.string(),
    artifactManifestDigest: v.string(),
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
    const deploymentHostname = managedHostname(args.deploymentHostname);
    if (project.hostingHostname !== deploymentHostname) {
      throw new ConvexError({ code: "RELEASE_BINDING_MISMATCH", message: "Release hostname does not match the managed Project" });
    }
    const artifactManifestDigest = manifestDigest(args.artifactManifestDigest);
    const releaseId = await ctx.db.insert("releases", {
      ownerId: args.ownerId,
      projectId: project._id,
      sourceRunId: run._id,
      approvalId: approval._id,
      version: (previous?.version ?? 0) + 1,
      status: "deploying",
      commitSha: args.commitSha,
      deploymentHostname,
      artifactManifestDigest,
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

const siteAuthorizationValidator = v.object({ authorized: v.boolean() });

export const authorizeManagedDeployment = internalQuery({
  args: {
    projectId: v.id("projects"),
    releaseId: v.id("releases"),
    sourceRunId: v.id("runs"),
    commitSha: v.string(),
    hostname: v.string(),
    artifactManifestDigest: v.string(),
  },
  returns: siteAuthorizationValidator,
  handler: async (ctx, args) => {
    const [project, release] = await Promise.all([
      ctx.db.get(args.projectId),
      ctx.db.get(args.releaseId),
    ]);
    return {
      authorized: Boolean(
        project &&
          project.status === "active" &&
          project.hostingHostname &&
          release &&
          release.projectId === project._id &&
          release.ownerId === project.ownerId &&
          release.status === "deploying" &&
          release.sourceRunId === args.sourceRunId &&
          release.commitSha === args.commitSha &&
          release.deploymentHostname === args.hostname &&
          release.artifactManifestDigest === args.artifactManifestDigest,
      ),
    };
  },
});

const uploadReservationResultValidator = v.union(
  v.object({ status: v.literal("reserved") }),
  v.object({
    status: v.literal("live"),
    deploymentRef: v.string(),
    liveUrl: v.string(),
  }),
);

const UPLOAD_RESERVATION_MILLISECONDS = 5 * 60 * 1_000;

export const reserveManagedDeploymentUpload = internalMutation({
  args: {
    projectId: v.id("projects"),
    releaseId: v.id("releases"),
    sourceRunId: v.id("runs"),
    commitSha: v.string(),
    hostname: v.string(),
    artifactManifestDigest: v.string(),
    attemptId: v.string(),
  },
  returns: uploadReservationResultValidator,
  handler: async (ctx, args) => {
    const [project, release] = await Promise.all([
      ctx.db.get(args.projectId),
      ctx.db.get(args.releaseId),
    ]);
    const hostname = managedHostname(args.hostname);
    const digest = manifestDigest(args.artifactManifestDigest);
    const attemptId = boundedOpaqueRef(args.attemptId, "attemptId", 128);
    if (
      !project || project.status !== "active" || project.hostingHostname !== hostname ||
      !release || release.projectId !== project._id || release.ownerId !== project.ownerId ||
      release.sourceRunId !== args.sourceRunId || release.commitSha !== args.commitSha ||
      release.deploymentHostname !== hostname || release.artifactManifestDigest !== digest
    ) {
      throw new ConvexError({
        code: "RELEASE_BINDING_MISMATCH",
        message: "Release does not match the preauthorized managed deployment",
      });
    }
    if (release.status === "live") {
      if (!release.deploymentRef || !release.liveUrl || release.uploadReservationStatus !== "completed") {
        throw new ConvexError({ code: "INVALID_RELEASE_STATE", message: "Live Release deployment is incomplete" });
      }
      return { status: "live" as const, deploymentRef: release.deploymentRef, liveUrl: release.liveUrl };
    }
    if (release.status !== "deploying") {
      throw new ConvexError({ code: "RELEASE_NOT_DEPLOYING", message: "Release is not deploying" });
    }
    const now = Date.now();
    if (
      release.uploadReservationStatus === "reserved" &&
      release.uploadReservedAt !== undefined &&
      release.uploadReservedAt + UPLOAD_RESERVATION_MILLISECONDS > now
    ) {
      throw new ConvexError({ code: "UPLOAD_IN_PROGRESS", message: "A Release upload is already in progress" });
    }
    await ctx.db.patch(release._id, {
      uploadAttemptId: attemptId,
      uploadReservedAt: now,
      uploadReservationStatus: "reserved",
      updatedAt: now,
    });
    return { status: "reserved" as const };
  },
});

export const failManagedDeploymentUpload = internalMutation({
  args: { releaseId: v.id("releases"), attemptId: v.string() },
  returns: v.object({ status: v.literal("failed") }),
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.releaseId);
    const attemptId = boundedOpaqueRef(args.attemptId, "attemptId", 128);
    if (!release || release.status !== "deploying" || release.uploadAttemptId !== attemptId) {
      throw new ConvexError({ code: "UPLOAD_RESERVATION_MISMATCH", message: "Release upload reservation does not match" });
    }
    if (release.uploadReservationStatus === "failed") return { status: "failed" as const };
    if (release.uploadReservationStatus !== "reserved") {
      throw new ConvexError({ code: "UPLOAD_RESERVATION_MISMATCH", message: "Release upload reservation does not match" });
    }
    await ctx.db.patch(release._id, { uploadReservationStatus: "failed", updatedAt: Date.now() });
    return { status: "failed" as const };
  },
});

export const resolveManagedSite = internalQuery({
  args: { hostname: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      projectId: v.id("projects"),
      releaseId: v.id("releases"),
      commitSha: v.string(),
      deploymentRef: v.string(),
      status: v.literal("live"),
    }),
  ),
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_hosting_hostname", (q) =>
        q.eq("hostingHostname", args.hostname),
      )
      .unique();
    if (!project || project.status !== "active" || !project.liveReleaseId) {
      return null;
    }
    const release = await ctx.db.get(project.liveReleaseId);
    if (
      !release ||
      release.projectId !== project._id ||
      release.ownerId !== project.ownerId ||
      release.status !== "live" ||
      !release.deploymentRef
    ) return null;
    return {
      projectId: project._id,
      releaseId: release._id,
      commitSha: release.commitSha,
      deploymentRef: release.deploymentRef,
      status: "live" as const,
    };
  },
});

export const activateManagedRelease = internalMutation({
  args: {
    projectId: v.id("projects"),
    releaseId: v.id("releases"),
    sourceRunId: v.id("runs"),
    deploymentRef: v.string(),
    liveUrl: v.string(),
    commitSha: v.string(),
    hostname: v.string(),
    artifactManifestDigest: v.string(),
    attemptId: v.string(),
  },
  returns: v.object({
    projectId: v.id("projects"),
    releaseId: v.id("releases"),
    status: v.literal("live"),
  }),
  handler: async (ctx, args) => {
    const [project, release] = await Promise.all([
      ctx.db.get(args.projectId),
      ctx.db.get(args.releaseId),
    ]);
    const hostname = managedHostname(args.hostname);
    const digest = manifestDigest(args.artifactManifestDigest);
    const attemptId = boundedOpaqueRef(args.attemptId, "attemptId", 128);
    if (
      !project ||
      project.status !== "active" ||
      !project.hostingHostname ||
      !release ||
      release.projectId !== project._id ||
      release.ownerId !== project.ownerId ||
      release.sourceRunId !== args.sourceRunId ||
      release.commitSha !== args.commitSha ||
      project.hostingHostname !== hostname ||
      release.deploymentHostname !== hostname ||
      release.artifactManifestDigest !== digest
    ) {
      throw new ConvexError({
        code: "RELEASE_BINDING_MISMATCH",
        message: "Release does not match the managed Project deployment",
      });
    }
    const deploymentRef = boundedOpaqueRef(args.deploymentRef, "deploymentRef", 512);
    const liveUrl = managedLiveUrl(args.liveUrl, project.hostingHostname);
    if (release.status === "live") {
      if (
        release.deploymentRef === deploymentRef &&
        release.liveUrl === liveUrl &&
        release.uploadAttemptId === attemptId &&
        release.uploadReservationStatus === "completed" &&
        project.liveReleaseId === release._id
      ) {
        return { projectId: project._id, releaseId: release._id, status: "live" as const };
      }
      throw new ConvexError({
        code: "RELEASE_ALREADY_ACTIVATED",
        message: "Release is already live with different deployment data",
      });
    }
    if (release.status !== "deploying") {
      throw new ConvexError({
        code: "RELEASE_NOT_DEPLOYING",
        message: "Release is not deploying",
      });
    }
    if (release.uploadReservationStatus !== "reserved" || release.uploadAttemptId !== attemptId) {
      throw new ConvexError({ code: "UPLOAD_RESERVATION_MISMATCH", message: "Release upload reservation does not match" });
    }
    const now = Date.now();
    if (project.liveReleaseId && project.liveReleaseId !== release._id) {
      const previous = await ctx.db.get(project.liveReleaseId);
      if (previous?.status === "live") {
        await ctx.db.patch(previous._id, { status: "superseded", updatedAt: now });
      }
    }
    await ctx.db.patch(release._id, {
      status: "live",
      deploymentRef,
      liveUrl,
      publishedAt: now,
      completedAt: now,
      uploadReservationStatus: "completed",
      updatedAt: now,
    });
    await ctx.db.patch(project._id, { liveReleaseId: release._id, updatedAt: now });
    await writeAudit(ctx, {
      ownerId: release.ownerId,
      actor: "gateway",
      action: "release.published",
      targetType: "release",
      targetId: release._id,
      outcome: "succeeded",
      metadataJson: JSON.stringify({ projectId: project._id, hostingHostname: project.hostingHostname }),
      now,
    });
    return { projectId: project._id, releaseId: release._id, status: "live" as const };
  },
});

function boundedOpaqueRef(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ConvexError({ code: "INVALID_DEPLOYMENT", message: `${field} is invalid` });
  }
  return normalized;
}

function managedHostname(value: string): string {
  const normalized = boundedOpaqueRef(value, "hostname", 253).toLowerCase();
  if (normalized !== value || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?-buddybox-sites\.buddytools\.org$/.test(normalized)) {
    throw new ConvexError({ code: "INVALID_DEPLOYMENT", message: "hostname is invalid" });
  }
  return normalized;
}

function manifestDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ConvexError({ code: "INVALID_DEPLOYMENT", message: "artifactManifestDigest is invalid" });
  }
  return value;
}

function managedLiveUrl(value: string, hostname: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConvexError({ code: "INVALID_DEPLOYMENT", message: "liveUrl is invalid" });
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== hostname ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new ConvexError({
      code: "INVALID_DEPLOYMENT",
      message: "liveUrl must be the managed HTTPS Project origin",
    });
  }
  return url.toString();
}

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
