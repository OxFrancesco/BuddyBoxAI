import { randomToken, sha256Bytes } from "./crypto";
import type { SecureVault } from "./vault";

export class ReplayGuard {
  readonly #seen = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(ttlMs = 25 * 60 * 60_000, maxEntries = 100_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000) throw new TypeError("Invalid replay TTL");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 100) throw new TypeError("Invalid replay capacity");
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  has(id: string, now = Date.now()): boolean {
    this.#prune(now);
    const expiry = this.#seen.get(id);
    return expiry !== undefined && expiry > now;
  }

  remember(id: string, now = Date.now()): void {
    this.#prune(now);
    if (this.#seen.size >= this.#maxEntries) this.#seen.delete(this.#seen.keys().next().value ?? "");
    this.#seen.set(id, now + this.#ttlMs);
  }

  #prune(now: number): void {
    for (const [key, expiry] of this.#seen) {
      if (expiry > now) break;
      this.#seen.delete(key);
    }
  }
}

const REPLAY_NAMESPACE = "webhook_replay";
const REPLAY_LEDGER_ID = "exact_body_digests";

interface ReplayLedger {
  format: 1;
  entries: Record<string, ReplayEntry>;
}

type ReplayEntry =
  | { state: "processing"; claimId: string; leaseExpiresAt: number; expiresAt: number }
  | { state: "accepted"; expiresAt: number };

export type WebhookReplayClaim = {
  digest: string;
  claimId: string;
};

export type WebhookReplayDecision =
  | { status: "claimed"; claim: WebhookReplayClaim }
  | { status: "duplicate" }
  | { status: "in_flight" }
  | { status: "full" };

/**
 * Durable admission boundary for an authenticated raw webhook body.
 *
 * The whole bounded ledger is one encrypted vault record so claim, completion,
 * release, expiry, and capacity checks are serialized into a single local
 * mutation and file rename. A remote/shared database would be needed before
 * running more than one bridge replica.
 */
export class WebhookReplayAdmission {
  readonly #vault: SecureVault;
  readonly #ttlMs: number;
  readonly #leaseMs: number;
  readonly #maxEntries: number;

  constructor(
    vault: SecureVault,
    options: { ttlMs?: number; leaseMs?: number; maxEntries?: number } = {},
  ) {
    this.#vault = vault;
    this.#ttlMs = options.ttlMs ?? 25 * 60 * 60_000;
    this.#leaseMs = options.leaseMs ?? 2 * 60_000;
    this.#maxEntries = options.maxEntries ?? 10_000;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 60_000) throw new TypeError("Invalid webhook replay TTL");
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1_000 || this.#leaseMs >= this.#ttlMs) {
      throw new TypeError("Invalid webhook replay lease");
    }
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 100 || this.#maxEntries > 100_000) {
      throw new TypeError("Invalid webhook replay capacity");
    }
  }

  async claim(rawBody: Uint8Array, now = Date.now()): Promise<WebhookReplayDecision> {
    const digest = await sha256Bytes(rawBody);
    const claimId = randomToken();
    return await this.#vault.update<ReplayLedger, WebhookReplayDecision>(
      REPLAY_NAMESPACE,
      REPLAY_LEDGER_ID,
      (stored) => {
        const ledger = validLedger(stored);
        let pruned = false;
        for (const [key, entry] of Object.entries(ledger.entries)) {
          if (entry.expiresAt <= now) {
            delete ledger.entries[key];
            pruned = true;
          }
        }
        const existing = ledger.entries[digest];
        if (existing?.state === "accepted") {
          return { next: ledger, result: { status: "duplicate" }, write: pruned };
        }
        if (existing?.state === "processing" && existing.leaseExpiresAt > now) {
          return { next: ledger, result: { status: "in_flight" }, write: pruned };
        }
        if (!existing && Object.keys(ledger.entries).length >= this.#maxEntries) {
          return { next: ledger, result: { status: "full" }, write: pruned };
        }
        ledger.entries[digest] = {
          state: "processing",
          claimId,
          leaseExpiresAt: now + this.#leaseMs,
          expiresAt: now + this.#ttlMs,
        };
        return { next: ledger, result: { status: "claimed", claim: { digest, claimId } } };
      },
    );
  }

  async complete(claim: WebhookReplayClaim, now = Date.now()): Promise<boolean> {
    return await this.#changeOwnedClaim(claim, (entry) => ({
      state: "accepted",
      expiresAt: Math.max(entry.expiresAt, now + this.#ttlMs),
    }));
  }

  async release(claim: WebhookReplayClaim): Promise<boolean> {
    return await this.#changeOwnedClaim(claim, () => undefined);
  }

  async #changeOwnedClaim(
    claim: WebhookReplayClaim,
    replacement: (entry: Extract<ReplayEntry, { state: "processing" }>) => ReplayEntry | undefined,
  ): Promise<boolean> {
    return await this.#vault.update<ReplayLedger, boolean>(REPLAY_NAMESPACE, REPLAY_LEDGER_ID, (stored) => {
      const ledger = validLedger(stored);
      const entry = ledger.entries[claim.digest];
      if (entry?.state !== "processing" || entry.claimId !== claim.claimId) {
        return { next: ledger, result: false, write: false };
      }
      const next = replacement(entry);
      if (next) ledger.entries[claim.digest] = next;
      else delete ledger.entries[claim.digest];
      return { next: ledger, result: true };
    });
  }
}

function validLedger(value: ReplayLedger | undefined): ReplayLedger {
  if (value === undefined) return { format: 1, entries: {} };
  if (value.format !== 1 || !isRecord(value.entries)) {
    throw new Error("Webhook replay ledger is malformed");
  }
  for (const [digest, entry] of Object.entries(value.entries)) {
    if (!/^[0-9a-f]{64}$/.test(digest) || !isRecord(entry) || !validTimestamp(entry.expiresAt)) {
      throw new Error("Webhook replay ledger is malformed");
    }
    if (entry.state === "accepted") {
      if (Object.keys(entry).length !== 2) throw new Error("Webhook replay ledger is malformed");
      continue;
    }
    if (
      entry.state !== "processing" ||
      Object.keys(entry).length !== 4 ||
      typeof entry.claimId !== "string" ||
      !/^[A-Za-z0-9_-]{32}$/.test(entry.claimId) ||
      !validTimestamp(entry.leaseExpiresAt) ||
      entry.leaseExpiresAt > entry.expiresAt
    ) {
      throw new Error("Webhook replay ledger is malformed");
    }
  }
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
