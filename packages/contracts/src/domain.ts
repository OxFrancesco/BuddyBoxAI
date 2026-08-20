import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });
const entityId = (prefix: string) =>
  z
    .string()
    .min(1)
    .max(128)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9._:-]+$`), `must start with ${prefix}`);

export const userIdSchema = entityId("user_");
export const iMessageConnectionIdSchema = entityId("imessage_");
export const xChatConnectionIdSchema = entityId("xchat_");
export const serviceConnectionIdSchema = entityId("service_");
export const proposedProjectIdSchema = entityId("proposal_");
export const projectIdSchema = entityId("project_");
export const conversationIdSchema = entityId("conversation_");
export const runIdSchema = entityId("run_");
export const previewIdSchema = entityId("preview_");
export const releaseIdSchema = entityId("release_");
export const approvalIdSchema = entityId("approval_");

const timestamps = {
  createdAt: timestamp,
  updatedAt: timestamp,
};

export const userSchema = z
  .object({
    id: userIdSchema,
    clerkUserId: z.string().min(1).max(128),
    status: z.enum(["invited", "active", "suspended", "deleting", "deleted"]),
    displayName: z.string().min(1).max(100).optional(),
    ...timestamps,
  })
  .strict();

export type User = z.infer<typeof userSchema>;

export const iMessageConnectionSchema = z
  .object({
    id: iMessageConnectionIdSchema,
    userId: userIdSchema,
    address: z.string().min(3).max(320),
    status: z.enum(["pending", "verified", "revoked"]),
    verifiedAt: timestamp.nullable().optional(),
    ...timestamps,
  })
  .strict()
  .superRefine((connection, context) => {
    if (connection.status === "verified" && !connection.verifiedAt) {
      context.addIssue({ code: "custom", path: ["verifiedAt"], message: "a verified iMessage Connection needs verifiedAt" });
    }
    if (connection.status === "pending" && connection.verifiedAt) {
      context.addIssue({ code: "custom", path: ["verifiedAt"], message: "a pending iMessage Connection is not verified" });
    }
  });

export type IMessageConnection = z.infer<typeof iMessageConnectionSchema>;

export const xChatConnectionSchema = z
  .object({
    id: xChatConnectionIdSchema,
    userId: userIdSchema,
    accountIdHash: z.string().min(16).max(255),
    status: z.enum(["pending", "verified", "revoked"]),
    verifiedAt: timestamp.nullable().optional(),
    ...timestamps,
  })
  .strict()
  .superRefine((connection, context) => {
    if (connection.status === "verified" && !connection.verifiedAt) {
      context.addIssue({ code: "custom", path: ["verifiedAt"], message: "a verified X Chat Connection needs verifiedAt" });
    }
    if (connection.status === "pending" && connection.verifiedAt) {
      context.addIssue({ code: "custom", path: ["verifiedAt"], message: "a pending X Chat Connection is not verified" });
    }
  });

export type XChatConnection = z.infer<typeof xChatConnectionSchema>;

export const serviceProviderSchema = z.enum(["chatgpt", "github", "cloudflare", "convex", "openrouter"]);
export type ServiceProvider = z.infer<typeof serviceProviderSchema>;

export const serviceConnectionSchema = z
  .object({
    id: serviceConnectionIdSchema,
    userId: userIdSchema,
    provider: serviceProviderSchema,
    externalAccountId: z.string().min(1).max(255),
    status: z.enum(["pending", "healthy", "action-required", "revoked"]),
    scopes: z.array(z.string().min(1).max(255)).max(100),
    connectedAt: timestamp,
    lastCheckedAt: timestamp.nullable(),
    ...timestamps,
  })
  .strict();

export type ServiceConnection = z.infer<typeof serviceConnectionSchema>;

export const REQUIRED_PROJECT_SERVICE_PROVIDERS = ["chatgpt", "github", "convex"] as const;
export const projectReadinessRequirementSchema = z.enum([
  "verified-messaging",
  ...REQUIRED_PROJECT_SERVICE_PROVIDERS,
]);
export type ProjectReadinessRequirement = z.infer<typeof projectReadinessRequirementSchema>;

export type ProjectReadiness =
  | { ready: true; missing: [] }
  | { ready: false; missing: ProjectReadinessRequirement[] };

export function evaluateProjectReadiness(input: {
  userId: string;
  iMessageConnections: readonly IMessageConnection[];
  xChatConnections?: readonly XChatConnection[];
  serviceConnections: readonly ServiceConnection[];
}): ProjectReadiness {
  const missing: ProjectReadinessRequirement[] = [];
  const ownsVerifiedIMessage = input.iMessageConnections.some(
    (connection) => connection.userId === input.userId && connection.status === "verified",
  );
  const ownsVerifiedXChat = (input.xChatConnections ?? []).some(
    (connection) => connection.userId === input.userId && connection.status === "verified",
  );
  if (!ownsVerifiedIMessage && !ownsVerifiedXChat) missing.push("verified-messaging");

  for (const provider of REQUIRED_PROJECT_SERVICE_PROVIDERS) {
    const ownsHealthyConnection = input.serviceConnections.some(
      (connection) =>
        connection.userId === input.userId && connection.provider === provider && connection.status === "healthy",
    );
    if (!ownsHealthyConnection) missing.push(provider);
  }

  return missing.length === 0 ? { ready: true, missing: [] } : { ready: false, missing };
}

export const proposedProjectSchema = z
  .object({
    id: proposedProjectIdSchema,
    userId: userIdSchema,
    conversationId: conversationIdSchema,
    name: z.string().min(1).max(100),
    brief: z.string().min(1).max(20_000),
    initialPlan: z.array(z.string().min(1).max(2_000)).min(1).max(50),
    status: z.enum(["awaiting-approval", "confirmed", "declined", "expired"]),
    expiresAt: timestamp,
    ...timestamps,
  })
  .strict();

export type ProposedProject = z.infer<typeof proposedProjectSchema>;

export const projectSchema = z
  .object({
    id: projectIdSchema,
    ownerUserId: userIdSchema,
    name: z.string().min(1).max(100),
    slug: z.string().min(1).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    status: z.enum(["provisioning", "active", "archived", "deleting", "deleted"]),
    repository: z
      .object({
        owner: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        defaultBranch: z.string().min(1).max(255),
      })
      .strict(),
    ...timestamps,
  })
  .strict();

export type Project = z.infer<typeof projectSchema>;

export const activeProjectSchema = z
  .object({
    userId: userIdSchema,
    iMessageConnectionId: iMessageConnectionIdSchema,
    projectId: projectIdSchema,
    selectedAt: timestamp,
  })
  .strict();

export type ActiveProject = z.infer<typeof activeProjectSchema>;

export const conversationSchema = z
  .object({
    id: conversationIdSchema,
    userId: userIdSchema,
    scope: z.enum(["onboarding", "project"]),
    projectId: projectIdSchema.nullable(),
    ...timestamps,
  })
  .strict()
  .superRefine((conversation, context) => {
    if (conversation.scope === "project" && conversation.projectId === null) {
      context.addIssue({ code: "custom", path: ["projectId"], message: "a Project Conversation requires a Project" });
    }
    if (conversation.scope === "onboarding" && conversation.projectId !== null) {
      context.addIssue({ code: "custom", path: ["projectId"], message: "an onboarding Conversation cannot target a Project" });
    }
  });

export type Conversation = z.infer<typeof conversationSchema>;

export const runOutcomeSchema = z.enum(["succeeded", "failed", "cancelled", "needs-attention"]);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

export const runSchema = z
  .object({
    id: runIdSchema,
    projectId: projectIdSchema,
    conversationId: conversationIdSchema,
    requestedByUserId: userIdSchema,
    instruction: z.string().min(1).max(32_768),
    status: z.enum(["queued", "admitted", "running", "cancelling", "terminal"]),
    outcome: runOutcomeSchema.nullable(),
    ...timestamps,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.status === "terminal" && run.outcome === null) {
      context.addIssue({ code: "custom", path: ["outcome"], message: "a terminal Run requires a Run Outcome" });
    }
    if (run.status !== "terminal" && run.outcome !== null) {
      context.addIssue({ code: "custom", path: ["outcome"], message: "only a terminal Run may have a Run Outcome" });
    }
  });

export type Run = z.infer<typeof runSchema>;

export const previewSchema = z
  .object({
    id: previewIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    status: z.enum(["starting", "ready", "stopped", "failed", "expired"]),
    url: z.url().nullable(),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/i),
    expiresAt: timestamp,
    ...timestamps,
  })
  .strict();

export type Preview = z.infer<typeof previewSchema>;

export const releaseSchema = z
  .object({
    id: releaseIdSchema,
    projectId: projectIdSchema,
    sourceRunId: runIdSchema,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/i),
    status: z.enum(["pending", "publishing", "live", "failed", "rolled-back"]),
    liveUrl: z.url().nullable(),
    previousReleaseId: releaseIdSchema.nullable(),
    ...timestamps,
  })
  .strict();

export type Release = z.infer<typeof releaseSchema>;

export const approvalSchema = z
  .object({
    id: approvalIdSchema,
    userId: userIdSchema,
    projectId: projectIdSchema.nullable(),
    operation: z.enum(["confirm-project", "publish-release", "rollback-release", "destructive-change"]),
    actionDigestSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    status: z.enum(["pending", "approved", "declined", "expired", "consumed"]),
    expiresAt: timestamp,
    decidedAt: timestamp.nullable(),
    ...timestamps,
  })
  .strict();

export type Approval = z.infer<typeof approvalSchema>;
