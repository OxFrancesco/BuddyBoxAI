import { z } from "zod";

import type {
  InboundAdmission,
  InboundAdmissionResult,
  OutboundLease,
  SettlementOutcome,
} from "./types";

const envelopeSchema = z.object({
  algorithm: z.literal("AES-256-GCM"),
  keyVersion: z.number().int().positive(),
  iv: z.string().min(12).max(128),
  ciphertext: z.string().min(1).max(32_000),
});

const admissionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("duplicate"), deliveryId: z.string().min(1), claimRequired: z.boolean() }),
  z.object({ status: z.literal("unbound"), deliveryId: z.string().min(1) }),
  z.object({
    status: z.literal("accepted"),
    deliveryId: z.string().min(1),
    connectionId: z.string().min(1),
    ownerId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    conversationId: z.string().min(1),
  }),
]);

const challengeSchema = z.object({
  connectionId: z.string().min(1),
  ownerId: z.string().min(1),
  alreadyVerified: z.boolean(),
});

const leaseSchema = z.object({
  deliveryId: z.string().min(1),
  connectionId: z.string().min(1),
  providerConversationIdHash: z.string().min(1).max(256),
  messageHash: z.string().min(1).max(256),
  encryptedPayload: envelopeSchema,
  payloadAad: z.string().min(1).max(512),
  occurredAt: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  leaseExpiresAt: z.number().int().positive(),
});

export class ControlPlaneUnavailableError extends Error {
  constructor(readonly status?: number) {
    super("The BuddyBox X Chat control plane is unavailable");
    this.name = "ControlPlaneUnavailableError";
  }
}

export class ConvexXChatControlPlane {
  readonly #url: string;
  readonly #secret: string;
  readonly #fetcher: typeof fetch;

  constructor(options: { url: string; secret: string; fetcher?: typeof fetch }) {
    const url = new URL(options.url);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new TypeError("Broker URL must use HTTPS outside localhost");
    }
    if (options.secret.length < 16) throw new TypeError("Broker secret is too short");
    this.#url = url.toString();
    this.#secret = options.secret;
    this.#fetcher = options.fetcher ?? fetch;
  }

  async admitInbound(input: InboundAdmission): Promise<InboundAdmissionResult> {
    return await this.#call("admit_inbound", input, admissionSchema);
  }

  async completeChallenge(input: { senderIdHash: string; challengeHash: string }) {
    return await this.#call("complete_challenge", input, challengeSchema);
  }

  async leaseOutbound(input: { leaseIdHash: string; now: number; leaseExpiresAt: number; limit: number }): Promise<OutboundLease[]> {
    return await this.#call("lease_outbound", input, z.array(leaseSchema));
  }

  async settleOutbound(input: {
    deliveryId: string;
    leaseIdHash: string;
    outcome: SettlementOutcome;
    externalMessageIdHash?: string;
    errorCode?: string;
  }): Promise<void> {
    await this.#call("settle_outbound", input, z.null());
  }

  async #call<T>(operation: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetcher(this.#url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#secret}`,
          "content-type": "application/json",
          "user-agent": "buddybox-xchat-bridge/0.1",
        },
        body: JSON.stringify({ operation, input }),
        signal: AbortSignal.timeout(10_000),
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
    const result = z.object({ ok: z.literal(true), result: schema }).safeParse(value);
    if (!result.success) throw new ControlPlaneUnavailableError(response.status);
    return result.data.result;
  }
}
