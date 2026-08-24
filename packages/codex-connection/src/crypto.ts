import type { SealedSecret, SecretVault } from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

export class AesGcmSecretVault implements SecretVault {
  private constructor(private readonly key: CryptoKey) {}

  static async fromRawKey(rawKey: Uint8Array): Promise<AesGcmSecretVault> {
    if (rawKey.byteLength !== 32) {
      throw new Error("The credential encryption key must be exactly 32 bytes.");
    }
    const key = await crypto.subtle.importKey(
      "raw",
      arrayBuffer(rawKey),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    return new AesGcmSecretVault(key);
  }

  static async fromBase64Key(encodedKey: string): Promise<AesGcmSecretVault> {
    let key: Uint8Array;
    try {
      key = new Uint8Array(Buffer.from(encodedKey, "base64"));
    } catch {
      throw new Error("The credential encryption key is not valid base64.");
    }
    return AesGcmSecretVault.fromRawKey(key);
  }

  async seal(plaintext: string, associatedData: string): Promise<SealedSecret> {
    if (!plaintext) throw new Error("Cannot encrypt an empty credential.");
    if (!associatedData) throw new Error("Credential associated data is required.");
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(associatedData) },
      this.key,
      encoder.encode(plaintext),
    );
    return {
      version: 1,
      nonce: encode(nonce),
      ciphertext: encode(new Uint8Array(ciphertext)),
    };
  }

  async open(secret: SealedSecret, associatedData: string): Promise<string> {
    if (secret.version !== 1 || !associatedData) {
      throw new Error("Credential decryption failed.");
    }
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: arrayBuffer(decode(secret.nonce)),
          additionalData: encoder.encode(associatedData),
        },
        this.key,
        arrayBuffer(decode(secret.ciphertext)),
      );
      return decoder.decode(plaintext);
    } catch {
      throw new Error("Credential decryption failed.");
    }
  }
}

export async function hashAccountId(accountId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`buddybox:chatgpt-account:v1:${accountId}`),
  );
  return encode(new Uint8Array(digest));
}
