import { z } from "zod";

import type { AttachmentKind, NormalizedAttachment, NormalizedInbound } from "./types";

const DEFAULT_MAX_TEXT_CHARACTERS = 16_000;
const DEFAULT_MAX_ATTACHMENTS = 4;
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const encoder = new TextEncoder();

const baseSpaceSchema = z
  .object({
    id: z.string().min(1).max(1024),
    platform: z.string().min(1).max(64),
    phone: z.string().min(1).max(128).optional(),
  })
  .passthrough();

const inboundMessageSchema = z
  .object({
    id: z.string().min(1).max(512),
    platform: z.string().min(1).max(64),
    direction: z.literal("inbound"),
    timestamp: z.string().min(1).max(64),
    sender: z.object({ id: z.string().min(1).max(512), platform: z.string().min(1).max(64) }).passthrough(),
    space: baseSpaceSchema.optional(),
    content: z.unknown(),
  })
  .passthrough();

const envelopeSchema = z
  .object({
    event: z.literal("messages"),
    space: baseSpaceSchema,
    message: inboundMessageSchema,
  })
  .passthrough();

export interface NormalizationOptions {
  addressPepper: string;
  webhookId: string;
  maxTextCharacters?: number;
  maxAttachments?: number;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
}

export type NormalizationResult =
  | { ok: true; value: NormalizedInbound }
  | {
      ok: false;
      reason:
        | "invalid_payload"
        | "unsupported_platform"
        | "unsupported_content"
        | "message_too_large"
        | "attachment_too_large"
        | "too_many_attachments";
    };

export async function normalizeSpectrumInbound(
  input: unknown,
  options: NormalizationOptions,
): Promise<NormalizationResult> {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success || !validDate(parsed.data.message.timestamp)) {
    return { ok: false, reason: "invalid_payload" };
  }
  const { message, space } = parsed.data;
  if (!isIMessage(message.platform) || !isIMessage(space.platform) || !isIMessage(message.sender.platform)) {
    return { ok: false, reason: "unsupported_platform" };
  }

  const limits = {
    maxTextCharacters: positiveLimit(options.maxTextCharacters, DEFAULT_MAX_TEXT_CHARACTERS),
    maxAttachments: positiveLimit(options.maxAttachments, DEFAULT_MAX_ATTACHMENTS),
    maxAttachmentBytes: positiveLimit(options.maxAttachmentBytes, DEFAULT_MAX_ATTACHMENT_BYTES),
    maxTotalAttachmentBytes: positiveLimit(
      options.maxTotalAttachmentBytes,
      DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
    ),
  };
  const content = normalizeContent(message.content, limits);
  if (!content.ok) return content;
  if (!content.text && content.attachments.length === 0) {
    return { ok: false, reason: "unsupported_content" };
  }

  const normalizedAddress = normalizeAddress(message.sender.id);
  if (!normalizedAddress) return { ok: false, reason: "invalid_payload" };
  const addressHash = await keyedHash(options.addressPepper, normalizedAddress);

  return {
    ok: true,
    value: {
      source: "imessage",
      idempotencyKey: `spectrum:imessage:${message.id}`,
      providerMessageId: message.id,
      providerWebhookId: options.webhookId,
      addressHash: `addr_${addressHash}`,
      spaceId: space.id,
      ...(space.phone ? { lineId: space.phone } : {}),
      sentAt: new Date(message.timestamp).toISOString(),
      text: content.text,
      attachments: content.attachments,
    },
  };
}

interface ContentLimits {
  maxTextCharacters: number;
  maxAttachments: number;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
}

type ContentResult =
  | { ok: true; text: string; attachments: NormalizedAttachment[] }
  | Exclude<NormalizationResult, { ok: true }>;

function normalizeContent(content: unknown, limits: ContentLimits): ContentResult {
  if (!isRecord(content) || typeof content.type !== "string") {
    return { ok: false, reason: "invalid_payload" };
  }
  if (content.type === "text") {
    if (typeof content.text !== "string") return { ok: false, reason: "invalid_payload" };
    const text = content.text.trim();
    if (text.length > limits.maxTextCharacters) return { ok: false, reason: "message_too_large" };
    return { ok: true, text, attachments: [] };
  }
  if (content.type === "attachment") {
    const attachment = normalizeAttachment(content, limits);
    return attachment.ok
      ? { ok: true, text: "", attachments: [attachment.value] }
      : attachment;
  }
  if (content.type === "group") {
    if (!Array.isArray(content.items)) return { ok: false, reason: "invalid_payload" };
    if (content.items.length > limits.maxAttachments) {
      return { ok: false, reason: "too_many_attachments" };
    }
    const attachments: NormalizedAttachment[] = [];
    const texts: string[] = [];
    for (const item of content.items) {
      if (!isRecord(item)) return { ok: false, reason: "invalid_payload" };
      const normalized = normalizeContent(item.content, limits);
      if (!normalized.ok) return normalized;
      attachments.push(...normalized.attachments);
      if (normalized.text) texts.push(normalized.text);
    }
    if (attachments.length > limits.maxAttachments) return { ok: false, reason: "too_many_attachments" };
    const totalBytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
    if (totalBytes > limits.maxTotalAttachmentBytes) return { ok: false, reason: "attachment_too_large" };
    const text = texts.join("\n");
    if (text.length > limits.maxTextCharacters) return { ok: false, reason: "message_too_large" };
    return { ok: true, text, attachments };
  }
  return { ok: false, reason: "unsupported_content" };
}

function normalizeAttachment(
  content: Record<string, unknown>,
  limits: ContentLimits,
): { ok: true; value: NormalizedAttachment } | Exclude<NormalizationResult, { ok: true }> {
  const { id, mimeType, name, size } = content;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 512 ||
    typeof mimeType !== "string" ||
    !validMimeType(mimeType) ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 255 ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    return { ok: false, reason: "invalid_payload" };
  }
  if (size > limits.maxAttachmentBytes || size > limits.maxTotalAttachmentBytes) {
    return { ok: false, reason: "attachment_too_large" };
  }
  return {
    ok: true,
    value: {
      providerAttachmentId: id,
      kind: attachmentKind(mimeType),
      mimeType: mimeType.toLowerCase(),
      name,
      sizeBytes: size,
    },
  };
}

export function normalizeAddress(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 320) return undefined;
  if (trimmed.includes("@")) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined;
  }
  const phone = trimmed.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : undefined;
}

async function keyedHash(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret).slice().buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value).slice().buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("normalization limits must be positive");
  return value;
}

function attachmentKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function validMimeType(value: string): boolean {
  return value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/.test(value);
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isIMessage(value: string): boolean {
  return value.toLowerCase() === "imessage";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
