import { keyedHash } from "./crypto";

export type NormalizedResult =
  | {
      ok: true;
      value: {
        source: "xchat";
        eventId: string;
        providerMessageId: string;
        senderIdHash: string;
        providerConversationIdHash: string;
        text: string;
        occurredAt: number;
      };
    }
  | { ok: false; reason: "unverified" | "unsupported" | "invalid" };

export async function normalizeVerifiedText(
  event: unknown,
  options: { eventId: string; addressPepper: string },
): Promise<NormalizedResult> {
  if (!isRecord(event) || event.verified !== true) return { ok: false, reason: "unverified" };
  if (event.type !== "message" || !isRecord(event.content) || event.content.contentType !== "text") {
    return { ok: false, reason: "unsupported" };
  }
  const { id, senderId, conversationId, createdAtMsec } = event;
  const text = typeof event.content.text === "string" ? event.content.text.trim() : "";
  if (
    typeof id !== "string" || !id ||
    typeof senderId !== "string" || !senderId ||
    typeof conversationId !== "string" || !conversationId ||
    !Number.isSafeInteger(createdAtMsec) ||
    !text || text.length > 16_000 ||
    !options.eventId || options.eventId.length > 256
  ) return { ok: false, reason: "invalid" };
  const [senderHash, conversationHash] = await Promise.all([
    keyedHash(options.addressPepper, senderId),
    keyedHash(options.addressPepper, conversationId),
  ]);
  return {
    ok: true,
    value: {
      source: "xchat",
      eventId: options.eventId,
      providerMessageId: id,
      senderIdHash: `xusr_${senderHash}`,
      providerConversationIdHash: `xconv_${conversationHash}`,
      text,
      occurredAt: createdAtMsec as number,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
