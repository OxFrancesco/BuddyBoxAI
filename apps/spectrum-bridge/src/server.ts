import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import type { Bridge } from "./bridge";
import { normalizeSpectrumInbound } from "./normalize";
import { acceptSpectrumWebhook, type SpectrumWebhookSecurityOptions } from "./security";
import type { OutboundMessage } from "./types";

const INTERNAL_BODY_LIMIT = 32 * 1024;

const outboundSchema = z.object({
  outboundId: z.string().min(1).max(256),
  idempotencyKey: z.string().min(1).max(512),
  spaceId: z.string().min(1).max(1024),
  lineId: z.string().min(1).max(128).optional(),
  text: z.string().min(1).max(6_000),
});

export interface RequestHandlerOptions {
  bridge: Bridge;
  addressPepper: string;
  internalSecret: string;
  webhookSecurity?: SpectrumWebhookSecurityOptions;
}

export function createRequestHandler(options: RequestHandlerOptions): (request: Request) => Promise<Response> {
  if (options.addressPepper.length < 16) throw new TypeError("The address pepper is too short");
  if (options.internalSecret.length < 16) throw new TypeError("The internal secret is too short");

  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }
    if (request.method === "POST" && url.pathname === "/v1/spectrum/webhook") {
      if (!options.webhookSecurity) return new Response(null, { status: 404 });
      return await handleSpectrumWebhook(request, options);
    }
    if (request.method === "POST" && url.pathname === "/v1/outbound") {
      return await handleOutbound(request, options);
    }
    return new Response(null, { status: 404 });
  };
}

async function handleSpectrumWebhook(request: Request, options: RequestHandlerOptions): Promise<Response> {
  const webhookSecurity = options.webhookSecurity;
  if (!webhookSecurity) return new Response(null, { status: 404 });
  const accepted = await acceptSpectrumWebhook(request, webhookSecurity);
  if (!accepted.ok) return new Response(null, { status: accepted.status });
  if (accepted.event !== "messages") return new Response(null, { status: 204 });

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(accepted.rawBody));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!isRecord(payload) || payload.event !== accepted.event) {
    return new Response(null, { status: 400 });
  }

  const normalized = await normalizeSpectrumInbound(payload, {
    addressPepper: options.addressPepper,
    webhookId: accepted.webhookId,
  });
  if (!normalized.ok) {
    const tooLarge = normalized.reason === "message_too_large" || normalized.reason === "attachment_too_large";
    const ignorable = normalized.reason === "unsupported_content" || normalized.reason === "unsupported_platform";
    return new Response(null, { status: tooLarge ? 413 : ignorable ? 202 : 400 });
  }

  try {
    await options.bridge.acceptInbound(normalized.value);
    return new Response(null, { status: 202 });
  } catch {
    return new Response(null, { status: 503, headers: { "retry-after": "5" } });
  }
}

async function handleOutbound(request: Request, options: RequestHandlerOptions): Promise<Response> {
  if (!authorized(request.headers.get("authorization"), options.internalSecret)) {
    return new Response(null, { status: 401 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return new Response(null, { status: 415 });
  }
  const input = await readJson(request, INTERNAL_BODY_LIMIT);
  if (input.status !== "ok") return new Response(null, { status: input.status });
  const message = outboundSchema.safeParse(input.value);
  if (!message.success) return new Response(null, { status: 400 });

  try {
    const result = await options.bridge.deliverOutbound(message.data as OutboundMessage);
    if (result.status === "failed_retryable" || result.status === "settlement_pending") {
      return Response.json(result, { status: 503, headers: { "retry-after": "30" } });
    }
    if (result.status === "reconciliation_required") {
      return Response.json(result, { status: 409 });
    }
    return Response.json(result, { status: result.status === "in_flight" ? 202 : 200 });
  } catch {
    return new Response(null, { status: 503, headers: { "retry-after": "30" } });
  }
}

function authorized(value: string | null, expected: string): boolean {
  const prefix = "Bearer ";
  if (!value?.startsWith(prefix)) return false;
  const received = Buffer.from(value.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

async function readJson(
  request: Request,
  limit: number,
): Promise<{ status: "ok"; value: unknown } | { status: 400 | 413 }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return { status: 400 };
    if (Number(contentLength) > limit) return { status: 413 };
  }
  if (!request.body) return { status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        return { status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { status: 400 };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { status: "ok", value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { status: 400 };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
