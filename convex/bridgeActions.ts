import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { randomToken, sha256 } from "./lib/bridgeCrypto";

const CHALLENGE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const attachImessageClaim = action({
  args: { claimToken: v.string() },
  returns: v.object({
    connectionId: v.id("imessageConnections"),
    challengeCode: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args): Promise<{
    connectionId: Id<"imessageConnections">;
    challengeCode: string;
    expiresAt: number;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in before claiming iMessage" });
    }
    const claimToken = args.claimToken.trim();
    if (claimToken.length < 24 || claimToken.length > 128) {
      throw new ConvexError({ code: "INVALID_CLAIM", message: "Claim token is invalid" });
    }
    const random = randomToken(8).replaceAll(/[^A-Z2-9]/gi, "").toUpperCase();
    let challengeCode = "";
    for (let index = 0; index < 8; index += 1) {
      const value = random.charCodeAt(index % Math.max(random.length, 1)) || index;
      challengeCode += CHALLENGE_ALPHABET[value % CHALLENGE_ALPHABET.length];
    }
    const expiresAt = Date.now() + 10 * 60 * 1_000;
    const result: { connectionId: Id<"imessageConnections">; expiresAt: number } =
      await ctx.runMutation(internal.bridge.attachClaim, {
      tokenHash: await sha256(claimToken),
      tokenIdentifier: identity.tokenIdentifier,
      challengeHash: await sha256(challengeCode),
      expiresAt,
      });
    return { ...result, challengeCode, expiresAt };
  },
});

export const attachXchatClaim = action({
  args: { claimToken: v.string() },
  returns: v.object({
    connectionId: v.id("xchatConnections"),
    challengeCode: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args): Promise<{
    connectionId: Id<"xchatConnections">;
    challengeCode: string;
    expiresAt: number;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHENTICATED",
        message: "Sign in before claiming X Chat",
      });
    }
    const claimToken = args.claimToken.trim();
    if (claimToken.length < 24 || claimToken.length > 128) {
      throw new ConvexError({ code: "INVALID_CLAIM", message: "Claim token is invalid" });
    }
    const random = randomToken(8).replaceAll(/[^A-Z2-9]/gi, "").toUpperCase();
    let challengeCode = "";
    for (let index = 0; index < 8; index += 1) {
      const value = random.charCodeAt(index % Math.max(random.length, 1)) || index;
      challengeCode += CHALLENGE_ALPHABET[value % CHALLENGE_ALPHABET.length];
    }
    const expiresAt = Date.now() + 10 * 60_000;
    const result: { connectionId: Id<"xchatConnections">; expiresAt: number } =
      await ctx.runMutation(internal.xchat.attachClaim, {
        tokenHash: await sha256(claimToken),
        authSubject: identity.subject,
        challengeHash: await sha256(challengeCode),
        expiresAt,
      });
    return { ...result, challengeCode, expiresAt };
  },
});
