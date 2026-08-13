import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { normalizeProjectName } from "./projectPolicy";

const projectSummary = v.object({
  _id: v.id("projects"),
  _creationTime: v.number(),
  name: v.string(),
  status: v.union(v.literal("active"), v.literal("archived")),
  updatedAt: v.number(),
});

async function requireIdentity(ctx: { auth: { getUserIdentity: () => Promise<null | { tokenIdentifier: string; name?: string }> } }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  return identity;
}

export const list = query({
  args: {},
  returns: v.array(projectSummary),
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner_token_identifier", (q) => q.eq("ownerTokenIdentifier", identity.tokenIdentifier))
      .order("desc")
      .take(24);

    return projects.map(({ _id, _creationTime, name, status, updatedAt }) => ({
      _id,
      _creationTime,
      name,
      status,
      updatedAt,
    }));
  },
});

export const create = mutation({
  args: { name: v.string() },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const now = Date.now();
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_token_identifier", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    if (!existingUser) {
      await ctx.db.insert("users", {
        tokenIdentifier: identity.tokenIdentifier,
        ...(identity.name ? { name: identity.name } : {}),
        createdAt: now,
      });
    }

    return ctx.db.insert("projects", {
      ownerTokenIdentifier: identity.tokenIdentifier,
      name: normalizeProjectName(args.name),
      status: "active",
      updatedAt: now,
    });
  },
});
