import type { EncryptedEnvelope } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class EnvelopeProtector {
  readonly #keyPromise: Promise<CryptoKey>;
  readonly keyVersion: number;

  constructor(encodedKey: string, keyVersion = 1) {
    const raw = Uint8Array.from(Buffer.from(encodedKey, "base64"));
    if (raw.byteLength !== 32) throw new TypeError("Encryption key must be 32 bytes");
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new TypeError("Invalid key version");
    this.keyVersion = keyVersion;
    this.#keyPromise = crypto.subtle.importKey("raw", raw.slice().buffer, "AES-GCM", false, ["encrypt", "decrypt"]);
    raw.fill(0);
  }

  async seal(value: unknown, purpose: string): Promise<EncryptedEnvelope> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
      await this.#keyPromise,
      plaintext,
    );
    return {
      algorithm: "AES-256-GCM",
      keyVersion: this.keyVersion,
      iv: Buffer.from(iv).toString("base64"),
      ciphertext: Buffer.from(ciphertext).toString("base64"),
    };
  }

  async open<T>(envelope: EncryptedEnvelope, purpose: string): Promise<T> {
    if (envelope.algorithm !== "AES-256-GCM" || envelope.keyVersion !== this.keyVersion) {
      throw new Error("Unsupported encryption envelope");
    }
    const iv = Uint8Array.from(Buffer.from(envelope.iv, "base64"));
    const ciphertext = Uint8Array.from(Buffer.from(envelope.ciphertext, "base64"));
    if (iv.byteLength !== 12 || ciphertext.byteLength < 17) throw new Error("Malformed encryption envelope");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
      await this.#keyPromise,
      ciphertext,
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  }
}

export async function sha256(value: string): Promise<string> {
  return sha256Bytes(encoder.encode(value));
}

export async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value.slice().buffer);
  return Buffer.from(digest).toString("hex");
}

export async function keyedHash(keyMaterial: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(keyMaterial), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, encoder.encode(value))).toString("hex");
}

export function randomToken(bytes = 24): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}
