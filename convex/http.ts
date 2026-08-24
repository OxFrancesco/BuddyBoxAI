import { httpRouter } from "convex/server";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { encryptBridgePayload, randomToken, safeSecretEquals, sha256 } from "./lib/bridgeCrypto";
import {
  providerCallbackResponse,
  type UserConnectableOAuthProvider,
} from "./providerOAuth";

const router = httpRouter();
const MAX_BODY_BYTES = 64 * 1024;
const SPECTRUM_OUTBOUND_LEASE_TTL_MS = 2 * 60 * 1_000;

router.route({
  path: "/v1/spectrum/bridge",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.BUDDYBOX_BRIDGE_SECRET;
    const authorization = request.headers.get("authorization") ?? "";
    const actual = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!expected || expected.length < 32 || !(await safeSecretEquals(actual, expected))) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "body_too_large" }, 413);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "body_too_large" }, 413);
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    try {
      const requestBody = asRecord(body);
      const operation = stringField(requestBody, "operation", 64);
      const input = asRecord(requestBody.input);
      if (operation === "accept_inbound") {
        const normalized = parseInbound(input);
        const claimToken = randomToken();
        const outboundId = crypto.randomUUID();
        const idempotencyKey = `onboarding:${normalized.idempotencyKey}`;
        const portal = new URL(process.env.PUBLIC_PORTAL_URL ?? "https://buddybox.dev");
        portal.pathname = "/connect/imessage";
        portal.search = new URLSearchParams({ claim: claimToken }).toString();
        const outbound = {
          outboundId,
          idempotencyKey,
          spaceId: normalized.spaceId,
          ...(normalized.lineId ? { lineId: normalized.lineId } : {}),
          text: `Welcome to BuddyBox. Securely connect this iMessage address: ${portal.toString()}`,
        };
        const admitted = await ctx.runMutation(internal.bridge.admitInbound, {
          providerMessageId: normalized.providerMessageId,
          messageHash: await sha256(JSON.stringify({ text: normalized.text, attachments: normalized.attachments })),
          addressHash: normalized.addressHash,
          sentAt: Date.parse(normalized.sentAt),
          payloadCiphertext: await encryptBridgePayload(normalized),
          claimTokenHash: await sha256(claimToken),
          claimExpiresAt: Date.now() + 15 * 60 * 1_000,
          outboundId,
          outboundIdempotencyKey: idempotencyKey,
          outboundPayloadCiphertext: await encryptBridgePayload(outbound),
        });
        if (admitted.status === "accepted") {
          await ctx.scheduler.runAfter(0, internal.orchestrator.dispatchInboundDelivery, {
            deliveryId: admitted.deliveryId,
          });
        }
        const result = admitted.status === "unbound"
          ? { status: "unbound", deliveryId: admitted.deliveryId, outbound }
          : { status: admitted.status, deliveryId: admitted.deliveryId };
        return json({ ok: true, result });
      }

      if (operation === "complete_challenge") {
        const challenge = parseChallenge(input);
        const outboundId = crypto.randomUUID();
        const idempotencyKey = `challenge:${challenge.idempotencyKey}`;
        const outbound = {
          outboundId,
          idempotencyKey,
          spaceId: challenge.spaceId,
          ...(challenge.lineId ? { lineId: challenge.lineId } : {}),
          text: "iMessage connected to BuddyBox. Finish connecting ChatGPT, GitHub, and Convex before starting your first project.",
        };
        const consumed = await ctx.runMutation(internal.bridge.consumeChallenge, {
          addressHash: challenge.addressHash,
          challengeHash: await sha256(challenge.challengeCode.toUpperCase()),
          providerMessageId: challenge.providerMessageId,
          messageHash: await sha256(`BUDDYBOX-${challenge.challengeCode.toUpperCase()}`),
          sentAt: Date.now(),
          outboundId,
          outboundIdempotencyKey: idempotencyKey,
          outboundPayloadCiphertext: await encryptBridgePayload(outbound),
        });
        if (consumed.status === "verified" && consumed.connectionId) {
          return json({ ok: true, result: { status: "verified", connectionId: consumed.connectionId, outbound } });
        }
        if ((consumed.status === "already_verified" || consumed.status === "duplicate") && consumed.connectionId) {
          return json({ ok: true, result: { status: "already_verified", connectionId: consumed.connectionId } });
        }
        return json({ ok: true, result: { status: consumed.status === "expired" ? "expired" : "invalid" } });
      }

      if (operation === "claim_outbound") {
        const leaseToken = randomToken(32);
        const result = await ctx.runMutation(internal.bridge.claimOutbound, {
          outboundId: stringField(input, "outboundId", 256),
          idempotencyKey: stringField(input, "idempotencyKey", 512),
          leaseIdHash: await sha256(leaseToken),
          leaseExpiresAt: Date.now() + SPECTRUM_OUTBOUND_LEASE_TTL_MS,
        });
        return json({
          ok: true,
          result: result.status === "claimed" ? { ...result, leaseToken } : result,
        });
      }

      if (operation === "settle_outbound") {
        const status = stringField(input, "status", 32);
        if (status !== "delivered" && status !== "failed_retryable") throw new Error("invalid status");
        const attempts = numberField(input, "attempts", 1, 8);
        await ctx.runMutation(internal.bridge.settleOutbound, {
          outboundId: stringField(input, "outboundId", 256),
          leaseIdHash: await sha256(stringField(input, "leaseToken", 256)),
          status,
          attempts,
          ...(status === "delivered"
            ? { providerMessageId: stringField(input, "providerMessageId", 300) }
            : { errorCode: "spectrum_unavailable" as const }),
        });
        return json({ ok: true, result: null });
      }
      return json({ ok: false, error: "unknown_operation" }, 400);
    } catch {
      return json({ ok: false, error: "invalid_request" }, 400);
    }
  }),
});

router.route({
  path: "/v1/xchat/broker",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.BUDDYBOX_BRIDGE_SECRET;
    const authorization = request.headers.get("authorization") ?? "";
    const actual = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!expected || expected.length < 32 || !(await safeSecretEquals(actual, expected))) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "body_too_large" }, 413);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "body_too_large" }, 413);
    }
    try {
      const body = asRecord(JSON.parse(raw));
      const operation = stringField(body, "operation", 64);
      const input = asRecord(body.input);
      if (operation === "admit_inbound") {
        const result = await ctx.runMutation(internal.xchat.admitInbound, {
          senderIdHash: stringField(input, "senderIdHash", 256),
          providerConversationIdHash: stringField(
            input,
            "providerConversationIdHash",
            256,
          ),
          eventUuid: stringField(input, "eventUuid", 256),
          providerMessageId: stringField(input, "providerMessageId", 256),
          messageHash: stringField(input, "messageHash", 256),
          ...(input.encryptedPayload === undefined
            ? {}
            : { encryptedPayload: encryptedPayloadField(input, "encryptedPayload") }),
          claimTokenHash: stringField(input, "claimTokenHash", 256),
          claimExpiresAt: numberField(
            input,
            "claimExpiresAt",
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          occurredAt: numberField(input, "occurredAt", 0, Number.MAX_SAFE_INTEGER),
        });
        if (result.status === "accepted") {
          await ctx.scheduler.runAfter(0, internal.orchestrator.dispatchInboundDelivery, {
            deliveryId: result.deliveryId,
          });
        }
        return json({ ok: true, result });
      }
      if (operation === "complete_challenge") {
        const result = await ctx.runMutation(internal.xchat.completeChallenge, {
          senderIdHash: stringField(input, "senderIdHash", 256),
          challengeHash: stringField(input, "challengeHash", 256),
        });
        return json({ ok: true, result });
      }
      if (operation === "enqueue_outbound") {
        const result = await ctx.runMutation(internal.xchat.enqueueOutbound, {
          ownerId: stringField(input, "ownerId", 128) as never,
          connectionId: stringField(input, "connectionId", 128) as never,
          ...(optionalStringField(input, "conversationId", 128)
            ? { conversationId: optionalStringField(input, "conversationId", 128) as never }
            : {}),
          ...(optionalStringField(input, "runId", 128)
            ? { runId: optionalStringField(input, "runId", 128) as never }
            : {}),
          idempotencyKey: stringField(input, "idempotencyKey", 256),
          messageHash: stringField(input, "messageHash", 256),
          encryptedPayload: encryptedPayloadField(input, "encryptedPayload"),
          ...(input.availableAt === undefined
            ? {}
            : { availableAt: numberField(input, "availableAt", 0, Number.MAX_SAFE_INTEGER) }),
        });
        return json({ ok: true, result: { deliveryId: result } });
      }
      if (operation === "lease_outbound") {
        const result = await ctx.runMutation(internal.xchat.leaseOutbound, {
          leaseIdHash: stringField(input, "leaseIdHash", 256),
          now: numberField(input, "now", 0, Number.MAX_SAFE_INTEGER),
          leaseExpiresAt: numberField(
            input,
            "leaseExpiresAt",
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          limit: numberField(input, "limit", 1, 100),
        });
        return json({ ok: true, result });
      }
      if (operation === "settle_outbound") {
        const outcome = stringField(input, "outcome", 32);
        if (
          outcome !== "sent" &&
          outcome !== "delivered" &&
          outcome !== "failed" &&
          outcome !== "failed_retryable"
        ) throw new Error("invalid outcome");
        await ctx.runMutation(internal.xchat.settleOutbound, {
          deliveryId: stringField(input, "deliveryId", 128) as never,
          leaseIdHash: stringField(input, "leaseIdHash", 256),
          outcome,
          ...(optionalStringField(input, "externalMessageIdHash", 256)
            ? { externalMessageIdHash: optionalStringField(input, "externalMessageIdHash", 256) }
            : {}),
          ...(optionalStringField(input, "errorCode", 128)
            ? { errorCode: optionalStringField(input, "errorCode", 128) }
            : {}),
        });
        return json({ ok: true, result: null });
      }
      return json({ ok: false, error: "unknown_operation" }, 400);
    } catch {
      return json({ ok: false, error: "invalid_request" }, 400);
    }
  }),
});

// This endpoint is private control-plane infrastructure. The BuddyBox site-host
// must authenticate every request with the operator-managed shared secret;
// browser/user credentials are intentionally not accepted at this boundary.
router.route({
  path: "/v1/site-host/broker",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.BUDDYBOX_SITE_HOST_SECRET;
    const authorization = request.headers.get("authorization") ?? "";
    const actual = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!expected || expected.length < 32 || !(await safeSecretEquals(actual, expected))) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 8_192) {
      return json({ ok: false, error: "body_too_large" }, 413);
    }
    try {
      const body = asRecord(JSON.parse(raw));
      const operation = stringField(body, "operation", 64);
      const input = asRecord(body.input);
      if (operation === "resolve_site") {
        const hostname = managedHostnameField(input, "hostname");
        const result = await ctx.runQuery(internal.releases.resolveManagedSite, {
          hostname,
        });
        return json({ ok: true, result });
      }
      if (operation === "reserve_upload") {
        const result = await ctx.runMutation(internal.releases.reserveManagedDeploymentUpload, {
          projectId: stringField(input, "projectId", 128) as never,
          releaseId: stringField(input, "releaseId", 128) as never,
          sourceRunId: stringField(input, "sourceRunId", 128) as never,
          commitSha: commitShaField(input),
          hostname: managedHostnameField(input, "hostname"),
          artifactManifestDigest: stringField(input, "artifactManifestDigest", 64),
          attemptId: stringField(input, "attemptId", 128),
        });
        return json({ ok: true, result });
      }
      if (operation === "fail_upload") {
        const result = await ctx.runMutation(internal.releases.failManagedDeploymentUpload, {
          releaseId: stringField(input, "releaseId", 128) as never,
          attemptId: stringField(input, "attemptId", 128),
        });
        return json({ ok: true, result });
      }
      if (operation === "activate_release") {
        const result = await ctx.runMutation(internal.releases.activateManagedRelease, {
          projectId: stringField(input, "projectId", 128) as never,
          releaseId: stringField(input, "releaseId", 128) as never,
          sourceRunId: stringField(input, "sourceRunId", 128) as never,
          deploymentRef: stringField(input, "deploymentRef", 512),
          liveUrl: stringField(input, "liveUrl", 512),
          commitSha: commitShaField(input),
          hostname: managedHostnameField(input, "hostname"),
          artifactManifestDigest: stringField(input, "artifactManifestDigest", 64),
          attemptId: stringField(input, "attemptId", 128),
        });
        return json({ ok: true, result });
      }
      return json({ ok: false, error: "unknown_operation" }, 400);
    } catch {
      return json({ ok: false, error: "invalid_request" }, 400);
    }
  }),
});

router.route({
  path: "/v1/credentials/codex",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.BUDDYBOX_CREDENTIAL_BROKER_SECRET;
    const authorization = request.headers.get("authorization") ?? "";
    const actual = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!expected || expected.length < 32 || !(await safeSecretEquals(actual, expected))) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 4_096) {
      return json({ ok: false, error: "body_too_large" }, 413);
    }
    try {
      const body = asRecord(JSON.parse(raw));
      const result = await ctx.runAction(internal.codexConnectionActions.resolveAccessInternal, {
        ownerId: stringField(body, "ownerId", 128) as never,
      });
      return json({ ok: true, result });
    } catch {
      return json({ ok: false, error: "credential_unavailable" }, 503);
    }
  }),
});

router.route({
  path: "/v1/credentials/github",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.BUDDYBOX_CREDENTIAL_BROKER_SECRET;
    const authorization = request.headers.get("authorization") ?? "";
    const actual = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!expected || expected.length < 32 || !(await safeSecretEquals(actual, expected))) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 4_096) {
      return json({ ok: false, error: "body_too_large" }, 413);
    }
    try {
      const body = asRecord(JSON.parse(raw));
      const result = await ctx.runAction(internal.providerOAuth.resolveGitHubInstallationInternal, {
        ownerId: stringField(body, "ownerId", 128) as never,
        projectId: stringField(body, "projectId", 128) as never,
      });
      return json({ ok: true, result });
    } catch {
      return json({ ok: false, error: "credential_unavailable" }, 503);
    }
  }),
});

function oauthCallback(provider: UserConnectableOAuthProvider) {
  return httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const denied = url.searchParams.has("error");
    if (denied || state.length < 32 || state.length > 160 || code.length < 1 || code.length > 2_048) {
      return providerCallbackResponse(provider, "error");
    }
    try {
      await ctx.runAction(internal.providerOAuth.finishCallback, { provider, state, code });
      return providerCallbackResponse(provider, "connected");
    } catch {
      return providerCallbackResponse(provider, "error");
    }
  });
}

router.route({ path: "/v1/oauth/github/callback", method: "GET", handler: oauthCallback("github") });
router.route({ path: "/v1/oauth/convex/callback", method: "GET", handler: oauthCallback("convex") });

function parseInbound(input: Record<string, unknown>) {
  const sentAt = stringField(input, "sentAt", 64);
  if (!Number.isFinite(Date.parse(sentAt))) throw new Error("invalid sentAt");
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  if (attachments.length > 4) throw new Error("too many attachments");
  return {
    source: "imessage" as const,
    idempotencyKey: stringField(input, "idempotencyKey", 512),
    providerMessageId: stringField(input, "providerMessageId", 300),
    providerWebhookId: stringField(input, "providerWebhookId", 300),
    addressHash: stringField(input, "addressHash", 256),
    spaceId: stringField(input, "spaceId", 1_024),
    ...(optionalStringField(input, "lineId", 128) ? { lineId: optionalStringField(input, "lineId", 128) } : {}),
    sentAt,
    text: typeof input.text === "string" && input.text.length <= 16_000 ? input.text : (() => { throw new Error("invalid text"); })(),
    attachments,
  };
}

function parseChallenge(input: Record<string, unknown>) {
  const challengeCode = stringField(input, "challengeCode", 10).toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6,10}$/.test(challengeCode)) throw new Error("invalid challenge");
  return {
    addressHash: stringField(input, "addressHash", 256),
    challengeCode,
    providerMessageId: stringField(input, "providerMessageId", 300),
    idempotencyKey: stringField(input, "idempotencyKey", 512),
    spaceId: stringField(input, "spaceId", 1_024),
    ...(optionalStringField(input, "lineId", 128) ? { lineId: optionalStringField(input, "lineId", 128) } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string, maximum: number): string {
  const result = value[field];
  if (typeof result !== "string" || result.length < 1 || result.length > maximum) throw new Error(`${field} invalid`);
  return result;
}

function optionalStringField(value: Record<string, unknown>, field: string, maximum: number): string | undefined {
  const result = value[field];
  if (result === undefined) return undefined;
  if (typeof result !== "string" || result.length < 1 || result.length > maximum) throw new Error(`${field} invalid`);
  return result;
}

function encryptedPayloadField(value: Record<string, unknown>, field: string) {
  const envelope = asRecord(value[field]);
  if (envelope.algorithm !== "AES-256-GCM") throw new Error(`${field} algorithm invalid`);
  return {
    algorithm: "AES-256-GCM" as const,
    keyVersion: numberField(envelope, "keyVersion", 1, Number.MAX_SAFE_INTEGER),
    iv: stringField(envelope, "iv", 128),
    ciphertext: stringField(envelope, "ciphertext", 32_000),
  };
}

function managedHostnameField(value: Record<string, unknown>, field: string): string {
  const hostname = stringField(value, field, 253);
  const baseDomain = (process.env.BUDDYBOX_SITES_BASE_DOMAIN ?? "buddybox-sites.buddytools.org")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    hostname !== hostname.toLowerCase() ||
    !hostname.endsWith(`-${baseDomain}`) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.buddytools\.org$/u.test(hostname)
  ) throw new Error(`${field} invalid`);
  return hostname;
}

function commitShaField(value: Record<string, unknown>): string {
  const commitSha = stringField(value, "commitSha", 64).toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(commitSha)) throw new Error("commitSha invalid");
  return commitSha;
}

function numberField(value: Record<string, unknown>, field: string, minimum: number, maximum: number): number {
  const result = value[field];
  if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > maximum) throw new Error(`${field} invalid`);
  return result as number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default router;
