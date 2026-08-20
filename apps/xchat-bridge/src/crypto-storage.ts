import { EnvelopeProtector } from "./crypto";
import type { EncryptedEnvelope } from "./types";

export class PayloadProtector {
  readonly #protector: EnvelopeProtector;
  constructor(encodedKey: string) {
    this.#protector = new EnvelopeProtector(encodedKey);
  }
  async seal(purpose: string, value: unknown): Promise<EncryptedEnvelope> {
    return await this.#protector.seal(value, purpose);
  }
  async open(purpose: string, envelope: EncryptedEnvelope): Promise<any> {
    return await this.#protector.open<any>(envelope, purpose);
  }
}

export interface BlobStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  readonly #records = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.#records.get(key); }
  async set(key: string, value: string): Promise<void> { this.#records.set(key, value); }
}

export class EncryptedStateStore {
  readonly #blobs: BlobStore;
  readonly #protector: PayloadProtector;
  constructor(blobs: BlobStore, encodedKey: string) {
    this.#blobs = blobs;
    this.#protector = new PayloadProtector(encodedKey);
  }
  async set(key: string, value: unknown): Promise<void> {
    const envelope = await this.#protector.seal(`xchat:state:${key}`, value);
    await this.#blobs.set(key, JSON.stringify(envelope));
  }
  async get(key: string): Promise<any | undefined> {
    const raw = await this.#blobs.get(key);
    if (!raw) return undefined;
    return await this.#protector.open(`xchat:state:${key}`, JSON.parse(raw) as EncryptedEnvelope);
  }
}
