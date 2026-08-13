export const RUN_STATUSES = [
  "queued",
  "provisioning",
  "running",
  "verifying",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "needs_attention",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

const ACTIVE_RUN_STATUSES = new Set<RunStatus>([
  "queued",
  "provisioning",
  "running",
  "verifying",
  "awaiting_approval",
]);

const RUN_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  queued: new Set(["provisioning", "cancelled", "failed", "needs_attention"]),
  provisioning: new Set(["running", "cancelled", "failed", "needs_attention"]),
  running: new Set(["verifying", "cancelled", "failed", "needs_attention"]),
  verifying: new Set([
    "awaiting_approval",
    "succeeded",
    "failed",
    "cancelled",
    "needs_attention",
  ]),
  awaiting_approval: new Set([
    "succeeded",
    "failed",
    "cancelled",
    "needs_attention",
  ]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  needs_attention: new Set(),
};

export function isActiveRunStatus(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].has(to);
}

export function quotaDecision(
  consumed: number,
  limit: number,
  requested: number,
): { allowed: boolean; remaining: number } {
  if (!Number.isSafeInteger(consumed) || consumed < 0) {
    throw new Error("Consumed quota must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("Quota limit must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error("Requested quota must be a positive safe integer");
  }
  const remaining = Math.max(0, limit - consumed);
  return { allowed: requested <= remaining, remaining: Math.max(0, remaining - (requested <= remaining ? requested : 0)) };
}
