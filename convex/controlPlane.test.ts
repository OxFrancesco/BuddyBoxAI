import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./approvals.ts": () => import("./approvals"),
  "./audit.ts": () => import("./audit"),
  "./channels.ts": () => import("./channels"),
  "./connections.ts": () => import("./connections"),
  "./conversations.ts": () => import("./conversations"),
  "./deletions.ts": () => import("./deletions"),
  "./maintenance.ts": () => import("./maintenance"),
  "./orchestrator.ts": () => import("./orchestrator"),
  "./projects.ts": () => import("./projects"),
  "./releases.ts": () => import("./releases"),
  "./runEvents.ts": () => import("./runEvents"),
  "./runs.ts": () => import("./runs"),
  "./runtime.ts": () => import("./runtime"),
  "./usage.ts": () => import("./usage"),
  "./users.ts": () => import("./users"),
};

function identity(subject: string) {
  return {
    subject,
    tokenIdentifier: `https://issuer.buddybox.test|${subject}`,
  };
}

async function readyUserFixture(t: ReturnType<typeof convexTest>, subject: string) {
  const authenticated = t.withIdentity(identity(subject));
  const user = await authenticated.mutation(api.users.syncCurrent, {
    displayName: subject,
  });
  const now = Date.now();
  const connectionId = await t.run(async (ctx) =>
    ctx.db.insert("imessageConnections", {
      ownerId: user._id,
      addressHash: `address-${subject}`,
      maskedAddress: "+1•••0000",
      status: "verified",
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  );
  for (const provider of ["chatgpt", "github", "convex"] as const) {
    const externalAccountIdHash = `${provider}-account-${subject}`;
    const credentialId = provider === "chatgpt" ? undefined : await t.run((ctx) =>
      ctx.db.insert("providerCredentials", {
        ownerId: user._id,
        provider,
        accessTokenCiphertext: `encrypted-${provider}-${subject}`,
        tokenType: "bearer",
        scopes: [],
        externalAccountIdHash,
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await t.mutation(internal.connections.setServiceConnection, {
      ownerId: user._id,
      provider,
      status: "connected",
      scopes: [],
      ...(credentialId ? {
        externalAccountIdHash,
        credentialRef: String(credentialId),
        expiresAt: now + 60_000,
      } : {}),
    });
  }
  const projectId = await t.run(async (ctx) =>
    ctx.db.insert("projects", {
      ownerId: user._id,
      name: `${subject}'s Project`,
      slug: `${subject}-project`,
      status: "active",
      githubRepositoryId: `repo-${subject}`,
      githubRepositoryFullName: `${subject}/project`,
      defaultBranch: "main",
      convexProjectRef: `convex-${subject}`,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { authenticated, user, connectionId, projectId };
}

describe("authenticated Convex control plane", () => {
  test("atomically binds every Proposed Project to a pending confirmation Approval", async () => {
    const t = convexTest(schema, modules);
    const alice = await readyUserFixture(t, "proposal-alice");
    const expiresAt = Date.now() + 60_000;
    const { proposalId, approvalId } = await alice.authenticated.mutation(api.projects.propose, {
      name: "Seasonal Field Notes",
      brief: "A signed-in guide for saving seasonal ingredient notes.",
      planJson: JSON.stringify({ version: 1 }),
      payloadHash: "a".repeat(64),
      expiresAt,
    });
    const [proposal, approvals] = await t.run((ctx) => Promise.all([
      ctx.db.get(proposalId),
      ctx.db.query("approvals")
        .withIndex("by_owner_id_and_binding_hash", (q) =>
          q.eq("ownerId", alice.user._id).eq("bindingHash", "a".repeat(64)),
        )
        .collect(),
    ]));

    expect(proposal?.status).toBe("awaiting_approval");
    expect(approvals).toHaveLength(1);
    expect(approvalId).toBe(approvals[0]!._id);
    expect(approvals[0]).toMatchObject({
      ownerId: alice.user._id,
      operation: "confirm_project",
      bindingHash: "a".repeat(64),
      status: "pending",
      expiresAt,
    });

    const retry = await alice.authenticated.mutation(api.projects.propose, {
      name: "Seasonal Field Notes",
      brief: "A signed-in guide for saving seasonal ingredient notes.",
      planJson: JSON.stringify({ version: 1 }),
      payloadHash: "a".repeat(64),
      expiresAt,
    });
    expect(retry).toEqual({ proposalId, approvalId });
    expect(await t.run((ctx) => ctx.db.query("proposedProjects")
      .withIndex("by_owner_id_and_payload_hash", (q) =>
        q.eq("ownerId", alice.user._id).eq("payloadHash", "a".repeat(64)),
      )
      .collect())).toHaveLength(1);
    await expect(alice.authenticated.mutation(api.projects.propose, {
      name: "Different project",
      brief: "A different payload cannot borrow the same approval binding.",
      planJson: JSON.stringify({ version: 1, changed: true }),
      payloadHash: "a".repeat(64),
      expiresAt,
    })).rejects.toThrow("already bound to different content");

    const confirmation = await alice.authenticated.mutation(api.projects.confirmProposal, {
      approvalId: approvals[0]!._id,
      bindingHash: "a".repeat(64),
    });
    expect(confirmation).toEqual({
      proposalId,
      approvalId: approvals[0]!._id,
      scheduled: true,
    });
    expect((await t.run((ctx) => ctx.db.get(approvals[0]!._id)))?.status).toBe("consumed");
    expect(await alice.authenticated.mutation(api.projects.confirmProposal, {
      approvalId: approvals[0]!._id,
      bindingHash: "a".repeat(64),
    })).toEqual(confirmation);

    const secondHash = "b".repeat(64);
    const second = await alice.authenticated.mutation(api.projects.propose, {
      name: "Kitchen Ledger",
      brief: "A small shared ledger for recipes and prep notes.",
      planJson: JSON.stringify({ version: 1 }),
      payloadHash: secondHash,
      expiresAt: Date.now() + 60_000,
    });
    const delivery = await t.mutation(internal.channels.recordDelivery, {
      ownerId: alice.user._id,
      imessageConnectionId: alice.connectionId,
      direction: "inbound",
      providerMessageId: "spectrum-confirm-project",
      messageHash: "approval-message-hash",
      status: "accepted",
      occurredAt: Date.now(),
    });
    expect(await t.mutation(internal.orchestrator.confirmProposalForDelivery, {
      ownerId: alice.user._id,
      deliveryId: delivery.deliveryId,
      approvalCode: secondHash.slice(0, 8).toUpperCase(),
    })).toEqual({ matched: true, proposalId: second.proposalId, approvalId: second.approvalId });
    expect((await t.run((ctx) => ctx.db.get(second.approvalId)))?.consumedByDeliveryId)
      .toBe(delivery.deliveryId);
  });

  test("managed hosting assigns collision-safe hostnames and atomically activates a release", async () => {
    const t = convexTest(schema, modules);
    const alice = await readyUserFixture(t, "hosting-alice");
    const bob = await readyUserFixture(t, "hosting-bob");
    const backfilled = await t.mutation(internal.projects.backfillManagedHostnames, {
      limit: 10,
    });
    expect(backfilled.updated).toBeGreaterThanOrEqual(2);
    const [aliceProject, bobProject] = await t.run((ctx) =>
      Promise.all([ctx.db.get(alice.projectId), ctx.db.get(bob.projectId)]),
    );
    expect(aliceProject?.hostingHostname).toEndWith("-buddybox-sites.buddytools.org");
    expect(bobProject?.hostingHostname).toEndWith("-buddybox-sites.buddytools.org");
    expect(aliceProject?.hostingHostname).not.toBe(bobProject?.hostingHostname);

    const now = Date.now();
    const commitSha = "a".repeat(40);
    const artifactManifestDigest = "b".repeat(64);
    const hostname = aliceProject?.hostingHostname ?? "";
    const sourceRunId = await t.run((ctx) =>
      ctx.db.insert("runs", {
        ownerId: alice.user._id,
        projectId: alice.projectId,
        commandKey: "managed-hosting-release",
        instructionHash: "managed-hosting-instruction",
        status: "succeeded",
        outcome: "succeeded",
        createdAt: now,
        updatedAt: now,
      }),
    );
    const approvalId = await t.run((ctx) =>
      ctx.db.insert("approvals", {
        ownerId: alice.user._id,
        projectId: alice.projectId,
        runId: sourceRunId,
        operation: "publish_release",
        bindingHash: "managed-hosting-binding",
        status: "consumed",
        expiresAt: now + 60_000,
        consumedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const releaseId = await t.mutation(internal.releases.create, {
      ownerId: alice.user._id,
      projectId: alice.projectId,
      sourceRunId,
      approvalId,
      bindingHash: "managed-hosting-binding",
      commitSha,
      deploymentHostname: hostname,
      artifactManifestDigest,
    });
    expect(await t.mutation(internal.releases.reserveManagedDeploymentUpload, {
      projectId: alice.projectId,
      releaseId,
      sourceRunId,
      commitSha,
      hostname,
      artifactManifestDigest,
      attemptId: "attempt_one",
    })).toEqual({ status: "reserved" });
    await expect(t.mutation(internal.releases.reserveManagedDeploymentUpload, {
      projectId: bob.projectId,
      releaseId,
      sourceRunId,
      commitSha,
      hostname,
      artifactManifestDigest,
      attemptId: "attempt_cross_project",
    })).rejects.toThrow("does not match");
    await expect(t.mutation(internal.releases.reserveManagedDeploymentUpload, {
      projectId: alice.projectId,
      releaseId,
      sourceRunId,
      commitSha,
      hostname,
      artifactManifestDigest: "c".repeat(64),
      attemptId: "attempt_other_manifest",
    })).rejects.toThrow("does not match");
    const siblingRunId = await t.run((ctx) =>
      ctx.db.insert("runs", {
        ownerId: alice.user._id,
        projectId: alice.projectId,
        commandKey: "managed-hosting-sibling",
        instructionHash: "managed-hosting-sibling-instruction",
        status: "succeeded",
        outcome: "succeeded",
        createdAt: now,
        updatedAt: now,
      }),
    );
    await expect(t.mutation(internal.releases.reserveManagedDeploymentUpload, {
      projectId: alice.projectId,
      releaseId,
      sourceRunId: siblingRunId,
      commitSha,
      hostname,
      artifactManifestDigest,
      attemptId: "attempt_sibling_run",
    })).rejects.toThrow("does not match");
    await expect(t.mutation(internal.releases.reserveManagedDeploymentUpload, {
      projectId: alice.projectId,
      releaseId,
      sourceRunId,
      commitSha,
      hostname,
      artifactManifestDigest,
      attemptId: "attempt_concurrent",
    })).rejects.toThrow("already in progress");
    expect(await t.mutation(internal.releases.failManagedDeploymentUpload, {
      releaseId,
      attemptId: "attempt_one",
    })).toEqual({ status: "failed" });
    expect(await t.mutation(internal.releases.reserveManagedDeploymentUpload, {
      projectId: alice.projectId,
      releaseId,
      sourceRunId,
      commitSha,
      hostname,
      artifactManifestDigest,
      attemptId: "attempt_retry",
    })).toEqual({ status: "reserved" });
    const liveUrl = `https://${hostname}/`;
    const activated = await t.mutation(internal.releases.activateManagedRelease, {
      projectId: alice.projectId,
      releaseId,
      sourceRunId,
      commitSha,
      hostname,
      artifactManifestDigest,
      attemptId: "attempt_retry",
      deploymentRef: "r2/releases/immutable-release-1",
      liveUrl,
    });
    expect(activated).toEqual({
      projectId: alice.projectId,
      releaseId,
      status: "live",
    });
    expect(await t.mutation(internal.releases.reserveManagedDeploymentUpload, {
      projectId: alice.projectId,
      releaseId,
      sourceRunId,
      commitSha,
      hostname,
      artifactManifestDigest,
      attemptId: "attempt_after_live",
    })).toEqual({
      status: "live",
      deploymentRef: "r2/releases/immutable-release-1",
      liveUrl,
    });
    expect(await t.mutation(internal.releases.activateManagedRelease, {
      projectId: alice.projectId,
      releaseId,
      sourceRunId,
      commitSha,
      hostname,
      artifactManifestDigest,
      attemptId: "attempt_retry",
      deploymentRef: "r2/releases/immutable-release-1",
      liveUrl,
    })).toEqual(activated);
    expect(await t.query(internal.releases.resolveManagedSite, {
      hostname: aliceProject?.hostingHostname ?? "",
    })).toEqual({
      projectId: alice.projectId,
      releaseId,
      commitSha,
      deploymentRef: "r2/releases/immutable-release-1",
      status: "live",
    });
    await expect(t.mutation(internal.releases.activateManagedRelease, {
      projectId: alice.projectId,
      releaseId,
      sourceRunId,
      commitSha,
      hostname,
      artifactManifestDigest,
      attemptId: "attempt_retry",
      deploymentRef: "r2/releases/different",
      liveUrl,
    })).rejects.toThrow("different deployment data");
  });

  test("owner isolation and one-active-Run admission hold across Users", async () => {
    const t = convexTest(schema, modules);
    const alice = await readyUserFixture(t, "alice");
    const bob = await readyUserFixture(t, "bob");

    const first = await t.mutation(internal.runs.admit, {
      ownerId: alice.user._id,
      projectId: alice.projectId,
      commandKey: "spectrum:message-1",
      instructionHash: "instruction-hash-1",
    });
    expect(first.duplicate).toBe(false);

    const retried = await t.mutation(internal.runs.admit, {
      ownerId: alice.user._id,
      projectId: alice.projectId,
      commandKey: "spectrum:message-1",
      instructionHash: "instruction-hash-1",
    });
    expect(retried).toEqual({ runId: first.runId, duplicate: true });

    await expect(
      t.mutation(internal.runs.admit, {
        ownerId: alice.user._id,
        projectId: alice.projectId,
        commandKey: "spectrum:message-2",
        instructionHash: "instruction-hash-2",
      }),
    ).rejects.toThrow("only one active Run");

    expect(await bob.authenticated.query(api.runs.getMine, { runId: first.runId })).toBeNull();
    expect((await alice.authenticated.query(api.runs.getMine, { runId: first.runId }))?.status).toBe("queued");
  });

  test("delivery identity and Approval consumption are idempotent but action-bound", async () => {
    const t = convexTest(schema, modules);
    const alice = await readyUserFixture(t, "approval-alice");
    const received = await t.mutation(internal.channels.recordDelivery, {
      ownerId: alice.user._id,
      imessageConnectionId: alice.connectionId,
      direction: "inbound",
      providerMessageId: "spectrum-approval-1",
      messageHash: "message-hash",
      status: "received",
      occurredAt: Date.now(),
    });
    const duplicate = await t.mutation(internal.channels.recordDelivery, {
      ownerId: alice.user._id,
      imessageConnectionId: alice.connectionId,
      direction: "inbound",
      providerMessageId: "spectrum-approval-1",
      messageHash: "message-hash",
      status: "received",
      occurredAt: Date.now(),
    });
    expect(duplicate).toEqual({ deliveryId: received.deliveryId, duplicate: true });

    const approvalId = await t.mutation(internal.approvals.create, {
      ownerId: alice.user._id,
      projectId: alice.projectId,
      operation: "publish_release",
      bindingHash: "release-payload-v1",
    });
    await expect(
      alice.authenticated.mutation(api.approvals.consume, {
        approvalId,
        bindingHash: "release-payload-v2",
      }),
    ).rejects.toThrow("does not authorize this payload");
    expect(
      await t.mutation(internal.approvals.consumeForChannel, {
        ownerId: alice.user._id,
        approvalId,
        bindingHash: "release-payload-v1",
        deliveryId: received.deliveryId,
      }),
    ).toEqual({ approvalId, alreadyConsumed: false });
    expect(
      await t.mutation(internal.approvals.consumeForChannel, {
        ownerId: alice.user._id,
        approvalId,
        bindingHash: "release-payload-v1",
        deliveryId: received.deliveryId,
      }),
    ).toEqual({ approvalId, alreadyConsumed: true });
  });

  test("Run success is rejected until verification and terminal state releases admission", async () => {
    const t = convexTest(schema, modules);
    const alice = await readyUserFixture(t, "outcome-alice");
    const { runId } = await t.mutation(internal.runs.admit, {
      ownerId: alice.user._id,
      projectId: alice.projectId,
      commandKey: "outcome-message-1",
      instructionHash: "outcome-instruction-1",
    });
    await t.mutation(internal.runs.transition, { runId, status: "provisioning" });
    await t.mutation(internal.runs.transition, { runId, status: "running" });
    await expect(
      t.mutation(internal.runs.transition, {
        runId,
        status: "succeeded",
        outcome: "succeeded",
      }),
    ).rejects.toThrow("Cannot transition Run");
    await t.mutation(internal.runs.transition, { runId, status: "verifying" });
    await t.mutation(internal.runs.transition, {
      runId,
      status: "succeeded",
      outcome: "succeeded",
      summary: "All verification gates passed",
    });
    const second = await t.mutation(internal.runs.admit, {
      ownerId: alice.user._id,
      projectId: alice.projectId,
      commandKey: "outcome-message-2",
      instructionHash: "outcome-instruction-2",
    });
    expect(second.duplicate).toBe(false);
  });

  test("quota admission fails closed and expired raw events are removed", async () => {
    const t = convexTest(schema, modules);
    const alice = await readyUserFixture(t, "retention-alice");
    const charged = await t.mutation(internal.usage.charge, {
      ownerId: alice.user._id,
      kind: "model_tokens",
      amount: 100,
      limit: 100,
    });
    expect(charged.remaining).toBe(0);
    await expect(
      t.mutation(internal.usage.charge, {
        ownerId: alice.user._id,
        kind: "model_tokens",
        amount: 1,
        limit: 100,
      }),
    ).rejects.toThrow("quota exceeded");

    const { runId } = await t.mutation(internal.runs.admit, {
      ownerId: alice.user._id,
      projectId: alice.projectId,
      commandKey: "retention-message-1",
      instructionHash: "retention-instruction-1",
    });
    const old = Date.now() - 31 * 24 * 60 * 60 * 1_000;
    await t.mutation(internal.runEvents.append, {
      ownerId: alice.user._id,
      runId,
      eventId: "old-event",
      sequence: 0,
      kind: "agent",
      level: "info",
      summary: "expired raw event",
      occurredAt: old,
    });
    const swept = await t.mutation(internal.maintenance.sweepExpired, { now: Date.now() });
    expect(swept.runEvents).toBe(1);
    expect(await alice.authenticated.query(api.runEvents.listMine, { runId })).toEqual([]);
  });

  test("account deletion resumes stage-by-stage and leaves a non-PII tombstone", async () => {
    const t = convexTest(schema, modules);
    const alice = await readyUserFixture(t, "deletion-alice");
    const bindingHash = "delete-account-deletion-alice-v1";
    const jobId = await alice.authenticated.mutation(api.deletions.request, {
      confirmationBindingHash: bindingHash,
    });
    const approvalId = await t.mutation(internal.approvals.create, {
      ownerId: alice.user._id,
      operation: "delete_account",
      bindingHash,
    });
    await alice.authenticated.mutation(api.approvals.consume, { approvalId, bindingHash });
    await t.mutation(internal.deletions.confirm, { jobId, approvalId });
    await t.mutation(internal.deletions.externalCleanupComplete, {
      jobId,
      outcomeJson: JSON.stringify({
        github: "revoked",
        chatgpt: "revoked",
        cloudflare: "revoked",
        convex: "revoked",
        clerk: "revoked",
        spectrum: "revoked",
      }),
    });
    const now = Date.now();
    const xchatConnectionId = await t.run((ctx) =>
      ctx.db.insert("xchatConnections", {
        ownerId: alice.user._id,
        senderIdHash: "deletion-xchat-sender",
        providerConversationIdHash: "deletion-xchat-conversation",
        maskedSender: "X Chat •sender",
        status: "verified",
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("xchatClaims", {
        senderIdHash: "deletion-xchat-sender",
        providerConversationIdHash: "deletion-xchat-conversation",
        tokenHash: "deletion-xchat-token",
        ownerId: alice.user._id,
        connectionId: xchatConnectionId,
        status: "verified",
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      }),
    );

    let result: { status: string; stage: string } = { status: "purging", stage: "approvals" };
    for (let pass = 0; pass < 40 && result.status !== "complete"; pass += 1) {
      result = await t.mutation(internal.deletions.advance, { jobId });
    }
    expect(result).toMatchObject({ status: "complete", stage: "done" });
    expect((await alice.authenticated.query(api.deletions.getMine, {}))?.status).toBe("complete");
    await expect(alice.authenticated.query(api.users.getCurrent, {})).rejects.toThrow("deleted");
    const tombstone = await t.run((ctx) =>
      ctx.db.query("users")
        .withIndex("by_token_identifier", (q) =>
          q.eq("tokenIdentifier", identity("deletion-alice").tokenIdentifier),
        )
        .unique(),
    );
    expect(tombstone).toMatchObject({ status: "deleted" });
    expect(tombstone?.primaryEmail).toBeUndefined();
    expect(tombstone?.displayName).toBeUndefined();
    expect(await t.run((ctx) =>
      ctx.db.query("xchatConnections")
        .withIndex("by_owner_id_and_created_at", (q) => q.eq("ownerId", alice.user._id))
        .take(1),
    )).toEqual([]);
    expect(await t.run((ctx) =>
      ctx.db.query("xchatClaims")
        .withIndex("by_owner_id", (q) => q.eq("ownerId", alice.user._id))
        .take(1),
    )).toEqual([]);
  });
});
