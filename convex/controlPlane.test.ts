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
    tokenIdentifier: `https://issuer.ichef.test|${subject}`,
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
  for (const provider of ["chatgpt", "github", "cloudflare", "convex"] as const) {
    await t.mutation(internal.connections.setServiceConnection, {
      ownerId: user._id,
      provider,
      status: "connected",
      scopes: [],
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
      cloudflareAccountRef: `cf-${subject}`,
      convexProjectRef: `convex-${subject}`,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { authenticated, user, connectionId, projectId };
}

describe("authenticated Convex control plane", () => {
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

    let result: { status: string; stage: string } = { status: "purging", stage: "approvals" };
    for (let pass = 0; pass < 30 && result.status !== "complete"; pass += 1) {
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
  });
});
