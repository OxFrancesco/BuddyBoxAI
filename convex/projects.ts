import { ConvexError, v } from "convex/values";

import { internalMutation, mutation, query } from "./_generated/server";
import { assertOwner, requireCurrentUser } from "./lib/auth";
import { boundedLimit, requireBoundedString } from "./lib/bounds";
import { projectReadiness } from "./lib/readiness";
import { writeAudit } from "./lib/audit";
import { projectStatusValidator, proposedProjectStatusValidator } from "./modelValidators";

const projectValidator = v.object({
  _id: v.id("projects"),
  _creationTime: v.number(),
  name: v.string(),
  slug: v.string(),
  status: projectStatusValidator,
  hostingHostname: v.optional(v.string()),
  githubRepositoryFullName: v.string(),
  defaultBranch: v.string(),
  liveReleaseId: v.optional(v.id("releases")),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const propose = mutation({
  args: {
    conversationId: v.optional(v.id("conversations")),
    name: v.string(),
    brief: v.string(),
    planJson: v.string(),
    payloadHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.id("proposedProjects"),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const readiness = await projectReadiness(ctx, user._id);
    if (!readiness.ready) {
      throw new ConvexError({
        code: "USER_NOT_PROJECT_READY",
        message: `Missing required connections: ${readiness.missing.join(", ")}`,
      });
    }
    if (args.conversationId) {
      const conversation = await ctx.db.get(args.conversationId);
      if (!conversation) throw new ConvexError({ code: "NOT_FOUND", message: "Conversation not found" });
      assertOwner(user._id, conversation.ownerId);
    }
    if (args.planJson.length > 64_000 || args.brief.length > 8_000) {
      throw new ConvexError({ code: "PROPOSAL_TOO_LARGE", message: "Proposed Project payload is too large" });
    }
    const now = Date.now();
    if (args.expiresAt <= now || args.expiresAt > now + 24 * 60 * 60 * 1_000) {
      throw new ConvexError({ code: "INVALID_EXPIRY", message: "Proposal must expire within 24 hours" });
    }
    return await ctx.db.insert("proposedProjects", {
      ownerId: user._id,
      conversationId: args.conversationId,
      name: requireBoundedString(args.name, "name", 120),
      brief: args.brief.trim(),
      planJson: args.planJson,
      payloadHash: args.payloadHash,
      status: "awaiting_approval",
      expiresAt: args.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const createProvisioned = internalMutation({
  args: {
    ownerId: v.id("users"),
    proposalId: v.id("proposedProjects"),
    approvalId: v.id("approvals"),
    slug: v.string(),
    githubRepositoryId: v.string(),
    githubRepositoryFullName: v.string(),
    convexProjectRef: v.string(),
    clerkApplicationRef: v.optional(v.string()),
  },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    const [owner, proposal, approval] = await Promise.all([
      ctx.db.get(args.ownerId),
      ctx.db.get(args.proposalId),
      ctx.db.get(args.approvalId),
    ]);
    if (!owner || owner.status !== "active") throw new ConvexError({ code: "USER_NOT_FOUND", message: "User not found" });
    if (!proposal || proposal.ownerId !== owner._id) throw new ConvexError({ code: "NOT_FOUND", message: "Proposal not found" });
    if (
      !approval ||
      approval.ownerId !== owner._id ||
      approval.operation !== "confirm_project" ||
      approval.bindingHash !== proposal.payloadHash ||
      approval.status !== "consumed"
    ) {
      throw new ConvexError({ code: "APPROVAL_REQUIRED", message: "A matching consumed Approval is required" });
    }
    if (proposal.status === "confirmed" && proposal.confirmedProjectId) return proposal.confirmedProjectId;
    if (proposal.status !== "awaiting_approval" || proposal.expiresAt <= Date.now()) {
      throw new ConvexError({ code: "INVALID_PROPOSAL", message: "Proposal is not confirmable" });
    }
    const readiness = await projectReadiness(ctx, owner._id);
    if (!readiness.ready) throw new ConvexError({ code: "USER_NOT_PROJECT_READY", message: "Required connections are unavailable" });
    const slug = normalizedProjectSlug(args.slug);
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_owner_id_and_slug", (q) => q.eq("ownerId", owner._id).eq("slug", slug))
      .unique();
    if (existing && existing.status !== "deleted") {
      throw new ConvexError({ code: "SLUG_TAKEN", message: "Project slug already exists" });
    }
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      ownerId: owner._id,
      name: proposal.name,
      slug,
      status: "active",
      githubRepositoryId: args.githubRepositoryId,
      githubRepositoryFullName: args.githubRepositoryFullName,
      defaultBranch: "main",
      convexProjectRef: args.convexProjectRef,
      clerkApplicationRef: args.clerkApplicationRef,
      createdAt: now,
      updatedAt: now,
    });
    const hostingHostname = managedHostingHostname(slug, projectId);
    const hostnameOwner = await ctx.db
      .query("projects")
      .withIndex("by_hosting_hostname", (q) =>
        q.eq("hostingHostname", hostingHostname),
      )
      .unique();
    if (hostnameOwner && hostnameOwner._id !== projectId) {
      throw new ConvexError({
        code: "HOSTNAME_COLLISION",
        message: "Managed hosting hostname collision",
      });
    }
    await ctx.db.patch(projectId, { hostingHostname });
    await ctx.db.patch(proposal._id, { status: "confirmed", confirmedProjectId: projectId, updatedAt: now });
    await writeAudit(ctx, {
      ownerId: owner._id, actor: "gateway", action: "project.created",
      targetType: "project", targetId: projectId, outcome: "succeeded",
      metadataJson: JSON.stringify({ repository: args.githubRepositoryFullName }), now,
    });
    return projectId;
  },
});

export const listMine = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(projectValidator),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", user._id))
      .order("desc")
      .take(boundedLimit(args.limit));
    return rows.map((project) => ({
      _id: project._id,
      _creationTime: project._creationTime,
      name: project.name,
      slug: project.slug,
      status: project.status,
      hostingHostname: project.hostingHostname,
      githubRepositoryFullName: project.githubRepositoryFullName,
      defaultBranch: project.defaultBranch,
      liveReleaseId: project.liveReleaseId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    }));
  },
});

export const getMine = query({
  args: { projectId: v.id("projects") },
  returns: v.union(v.null(), projectValidator),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.ownerId !== user._id) return null;
    return {
      _id: project._id,
      _creationTime: project._creationTime,
      name: project.name,
      slug: project.slug,
      status: project.status,
      hostingHostname: project.hostingHostname,
      githubRepositoryFullName: project.githubRepositoryFullName,
      defaultBranch: project.defaultBranch,
      liveReleaseId: project.liveReleaseId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  },
});

function normalizedProjectSlug(value: string): string {
  const slug = requireBoundedString(value, "slug", 80).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(slug)) {
    throw new ConvexError({
      code: "INVALID_PROJECT_SLUG",
      message: "Project slug must be a lowercase DNS label",
    });
  }
  return slug;
}

function sitesBaseDomain(): string {
  const domain = (process.env.ICHEF_SITES_BASE_DOMAIN ?? "ichef-sites.buddytools.org")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    domain.length > 180 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(domain)
  ) {
    throw new ConvexError({
      code: "INVALID_SITES_BASE_DOMAIN",
      message: "Managed sites base domain is invalid",
    });
  }
  return domain;
}

function managedHostingHostname(
  slugValue: string,
  projectId: string,
): string {
  const slug = normalizedProjectSlug(slugValue);
  const suffix = projectId.toLowerCase();
  if (!/^[a-z0-9]{16,48}$/.test(suffix)) {
    throw new ConvexError({
      code: "INVALID_PROJECT_ID",
      message: "Project ID cannot be encoded as a hosting hostname",
    });
  }
  const siteLabel = sitesBaseDomain().split(".")[0] ?? "ichef-sites";
  const prefixLength = 63 - suffix.length - siteLabel.length - 2;
  const prefix = slug.slice(0, prefixLength).replace(/-+$/, "") || "site";
  return `${prefix}-${suffix}-${sitesBaseDomain()}`;
}

export const backfillManagedHostnames = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ updated: v.number(), remaining: v.boolean() }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ConvexError({ code: "INVALID_LIMIT", message: "Invalid backfill limit" });
    }
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_hosting_hostname", (q) => q.eq("hostingHostname", undefined))
      .take(limit + 1);
    for (const project of rows.slice(0, limit)) {
      const hostingHostname = managedHostingHostname(project.slug, project._id);
      const existing = await ctx.db
        .query("projects")
        .withIndex("by_hosting_hostname", (q) =>
          q.eq("hostingHostname", hostingHostname),
        )
        .unique();
      if (existing && existing._id !== project._id) {
        throw new ConvexError({
          code: "HOSTNAME_COLLISION",
          message: "Managed hosting hostname collision",
        });
      }
      await ctx.db.patch(project._id, {
        hostingHostname,
        updatedAt: Date.now(),
      });
    }
    return {
      updated: Math.min(rows.length, limit),
      remaining: rows.length > limit,
    };
  },
});

export const listProposals = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.object({
    _id: v.id("proposedProjects"),
    _creationTime: v.number(),
    name: v.string(),
    brief: v.string(),
    status: proposedProjectStatusValidator,
    expiresAt: v.number(),
    confirmedProjectId: v.optional(v.id("projects")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const rows = await ctx.db.query("proposedProjects")
      .withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", user._id))
      .order("desc").take(boundedLimit(args.limit));
    return rows.map(({ _id, _creationTime, name, brief, status, expiresAt, confirmedProjectId, createdAt, updatedAt }) => ({
      _id, _creationTime, name, brief, status, expiresAt, confirmedProjectId, createdAt, updatedAt,
    }));
  },
});
