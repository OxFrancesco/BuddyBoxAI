import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const REQUIRED_PROJECT_PROVIDERS = [
  "chatgpt",
  "github",
  "cloudflare",
  "convex",
] as const;

export async function projectReadiness(
  ctx: QueryCtx | MutationCtx,
  ownerId: Id<"users">,
): Promise<{
  ready: boolean;
  missing: Array<"imessage" | (typeof REQUIRED_PROJECT_PROVIDERS)[number]>;
}> {
  const verifiedAddress = await ctx.db
    .query("imessageConnections")
    .withIndex("by_owner_id_and_status", (q) =>
      q.eq("ownerId", ownerId).eq("status", "verified"),
    )
    .first();
  const missing: Array<
    "imessage" | (typeof REQUIRED_PROJECT_PROVIDERS)[number]
  > = [];
  if (!verifiedAddress) missing.push("imessage");
  for (const provider of REQUIRED_PROJECT_PROVIDERS) {
    const connection = await ctx.db
      .query("serviceConnections")
      .withIndex("by_owner_id_and_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", provider),
      )
      .unique();
    if (!connection || connection.status !== "connected") {
      missing.push(provider);
    }
  }
  return { ready: missing.length === 0, missing };
}
