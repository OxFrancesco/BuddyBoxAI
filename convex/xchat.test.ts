import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./channels.ts": () => import("./channels"),
  "./connections.ts": () => import("./connections"),
  "./conversations.ts": () => import("./conversations"),
  "./maintenance.ts": () => import("./maintenance"),
  "./runs.ts": () => import("./runs"),
  "./usage.ts": () => import("./usage"),
  "./users.ts": () => import("./users"),
  "./xchat.ts": () => import("./xchat"),
};

const identity = {
  subject: "xchat-user",
  tokenIdentifier: "https://issuer.ichef.test|xchat-user",
};

async function userFixture(t: ReturnType<typeof convexTest>) {
  const authenticated = t.withIdentity(identity);
  const user = await authenticated.mutation(api.users.syncCurrent, {
    displayName: "X Chat User",
  });
  const now = Date.now();
  for (const provider of ["chatgpt", "github", "convex"] as const) {
    const externalAccountIdHash = `${provider}-account-hash`;
    const credentialId = provider === "chatgpt" ? undefined : await t.run((ctx) =>
      ctx.db.insert("providerCredentials", {
        ownerId: user._id,
        provider,
        accessTokenCiphertext: `encrypted-${provider}-access`,
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
  const projectId = await t.run((ctx) =>
    ctx.db.insert("projects", {
      ownerId: user._id,
      name: "X Project",
      slug: "x-project",
      status: "active",
      githubRepositoryId: "repo-x",
      githubRepositoryFullName: "owner/x-project",
      defaultBranch: "main",
      convexProjectRef: "convex-x",
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { authenticated, user, projectId };
}

describe("X Chat channel", () => {
  test("readiness accepts centrally hosted Cloudflare and either verified messaging channel", async () => {
    const t = convexTest(schema, modules);
    const fixture = await userFixture(t);
    const before = await fixture.authenticated.query(api.connections.listMine, {});
    expect(before.readiness).toEqual({ ready: false, missing: ["messaging"] });
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("xchatConnections", {
        ownerId: fixture.user._id,
        senderIdHash: "readiness-sender",
        providerConversationIdHash: "readiness-conversation",
        maskedSender: "X Chat •sender",
        status: "verified",
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const after = await fixture.authenticated.query(api.connections.listMine, {});
    expect(after.readiness).toEqual({ ready: true, missing: [] });
    expect(after.services.map((service) => service.provider)).not.toContain("cloudflare");
  });

  test("an expiring one-use claim binds a hashed X sender to the Clerk identity", async () => {
    const t = convexTest(schema, modules);
    const fixture = await userFixture(t);
    const expiresAt = Date.now() + 5 * 60_000;
    const admitted = await t.mutation(internal.xchat.admitInbound, {
      senderIdHash: "sender-hash",
      providerConversationIdHash: "conversation-hash",
      eventUuid: "event-claim-1",
      providerMessageId: "message-claim-1",
      messageHash: "message-claim-hash",
      claimTokenHash: "claim-token-hash",
      claimExpiresAt: expiresAt,
      occurredAt: Date.now(),
    });
    expect(admitted.status).toBe("unbound");
    const duplicateAdmission = await t.mutation(internal.xchat.admitInbound, {
      senderIdHash: "sender-hash",
      providerConversationIdHash: "conversation-hash",
      eventUuid: "event-claim-1",
      providerMessageId: "message-claim-1",
      messageHash: "message-claim-hash",
      claimTokenHash: "unused-retry-token-hash",
      claimExpiresAt: expiresAt,
      occurredAt: Date.now(),
    });
    expect(duplicateAdmission).toEqual({
      status: "duplicate",
      deliveryId: admitted.deliveryId,
      claimRequired: true,
    });
    const attached = await t.mutation(internal.xchat.attachClaim, {
      tokenHash: "claim-token-hash",
      authSubject: identity.subject,
      challengeHash: "challenge-hash",
      expiresAt,
    });
    const connectionId = attached.connectionId;
    await expect(t.mutation(internal.xchat.attachClaim, {
      tokenHash: "claim-token-hash",
      authSubject: identity.subject,
      challengeHash: "other-challenge",
      expiresAt,
    })).rejects.toThrow("already used");
    const completed = await t.mutation(internal.xchat.completeChallenge, {
      senderIdHash: "sender-hash",
      challengeHash: "challenge-hash",
    });
    expect(completed).toEqual({
      connectionId,
      ownerId: fixture.user._id,
      alreadyVerified: false,
    });
    await expect(
      t.mutation(internal.xchat.completeChallenge, {
        senderIdHash: "sender-hash",
        challengeHash: "challenge-hash",
      }),
    ).rejects.toThrow("already verified");
  });

  test("an inbound event is deduplicated and routes through the active Project", async () => {
    const t = convexTest(schema, modules);
    const fixture = await userFixture(t);
    const now = Date.now();
    const connectionId = await t.run((ctx) =>
      ctx.db.insert("xchatConnections", {
        ownerId: fixture.user._id,
        senderIdHash: "inbound-sender",
        providerConversationIdHash: "inbound-conversation",
        maskedSender: "@i•••d",
        status: "verified",
        verifiedAt: now,
        activeProjectId: fixture.projectId,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const first = await t.mutation(internal.xchat.acceptInbound, {
      senderIdHash: "inbound-sender",
      providerConversationIdHash: "inbound-conversation",
      eventUuid: "event-uuid-1",
      providerMessageId: "message-id-1",
      messageHash: "message-hash-1",
      occurredAt: now,
    });
    expect(first).toMatchObject({
      duplicate: false,
      ownerId: fixture.user._id,
      projectId: fixture.projectId,
      connectionId,
    });
    const duplicateAdmission = await t.mutation(internal.xchat.admitInbound, {
      senderIdHash: "inbound-sender",
      providerConversationIdHash: "inbound-conversation",
      eventUuid: "event-uuid-1",
      providerMessageId: "message-id-1",
      messageHash: "message-hash-1",
      claimTokenHash: "unused-bound-duplicate-claim-hash",
      claimExpiresAt: now + 60_000,
      occurredAt: now,
    });
    expect(duplicateAdmission).toEqual({
      status: "duplicate",
      deliveryId: first.deliveryId,
      claimRequired: false,
    });
    const duplicate = await t.mutation(internal.xchat.acceptInbound, {
      senderIdHash: "inbound-sender",
      providerConversationIdHash: "inbound-conversation",
      eventUuid: "event-uuid-1",
      providerMessageId: "message-id-1",
      messageHash: "message-hash-1",
      occurredAt: now,
    });
    expect(duplicate).toEqual({ ...first, duplicate: true });
    const duplicateMessage = await t.mutation(internal.xchat.acceptInbound, {
      senderIdHash: "inbound-sender",
      providerConversationIdHash: "inbound-conversation",
      eventUuid: "event-uuid-retry",
      providerMessageId: "message-id-1",
      messageHash: "message-hash-1",
      occurredAt: now,
    });
    expect(duplicateMessage).toEqual({ ...first, duplicate: true });
    const conversation = await t.run((ctx) => ctx.db.get(first.conversationId));
    expect(conversation).toMatchObject({ channel: "xchat", xchatConnectionId: connectionId });
  });

  test("outbound payloads persist only ciphertext and use an exclusive lease", async () => {
    const t = convexTest(schema, modules);
    const fixture = await userFixture(t);
    const now = Date.now();
    const connectionId = await t.run((ctx) =>
      ctx.db.insert("xchatConnections", {
        ownerId: fixture.user._id,
        senderIdHash: "outbound-sender",
        providerConversationIdHash: "outbound-conversation",
        maskedSender: "@o•••d",
        status: "verified",
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const envelope = {
      algorithm: "AES-256-GCM" as const,
      keyVersion: 1,
      iv: "base64-iv-value",
      ciphertext: "base64-ciphertext-with-tag",
    };
    const deliveryId = await t.mutation(internal.xchat.enqueueOutbound, {
      ownerId: fixture.user._id,
      connectionId,
      idempotencyKey: "reply-to-event-1",
      messageHash: "outbound-message-hash",
      encryptedPayload: envelope,
      availableAt: now,
    });
    const leased = await t.mutation(internal.xchat.leaseOutbound, {
      leaseIdHash: "lease-hash-1",
      now,
      leaseExpiresAt: now + 30_000,
      limit: 10,
    });
    expect(leased).toHaveLength(1);
    expect(leased[0]).toMatchObject({
      deliveryId,
      encryptedPayload: envelope,
      payloadAad: "xchat:outbound:reply-to-event-1",
    });
    expect(await t.mutation(internal.xchat.leaseOutbound, {
      leaseIdHash: "lease-hash-2",
      now,
      leaseExpiresAt: now + 30_000,
      limit: 10,
    })).toEqual([]);
    await t.mutation(internal.xchat.settleOutbound, {
      deliveryId,
      leaseIdHash: "lease-hash-1",
      outcome: "sent",
      externalMessageIdHash: "x-message-id-hash",
    });
    const stored = await t.run((ctx) => ctx.db.get(deliveryId));
    expect(stored?.status).toBe("sent");
    expect(stored?.encryptedPayload).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("plaintext");
  });

  test("retention removes expired X Chat claims and deliveries", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("xchatClaims", {
        senderIdHash: "expired-sender",
        providerConversationIdHash: "expired-conversation",
        tokenHash: "expired-token",
        status: "expired",
        expiresAt: now - 1,
        createdAt: now - 10,
        updatedAt: now - 1,
      });
      await ctx.db.insert("channelDeliveries", {
        provider: "xchat",
        providerSenderIdHash: "expired-sender",
        providerConversationIdHash: "expired-conversation",
        direction: "inbound",
        providerEventId: "expired-event",
        providerMessageId: "expired-message",
        messageHash: "expired-message-hash",
        status: "received",
        occurredAt: now - 10,
        updatedAt: now - 1,
        expiresAt: now - 1,
      });
    });
    const result = await t.mutation(internal.maintenance.sweepExpired, { now });
    expect(result.xchatClaims).toBe(1);
    expect(result.deliveries).toBe(1);
  });
});
