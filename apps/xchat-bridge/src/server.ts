import { crcResponse, acceptXWebhook } from "./security";
import type { XChatBridge } from "./bridge";
import type { WebhookReplayAdmission, WebhookReplayClaim } from "./replay";

export function createRequestHandler(options: {
  bridge: Pick<XChatBridge, "acceptWebhookPayload">;
  consumerSecret?: string;
  replay: WebhookReplayAdmission;
  ready?: () => boolean;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok" }, { headers: noStore() });
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      return Response.json(
        { status: options.ready?.() === false ? "starting" : "ready" },
        { status: options.ready?.() === false ? 503 : 200, headers: noStore() },
      );
    }
    if (request.method === "GET" && url.pathname === "/v1/xchat/webhook") {
      if (!options.consumerSecret) return new Response(null, { status: 404 });
      const token = url.searchParams.get("crc_token");
      if (!token) return new Response(null, { status: 400 });
      return Response.json(
        { response_token: await crcResponse(token, options.consumerSecret) },
        { headers: noStore() },
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/xchat/webhook") {
      if (!options.consumerSecret) return new Response(null, { status: 404 });
      const admitted = await acceptXWebhook(request, options.consumerSecret);
      if (!admitted.ok) return new Response(null, { status: admitted.status });
      let claim: WebhookReplayClaim;
      try {
        const decision = await options.replay.claim(admitted.rawBody);
        if (decision.status === "duplicate") return webhookResponse(200);
        if (decision.status === "in_flight") return webhookResponse(409, "2");
        if (decision.status === "full") return webhookResponse(429, "60");
        claim = decision.claim;
      } catch {
        return webhookResponse(503, "5");
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(admitted.rawBody));
      } catch {
        try {
          await options.replay.complete(claim);
        } catch {
          return webhookResponse(503, "5");
        }
        return webhookResponse(400);
      }
      try {
        await options.bridge.acceptWebhookPayload(body);
        await options.replay.complete(claim);
        return webhookResponse(200);
      } catch {
        try {
          await options.replay.release(claim);
        } catch {
          // A processing lease expires, allowing a later provider retry even
          // if the encrypted vault is temporarily unavailable during release.
        }
        return webhookResponse(503, "5");
      }
    }
    return new Response(null, { status: 404 });
  };
}

function webhookResponse(status: number, retryAfter?: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(null, { status, headers });
}

function noStore(): HeadersInit {
  return { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" };
}
