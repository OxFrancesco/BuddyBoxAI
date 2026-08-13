import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  approvalOperationValidator,
  approvalStatusValidator,
  auditActorValidator,
  auditOutcomeValidator,
  conversationStatusValidator,
  deletionStageValidator,
  deletionStatusValidator,
  deliveryDirectionValidator,
  deliveryStatusValidator,
  iMessageConnectionStatusValidator,
  previewStatusValidator,
  projectStatusValidator,
  proposedProjectStatusValidator,
  releaseStatusValidator,
  runEventKindValidator,
  runEventLevelValidator,
  runOutcomeValidator,
  runStatusValidator,
  sandboxLeaseStatusValidator,
  serviceConnectionStatusValidator,
  serviceProviderValidator,
  usageKindValidator,
  userStatusValidator,
} from "./modelValidators";

export default defineSchema({
  users: defineTable({
    authSubject: v.string(),
    tokenIdentifier: v.string(),
    displayName: v.optional(v.string()),
    primaryEmail: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    status: userStatusValidator,
    activeRunId: v.optional(v.id("runs")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_token_identifier", ["tokenIdentifier"])
    .index("by_auth_subject", ["authSubject"])
    .index("by_status_and_updated_at", ["status", "updatedAt"]),

  imessageConnections: defineTable({
    ownerId: v.id("users"),
    addressHash: v.string(),
    maskedAddress: v.string(),
    status: iMessageConnectionStatusValidator,
    challengeHash: v.optional(v.string()),
    challengeExpiresAt: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    activeProjectId: v.optional(v.id("projects")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id_and_created_at", ["ownerId", "createdAt"])
    .index("by_owner_id_and_status", ["ownerId", "status"])
    .index("by_address_hash", ["addressHash"]),

  imessageClaims: defineTable({
    addressHash: v.string(),
    tokenHash: v.string(),
    ownerId: v.optional(v.id("users")),
    connectionId: v.optional(v.id("imessageConnections")),
    status: v.union(
      v.literal("pending"),
      v.literal("attached"),
      v.literal("verified"),
      v.literal("expired"),
    ),
    challengeHash: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_owner_id", ["ownerId"])
    .index("by_address_hash_and_status", ["addressHash", "status"])
    .index("by_expires_at", ["expiresAt"])
    .index("by_status_and_expires_at", ["status", "expiresAt"]),

  serviceConnections: defineTable({
    ownerId: v.id("users"),
    provider: serviceProviderValidator,
    status: serviceConnectionStatusValidator,
    externalAccountIdHash: v.optional(v.string()),
    accountLabel: v.optional(v.string()),
    scopes: v.array(v.string()),
    credentialRef: v.optional(v.string()),
    lastCheckedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id_and_provider", ["ownerId", "provider"])
    .index("by_owner_id_and_status", ["ownerId", "status"]),

  providerOAuthStates: defineTable({
    ownerId: v.id("users"),
    provider: v.union(
      v.literal("github"),
      v.literal("cloudflare"),
      v.literal("convex"),
    ),
    stateHash: v.string(),
    codeVerifierCiphertext: v.string(),
    redirectUri: v.string(),
    status: v.union(v.literal("pending"), v.literal("consumed"), v.literal("expired")),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_state_hash", ["stateHash"])
    .index("by_owner_id_and_provider", ["ownerId", "provider"])
    .index("by_status_and_expires_at", ["status", "expiresAt"]),

  providerCredentials: defineTable({
    ownerId: v.id("users"),
    provider: v.union(
      v.literal("github"),
      v.literal("cloudflare"),
      v.literal("convex"),
    ),
    accessTokenCiphertext: v.string(),
    refreshTokenCiphertext: v.optional(v.string()),
    tokenType: v.string(),
    scopes: v.array(v.string()),
    externalAccountIdHash: v.string(),
    externalAccountRefCiphertext: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner_id_and_provider", ["ownerId", "provider"]),

  codexConnections: defineTable({
    ownerId: v.id("users"),
    revision: v.number(),
    valueJson: v.string(),
    updatedAt: v.number(),
  }).index("by_owner_id", ["ownerId"]),

  proposedProjects: defineTable({
    ownerId: v.id("users"),
    conversationId: v.optional(v.id("conversations")),
    name: v.string(),
    brief: v.string(),
    planJson: v.string(),
    payloadHash: v.string(),
    status: proposedProjectStatusValidator,
    expiresAt: v.number(),
    confirmedProjectId: v.optional(v.id("projects")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id_and_created_at", ["ownerId", "createdAt"])
    .index("by_owner_id_and_status", ["ownerId", "status"])
    .index("by_status_and_expires_at", ["status", "expiresAt"]),

  projects: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    slug: v.string(),
    status: projectStatusValidator,
    githubRepositoryId: v.string(),
    githubRepositoryFullName: v.string(),
    defaultBranch: v.string(),
    cloudflareAccountRef: v.optional(v.string()),
    convexProjectRef: v.optional(v.string()),
    clerkApplicationRef: v.optional(v.string()),
    liveReleaseId: v.optional(v.id("releases")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id_and_created_at", ["ownerId", "createdAt"])
    .index("by_owner_id_and_status", ["ownerId", "status"])
    .index("by_owner_id_and_slug", ["ownerId", "slug"]),

  conversations: defineTable({
    ownerId: v.id("users"),
    projectId: v.optional(v.id("projects")),
    imessageConnectionId: v.optional(v.id("imessageConnections")),
    status: conversationStatusValidator,
    title: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id_and_updated_at", ["ownerId", "updatedAt"])
    .index("by_owner_id_and_project_id_and_updated_at", [
      "ownerId",
      "projectId",
      "updatedAt",
    ])
    .index("by_imessage_connection_id_and_updated_at", [
      "imessageConnectionId",
      "updatedAt",
    ]),

  runs: defineTable({
    ownerId: v.id("users"),
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    commandKey: v.string(),
    instructionHash: v.string(),
    status: runStatusValidator,
    outcome: v.optional(runOutcomeValidator),
    activeLeaseKey: v.optional(v.string()),
    branchName: v.optional(v.string()),
    checkpointRef: v.optional(v.string()),
    summary: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    cancelRequestedAt: v.optional(v.number()),
    cancelReason: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    lastHeartbeatAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id_and_created_at", ["ownerId", "createdAt"])
    .index("by_project_id_and_created_at", ["projectId", "createdAt"])
    .index("by_owner_id_and_command_key", ["ownerId", "commandKey"])
    .index("by_active_lease_key", ["activeLeaseKey"])
    .index("by_status_and_updated_at", ["status", "updatedAt"]),

  runEvents: defineTable({
    ownerId: v.id("users"),
    runId: v.id("runs"),
    eventId: v.string(),
    sequence: v.number(),
    kind: runEventKindValidator,
    level: runEventLevelValidator,
    summary: v.string(),
    dataJson: v.optional(v.string()),
    occurredAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_run_id_and_sequence", ["runId", "sequence"])
    .index("by_owner_id_and_event_id", ["ownerId", "eventId"])
    .index("by_expires_at", ["expiresAt"]),

  sandboxLeases: defineTable({
    ownerId: v.id("users"),
    projectId: v.id("projects"),
    runId: v.id("runs"),
    sandboxIdHash: v.string(),
    status: sandboxLeaseStatusValidator,
    acquiredAt: v.number(),
    heartbeatAt: v.number(),
    expiresAt: v.number(),
    releasedAt: v.optional(v.number()),
  })
    .index("by_owner_id", ["ownerId"])
    .index("by_run_id", ["runId"])
    .index("by_status_and_expires_at", ["status", "expiresAt"]),

  previews: defineTable({
    ownerId: v.id("users"),
    projectId: v.id("projects"),
    runId: v.id("runs"),
    status: previewStatusValidator,
    url: v.optional(v.string()),
    externalDeploymentRef: v.optional(v.string()),
    commitSha: v.optional(v.string()),
    verificationJson: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id_and_created_at", ["ownerId", "createdAt"])
    .index("by_project_id_and_created_at", ["projectId", "createdAt"])
    .index("by_run_id", ["runId"])
    .index("by_status_and_expires_at", ["status", "expiresAt"]),

  approvals: defineTable({
    ownerId: v.id("users"),
    projectId: v.optional(v.id("projects")),
    runId: v.optional(v.id("runs")),
    releaseId: v.optional(v.id("releases")),
    operation: approvalOperationValidator,
    bindingHash: v.string(),
    status: approvalStatusValidator,
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    consumedByDeliveryId: v.optional(v.id("channelDeliveries")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id_and_status_and_expires_at", [
      "ownerId",
      "status",
      "expiresAt",
    ])
    .index("by_owner_id_and_binding_hash", ["ownerId", "bindingHash"])
    .index("by_status_and_expires_at", ["status", "expiresAt"]),

  releases: defineTable({
    ownerId: v.id("users"),
    projectId: v.id("projects"),
    sourceRunId: v.id("runs"),
    approvalId: v.id("approvals"),
    version: v.number(),
    status: releaseStatusValidator,
    commitSha: v.string(),
    deploymentRef: v.optional(v.string()),
    liveUrl: v.optional(v.string()),
    previousReleaseId: v.optional(v.id("releases")),
    publishedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id_and_created_at", ["ownerId", "createdAt"])
    .index("by_project_id_and_created_at", ["projectId", "createdAt"])
    .index("by_project_id_and_version", ["projectId", "version"])
    .index("by_approval_id", ["approvalId"]),

  channelDeliveries: defineTable({
    ownerId: v.optional(v.id("users")),
    imessageConnectionId: v.optional(v.id("imessageConnections")),
    conversationId: v.optional(v.id("conversations")),
    runId: v.optional(v.id("runs")),
    provider: v.literal("spectrum"),
    direction: deliveryDirectionValidator,
    providerMessageId: v.string(),
    commandKey: v.optional(v.string()),
    messageHash: v.string(),
    status: deliveryStatusValidator,
    errorCode: v.optional(v.string()),
    occurredAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_provider_and_provider_message_id", [
      "provider",
      "providerMessageId",
    ])
    .index("by_owner_id_and_command_key", ["ownerId", "commandKey"])
    .index("by_owner_id_and_occurred_at", ["ownerId", "occurredAt"])
    .index("by_status_and_updated_at", ["status", "updatedAt"])
    .index("by_expires_at", ["expiresAt"]),

  channelMessages: defineTable({
    deliveryId: v.id("channelDeliveries"),
    ownerId: v.id("users"),
    payloadCiphertext: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_delivery_id", ["deliveryId"])
    .index("by_owner_id_and_created_at", ["ownerId", "createdAt"])
    .index("by_expires_at", ["expiresAt"]),

  outboundDeliveries: defineTable({
    outboundId: v.string(),
    idempotencyKey: v.string(),
    ownerId: v.optional(v.id("users")),
    payloadCiphertext: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("in_flight"),
      v.literal("delivered"),
      v.literal("failed_retryable"),
    ),
    attempts: v.number(),
    providerMessageId: v.optional(v.string()),
    lastErrorCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_outbound_id", ["outboundId"])
    .index("by_owner_id", ["ownerId"])
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_status_and_updated_at", ["status", "updatedAt"])
    .index("by_expires_at", ["expiresAt"]),

  usageBuckets: defineTable({
    ownerId: v.id("users"),
    bucketStart: v.number(),
    bucketEnd: v.number(),
    kind: usageKindValidator,
    consumed: v.number(),
    limit: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id_and_bucket_start_and_kind", [
      "ownerId",
      "bucketStart",
      "kind",
    ])
    .index("by_bucket_end", ["bucketEnd"]),

  auditHistory: defineTable({
    ownerId: v.optional(v.id("users")),
    actor: auditActorValidator,
    action: v.string(),
    targetType: v.string(),
    targetId: v.optional(v.string()),
    outcome: auditOutcomeValidator,
    metadataJson: v.optional(v.string()),
    occurredAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_owner_id_and_occurred_at", ["ownerId", "occurredAt"])
    .index("by_action_and_occurred_at", ["action", "occurredAt"])
    .index("by_expires_at", ["expiresAt"]),

  accountDeletionJobs: defineTable({
    ownerId: v.id("users"),
    status: deletionStatusValidator,
    stage: deletionStageValidator,
    cursor: v.optional(v.string()),
    deletedDocuments: v.number(),
    externalCleanupJson: v.optional(v.string()),
    confirmationBindingHash: v.string(),
    confirmedAt: v.optional(v.number()),
    lastErrorCode: v.optional(v.string()),
    nextAttemptAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id", ["ownerId"])
    .index("by_status_and_updated_at", ["status", "updatedAt"])
    .index("by_status_and_next_attempt_at", ["status", "nextAttemptAt"]),
});
