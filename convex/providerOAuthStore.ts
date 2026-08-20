import { ConvexError, v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import { writeAudit } from "./lib/audit";

const providerValidator = v.union(
  v.literal("github"),
  v.literal("cloudflare"),
  v.literal("convex"),
);

export const resolveOwner = internalQuery({
  args: { tokenIdentifier: v.string() },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", args.tokenIdentifier))
      .unique();
    if (!user || user.status !== "active") {
      throw new ConvexError({ code: "USER_NOT_READY", message: "Create the authenticated User first" });
    }
    return user._id;
  },
});

export const createState = internalMutation({
  args: {
    ownerId: v.id("users"),
    provider: providerValidator,
    stateHash: v.string(),
    codeVerifierCiphertext: v.string(),
    redirectUri: v.string(),
    expiresAt: v.number(),
  },
  returns: v.id("providerOAuthStates"),
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.expiresAt <= now || args.expiresAt > now + 10 * 60 * 1_000) {
      throw new ConvexError({ code: "INVALID_EXPIRY", message: "OAuth state must expire within 10 minutes" });
    }
    if (!args.redirectUri.startsWith("https://") || args.redirectUri.length > 500) {
      throw new ConvexError({ code: "INVALID_REDIRECT", message: "OAuth redirect URI is invalid" });
    }
    const existing = await ctx.db
      .query("providerOAuthStates")
      .withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (existing) throw new ConvexError({ code: "STATE_COLLISION", message: "OAuth state collision" });
    return await ctx.db.insert("providerOAuthStates", {
      ...args,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const consumeState = internalMutation({
  args: { provider: providerValidator, stateHash: v.string() },
  returns: v.object({
    ownerId: v.id("users"),
    codeVerifierCiphertext: v.string(),
    redirectUri: v.string(),
  }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("providerOAuthStates")
      .withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    const now = Date.now();
    if (!row || row.provider !== args.provider || row.status !== "pending") {
      throw new ConvexError({ code: "INVALID_OAUTH_STATE", message: "OAuth state is invalid or already used" });
    }
    if (row.expiresAt <= now) {
      await ctx.db.patch(row._id, { status: "expired", updatedAt: now });
      throw new ConvexError({ code: "EXPIRED_OAUTH_STATE", message: "OAuth state has expired" });
    }
    await ctx.db.patch(row._id, { status: "consumed", updatedAt: now });
    return {
      ownerId: row.ownerId,
      codeVerifierCiphertext: row.codeVerifierCiphertext,
      redirectUri: row.redirectUri,
    };
  },
});

export const finalizeConnection = internalMutation({
  args: {
    ownerId: v.id("users"),
    provider: providerValidator,
    accessTokenCiphertext: v.string(),
    refreshTokenCiphertext: v.optional(v.string()),
    externalAccountRefCiphertext: v.optional(v.string()),
    tokenType: v.string(),
    scopes: v.array(v.string()),
    externalAccountIdHash: v.string(),
    accountLabel: v.string(),
    expiresAt: v.optional(v.number()),
  },
  returns: v.id("serviceConnections"),
  handler: async (ctx, args) => {
    if (args.accountLabel.length < 1 || args.accountLabel.length > 160) {
      throw new ConvexError({ code: "INVALID_ACCOUNT", message: "Provider account label is invalid" });
    }
    if (args.scopes.length > 100 || args.scopes.some((scope) => scope.length < 1 || scope.length > 160)) {
      throw new ConvexError({ code: "INVALID_SCOPES", message: "Provider scopes are invalid" });
    }
    const owner = await ctx.db.get(args.ownerId);
    if (!owner || owner.status !== "active") {
      throw new ConvexError({ code: "USER_NOT_FOUND", message: "User not found" });
    }
    const now = Date.now();
    const credential = await ctx.db
      .query("providerCredentials")
      .withIndex("by_owner_id_and_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
    const credentialValue = {
      accessTokenCiphertext: args.accessTokenCiphertext,
      refreshTokenCiphertext: args.refreshTokenCiphertext,
      externalAccountRefCiphertext: args.externalAccountRefCiphertext,
      tokenType: args.tokenType,
      scopes: args.scopes,
      externalAccountIdHash: args.externalAccountIdHash,
      expiresAt: args.expiresAt,
      updatedAt: now,
    };
    const credentialId = credential
      ? (await ctx.db.patch(credential._id, credentialValue), credential._id)
      : await ctx.db.insert("providerCredentials", {
          ownerId: args.ownerId,
          provider: args.provider,
          ...credentialValue,
          createdAt: now,
        });
    const connection = await ctx.db
      .query("serviceConnections")
      .withIndex("by_owner_id_and_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
    const connectionValue = {
      status: "connected" as const,
      externalAccountIdHash: args.externalAccountIdHash,
      accountLabel: args.accountLabel,
      scopes: args.scopes,
      credentialRef: String(credentialId),
      lastCheckedAt: now,
      expiresAt: args.expiresAt,
      revokedAt: undefined,
      updatedAt: now,
    };
    const connectionId = connection
      ? (await ctx.db.patch(connection._id, connectionValue), connection._id)
      : await ctx.db.insert("serviceConnections", {
          ownerId: args.ownerId,
          provider: args.provider,
          ...connectionValue,
          createdAt: now,
        });
    await writeAudit(ctx, {
      ownerId: args.ownerId,
      actor: "user",
      action: "provider_connection.connected",
      targetType: "service_connection",
      targetId: connectionId,
      outcome: "succeeded",
      metadataJson: JSON.stringify({ provider: args.provider }),
      now,
    });
    return connectionId;
  },
});

export const loadCredential = internalQuery({
  args: { ownerId: v.id("users"), provider: providerValidator },
  returns: v.union(
    v.null(),
    v.object({
      accessTokenCiphertext: v.string(),
      refreshTokenCiphertext: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("providerCredentials")
      .withIndex("by_owner_id_and_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
    return row
      ? { accessTokenCiphertext: row.accessTokenCiphertext, refreshTokenCiphertext: row.refreshTokenCiphertext }
      : null;
  },
});

export const loadGitHubInstallationBinding = internalQuery({
  args: { ownerId: v.id("users"), projectId: v.id("projects") },
  returns: v.union(
    v.object({ status: v.literal("missing") }),
    v.object({ status: v.literal("reauth") }),
    v.object({
      status: v.literal("ok"),
      externalAccountRefCiphertext: v.string(),
      repositoryId: v.string(),
      repositoryFullName: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const [owner, project, connection, credential] = await Promise.all([
      ctx.db.get(args.ownerId),
      ctx.db.get(args.projectId),
      ctx.db
        .query("serviceConnections")
        .withIndex("by_owner_id_and_provider", (q) =>
          q.eq("ownerId", args.ownerId).eq("provider", "github"),
        )
        .unique(),
      ctx.db
        .query("providerCredentials")
        .withIndex("by_owner_id_and_provider", (q) =>
          q.eq("ownerId", args.ownerId).eq("provider", "github"),
        )
        .unique(),
    ]);
    if (!owner || owner.status !== "active" || !project || project.ownerId !== args.ownerId || project.status !== "active") {
      throw new ConvexError({ code: "INVALID_CREDENTIAL_SCOPE", message: "Credential scope is invalid" });
    }
    if (!connection) return { status: "missing" as const };
    if (
      connection.status !== "connected" ||
      connection.revokedAt !== undefined ||
      (connection.expiresAt !== undefined && connection.expiresAt <= Date.now()) ||
      !credential ||
      connection.credentialRef !== String(credential._id) ||
      connection.externalAccountIdHash !== credential.externalAccountIdHash ||
      (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) ||
      !credential.externalAccountRefCiphertext
    ) {
      return { status: "reauth" as const };
    }
    return {
      status: "ok" as const,
      externalAccountRefCiphertext: credential.externalAccountRefCiphertext,
      repositoryId: project.githubRepositoryId,
      repositoryFullName: project.githubRepositoryFullName,
    };
  },
});

export const revokeConnection = internalMutation({
  args: { ownerId: v.id("users"), provider: providerValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const credential = await ctx.db
      .query("providerCredentials")
      .withIndex("by_owner_id_and_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
    if (credential) await ctx.db.delete(credential._id);
    const connection = await ctx.db
      .query("serviceConnections")
      .withIndex("by_owner_id_and_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
    if (connection) {
      await ctx.db.patch(connection._id, {
        status: "revoked",
        credentialRef: undefined,
        expiresAt: undefined,
        revokedAt: now,
        updatedAt: now,
      });
    }
    await writeAudit(ctx, {
      ownerId: args.ownerId,
      actor: "user",
      action: "provider_connection.revoked",
      targetType: "service_connection",
      targetId: connection?._id,
      outcome: "succeeded",
      metadataJson: JSON.stringify({ provider: args.provider }),
      now,
    });
    return null;
  },
});
