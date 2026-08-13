import { httpRouter } from "convex/server";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { encryptBridgePayload, randomToken, safeSecretEquals, sha256 } from "./lib/bridgeCrypto";
import type { OAuthProvider } from "./lib/providerCrypto";
import { providerCallbackResponse } from "./providerOAuth";

const router = httpRouter();
const MAX_BODY_BYTES = 64 * 1024;

router.route({
  path: "/v1/spectrum/bridge",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.ICHEF_BRIDGE_SECRET;
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
        const portal = new URL(process.env.PUBLIC_PORTAL_URL ?? "https://ichef.dev");
        portal.pathname = "/connect/imessage";
        portal.search = new URLSearchParams({ claim: claimToken }).toString();
        const outbound = {
          outboundId,
          idempotencyKey,
          spaceId: normalized.spaceId,
          ...(normalized.lineId ? { lineId: normalized.lineId } : {}),
          text: `Welcome to iChef. Securely connect this iMessage address: ${portal.toString()}`,
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
        if (admitted.status === "accepted" && admitted.activeProjectId) {
          try {
            await ctx.runMutation(internal.runs.admit, {
              ownerId: admitted.ownerId,
              projectId: admitted.activeProjectId,
              commandKey: normalized.idempotencyKey,
              instructionHash: await sha256(normalized.text),
            });
          } catch {
            // A concurrent active Run is an expected admission outcome. The
            // encrypted inbound remains durable for ordered processing.
          }
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
          text: "iMessage connected to iChef. Finish connecting ChatGPT, GitHub, Cloudflare, and Convex before starting your first project.",
        };
        const consumed = await ctx.runMutation(internal.bridge.consumeChallenge, {
          addressHash: challenge.addressHash,
          challengeHash: await sha256(challenge.challengeCode.toUpperCase()),
          providerMessageId: challenge.providerMessageId,
          messageHash: await sha256(`ICHEF-${challenge.challengeCode.toUpperCase()}`),
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
        const result = await ctx.runMutation(internal.bridge.claimOutbound, {
          outboundId: stringField(input, "outboundId", 256),
          idempotencyKey: stringField(input, "idempotencyKey", 512),
        });
        return json({ ok: true, result });
      }

      if (operation === "settle_outbound") {
        const status = stringField(input, "status", 32);
        if (status !== "delivered" && status !== "failed_retryable") throw new Error("invalid status");
        const attempts = numberField(input, "attempts", 1, 8);
        await ctx.runMutation(internal.bridge.settleOutbound, {
          outboundId: stringField(input, "outboundId", 256),
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
  path: "/v1/credentials/codex",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.ICHEF_CREDENTIAL_BROKER_SECRET;
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

function oauthCallback(provider: OAuthProvider) {
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
router.route({ path: "/v1/oauth/cloudflare/callback", method: "GET", handler: oauthCallback("cloudflare") });
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
