const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type OAuthProvider = "github" | "cloudflare" | "convex";

export async function sealProviderSecret(
  plaintext: string,
  ownerId: string,
  provider: OAuthProvider,
  purpose: "pkce" | "access" | "refresh" | "account",
): Promise<string> {
  if (!plaintext) throw new Error("Cannot encrypt an empty provider secret");
  const key = await providerKey(["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: encoder.encode(associatedData(ownerId, provider, purpose)),
    },
    key,
    encoder.encode(plaintext),
  );
  return `v1.${toBase64(nonce)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function openProviderSecret(
  sealed: string,
  ownerId: string,
  provider: OAuthProvider,
  purpose: "pkce" | "access" | "refresh" | "account",
): Promise<string> {
  const [version, encodedNonce, encodedCiphertext, ...rest] = sealed.split(".");
  if (version !== "v1" || !encodedNonce || !encodedCiphertext || rest.length > 0) {
    throw new Error("Provider secret envelope is invalid");
  }
  const nonce = fromBase64(encodedNonce);
  if (nonce.byteLength !== 12) throw new Error("Provider secret nonce is invalid");
  const nonceBuffer = nonce.slice().buffer as ArrayBuffer;
  const ciphertextBuffer = fromBase64(encodedCiphertext).slice().buffer as ArrayBuffer;
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonceBuffer,
      additionalData: encoder.encode(associatedData(ownerId, provider, purpose)),
    },
    await providerKey(["decrypt"]),
    ciphertextBuffer,
  );
  return decoder.decode(plaintext);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

function associatedData(ownerId: string, provider: OAuthProvider, purpose: string): string {
  return `buddybox:provider-oauth:v1:${ownerId}:${provider}:${purpose}`;
}

async function providerKey(usages: KeyUsage[]): Promise<CryptoKey> {
  const encoded = process.env.BUDDYBOX_PROVIDER_CREDENTIAL_KEY;
  if (!encoded) throw new Error("BUDDYBOX_PROVIDER_CREDENTIAL_KEY is not configured");
  const bytes = fromBase64(encoded);
  if (bytes.byteLength !== 32) {
    throw new Error("BUDDYBOX_PROVIDER_CREDENTIAL_KEY must decode to exactly 32 bytes");
  }
  return await crypto.subtle.importKey(
    "raw",
    bytes.slice().buffer as ArrayBuffer,
    "AES-GCM",
    false,
    usages,
  );
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBase64Url(value: Uint8Array): string {
  return toBase64(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
