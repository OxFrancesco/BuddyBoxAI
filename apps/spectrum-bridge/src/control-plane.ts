import { z } from "zod";

import type { ControlPlane } from "./bridge";
import type {
  ChallengeAttempt,
  ChallengeResult,
  InboundResult,
  NormalizedInbound,
  OutboundClaim,
  OutboundMessage,
  OutboundSettlement,
} from "./types";

const outboundSchema = z.object({
  outboundId: z.string().min(1).max(256),
  idempotencyKey: z.string().min(1).max(512),
  spaceId: z.string().min(1).max(1024),
  lineId: z.string().min(1).max(128).optional(),
  text: z.string().min(1).max(6_000),
});

const inboundResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), deliveryId: z.string().min(1), outbound: outboundSchema.optional() }),
  z.object({ status: z.literal("duplicate"), deliveryId: z.string().min(1) }),
  z.object({ status: z.literal("unbound"), deliveryId: z.string().min(1), outbound: outboundSchema }),
]);

const challengeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("verified"), connectionId: z.string().min(1), outbound: outboundSchema }),
  z.object({ status: z.literal("already_verified"), connectionId: z.string().min(1), outbound: outboundSchema.optional() }),
  z.object({ status: z.literal("invalid"), outbound: outboundSchema.optional() }),
  z.object({ status: z.literal("expired"), outbound: outboundSchema.optional() }),
]);

const outboundClaimSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("claimed") }),
  z.object({ status: z.literal("already_delivered") }),
  z.object({ status: z.literal("in_flight") }),
]);

const emptyResultSchema = z.union([z.null(), z.object({}).strict()]);

export class ControlPlaneUnavailableError extends Error {
  readonly code = "control_plane_unavailable";

  constructor(readonly status?: number) {
    super("The iChef control plane is unavailable");
    this.name = "ControlPlaneUnavailableError";
  }
}

export interface ConvexHttpControlPlaneOptions {
  bridgeUrl: string;
  bridgeSecret: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export class ConvexHttpControlPlane implements ControlPlane {
  readonly #url: string;
  readonly #secret: string;
  readonly #fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly #timeoutMs: number;

  constructor(options: ConvexHttpControlPlaneOptions) {
    const url = new URL(options.bridgeUrl);
    if (url.protocol !== "https:" && !isLocalhost(url.hostname)) {
      throw new TypeError("The Convex bridge URL must use HTTPS outside localhost");
    }
    if (options.bridgeSecret.length < 16) throw new TypeError("The bridge secret is too short");
    this.#url = url.toString();
    this.#secret = options.bridgeSecret;
    this.#fetcher = options.fetcher ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async acceptInbound(message: NormalizedInbound): Promise<InboundResult> {
    return await this.#call("accept_inbound", message, inboundResultSchema);
  }

  async completeChallenge(attempt: ChallengeAttempt): Promise<ChallengeResult> {
    return await this.#call("complete_challenge", attempt, challengeResultSchema);
  }

  async claimOutbound(
    message: Pick<OutboundMessage, "outboundId" | "idempotencyKey">,
  ): Promise<OutboundClaim> {
    return await this.#call("claim_outbound", message, outboundClaimSchema);
  }

  async settleOutbound(settlement: OutboundSettlement): Promise<void> {
    await this.#call("settle_outbound", settlement, emptyResultSchema);
  }

  async #call<T>(operation: string, input: unknown, resultSchema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetcher(this.#url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#secret}`,
          "content-type": "application/json",
          "user-agent": "ichef-spectrum-bridge/0.1",
        },
        body: JSON.stringify({ operation, input }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new ControlPlaneUnavailableError();
    }
    if (!response.ok) throw new ControlPlaneUnavailableError(response.status);

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ControlPlaneUnavailableError(response.status);
    }
    const envelope = z.object({ ok: z.literal(true), result: resultSchema }).safeParse(value);
    if (!envelope.success) throw new ControlPlaneUnavailableError(response.status);
    return envelope.data.result;
  }
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
