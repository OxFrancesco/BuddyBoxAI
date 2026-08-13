import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { AUDIT_RETENTION_MS } from "./bounds";

export async function writeAudit(
  ctx: MutationCtx,
  input: {
    ownerId?: Id<"users">;
    actor: "user" | "system" | "imessage" | "gateway";
    action: string;
    targetType: string;
    targetId?: string;
    outcome: "accepted" | "rejected" | "succeeded" | "failed";
    metadataJson?: string;
    now: number;
  },
): Promise<void> {
  const { now, ...event } = input;
  await ctx.db.insert("auditHistory", {
    ...event,
    occurredAt: now,
    expiresAt: now + AUDIT_RETENTION_MS,
  });
}
