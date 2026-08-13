import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type AuthenticatedCtx = QueryCtx | MutationCtx;

export async function requireCurrentUser(
  ctx: AuthenticatedCtx,
): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_token_identifier", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
  if (!user) {
    throw new ConvexError({
      code: "USER_NOT_READY",
      message: "Create or restore the authenticated User first",
    });
  }
  if (user.status === "deleted") {
    throw new ConvexError({
      code: "ACCOUNT_DELETED",
      message: "This User has been deleted",
    });
  }
  if (user.status === "deleting") {
    throw new ConvexError({
      code: "ACCOUNT_DELETING",
      message: "This account is being deleted",
    });
  }
  return user;
}

export function assertOwner(
  ownerId: Id<"users">,
  resourceOwnerId: Id<"users">,
): void {
  if (ownerId !== resourceOwnerId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Resource not found",
    });
  }
}

export function assertActiveUser(user: Doc<"users">): void {
  if (user.status !== "active") {
    throw new ConvexError({
      code: "ACCOUNT_UNAVAILABLE",
      message: "The User is not active",
    });
  }
}
