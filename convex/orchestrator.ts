import { ConvexError, v } from "convex/values";

import { consumeApproval } from "./approvals";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { decryptBridgePayload, decryptRouteEnvelope, sha256 } from "./lib/bridgeCrypto";
import { openProviderSecret } from "./lib/providerCrypto";

const MAX_ATTEMPTS = 3;
const GITHUB_API = "https://api.github.com";

const contextValidator = v.object({
  ownerId: v.id("users"),
  proposalId: v.id("proposedProjects"),
  approvalId: v.id("approvals"),
  name: v.string(),
  brief: v.string(),
  planJson: v.string(),
  payloadHash: v.string(),
  githubAccessTokenCiphertext: v.string(),
  githubAccountRefCiphertext: v.string(),
  convexAccountRefCiphertext: v.string(),
});

export const loadProvisioningContext = internalQuery({
  args: {
    proposalId: v.id("proposedProjects"),
    approvalId: v.id("approvals"),
  },
  returns: contextValidator,
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    const approval = await ctx.db.get(args.approvalId);
    if (
      !proposal ||
      proposal.approvalId !== args.approvalId ||
      (proposal.status !== "awaiting_approval" && proposal.status !== "confirmed") ||
      !approval ||
      approval.ownerId !== proposal.ownerId ||
      approval.operation !== "confirm_project" ||
      approval.bindingHash !== proposal.payloadHash ||
      approval.status !== "consumed"
    ) {
      throw new ConvexError({ code: "PROVISIONING_NOT_AUTHORIZED", message: "Proposal provisioning is not authorized" });
    }
    const [githubConnection, convexConnection, githubCredential, convexCredential] = await Promise.all([
      ctx.db.query("serviceConnections")
        .withIndex("by_owner_id_and_provider", (q) => q.eq("ownerId", proposal.ownerId).eq("provider", "github"))
        .unique(),
      ctx.db.query("serviceConnections")
        .withIndex("by_owner_id_and_provider", (q) => q.eq("ownerId", proposal.ownerId).eq("provider", "convex"))
        .unique(),
      ctx.db.query("providerCredentials")
        .withIndex("by_owner_id_and_provider", (q) => q.eq("ownerId", proposal.ownerId).eq("provider", "github"))
        .unique(),
      ctx.db.query("providerCredentials")
        .withIndex("by_owner_id_and_provider", (q) => q.eq("ownerId", proposal.ownerId).eq("provider", "convex"))
        .unique(),
    ]);
    const now = Date.now();
    if (
      !githubConnection || githubConnection.status !== "connected" || githubConnection.revokedAt !== undefined ||
      (githubConnection.expiresAt !== undefined && githubConnection.expiresAt <= now) ||
      !githubCredential || githubConnection.credentialRef !== String(githubCredential._id) ||
      (githubCredential.expiresAt !== undefined && githubCredential.expiresAt <= now) ||
      !githubCredential.externalAccountRefCiphertext ||
      !convexConnection || convexConnection.status !== "connected" || convexConnection.revokedAt !== undefined ||
      (convexConnection.expiresAt !== undefined && convexConnection.expiresAt <= now) ||
      !convexCredential || convexConnection.credentialRef !== String(convexCredential._id) ||
      (convexCredential.expiresAt !== undefined && convexCredential.expiresAt <= now) ||
      !convexCredential.externalAccountRefCiphertext
    ) {
      throw new ConvexError({ code: "PROVIDER_REAUTH_REQUIRED", message: "GitHub and Convex must remain connected" });
    }
    return {
      ownerId: proposal.ownerId,
      proposalId: proposal._id,
      approvalId: approval._id,
      name: proposal.name,
      brief: proposal.brief,
      planJson: proposal.planJson,
      payloadHash: proposal.payloadHash,
      githubAccessTokenCiphertext: githubCredential.accessTokenCiphertext,
      githubAccountRefCiphertext: githubCredential.externalAccountRefCiphertext,
      convexAccountRefCiphertext: convexCredential.externalAccountRefCiphertext,
    };
  },
});

export const markProvisioningAttempt = internalMutation({
  args: {
    proposalId: v.id("proposedProjects"),
    attempt: v.number(),
    status: v.union(v.literal("running"), v.literal("failed")),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new ConvexError({ code: "NOT_FOUND", message: "Proposal not found" });
    if (!Number.isSafeInteger(args.attempt) || args.attempt < 1 || args.attempt > MAX_ATTEMPTS) {
      throw new ConvexError({ code: "INVALID_ATTEMPT", message: "Provisioning attempt is invalid" });
    }
    if (proposal.provisioningStatus === "completed") return null;
    await ctx.db.patch(proposal._id, {
      provisioningStatus: args.status,
      provisioningAttempts: Math.max(proposal.provisioningAttempts ?? 0, args.attempt),
      provisioningErrorCode: args.errorCode?.slice(0, 120),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const activateProjectConnections = internalMutation({
  args: { ownerId: v.id("users"), projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project || project.ownerId !== args.ownerId || project.status !== "active") {
      throw new ConvexError({ code: "PROJECT_NOT_FOUND", message: "Active Project not found" });
    }
    const [imessage, xchat] = await Promise.all([
      ctx.db.query("imessageConnections")
        .withIndex("by_owner_id_and_status", (q) => q.eq("ownerId", args.ownerId).eq("status", "verified"))
        .collect(),
      ctx.db.query("xchatConnections")
        .withIndex("by_owner_id_and_status", (q) => q.eq("ownerId", args.ownerId).eq("status", "verified"))
        .collect(),
    ]);
    const now = Date.now();
    for (const connection of imessage) await ctx.db.patch(connection._id, { activeProjectId: project._id, updatedAt: now });
    for (const connection of xchat) await ctx.db.patch(connection._id, { activeProjectId: project._id, updatedAt: now });
    return null;
  },
});

export const loadRunState = internalQuery({
  args: { runId: v.id("runs") },
  returns: v.union(v.null(), v.object({ status: v.string(), ownerId: v.id("users") })),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    return run ? { status: run.status, ownerId: run.ownerId } : null;
  },
});

const inboundDeliveryValidator = v.union(
  v.object({
    provider: v.literal("spectrum"),
    ownerId: v.id("users"),
    deliveryId: v.id("channelDeliveries"),
    commandKey: v.string(),
    payloadCiphertext: v.string(),
    projectId: v.optional(v.id("projects")),
    repository: v.optional(v.string()),
    branch: v.optional(v.string()),
  }),
  v.object({
    provider: v.literal("xchat"),
    ownerId: v.id("users"),
    deliveryId: v.id("channelDeliveries"),
    commandKey: v.string(),
    encryptedPayload: v.object({
      algorithm: v.literal("AES-256-GCM"),
      keyVersion: v.number(),
      iv: v.string(),
      ciphertext: v.string(),
    }),
    payloadAad: v.string(),
    projectId: v.optional(v.id("projects")),
    repository: v.optional(v.string()),
    branch: v.optional(v.string()),
  }),
);

export const loadInboundDelivery = internalQuery({
  args: { deliveryId: v.id("channelDeliveries") },
  returns: inboundDeliveryValidator,
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (
      !delivery || delivery.direction !== "inbound" || delivery.status !== "accepted" ||
      !delivery.ownerId || !delivery.commandKey
    ) {
      throw new ConvexError({ code: "INBOUND_NOT_ROUTABLE", message: "Inbound delivery is not routable" });
    }
    const connection = delivery.provider === "xchat"
      ? delivery.xchatConnectionId ? await ctx.db.get(delivery.xchatConnectionId) : null
      : delivery.imessageConnectionId ? await ctx.db.get(delivery.imessageConnectionId) : null;
    const projectId = connection?.activeProjectId;
    const project = projectId ? await ctx.db.get(projectId) : null;
    const projectFields = project && project.ownerId === delivery.ownerId && project.status === "active"
      ? { projectId: project._id, repository: project.githubRepositoryFullName, branch: project.defaultBranch }
      : {};
    if (delivery.provider === "spectrum") {
      const message = await ctx.db.query("channelMessages")
        .withIndex("by_delivery_id", (q) => q.eq("deliveryId", delivery._id))
        .unique();
      if (!message || message.ownerId !== delivery.ownerId) {
        throw new ConvexError({ code: "INBOUND_PAYLOAD_MISSING", message: "Inbound payload is unavailable" });
      }
      return {
        provider: "spectrum" as const,
        ownerId: delivery.ownerId,
        deliveryId: delivery._id,
        commandKey: delivery.commandKey,
        payloadCiphertext: message.payloadCiphertext,
        ...projectFields,
      };
    }
    if (!delivery.encryptedPayload || !delivery.payloadAad) {
      throw new ConvexError({ code: "INBOUND_PAYLOAD_MISSING", message: "Inbound payload is unavailable" });
    }
    return {
      provider: "xchat" as const,
      ownerId: delivery.ownerId,
      deliveryId: delivery._id,
      commandKey: delivery.commandKey,
      encryptedPayload: delivery.encryptedPayload,
      payloadAad: delivery.payloadAad,
      ...projectFields,
    };
  },
});

export const confirmProposalForDelivery = internalMutation({
  args: {
    ownerId: v.id("users"),
    deliveryId: v.id("channelDeliveries"),
    approvalCode: v.string(),
  },
  returns: v.union(
    v.object({ matched: v.literal(false) }),
    v.object({ matched: v.literal(true), proposalId: v.id("proposedProjects"), approvalId: v.id("approvals") }),
  ),
  handler: async (ctx, args) => {
    const code = args.approvalCode.trim().toLowerCase();
    if (!/^[a-f0-9]{8,12}$/u.test(code)) return { matched: false as const };
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.ownerId !== args.ownerId || delivery.direction !== "inbound" || delivery.status !== "accepted") {
      throw new ConvexError({ code: "INVALID_DELIVERY", message: "Approval delivery is invalid" });
    }
    const proposals = await ctx.db.query("proposedProjects")
      .withIndex("by_owner_id_and_status", (q) => q.eq("ownerId", args.ownerId).eq("status", "awaiting_approval"))
      .take(100);
    const matches = proposals.filter((proposal) =>
      proposal.expiresAt > Date.now() && proposal.payloadHash.startsWith(code) && proposal.approvalId !== undefined,
    );
    if (matches.length === 0) return { matched: false as const };
    if (matches.length !== 1) {
      throw new ConvexError({ code: "APPROVAL_CODE_COLLISION", message: "Approval code is ambiguous" });
    }
    const proposal = matches[0]!;
    await consumeApproval(ctx, {
      ownerId: args.ownerId,
      approvalId: proposal.approvalId!,
      bindingHash: proposal.payloadHash,
      deliveryId: args.deliveryId,
    });
    await ctx.scheduler.runAfter(0, internal.orchestrator.provisionProposal, {
      proposalId: proposal._id,
      approvalId: proposal.approvalId!,
    });
    return { matched: true as const, proposalId: proposal._id, approvalId: proposal.approvalId! };
  },
});

export const attachDeliveryRun = internalMutation({
  args: { deliveryId: v.id("channelDeliveries"), runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const [delivery, run] = await Promise.all([ctx.db.get(args.deliveryId), ctx.db.get(args.runId)]);
    if (!delivery || !run || delivery.ownerId !== run.ownerId || delivery.direction !== "inbound") {
      throw new ConvexError({ code: "DELIVERY_RUN_MISMATCH", message: "Inbound delivery cannot be attached to this Run" });
    }
    if (delivery.runId && delivery.runId !== run._id) {
      throw new ConvexError({ code: "DELIVERY_ALREADY_ROUTED", message: "Inbound delivery was already routed" });
    }
    await ctx.db.patch(delivery._id, { runId: run._id, updatedAt: Date.now() });
    return null;
  },
});

export const dispatchInboundDelivery = internalAction({
  args: { deliveryId: v.id("channelDeliveries"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const attempt = args.attempt ?? 1;
    let runId: Id<"runs"> | undefined;
    try {
      const inbound = await ctx.runQuery(internal.orchestrator.loadInboundDelivery, { deliveryId: args.deliveryId });
      const payload = inbound.provider === "spectrum"
        ? await decryptBridgePayload<{ text?: unknown }>(inbound.payloadCiphertext)
        : await decryptRouteEnvelope<{ text?: unknown }>(inbound.encryptedPayload, inbound.payloadAad);
      if (typeof payload.text !== "string" || payload.text.length < 1 || payload.text.length > 32_000) {
        throw new Error("instruction_invalid");
      }
      const approval = /^APPROVE\s+([A-F0-9]{8,12})$/iu.exec(payload.text.trim());
      if (approval) {
        await ctx.runMutation(internal.orchestrator.confirmProposalForDelivery, {
          ownerId: inbound.ownerId,
          deliveryId: inbound.deliveryId,
          approvalCode: approval[1]!,
        });
        return null;
      }
      if (!inbound.projectId || !inbound.repository || !inbound.branch) return null;
      const admitted: { runId: Id<"runs">; duplicate: boolean } = await ctx.runMutation(internal.runs.admit, {
        ownerId: inbound.ownerId,
        projectId: inbound.projectId,
        commandKey: inbound.commandKey,
        instructionHash: await sha256(payload.text),
      });
      runId = admitted.runId;
      await ctx.runMutation(internal.orchestrator.attachDeliveryRun, { deliveryId: inbound.deliveryId, runId });
      const state = await ctx.runQuery(internal.orchestrator.loadRunState, { runId });
      if (!state || ["succeeded", "failed", "cancelled", "needs_attention"].includes(state.status)) return null;
      if (state.status === "queued") {
        await ctx.runMutation(internal.runEvents.append, {
          ownerId: inbound.ownerId,
          runId,
          eventId: `${runId}:0`,
          sequence: 0,
          kind: "admitted",
          level: "info",
          summary: "Messaging instruction admitted.",
          occurredAt: Date.now(),
        });
        await ctx.runMutation(internal.runs.transition, { runId, status: "provisioning" });
      }
      await executeGatewayRun(ctx, {
        ownerId: inbound.ownerId,
        projectId: inbound.projectId,
        runId,
        repository: inbound.repository,
        branch: inbound.branch,
        prompt: payload.text,
      });
      return null;
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        await ctx.scheduler.runAfter(2 ** attempt * 1_000, internal.orchestrator.dispatchInboundDelivery, {
          deliveryId: args.deliveryId,
          attempt: attempt + 1,
        });
      } else if (runId) {
        const state = await ctx.runQuery(internal.orchestrator.loadRunState, { runId });
        if (state && ["queued", "provisioning", "running", "verifying"].includes(state.status)) {
          await ctx.runMutation(internal.runs.transition, {
            runId,
            status: "needs_attention",
            outcome: "needs_attention",
            errorCode: "orchestration_failed",
          });
        }
      }
      return null;
    }
  },
});

export const provisionProposal = internalAction({
  args: {
    proposalId: v.id("proposedProjects"),
    approvalId: v.id("approvals"),
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const attempt = args.attempt ?? 1;
    await ctx.runMutation(internal.orchestrator.markProvisioningAttempt, {
      proposalId: args.proposalId,
      attempt,
      status: "running",
    });
    try {
      const context = await ctx.runQuery(internal.orchestrator.loadProvisioningContext, {
        proposalId: args.proposalId,
        approvalId: args.approvalId,
      });
      const [githubAccessToken, githubAccountRef, convexAccountRef] = await Promise.all([
        openProviderSecret(context.githubAccessTokenCiphertext, context.ownerId, "github", "access"),
        openProviderSecret(context.githubAccountRefCiphertext, context.ownerId, "github", "account"),
        openProviderSecret(context.convexAccountRefCiphertext, context.ownerId, "convex", "account"),
      ]);
      const github = parseGitHubAccountRef(githubAccountRef);
      const convexProjectRef = parseConvexProjectRef(convexAccountRef);
      const slug = projectSlug(context.name, context.proposalId);
      const repository = await ensureGitHubRepository({
        accessToken: githubAccessToken,
        login: github.login,
        name: `ichef-${slug}`.slice(0, 100),
        proposalId: context.proposalId,
        description: context.brief.slice(0, 240),
      });
      const projectId: Id<"projects"> = await ctx.runMutation(internal.projects.createProvisioned, {
        ownerId: context.ownerId,
        proposalId: context.proposalId,
        approvalId: context.approvalId,
        slug,
        githubRepositoryId: String(repository.id),
        githubRepositoryFullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
        convexProjectRef,
      });
      await ctx.runMutation(internal.orchestrator.activateProjectConnections, {
        ownerId: context.ownerId,
        projectId,
      });
      const admitted: { runId: Id<"runs">; duplicate: boolean } = await ctx.runMutation(internal.runs.admit, {
        ownerId: context.ownerId,
        projectId,
        commandKey: `proposal:${context.proposalId}`,
        instructionHash: context.payloadHash,
      });
      const existing = await ctx.runQuery(internal.orchestrator.loadRunState, { runId: admitted.runId });
      if (!existing || ["succeeded", "failed", "cancelled", "needs_attention"].includes(existing.status)) return null;
      if (existing.status === "queued") {
        await ctx.runMutation(internal.runEvents.append, {
          ownerId: context.ownerId,
          runId: admitted.runId,
          eventId: `${admitted.runId}:0`,
          sequence: 0,
          kind: "admitted",
          level: "info",
          summary: "Initial Project Run admitted after confirmation.",
          occurredAt: Date.now(),
        });
        await ctx.runMutation(internal.runs.transition, { runId: admitted.runId, status: "provisioning" });
      }
      await executeGatewayRun(ctx, {
        ownerId: context.ownerId,
        projectId,
        runId: admitted.runId,
        repository: repository.fullName,
        branch: repository.defaultBranch,
        prompt: initialPrompt(context.name, context.brief, context.planJson),
      });
      return null;
    } catch (error) {
      const errorCode = provisioningErrorCode(error);
      if (attempt < MAX_ATTEMPTS) {
        await ctx.scheduler.runAfter(2 ** attempt * 1_000, internal.orchestrator.provisionProposal, {
          proposalId: args.proposalId,
          approvalId: args.approvalId,
          attempt: attempt + 1,
        });
      } else {
        await ctx.runMutation(internal.orchestrator.markProvisioningAttempt, {
          proposalId: args.proposalId,
          attempt,
          status: "failed",
          errorCode,
        });
      }
      return null;
    }
  },
});

async function executeGatewayRun(
  ctx: ActionCtx,
  input: {
    ownerId: Id<"users">;
    projectId: Id<"projects">;
    runId: Id<"runs">;
    repository: string;
    branch: string;
    prompt: string;
  },
): Promise<void> {
  const secret = process.env.ICHEF_ORCHESTRATOR_SECRET;
  if (!secret || secret.length < 32) throw new Error("orchestrator_not_configured");
  const url = process.env.ICHEF_ORCHESTRATOR_URL ?? "https://ichef.buddytools.org/v1/orchestration/runs";
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      ...input,
      sandboxGeneration: 1,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      verificationCommands: ["bun test", "bun run build"],
    }),
    redirect: "error",
  });
  if (response.status !== 202 || !response.body) throw new Error("gateway_unavailable");
  let state = (await ctx.runQuery(internal.orchestrator.loadRunState, { runId: input.runId }))?.status ?? "provisioning";
  if (state === "provisioning") {
    await ctx.runMutation(internal.runs.transition, { runId: input.runId, status: "running" });
    state = "running";
  }
  let sawOutcome = false;
  for await (const event of runtimeEvents(response.body, input.runId)) {
    await ctx.runMutation(internal.runEvents.append, {
      ownerId: input.ownerId,
      runId: input.runId,
      eventId: `${input.runId}:${event.sequence}`,
      sequence: event.sequence,
      kind: eventKind(event.type),
      level: eventLevel(event),
      summary: eventSummary(event),
      dataJson: JSON.stringify({ type: event.type, ...(event.tool ? { tool: event.tool } : {}) }),
      occurredAt: Date.parse(event.at),
    });
    if (event.type === "verification.finished" && state === "running") {
      await ctx.runMutation(internal.runs.transition, { runId: input.runId, status: "verifying" });
      state = "verifying";
    }
    if (event.type === "run.outcome" && event.outcome) {
      sawOutcome = true;
      if (event.outcome === "succeeded" && state === "running") {
        await ctx.runMutation(internal.runs.transition, { runId: input.runId, status: "verifying" });
        state = "verifying";
      }
      await ctx.runMutation(internal.runs.transition, {
        runId: input.runId,
        status: event.outcome,
        outcome: event.outcome,
        summary: event.summary,
      });
      state = event.outcome;
    }
  }
  if (!sawOutcome && ["provisioning", "running", "verifying"].includes(state)) {
    await ctx.runMutation(internal.runs.transition, {
      runId: input.runId,
      status: "needs_attention",
      outcome: "needs_attention",
      errorCode: "runtime_stream_ended",
    });
  }
}

interface RuntimeEvent {
  sequence: number;
  type: "run.accepted" | "agent.started" | "tool.started" | "tool.finished" | "verification.finished" | "run.outcome" | "runtime.warning";
  runId: string;
  at: string;
  tool?: string;
  status?: "succeeded" | "failed";
  outcome?: "succeeded" | "failed" | "cancelled" | "needs_attention";
  summary?: string;
  code?: string;
}

async function* runtimeEvents(stream: ReadableStream<Uint8Array>, expectedRunId: string): AsyncGenerator<RuntimeEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let count = 0;
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) {
        count += 1;
        if (count > 10_000 || line.length > 16_384) throw new Error("runtime_stream_invalid");
        const event = parseRuntimeEvent(JSON.parse(line), expectedRunId);
        yield event;
      }
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > 32_768) throw new Error("runtime_stream_invalid");
    if (chunk.done) break;
  }
  if (buffer.trim()) yield parseRuntimeEvent(JSON.parse(buffer), expectedRunId);
}

export function parseRuntimeEvent(value: unknown, expectedRunId: string): RuntimeEvent {
  const row = record(value);
  const allowed = new Set(["run.accepted", "agent.started", "tool.started", "tool.finished", "verification.finished", "run.outcome", "runtime.warning"]);
  if (
    !row || row.protocolVersion !== "2026-08-13" || row.runId !== expectedRunId ||
    typeof row.type !== "string" || !allowed.has(row.type) ||
    !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1 ||
    typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))
  ) throw new Error("runtime_stream_invalid");
  const outcome = row.outcome;
  if (outcome !== undefined && !["succeeded", "failed", "cancelled", "needs_attention"].includes(String(outcome))) {
    throw new Error("runtime_stream_invalid");
  }
  return {
    sequence: Number(row.sequence),
    type: row.type as RuntimeEvent["type"],
    runId: expectedRunId,
    at: row.at,
    ...(typeof row.tool === "string" ? { tool: row.tool.slice(0, 64) } : {}),
    ...(row.status === "succeeded" || row.status === "failed" ? { status: row.status } : {}),
    ...(outcome ? { outcome: outcome as RuntimeEvent["outcome"] } : {}),
    ...(typeof row.summary === "string" ? { summary: row.summary.slice(0, 512) } : {}),
    ...(typeof row.code === "string" ? { code: row.code.slice(0, 64) } : {}),
  };
}

function parseGitHubAccountRef(value: string): { installationId: number; login: string } {
  const row = record(JSON.parse(value));
  const installationId = Number(row?.installationId);
  const login = row?.login;
  if (!Number.isSafeInteger(installationId) || installationId <= 0 || typeof login !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(login)) {
    throw new Error("github_binding_invalid");
  }
  return { installationId, login };
}

function parseConvexProjectRef(value: string): string {
  const row = record(JSON.parse(value));
  const projectId = row?.projectId;
  if (typeof projectId !== "string" || projectId.length < 1 || projectId.length > 256) throw new Error("convex_project_required");
  return projectId;
}

function projectSlug(name: string, proposalId: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 56) || "site";
  const suffix = proposalId.toLowerCase().replace(/[^a-z0-9]/gu, "").slice(-10);
  return `${base}-${suffix}`.slice(0, 67).replace(/-+$/u, "");
}

async function ensureGitHubRepository(input: {
  accessToken: string;
  login: string;
  name: string;
  proposalId: string;
  description: string;
}): Promise<{ id: number; fullName: string; defaultBranch: string }> {
  const marker = `iChef proposal ${input.proposalId}`;
  const response = await fetch(`${GITHUB_API}/user/repos`, {
    method: "POST",
    headers: githubHeaders(input.accessToken),
    body: JSON.stringify({
      name: input.name,
      description: `${marker} — ${input.description}`.slice(0, 350),
      private: true,
      auto_init: true,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    }),
    redirect: "error",
  });
  if (response.ok) return parseRepository(await boundedJson(response), input.login, input.name, marker);
  if (response.status !== 422) throw new Error(`github_repository_${response.status}`);
  const existing = await fetch(`${GITHUB_API}/repos/${encodeURIComponent(input.login)}/${encodeURIComponent(input.name)}`, {
    headers: githubHeaders(input.accessToken),
    redirect: "error",
  });
  if (!existing.ok) throw new Error(`github_repository_${existing.status}`);
  return parseRepository(await boundedJson(existing), input.login, input.name, marker);
}

function parseRepository(value: unknown, login: string, name: string, marker: string) {
  const row = record(value);
  const id = Number(row?.id);
  const fullName = row?.full_name;
  const defaultBranch = row?.default_branch;
  const description = row?.description;
  if (
    !Number.isSafeInteger(id) || id <= 0 || fullName !== `${login}/${name}` ||
    typeof defaultBranch !== "string" || defaultBranch.length < 1 || defaultBranch.length > 200 ||
    typeof description !== "string" || !description.startsWith(marker)
  ) throw new Error("github_repository_invalid");
  return { id, fullName, defaultBranch };
}

function githubHeaders(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "iChef/0.1",
    "x-github-api-version": "2022-11-28",
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (raw.length > 1_000_000) throw new Error("provider_response_too_large");
  return JSON.parse(raw);
}

function initialPrompt(name: string, brief: string, planJson: string): string {
  return [
    `Create the first production-quality version of ${name}.`,
    brief,
    "Use TanStack Start, Clerk, Convex, Tailwind, and shadcn/ui. Work autonomously in YOLO mode inside the sandbox. Commit the verified result to the configured repository.",
    `Approved plan: ${planJson.slice(0, 20_000)}`,
  ].join("\n\n").slice(0, 32_000);
}

function eventKind(type: RuntimeEvent["type"]): "admitted" | "agent" | "tool" | "verification" | "warning" {
  if (type === "run.accepted") return "admitted";
  if (type === "tool.started" || type === "tool.finished") return "tool";
  if (type === "verification.finished" || type === "run.outcome") return "verification";
  if (type === "runtime.warning") return "warning";
  return "agent";
}

function eventLevel(event: RuntimeEvent): "info" | "warning" | "error" {
  if (event.type === "runtime.warning") return "warning";
  if (event.status === "failed" || event.outcome === "failed" || event.outcome === "needs_attention") return "error";
  return "info";
}

function eventSummary(event: RuntimeEvent): string {
  return event.summary ?? event.type.replaceAll(".", " ");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function provisioningErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "provisioning_failed";
  return /^[a-z0-9_-]{1,120}$/u.test(message) ? message : "provisioning_failed";
}
