"use node";

import {
  AesGcmSecretVault,
  CodexConnectionManager,
  OpenAiCodexAuthClient,
  type CodexConnectionRepository,
  type DeviceConnectionStatus,
  type PersistedCodexConnection,
} from "@buddybox/codex-connection";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";

const connectionStatus = v.union(
  v.object({ state: v.literal("disconnected") }),
  v.object({
    state: v.literal("pending"),
    sessionId: v.string(),
    userCode: v.string(),
    verificationUri: v.string(),
    expiresAt: v.number(),
    retryAfterMs: v.number(),
  }),
  v.object({ state: v.literal("busy"), retryAfterMs: v.number() }),
  v.object({ state: v.literal("connected") }),
  v.object({ state: v.literal("failed"), code: v.string() }),
);

async function currentOwner(ctx: ActionCtx): Promise<Id<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Authentication required" });
  const owner: { ownerId: Id<"users"> } = await ctx.runQuery(internal.codexStore.ownerForToken, {
    tokenIdentifier: identity.tokenIdentifier,
  });
  return owner.ownerId;
}

async function managerFor(ctx: ActionCtx): Promise<CodexConnectionManager> {
  const key = process.env.BUDDYBOX_CODEX_CREDENTIAL_KEY;
  if (!key) throw new Error("BUDDYBOX_CODEX_CREDENTIAL_KEY is not configured");
  const repository: CodexConnectionRepository = {
    async load(userId) {
      const stored: { revision: number; valueJson: string } | null = await ctx.runQuery(
        internal.codexStore.load,
        { ownerId: userId as Id<"users"> },
      );
      if (!stored) return null;
      return { revision: stored.revision, value: JSON.parse(stored.valueJson) as PersistedCodexConnection };
    },
    async commit(userId, expectedRevision, next) {
      return await ctx.runMutation(internal.codexStore.commit, {
        ownerId: userId as Id<"users">,
        expectedRevision,
        valueJson: next === null ? null : JSON.stringify(next),
      });
    },
  };
  return new CodexConnectionManager({
    client: new OpenAiCodexAuthClient(),
    repository,
    vault: await AesGcmSecretVault.fromBase64Key(key),
  });
}

async function syncServiceStatus(ctx: ActionCtx, ownerId: Id<"users">, status: DeviceConnectionStatus) {
  if (status.state !== "connected") return;
  await ctx.runMutation(internal.connections.setServiceConnection, {
    ownerId,
    provider: "chatgpt",
    status: "connected",
    scopes: ["codex:responses"],
  });
}

export const status = action({
  args: {},
  returns: connectionStatus,
  handler: async (ctx): Promise<DeviceConnectionStatus> => {
    const ownerId = await currentOwner(ctx);
    const result = await (await managerFor(ctx)).status(ownerId);
    await syncServiceStatus(ctx, ownerId, result);
    return result;
  },
});

export const start = action({
  args: {},
  returns: connectionStatus,
  handler: async (ctx): Promise<DeviceConnectionStatus> => {
    const ownerId = await currentOwner(ctx);
    const result = await (await managerFor(ctx)).start(ownerId);
    await syncServiceStatus(ctx, ownerId, result);
    return result;
  },
});

export const poll = action({
  args: { sessionId: v.string() },
  returns: connectionStatus,
  handler: async (ctx, args): Promise<DeviceConnectionStatus> => {
    const ownerId = await currentOwner(ctx);
    const result = await (await managerFor(ctx)).poll(ownerId, args.sessionId);
    await syncServiceStatus(ctx, ownerId, result);
    return result;
  },
});

export const revoke = action({
  args: {},
  returns: v.object({
    local: v.literal("revoked"),
    upstream: v.union(v.literal("revoked"), v.literal("unsupported"), v.literal("failed")),
  }),
  handler: async (ctx) => {
    const ownerId = await currentOwner(ctx);
    const result = await (await managerFor(ctx)).revoke(ownerId);
    await ctx.runMutation(internal.connections.setServiceConnection, {
      ownerId,
      provider: "chatgpt",
      status: "revoked",
      scopes: [],
    });
    return result;
  },
});

export const resolveAccessInternal = internalAction({
  args: { ownerId: v.id("users") },
  returns: v.union(
    v.object({ status: v.literal("ok"), accessToken: v.string(), expiresAt: v.number() }),
    v.object({ status: v.union(v.literal("missing"), v.literal("reauth")) }),
    v.object({ status: v.union(v.literal("busy"), v.literal("unavailable")), retryAfterMs: v.number() }),
  ),
  handler: async (ctx, args) => await (await managerFor(ctx)).resolveAccess(args.ownerId),
});
