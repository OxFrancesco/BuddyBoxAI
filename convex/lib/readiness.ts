import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const REQUIRED_PROJECT_PROVIDERS = [
  "chatgpt",
  "github",
  "convex",
] as const;

export async function projectReadiness(
  ctx: QueryCtx | MutationCtx,
  ownerId: Id<"users">,
): Promise<{
  ready: boolean;
  missing: Array<"messaging" | (typeof REQUIRED_PROJECT_PROVIDERS)[number]>;
}> {
  const verifiedAddress = await ctx.db
    .query("imessageConnections")
    .withIndex("by_owner_id_and_status", (q) =>
      q.eq("ownerId", ownerId).eq("status", "verified"),
    )
    .first();
  const verifiedXChat = await ctx.db
    .query("xchatConnections")
    .withIndex("by_owner_id_and_status", (q) =>
      q.eq("ownerId", ownerId).eq("status", "verified"),
    )
    .first();
  const missing: Array<
    "messaging" | (typeof REQUIRED_PROJECT_PROVIDERS)[number]
  > = [];
  const now = Date.now();
  if (!verifiedAddress && !verifiedXChat) missing.push("messaging");
  for (const provider of REQUIRED_PROJECT_PROVIDERS) {
    const connection = await ctx.db
      .query("serviceConnections")
      .withIndex("by_owner_id_and_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", provider),
      )
      .unique();
    let healthy = Boolean(
      connection &&
      connection.status === "connected" &&
      connection.revokedAt === undefined &&
      (connection.expiresAt === undefined || connection.expiresAt > now),
    );
    if (healthy && provider !== "chatgpt") {
      const credential = await ctx.db
        .query("providerCredentials")
        .withIndex("by_owner_id_and_provider", (q) =>
          q.eq("ownerId", ownerId).eq("provider", provider),
        )
        .unique();
      healthy = Boolean(
        credential &&
        connection?.credentialRef === String(credential._id) &&
        connection.externalAccountIdHash !== undefined &&
        connection.externalAccountIdHash === credential.externalAccountIdHash &&
        (credential.expiresAt === undefined || credential.expiresAt > now),
      );
    }
    if (!healthy) {
      missing.push(provider);
    }
  }
  return { ready: missing.length === 0, missing };
}
