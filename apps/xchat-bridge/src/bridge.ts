import { EnvelopeProtector, keyedHash, randomToken, sha256 } from "./crypto";
import type { XChatEngine } from "./chat-engine";
import type { ConvexXChatControlPlane } from "./control-plane";
import { ReplayGuard } from "./replay";
import type { OutboundPlaintext, PreparedSend, VerifiedInboundText } from "./types";
import type { SecureVault } from "./vault";
import { XApiError } from "./x-api";

const CHALLENGE_PATTERN = /^BUDDYBOX[- ]([A-HJ-NP-Z2-9]{6,10})$/i;

interface PreparedRecord {
  state: "prepared" | "accepted";
  prepared: PreparedSend;
}

type DirectReplyRecord =
  | {
      state: "pending";
      conversationId: string;
      text: string;
      claimAdmission?: ClaimAdmission;
    }
  | { state: "prepared"; prepared: PreparedSend; claimAdmission?: ClaimAdmission };

interface ClaimAdmission {
  claimTokenHash: string;
  claimExpiresAt: number;
}

type ClaimDirectReplyRecord = DirectReplyRecord & { claimAdmission: ClaimAdmission };

const CLAIM_TTL_MS = 14 * 60_000;

export class XChatBridge {
  readonly #control: Pick<ConvexXChatControlPlane, "admitInbound" | "completeChallenge" | "leaseOutbound" | "settleOutbound">;
  readonly #engine: Pick<XChatEngine, "decryptLive" | "prepareText" | "send">;
  readonly #protector: EnvelopeProtector;
  readonly #vault: SecureVault;
  readonly #addressPepper: string;
  readonly #portalUrl: string;
  readonly #claimTokenFactory: () => string;
  readonly #uncommittedClaimReplies = new Map<
    string,
    Extract<ClaimDirectReplyRecord, { state: "pending" }>
  >();
  readonly #replay = new ReplayGuard();

  constructor(options: {
    control: Pick<ConvexXChatControlPlane, "admitInbound" | "completeChallenge" | "leaseOutbound" | "settleOutbound">;
    engine: Pick<XChatEngine, "decryptLive" | "prepareText" | "send">;
    protector: EnvelopeProtector;
    vault: SecureVault;
    addressPepper: string;
    portalUrl?: string;
    claimTokenFactory?: () => string;
  }) {
    this.#control = options.control;
    this.#engine = options.engine;
    this.#protector = options.protector;
    this.#vault = options.vault;
    this.#addressPepper = options.addressPepper;
    this.#portalUrl = securePortalUrl(options.portalUrl ?? "https://buddybox.buddytools.org");
    this.#claimTokenFactory = options.claimTokenFactory ?? (() => randomToken());
  }

  async acceptWebhookPayload(payload: unknown): Promise<"accepted" | "duplicate" | "ignored"> {
    const message = await this.#engine.decryptLive(payload);
    if (!message) return "ignored";
    if (this.#replay.has(message.eventUuid)) return "duplicate";

    const senderIdHash = await keyedHash(this.#addressPepper, message.senderId);
    const challenge = extractChallenge(message.text);
    if (challenge) {
      if (await this.#resumeDirectReply(`challenge:${message.eventUuid}`)) {
        this.#replay.remember(message.eventUuid);
        return "accepted";
      }
      await this.#control.completeChallenge({
        senderIdHash,
        challengeHash: await sha256(challenge),
      });
      await this.#queueDirectReply(
        `challenge:${message.eventUuid}`,
        message.conversationId,
        "X Chat connected to BuddyBox. Finish connecting ChatGPT, GitHub, and Convex before starting your first project.",
      );
      this.#replay.remember(message.eventUuid);
      return "accepted";
    }

    const [eventUuid, providerMessageId, providerConversationIdHash, messageHash] = await Promise.all([
      sha256(message.eventUuid),
      sha256(message.providerMessageId),
      keyedHash(this.#addressPepper, message.conversationId),
      sha256(message.text),
    ]);
    const encryptedPayload = await this.#protector.seal(
      { text: message.text, conversationId: message.conversationId },
      `xchat:inbound:${eventUuid}`,
    );
    const directReplyId = `claim:${message.eventUuid}`;
    const claimReply = await this.#ensureClaimReply(
      directReplyId,
      message.conversationId,
    );
    const result = await this.#control.admitInbound({
      senderIdHash,
      providerConversationIdHash,
      eventUuid,
      providerMessageId,
      messageHash,
      encryptedPayload,
      ...claimReply.claimAdmission,
      occurredAt: message.occurredAt,
    });
    if (result.status === "unbound") {
      await this.#prepareDirectReply(directReplyId, claimReply);
    } else if (result.status === "duplicate") {
      if (result.claimRequired) {
        if (!await this.#resumeDirectReply(directReplyId)) {
          throw new Error("X Chat claim reply is not recoverable");
        }
      } else {
        await this.#discardDirectReply(directReplyId);
      }
    } else {
      await this.#discardDirectReply(directReplyId);
    }
    this.#replay.remember(message.eventUuid);
    return result.status === "duplicate" ? "duplicate" : "accepted";
  }

  async deliverLeasedBatch(now = Date.now()): Promise<number> {
    const leaseSecret = crypto.randomUUID();
    const leaseIdHash = await sha256(leaseSecret);
    const leases = await this.#control.leaseOutbound({
      leaseIdHash,
      now,
      leaseExpiresAt: now + 90_000,
      limit: 10,
    });
    for (const lease of leases) {
      let record = await this.#vault.get<PreparedRecord>("prepared_send", lease.deliveryId);
      try {
        if (!record) {
          const plaintext = await this.#protector.open<OutboundPlaintext>(lease.encryptedPayload, lease.payloadAad);
          assertOutboundPlaintext(plaintext);
          const prepared = await this.#engine.prepareText(plaintext.conversationId, plaintext.text);
          record = { state: "prepared", prepared };
          // This must complete before the first network send. It is the
          // durable idempotency boundary for X's SDK-minted message ID.
          await this.#vault.put("prepared_send", lease.deliveryId, record);
        }
        if (record.state === "prepared") {
          await this.#sendWithRetries(record.prepared);
          record = { ...record, state: "accepted" };
          await this.#vault.put("prepared_send", lease.deliveryId, record);
        }
        await this.#control.settleOutbound({
          deliveryId: lease.deliveryId,
          leaseIdHash,
          outcome: "delivered",
          externalMessageIdHash: await sha256(record.prepared.messageId),
        });
      } catch (error) {
        const permanent = error instanceof XApiError && !error.retryable;
        try {
          await this.#control.settleOutbound({
            deliveryId: lease.deliveryId,
            leaseIdHash,
            outcome: permanent ? "failed" : "failed_retryable",
            errorCode: permanent ? "xchat_rejected" : "xchat_unavailable",
          });
        } catch {
          // Convex can reclaim the expired lease. The prepared record makes
          // that recovery reuse exactly the same signed ciphertext and ID.
        }
      }
    }
    return leases.length;
  }

  async flushDirectReplies(): Promise<number> {
    const ids = await this.#vault.listIds("direct_reply");
    for (const id of ids.slice(0, 10)) {
      try {
        await this.#resumeDirectReply(id);
      } catch {
        // The encrypted record remains prepared for the next poll.
      }
    }
    return ids.length;
  }

  async #queueDirectReply(id: string, conversationId: string, text: string): Promise<void> {
    if (await this.#vault.get<{ sent: true }>("direct_reply_done", id)) return;
    let record = await this.#vault.get<DirectReplyRecord>("direct_reply", id);
    if (!record) {
      record = { state: "pending", conversationId, text };
      // Commit the exact reply intent before asking the SDK to mint its
      // ciphertext. If preparation fails, a duplicate webhook can still
      // recover the one-time claim URL that Convex deliberately omits.
      await this.#vault.put("direct_reply", id, record);
    }
    await this.#prepareDirectReply(id, record);
  }

  async #resumeDirectReply(id: string): Promise<boolean> {
    if (await this.#vault.get<{ sent: true }>("direct_reply_done", id)) {
      await this.#discardDirectReply(id);
      return true;
    }
    let record = await this.#vault.get<DirectReplyRecord>("direct_reply", id);
    if (!record) return false;
    if (record.state === "pending") {
      record = await this.#prepareDirectReply(id, record);
    }
    if (record.state === "prepared") {
      await this.#sendWithRetries(record.prepared);
      await this.#vault.put("direct_reply_done", id, { sent: true });
      await this.#vault.delete("direct_reply", id);
    }
    return true;
  }

  async #ensureClaimReply(
    id: string,
    conversationId: string,
  ): Promise<ClaimDirectReplyRecord> {
    const uncommitted = this.#uncommittedClaimReplies.get(id);
    const existing = uncommitted ?? await this.#vault.get<DirectReplyRecord>("direct_reply", id);
    if (existing) {
      if (!existing.claimAdmission) throw new Error("X Chat claim reply admission is missing");
      if (uncommitted) {
        await this.#vault.put("direct_reply", id, uncommitted);
        this.#uncommittedClaimReplies.delete(id);
      }
      return existing as ClaimDirectReplyRecord;
    }

    const claimToken = checkedClaimToken(this.#claimTokenFactory());
    const portal = new URL(this.#portalUrl);
    portal.pathname = "/connect/xchat";
    portal.search = new URLSearchParams({ claim: claimToken }).toString();
    const record: Extract<ClaimDirectReplyRecord, { state: "pending" }> = {
      state: "pending",
      conversationId,
      text: `Welcome to BuddyBox. Securely connect this X Chat account: ${portal.toString()}`,
      claimAdmission: {
        claimTokenHash: await sha256(claimToken),
        claimExpiresAt: Date.now() + CLAIM_TTL_MS,
      },
    };
    this.#uncommittedClaimReplies.set(id, record);
    await this.#vault.put("direct_reply", id, record);
    this.#uncommittedClaimReplies.delete(id);
    return record;
  }

  async #prepareDirectReply(
    id: string,
    record: DirectReplyRecord,
  ): Promise<Extract<DirectReplyRecord, { state: "prepared" }>> {
    if (record.state === "prepared") return record;
    const prepared: Extract<DirectReplyRecord, { state: "prepared" }> = {
      state: "prepared",
      prepared: await this.#engine.prepareText(record.conversationId, record.text),
      ...(record.claimAdmission ? { claimAdmission: record.claimAdmission } : {}),
    };
    // No network send may happen until the SDK payload is durable. Every
    // later retry therefore reuses the same message ID and exact bytes.
    await this.#vault.put("direct_reply", id, prepared);
    return prepared;
  }

  async #discardDirectReply(id: string): Promise<void> {
    this.#uncommittedClaimReplies.delete(id);
    await this.#vault.delete("direct_reply", id);
  }

  async #sendWithRetries(prepared: PreparedSend): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.#engine.send(prepared);
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof XApiError && !error.retryable) throw error;
        if (attempt < 3) await Bun.sleep(200 * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }
}

export function extractChallenge(text: string): string | undefined {
  return CHALLENGE_PATTERN.exec(text.trim())?.[1]?.toUpperCase();
}

function assertOutboundPlaintext(value: OutboundPlaintext): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.conversationId !== "string" ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 10_000
  ) throw new Error("Outbound payload is invalid");
}

function checkedClaimToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(value)) throw new Error("Invalid X Chat claim token");
  return value;
}

function securePortalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new TypeError("Portal URL must use HTTPS outside localhost");
  }
  return url.origin;
}

export type { VerifiedInboundText };
