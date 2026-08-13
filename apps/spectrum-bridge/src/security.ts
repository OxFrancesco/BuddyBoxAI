const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const REPLAY_WINDOW_SECONDS = 5 * 60;
const encoder = new TextEncoder();

export interface SpectrumWebhookSecurityOptions {
  signingSecret: string;
  expectedWebhookId?: string;
  bodyLimitBytes?: number;
  now?: () => number;
}

export type AcceptedSpectrumWebhook =
  | {
      ok: true;
      rawBody: Uint8Array;
      webhookId: string;
      event: string;
    }
  | { ok: false; status: 400 | 401 | 403 | 413 | 415 };

export async function acceptSpectrumWebhook(
  request: Request,
  options: SpectrumWebhookSecurityOptions,
): Promise<AcceptedSpectrumWebhook> {
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes <= 0) {
    throw new TypeError("bodyLimitBytes must be a positive safe integer");
  }
  if (mediaType(request.headers.get("content-type")) !== "application/json") {
    return { ok: false, status: 415 };
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return { ok: false, status: 400 };
    if (Number(contentLength) > bodyLimitBytes) return { ok: false, status: 413 };
  }

  const timestamp = parseTimestamp(request.headers.get("x-spectrum-timestamp"));
  const signature = parseSignature(request.headers.get("x-spectrum-signature"));
  const webhookId = cleanHeader(request.headers.get("x-spectrum-webhook-id"));
  const event = cleanHeader(request.headers.get("x-spectrum-event"));
  if (timestamp === undefined || !signature || !webhookId || !event) {
    return { ok: false, status: 400 };
  }
  if (options.expectedWebhookId && webhookId !== options.expectedWebhookId) {
    return { ok: false, status: 403 };
  }

  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, status: 401 };
  }

  const body = await readBoundedBody(request, bodyLimitBytes);
  if (body.status !== "ok") return { ok: false, status: body.status };

  const key = await importHmacKey(options.signingSecret);
  const signed = concatenate(encoder.encode(`v0:${timestamp}:`), body.value);
  try {
    if (!(await crypto.subtle.verify("HMAC", key, toArrayBuffer(signature), toArrayBuffer(signed)))) {
      return { ok: false, status: 401 };
    }
  } catch {
    return { ok: false, status: 401 };
  }

  return { ok: true, rawBody: body.value, webhookId, event };
}

export async function signSpectrumWebhookForTest(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = encoder.encode(`v0:${timestamp}:${body}`);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(signed)));
  return `v0=${toHex(signature)}`;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function readBoundedBody(
  request: Request,
  limit: number,
): Promise<{ status: "ok"; value: Uint8Array } | { status: 400 | 413 }> {
  if (!request.body) return { status: "ok", value: new Uint8Array() };
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
        return { status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { status: 400 };
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "ok", value: joined };
}

function parseTimestamp(value: string | null): number | undefined {
  if (!value || !/^\d{10}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseSignature(value: string | null): Uint8Array | undefined {
  const match = /^v0=([0-9a-fA-F]{64})$/.exec(value ?? "");
  if (!match?.[1]) return undefined;
  return fromHex(match[1]);
}

function cleanHeader(value: string | null): string | undefined {
  if (!value || value.trim() !== value || value.length > 256) return undefined;
  return value;
}

function mediaType(value: string | null): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
