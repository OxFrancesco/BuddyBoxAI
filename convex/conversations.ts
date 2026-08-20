import { ConvexError, v } from "convex/values";

import { internalMutation, query } from "./_generated/server";
import { assertOwner, requireCurrentUser } from "./lib/auth";
import { boundedLimit, requireBoundedString } from "./lib/bounds";
import { channelValidator, conversationStatusValidator } from "./modelValidators";

const conversationValidator = v.object({
  _id: v.id("conversations"),
  _creationTime: v.number(),
  projectId: v.optional(v.id("projects")),
  imessageConnectionId: v.optional(v.id("imessageConnections")),
  xchatConnectionId: v.optional(v.id("xchatConnections")),
  channel: v.optional(channelValidator),
  status: conversationStatusValidator,
  title: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const openForChannel = internalMutation({
  args: {
    ownerId: v.id("users"),
    projectId: v.optional(v.id("projects")),
    imessageConnectionId: v.id("imessageConnections"),
    title: v.optional(v.string()),
  },
  returns: v.id("conversations"),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.imessageConnectionId);
    if (!connection || connection.ownerId !== args.ownerId || connection.status !== "verified") {
      throw new ConvexError({ code: "INVALID_CONNECTION", message: "Verified iMessage Connection required" });
    }
    if (args.projectId) {
      const project = await ctx.db.get(args.projectId);
      if (!project) throw new ConvexError({ code: "NOT_FOUND", message: "Project not found" });
      assertOwner(args.ownerId, project.ownerId);
    }
    const now = Date.now();
    return await ctx.db.insert("conversations", {
      ownerId: args.ownerId,
      projectId: args.projectId,
      imessageConnectionId: args.imessageConnectionId,
      channel: "imessage",
      status: "open",
      title: args.title ? requireBoundedString(args.title, "title", 160) : undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listMine = query({
  args: { projectId: v.optional(v.id("projects")), limit: v.optional(v.number()) },
  returns: v.array(conversationValidator),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const limit = boundedLimit(args.limit);
    const rows = args.projectId
      ? await ctx.db.query("conversations")
          .withIndex("by_owner_id_and_project_id_and_updated_at", (q) =>
            q.eq("ownerId", user._id).eq("projectId", args.projectId),
          ).order("desc").take(limit)
      : await ctx.db.query("conversations")
          .withIndex("by_owner_id_and_updated_at", (q) => q.eq("ownerId", user._id))
          .order("desc").take(limit);
    return rows.map(({ _id, _creationTime, projectId, imessageConnectionId, xchatConnectionId, channel, status, title, createdAt, updatedAt }) => ({
      _id, _creationTime, projectId, imessageConnectionId, xchatConnectionId, channel, status, title, createdAt, updatedAt,
    }));
  },
});
