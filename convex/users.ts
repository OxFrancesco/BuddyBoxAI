import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireCurrentUser } from "./lib/auth";
import { requireBoundedString } from "./lib/bounds";
import { writeAudit } from "./lib/audit";
import { userStatusValidator } from "./modelValidators";

const publicUserValidator = v.object({
  _id: v.id("users"),
  _creationTime: v.number(),
  displayName: v.optional(v.string()),
  primaryEmail: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  status: userStatusValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
});

function publicUser(user: Doc<"users">) {
  return {
    _id: user._id,
    _creationTime: user._creationTime,
    displayName: user.displayName,
    primaryEmail: user.primaryEmail,
    imageUrl: user.imageUrl,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export const syncCurrent = mutation({
  args: {
    displayName: v.optional(v.string()),
    primaryEmail: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  returns: publicUserValidator,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("users")
      .withIndex("by_token_identifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
    const displayName = args.displayName
      ? requireBoundedString(args.displayName, "displayName", 120)
      : undefined;
    const primaryEmail = args.primaryEmail?.trim().toLowerCase();
    if (existing) {
      if (existing.status === "deleted") {
        throw new ConvexError({
          code: "ACCOUNT_DELETED",
          message: "This User has been deleted",
        });
      }
      await ctx.db.patch(existing._id, {
        displayName,
        primaryEmail,
        imageUrl: args.imageUrl,
        updatedAt: now,
      });
      return publicUser({
        ...existing,
        displayName,
        primaryEmail,
        imageUrl: args.imageUrl,
        updatedAt: now,
      });
    }
    const sameSubject = await ctx.db
      .query("users")
      .withIndex("by_auth_subject", (q) => q.eq("authSubject", identity.subject))
      .unique();
    if (sameSubject) {
      throw new ConvexError({
        code: "IDENTITY_CONFLICT",
        message: "The authenticated subject is already registered",
      });
    }
    const id = await ctx.db.insert("users", {
      authSubject: identity.subject,
      tokenIdentifier: identity.tokenIdentifier,
      displayName,
      primaryEmail,
      imageUrl: args.imageUrl,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const user = await ctx.db.get(id);
    if (!user) throw new Error("Inserted User could not be read");
    await writeAudit(ctx, {
      ownerId: id,
      actor: "user",
      action: "user.created",
      targetType: "user",
      targetId: id,
      outcome: "succeeded",
      now,
    });
    return publicUser(user);
  },
});

export const getCurrent = query({
  args: {},
  returns: publicUserValidator,
  handler: async (ctx) => publicUser(await requireCurrentUser(ctx)),
});
