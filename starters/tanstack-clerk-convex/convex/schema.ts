import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    name: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_token_identifier", ["tokenIdentifier"]),

  projects: defineTable({
    ownerTokenIdentifier: v.string(),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("archived")),
    updatedAt: v.number(),
  }).index("by_owner_token_identifier", ["ownerTokenIdentifier"]),
});
