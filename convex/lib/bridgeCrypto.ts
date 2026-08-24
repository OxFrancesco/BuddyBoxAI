const encoder = new TextEncoder();

export function randomToken(bytes = 24): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToBase64(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function safeSecretEquals(actual: string, expected: string): Promise<boolean> {
  const [actualHash, expectedHash] = await Promise.all([sha256(actual), sha256(expected)]);
  let difference = actualHash.length ^ expectedHash.length;
  for (let index = 0; index < Math.max(actualHash.length, expectedHash.length); index += 1) {
    difference |= (actualHash.charCodeAt(index) || 0) ^ (expectedHash.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function encryptBridgePayload(value: unknown): Promise<string> {
  const key = await routeEncryptionKey(["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${bytesToBase64(nonce)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptBridgePayload<T>(value: string): Promise<T> {
  const [version, encodedNonce, encodedCiphertext, extra] = value.split(".");
  if (version !== "v1" || !encodedNonce || !encodedCiphertext || extra) {
    throw new Error("Bridge payload is malformed");
  }
  const nonce = base64ToBytes(encodedNonce);
  const ciphertext = base64ToBytes(encodedCiphertext);
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 17 || ciphertext.byteLength > 128_000) {
    throw new Error("Bridge payload is malformed");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce.slice().buffer as ArrayBuffer },
    await routeEncryptionKey(["decrypt"]),
    ciphertext.slice().buffer as ArrayBuffer,
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as T;
}

export async function decryptRouteEnvelope<T>(
  envelope: { algorithm: "AES-256-GCM"; keyVersion: number; iv: string; ciphertext: string },
  purpose: string,
): Promise<T> {
  if (envelope.algorithm !== "AES-256-GCM" || envelope.keyVersion !== 1 || purpose.length < 1 || purpose.length > 512) {
    throw new Error("Route envelope is malformed");
  }
  const nonce = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 17 || ciphertext.byteLength > 128_000) {
    throw new Error("Route envelope is malformed");
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce.slice().buffer as ArrayBuffer,
      additionalData: new TextEncoder().encode(purpose),
    },
    await routeEncryptionKey(["decrypt"]),
    ciphertext.slice().buffer as ArrayBuffer,
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as T;
}

async function routeEncryptionKey(usages: KeyUsage[]): Promise<CryptoKey> {
  const encodedKey = process.env.BUDDYBOX_ROUTE_ENCRYPTION_KEY;
  if (!encodedKey) throw new Error("BUDDYBOX_ROUTE_ENCRYPTION_KEY is not configured");
  const rawKey = base64ToBytes(encodedKey);
  if (rawKey.byteLength !== 32) throw new Error("BUDDYBOX_ROUTE_ENCRYPTION_KEY must decode to 32 bytes");
  const keyBytes = rawKey.slice().buffer as ArrayBuffer;
  return await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, usages);
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
