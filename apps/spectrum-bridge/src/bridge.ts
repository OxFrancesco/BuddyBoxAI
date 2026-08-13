import type {
  ChallengeAttempt,
  ChallengeResult,
  InboundResult,
  NormalizedInbound,
  OutboundClaim,
  OutboundMessage,
  OutboundSettlement,
} from "./types";

const DEFAULT_MAX_SEND_ATTEMPTS = 3;
const MAX_OUTBOUND_CHARACTERS = 6_000;
const CHALLENGE_PATTERN = /^ICHEF[- ]([A-HJ-NP-Z2-9]{6,10})$/i;

export interface ControlPlane {
  acceptInbound(message: NormalizedInbound): Promise<InboundResult>;
  completeChallenge(attempt: ChallengeAttempt): Promise<ChallengeResult>;
  claimOutbound(message: Pick<OutboundMessage, "outboundId" | "idempotencyKey">): Promise<OutboundClaim>;
  settleOutbound(settlement: OutboundSettlement): Promise<void>;
}

export interface OutboundTransport {
  sendText(message: Pick<OutboundMessage, "spaceId" | "lineId" | "text">): Promise<{
    providerMessageId: string;
  }>;
}

export interface BridgeOptions {
  controlPlane: ControlPlane;
  transport: OutboundTransport;
  maxSendAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

export type DeliveryResult =
  | { status: "delivered"; attempts: number; providerMessageId: string }
  | { status: "duplicate" }
  | { status: "in_flight" }
  | { status: "settlement_pending"; attempts: number; providerMessageId: string }
  | { status: "failed_retryable"; attempts: number };

export interface Bridge {
  acceptInbound(message: NormalizedInbound): Promise<void>;
  deliverOutbound(message: OutboundMessage): Promise<DeliveryResult>;
}

export function createBridge(options: BridgeOptions): Bridge {
  const maxSendAttempts = options.maxSendAttempts ?? DEFAULT_MAX_SEND_ATTEMPTS;
  if (!Number.isSafeInteger(maxSendAttempts) || maxSendAttempts < 1 || maxSendAttempts > 8) {
    throw new TypeError("maxSendAttempts must be between 1 and 8");
  }
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const random = options.random ?? Math.random;

  async function deliverOutbound(message: OutboundMessage): Promise<DeliveryResult> {
    validateOutbound(message);
    const claim = await options.controlPlane.claimOutbound({
      outboundId: message.outboundId,
      idempotencyKey: message.idempotencyKey,
    });
    if (claim.status === "already_delivered") return { status: "duplicate" };
    if (claim.status === "in_flight") return { status: "in_flight" };

    for (let attempt = 1; attempt <= maxSendAttempts; attempt += 1) {
      let sent: { providerMessageId: string };
      try {
        sent = await options.transport.sendText(message);
      } catch {
        if (attempt < maxSendAttempts) {
          await sleep(backoffMilliseconds(attempt, random()));
        }
        continue;
      }

      const settlement: OutboundSettlement = {
        outboundId: message.outboundId,
        status: "delivered",
        attempts: attempt,
        providerMessageId: sent.providerMessageId,
      };
      try {
        await options.controlPlane.settleOutbound(settlement);
      } catch {
        // The provider accepted this message. Retrying the send here would
        // create a duplicate; leave the Convex lease in-flight for explicit
        // reconciliation instead.
        return {
          status: "settlement_pending",
          attempts: attempt,
          providerMessageId: sent.providerMessageId,
        };
      }
      return { status: "delivered", attempts: attempt, providerMessageId: sent.providerMessageId };
    }

    try {
      await options.controlPlane.settleOutbound({
        outboundId: message.outboundId,
        status: "failed_retryable",
        attempts: maxSendAttempts,
        errorCode: "spectrum_unavailable",
      });
    } catch {
      // The provider never accepted a send, so a later lease recovery may
      // safely retry the same outbound message.
    }
    return { status: "failed_retryable", attempts: maxSendAttempts };
  }

  async function acceptInbound(message: NormalizedInbound): Promise<void> {
    const challengeCode = extractChallengeCode(message.text);
    const result = challengeCode
      ? await options.controlPlane.completeChallenge({
          addressHash: message.addressHash,
          challengeCode,
          providerMessageId: message.providerMessageId,
          idempotencyKey: message.idempotencyKey,
          spaceId: message.spaceId,
          ...(message.lineId ? { lineId: message.lineId } : {}),
        })
      : await options.controlPlane.acceptInbound(message);

    if ("outbound" in result && result.outbound) {
      await deliverOutbound(result.outbound);
    }
  }

  return { acceptInbound, deliverOutbound };
}

export function extractChallengeCode(text: string): string | undefined {
  return CHALLENGE_PATTERN.exec(text.trim())?.[1]?.toUpperCase();
}

function validateOutbound(message: OutboundMessage): void {
  if (
    !message.outboundId ||
    !message.idempotencyKey ||
    !message.spaceId ||
    !message.text.trim() ||
    message.text.length > MAX_OUTBOUND_CHARACTERS
  ) {
    throw new TypeError("invalid outbound message");
  }
}

function backoffMilliseconds(attempt: number, random: number): number {
  const base = Math.min(4_000, 250 * 2 ** (attempt - 1));
  return base + Math.floor(base * 0.25 * Math.max(0, Math.min(1, random)));
}
