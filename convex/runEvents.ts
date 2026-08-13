import { ConvexError, v } from "convex/values";

import { internalMutation, query } from "./_generated/server";
import { requireCurrentUser } from "./lib/auth";
import {
  boundedLimit,
  MAX_EVENT_SUMMARY_LENGTH,
  RAW_EVENT_RETENTION_MS,
  requireBoundedString,
  requireDataJson,
} from "./lib/bounds";
import { runEventKindValidator, runEventLevelValidator } from "./modelValidators";

const eventValidator = v.object({
  _id: v.id("runEvents"),
  _creationTime: v.number(),
  runId: v.id("runs"),
  eventId: v.string(),
  sequence: v.number(),
  kind: runEventKindValidator,
  level: runEventLevelValidator,
  summary: v.string(),
  dataJson: v.optional(v.string()),
  occurredAt: v.number(),
});

export const append = internalMutation({
  args: {
    ownerId: v.id("users"),
    runId: v.id("runs"),
    eventId: v.string(),
    sequence: v.number(),
    kind: runEventKindValidator,
    level: runEventLevelValidator,
    summary: v.string(),
    dataJson: v.optional(v.string()),
    occurredAt: v.number(),
  },
  returns: v.object({ eventRecordId: v.id("runEvents"), duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    const duplicate = await ctx.db.query("runEvents")
      .withIndex("by_owner_id_and_event_id", (q) =>
        q.eq("ownerId", args.ownerId).eq("eventId", args.eventId),
      ).unique();
    if (duplicate) {
      if (duplicate.runId !== args.runId || duplicate.sequence !== args.sequence) {
        throw new ConvexError({ code: "EVENT_ID_CONFLICT", message: "Event identity was reused with different content" });
      }
      return { eventRecordId: duplicate._id, duplicate: true };
    }
    const run = await ctx.db.get(args.runId);
    if (!run || run.ownerId !== args.ownerId) throw new ConvexError({ code: "RUN_NOT_FOUND", message: "Run not found" });
    if (!Number.isSafeInteger(args.sequence) || args.sequence < 0) {
      throw new ConvexError({ code: "INVALID_SEQUENCE", message: "Event sequence must be a non-negative integer" });
    }
    const last = await ctx.db.query("runEvents")
      .withIndex("by_run_id_and_sequence", (q) => q.eq("runId", run._id))
      .order("desc").first();
    const expected = (last?.sequence ?? -1) + 1;
    if (args.sequence !== expected) {
      throw new ConvexError({ code: "EVENT_SEQUENCE_GAP", message: `Expected event sequence ${expected}` });
    }
    requireDataJson(args.dataJson);
    const eventRecordId = await ctx.db.insert("runEvents", {
      ownerId: args.ownerId,
      runId: run._id,
      eventId: requireBoundedString(args.eventId, "eventId", 200),
      sequence: args.sequence,
      kind: args.kind,
      level: args.level,
      summary: requireBoundedString(args.summary, "summary", MAX_EVENT_SUMMARY_LENGTH),
      dataJson: args.dataJson,
      occurredAt: args.occurredAt,
      expiresAt: args.occurredAt + RAW_EVENT_RETENTION_MS,
    });
    return { eventRecordId, duplicate: false };
  },
});

export const listMine = query({
  args: {
    runId: v.id("runs"),
    afterSequence: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.array(eventValidator),
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run || run.ownerId !== user._id) return [];
    const after = args.afterSequence ?? -1;
    const events = await ctx.db.query("runEvents")
      .withIndex("by_run_id_and_sequence", (q) =>
        q.eq("runId", run._id).gt("sequence", after),
      ).take(boundedLimit(args.limit));
    return events.map(({ _id, _creationTime, runId, eventId, sequence, kind, level, summary, dataJson, occurredAt }) => ({
      _id, _creationTime, runId, eventId, sequence, kind, level, summary, dataJson, occurredAt,
    }));
  },
});
