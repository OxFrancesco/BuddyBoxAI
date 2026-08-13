import { ConvexError, v } from "convex/values";

import { internalMutation, mutation, query } from "./_generated/server";
import { assertOwner, requireCurrentUser } from "./lib/auth";
import { requireBoundedString } from "./lib/bounds";
import { projectReadiness } from "./lib/readiness";
import { writeAudit } from "./lib/audit";
import {
  iMessageConnectionStatusValidator,
  serviceConnectionStatusValidator,
  serviceProviderValidator,
} from "./modelValidators";

const serviceConnectionValidator = v.object({
  _id: v.id("serviceConnections"),
  _creationTime: v.number(),
  provider: serviceProviderValidator,
  status: serviceConnectionStatusValidator,
  accountLabel: v.optional(v.string()),
  scopes: v.array(v.string()),
  lastCheckedAt: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const imessageConnectionValidator = v.object({
  _id: v.id("imessageConnections"),
  _creationTime: v.number(),
  maskedAddress: v.string(),
  status: iMessageConnectionStatusValidator,
  verifiedAt: v.optional(v.number()),
  activeProjectId: v.optional(v.id("projects")),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const listMine = query({
  args: {},
  returns: v.object({
    imessage: v.array(imessageConnectionValidator),
    services: v.array(serviceConnectionValidator),
    readiness: v.object({
      ready: v.boolean(),
      missing: v.array(
        v.union(
          v.literal("imessage"),
          v.literal("chatgpt"),
          v.literal("github"),
          v.literal("cloudflare"),
          v.literal("convex"),
        ),
      ),
    }),
  }),
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const imessage = await ctx.db
      .query("imessageConnections")
      .withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", user._id))
      .order("desc")
      .take(20);
    const services = await ctx.db
      .query("serviceConnections")
      .withIndex("by_owner_id_and_status", (q) => q.eq("ownerId", user._id))
      .take(20);
    return {
      imessage: imessage.map((connection) => ({
        _id: connection._id,
        _creationTime: connection._creationTime,
        maskedAddress: connection.maskedAddress,
        status: connection.status,
        verifiedAt: connection.verifiedAt,
        activeProjectId: connection.activeProjectId,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      })),
      services: services.map((connection) => ({
        _id: connection._id,
        _creationTime: connection._creationTime,
        provider: connection.provider,
        status: connection.status,
        accountLabel: connection.accountLabel,
        scopes: connection.scopes,
        lastCheckedAt: connection.lastCheckedAt,
        expiresAt: connection.expiresAt,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      })),
      readiness: await projectReadiness(ctx, user._id),
    };
  },
});

export const beginImessageVerification = internalMutation({
  args: {
    ownerId: v.id("users"),
    addressHash: v.string(),
    maskedAddress: v.string(),
    challengeHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.id("imessageConnections"),
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.expiresAt <= now || args.expiresAt > now + 15 * 60 * 1_000) {
      throw new ConvexError({
        code: "INVALID_EXPIRY",
        message: "The iMessage challenge must expire within 15 minutes",
      });
    }
    const owner = await ctx.db.get(args.ownerId);
    if (!owner || owner.status !== "active") {
      throw new ConvexError({ code: "USER_NOT_FOUND", message: "User not found" });
    }
    const claimed = await ctx.db
      .query("imessageConnections")
      .withIndex("by_address_hash", (q) => q.eq("addressHash", args.addressHash))
      .unique();
    if (claimed && claimed.ownerId !== args.ownerId && claimed.status !== "revoked") {
      throw new ConvexError({
        code: "ADDRESS_ALREADY_CLAIMED",
        message: "This iMessage address belongs to another User",
      });
    }
    if (claimed) {
      await ctx.db.patch(claimed._id, {
        ownerId: args.ownerId,
        maskedAddress: requireBoundedString(args.maskedAddress, "maskedAddress", 80),
        status: "challenge_sent",
        challengeHash: args.challengeHash,
        challengeExpiresAt: args.expiresAt,
        verifiedAt: undefined,
        revokedAt: undefined,
        updatedAt: now,
      });
      return claimed._id;
    }
    return await ctx.db.insert("imessageConnections", {
      ownerId: args.ownerId,
      addressHash: args.addressHash,
      maskedAddress: requireBoundedString(args.maskedAddress, "maskedAddress", 80),
      status: "challenge_sent",
      challengeHash: args.challengeHash,
      challengeExpiresAt: args.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const completeImessageChallenge = internalMutation({
  args: { addressHash: v.string(), challengeHash: v.string() },
  returns: v.object({
    connectionId: v.id("imessageConnections"),
    ownerId: v.id("users"),
    alreadyVerified: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("imessageConnections")
      .withIndex("by_address_hash", (q) => q.eq("addressHash", args.addressHash))
      .unique();
    if (!connection) {
      throw new ConvexError({ code: "CHALLENGE_NOT_FOUND", message: "Challenge not found" });
    }
    if (connection.status === "verified") {
      throw new ConvexError({ code: "ADDRESS_ALREADY_VERIFIED", message: "Address is already verified" });
    }
    const now = Date.now();
    if (
      connection.status !== "challenge_sent" ||
      connection.challengeHash !== args.challengeHash ||
      !connection.challengeExpiresAt ||
      connection.challengeExpiresAt <= now
    ) {
      throw new ConvexError({ code: "INVALID_CHALLENGE", message: "Challenge is invalid or expired" });
    }
    await ctx.db.patch(connection._id, {
      status: "verified",
      challengeHash: undefined,
      challengeExpiresAt: undefined,
      verifiedAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, {
      ownerId: connection.ownerId, actor: "imessage", action: "imessage_connection.verified",
      targetType: "imessage_connection", targetId: connection._id, outcome: "succeeded", now,
    });
    return { connectionId: connection._id, ownerId: connection.ownerId, alreadyVerified: false };
  },
});

export const setServiceConnection = internalMutation({
  args: {
    ownerId: v.id("users"),
    provider: serviceProviderValidator,
    status: serviceConnectionStatusValidator,
    externalAccountIdHash: v.optional(v.string()),
    accountLabel: v.optional(v.string()),
    scopes: v.array(v.string()),
    credentialRef: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  returns: v.id("serviceConnections"),
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.ownerId);
    if (!owner || owner.status !== "active") {
      throw new ConvexError({ code: "USER_NOT_FOUND", message: "User not found" });
    }
    if (args.scopes.length > 100 || args.scopes.some((scope) => scope.length > 160)) {
      throw new ConvexError({ code: "INVALID_SCOPES", message: "Service scopes are too large" });
    }
    const existing = await ctx.db
      .query("serviceConnections")
      .withIndex("by_owner_id_and_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
    const now = Date.now();
    const value = {
      status: args.status,
      externalAccountIdHash: args.externalAccountIdHash,
      accountLabel: args.accountLabel,
      scopes: args.scopes,
      credentialRef: args.credentialRef,
      lastCheckedAt: now,
      expiresAt: args.expiresAt,
      revokedAt: args.status === "revoked" ? now : undefined,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, value);
      await writeAudit(ctx, {
        ownerId: args.ownerId, actor: "system", action: "service_connection.updated",
        targetType: "service_connection", targetId: existing._id, outcome: "succeeded",
        metadataJson: JSON.stringify({ provider: args.provider, status: args.status }), now,
      });
      return existing._id;
    }
    const connectionId = await ctx.db.insert("serviceConnections", {
      ownerId: args.ownerId,
      provider: args.provider,
      ...value,
      createdAt: now,
    });
    await writeAudit(ctx, {
      ownerId: args.ownerId, actor: "system", action: "service_connection.created",
      targetType: "service_connection", targetId: connectionId, outcome: "succeeded",
      metadataJson: JSON.stringify({ provider: args.provider, status: args.status }), now,
    });
    return connectionId;
  },
});

export const selectActiveProject = mutation({
  args: {
    connectionId: v.id("imessageConnections"),
    projectId: v.id("projects"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const connection = await ctx.db.get(args.connectionId);
    const project = await ctx.db.get(args.projectId);
    if (!connection || !project) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Connection or Project not found" });
    }
    assertOwner(user._id, connection.ownerId);
    assertOwner(user._id, project.ownerId);
    if (connection.status !== "verified" || project.status !== "active") {
      throw new ConvexError({ code: "INVALID_STATE", message: "Connection and Project must be active" });
    }
    await ctx.db.patch(connection._id, { activeProjectId: project._id, updatedAt: Date.now() });
    return null;
  },
});
