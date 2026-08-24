import { timingSafeEqual } from "node:crypto";

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();

export type WebhookAdmission =
  | { ok: true; rawBody: Uint8Array }
  | { ok: false; status: 400 | 401 | 413 | 415 };

export async function crcResponse(token: string, consumerSecret: string): Promise<string> {
  if (!token || token.length > 512) throw new TypeError("Invalid CRC token");
  const digest = await hmac(consumerSecret, encoder.encode(token));
  return `sha256=${Buffer.from(digest).toString("base64")}`;
}

export async function acceptXWebhook(
  request: Request,
  consumerSecret: string,
  bodyLimit = DEFAULT_BODY_LIMIT,
): Promise<WebhookAdmission> {
  if (mediaType(request.headers.get("content-type")) !== "application/json") return { ok: false, status: 415 };
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1 || bodyLimit > DEFAULT_BODY_LIMIT) throw new TypeError("Invalid body limit");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > bodyLimit)) {
    return { ok: false, status: /^\d+$/.test(declared) ? 413 : 400 };
  }
  const signature = request.headers.get("x-twitter-webhooks-signature");
  if (!signature?.startsWith("sha256=") || signature.length > 128) return { ok: false, status: 401 };
  const rawBody = await readBounded(request, bodyLimit);
  if (!rawBody.ok) return rawBody;
  const expected = `sha256=${Buffer.from(await hmac(consumerSecret, rawBody.value)).toString("base64")}`;
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, status: 401 };
  return { ok: true, rawBody: rawBody.value };
}

export async function signXWebhookForTest(secret: string, body: string): Promise<string> {
  return `sha256=${Buffer.from(await hmac(secret, encoder.encode(body))).toString("base64")}`;
}

async function hmac(secret: string, bytes: Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", key, bytes.slice().buffer);
}

async function readBounded(
  request: Request,
  limit: number,
): Promise<{ ok: true; value: Uint8Array } | { ok: false; status: 400 | 413 }> {
  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: joined };
}

function mediaType(value: string | null): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}
