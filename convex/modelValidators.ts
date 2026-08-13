import { v } from "convex/values";

export const userStatusValidator = v.union(
  v.literal("active"),
  v.literal("deleting"),
  v.literal("deleted"),
);

export const iMessageConnectionStatusValidator = v.union(
  v.literal("pending"),
  v.literal("challenge_sent"),
  v.literal("verified"),
  v.literal("revoked"),
);

export const serviceProviderValidator = v.union(
  v.literal("chatgpt"),
  v.literal("github"),
  v.literal("cloudflare"),
  v.literal("convex"),
  v.literal("clerk"),
  v.literal("openrouter"),
);

export const serviceConnectionStatusValidator = v.union(
  v.literal("pending"),
  v.literal("connected"),
  v.literal("needs_reauth"),
  v.literal("revoked"),
);

export const projectStatusValidator = v.union(
  v.literal("active"),
  v.literal("archived"),
  v.literal("deleting"),
  v.literal("deleted"),
);

export const proposedProjectStatusValidator = v.union(
  v.literal("draft"),
  v.literal("awaiting_approval"),
  v.literal("confirmed"),
  v.literal("abandoned"),
  v.literal("expired"),
);

export const conversationStatusValidator = v.union(
  v.literal("open"),
  v.literal("archived"),
);

export const runStatusValidator = v.union(
  v.literal("queued"),
  v.literal("provisioning"),
  v.literal("running"),
  v.literal("verifying"),
  v.literal("awaiting_approval"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("needs_attention"),
);

export const runOutcomeValidator = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("needs_attention"),
);

export const runEventKindValidator = v.union(
  v.literal("admitted"),
  v.literal("status_changed"),
  v.literal("agent"),
  v.literal("tool"),
  v.literal("verification"),
  v.literal("checkpoint"),
  v.literal("preview"),
  v.literal("approval"),
  v.literal("warning"),
  v.literal("error"),
);

export const runEventLevelValidator = v.union(
  v.literal("debug"),
  v.literal("info"),
  v.literal("warning"),
  v.literal("error"),
);

export const sandboxLeaseStatusValidator = v.union(
  v.literal("provisioning"),
  v.literal("active"),
  v.literal("checkpointing"),
  v.literal("released"),
  v.literal("lost"),
);

export const previewStatusValidator = v.union(
  v.literal("provisioning"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("expired"),
  v.literal("deleted"),
);

export const approvalOperationValidator = v.union(
  v.literal("confirm_project"),
  v.literal("merge_run"),
  v.literal("publish_release"),
  v.literal("rollback_release"),
  v.literal("delete_project"),
  v.literal("delete_account"),
);

export const approvalStatusValidator = v.union(
  v.literal("pending"),
  v.literal("consumed"),
  v.literal("expired"),
  v.literal("revoked"),
);

export const releaseStatusValidator = v.union(
  v.literal("deploying"),
  v.literal("live"),
  v.literal("superseded"),
  v.literal("failed"),
  v.literal("rolled_back"),
);

export const deliveryDirectionValidator = v.union(
  v.literal("inbound"),
  v.literal("outbound"),
);

export const deliveryStatusValidator = v.union(
  v.literal("received"),
  v.literal("accepted"),
  v.literal("duplicate"),
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("failed"),
);

export const usageKindValidator = v.union(
  v.literal("runs"),
  v.literal("sandbox_seconds"),
  v.literal("model_tokens"),
  v.literal("preview_minutes"),
  v.literal("messages"),
);

export const deletionStatusValidator = v.union(
  v.literal("awaiting_confirmation"),
  v.literal("revoking_services"),
  v.literal("purging"),
  v.literal("tombstoned"),
  v.literal("complete"),
  v.literal("failed"),
);

export const deletionStageValidator = v.union(
  v.literal("approvals"),
  v.literal("runtime"),
  v.literal("projects"),
  v.literal("connections"),
  v.literal("account"),
  v.literal("done"),
);

export const auditActorValidator = v.union(
  v.literal("user"),
  v.literal("system"),
  v.literal("imessage"),
  v.literal("gateway"),
);

export const auditOutcomeValidator = v.union(
  v.literal("accepted"),
  v.literal("rejected"),
  v.literal("succeeded"),
  v.literal("failed"),
);
