import { createChat, type ChatWithJuicebox, type ConversationKeyMap, type Event, type SigningKeyEntry } from "@xdevplatform/chat-xdk";
import { z } from "zod";

import type { SecureVault } from "./vault";
import type { PreparedSend, VerifiedInboundText } from "./types";
import type { XApiClient } from "./x-api";

const liveEventSchema = z.object({
  data: z.object({
    event_type: z.enum(["chat.received", "chat.sent"]),
    event_uuid: z.string().min(1).max(256),
    payload: z.object({
      conversation_id: z.string().min(1).max(256),
      sender_id: z.string().regex(/^\d{1,19}$/),
      encoded_event: z.string().min(1).max(900_000),
      conversation_key_change_event: z.string().min(1).max(900_000).optional(),
    }),
  }),
});

interface StoredConversationKeys {
  keys: Record<string, string>;
}

export class XChatEngine {
  readonly #chat: ChatWithJuicebox;
  readonly #api: XApiClient;
  readonly #vault: SecureVault;
  readonly #botUserId: string;
  readonly #keyVersion: string;

  private constructor(options: {
    chat: ChatWithJuicebox;
    api: XApiClient;
    vault: SecureVault;
    botUserId: string;
    keyVersion: string;
  }) {
    this.#chat = options.chat;
    this.#api = options.api;
    this.#vault = options.vault;
    this.#botUserId = options.botUserId;
    this.#keyVersion = options.keyVersion;
  }

  static async create(options: {
    juiceboxConfig: string;
    juiceboxPin: string;
    realmTokens: Readonly<Record<string, string>>;
    botUserId: string;
    keyVersion: string;
    api: XApiClient;
    vault: SecureVault;
  }): Promise<XChatEngine> {
    const chat = await createChat({
      juiceboxConfig: options.juiceboxConfig,
      getAuthToken: async (realmId) => {
        const token = options.realmTokens[realmId.toLowerCase()];
        if (!token) throw new Error("No auth token configured for the requested Juicebox realm");
        return token;
      },
    });
    await chat.unlock(options.juiceboxPin);
    chat.setIdentity(options.botUserId, options.keyVersion);
    chat.setRejectUnverified(true);
    chat.setCacheKeys(true);
    return new XChatEngine({ chat, api: options.api, vault: options.vault, botUserId: options.botUserId, keyVersion: options.keyVersion });
  }

  async decryptLive(input: unknown): Promise<VerifiedInboundText | undefined> {
    const parsed = liveEventSchema.safeParse(input);
    if (!parsed.success || parsed.data.data.event_type !== "chat.received") return undefined;
    const { event_uuid: eventUuid, payload } = parsed.data.data;
    if (payload.sender_id === this.#botUserId) return undefined;
    const signingKeys = await this.#signingKeys([this.#botUserId, payload.sender_id]);
    this.#chat.setSigningKeys(signingKeys);
    const stored = await this.#loadConversationKeys(payload.conversation_id);
    let verifiedKeys: ConversationKeyMap = stored;
    if (payload.conversation_key_change_event) {
      const result = this.#chat.decryptEvents([payload.conversation_key_change_event], signingKeys);
      if (Object.keys(result.errors).length) throw new Error("X Chat key change signature verification failed");
      verifiedKeys = { ...stored, ...result.conversationKeys.keys };
      await this.#storeConversationKeys(payload.conversation_id, verifiedKeys);
    }
    const event = this.#chat.decryptEvent(payload.encoded_event, verifiedKeys, signingKeys);
    return normalizeVerifiedText(event, eventUuid, payload.conversation_id, payload.conversation_key_change_event);
  }

  async prepareText(conversationId: string, text: string): Promise<PreparedSend> {
    if (!text.trim() || text.length > 10_000) throw new TypeError("Invalid outbound text");
    const keys = await this.#loadConversationKeys(conversationId);
    const versions = Object.keys(keys).sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
    const latest = versions.at(-1);
    if (!latest || !keys[latest]) throw new Error("No verified conversation key is available");
    const payload = this.#chat.encryptMessage({
      conversationId,
      text,
      conversationKey: keys[latest],
      conversationKeyVersion: latest,
    });
    return {
      messageId: payload.messageId,
      conversationId,
      encodedMessageCreateEvent: payload.encryptedContent,
      encodedMessageEventSignature: payload.encodedEventSignature,
    };
  }

  async send(prepared: PreparedSend): Promise<string> {
    return await this.#api.sendPrepared(prepared);
  }

  lock(): void {
    this.#chat.lock();
    this.#chat.free();
  }

  async #signingKeys(userIds: string[]): Promise<SigningKeyEntry[]> {
    const records = await Promise.all(userIds.map((id) => this.#api.getSigningKeys(id)));
    const keys = records.flat();
    for (const key of keys) {
      if (!this.#chat.verifyKeyBinding(key.identityPublicKey, key.publicKey, key.identityPublicKeySignature)) {
        throw new Error("X Chat signing-key binding is invalid");
      }
    }
    return keys;
  }

  async #loadConversationKeys(conversationId: string): Promise<ConversationKeyMap> {
    const stored = await this.#vault.get<StoredConversationKeys>("conversation_keys", await vaultId(conversationId));
    if (!stored) return {};
    return Object.fromEntries(Object.entries(stored.keys).map(([version, encoded]) => [version, Uint8Array.from(Buffer.from(encoded, "base64"))]));
  }

  async #storeConversationKeys(conversationId: string, keys: ConversationKeyMap): Promise<void> {
    const encoded = Object.fromEntries(Object.entries(keys).map(([version, value]) => [version, Buffer.from(value).toString("base64")]));
    await this.#vault.put("conversation_keys", await vaultId(conversationId), { keys: encoded });
  }
}

function normalizeVerifiedText(
  event: Event,
  eventUuid: string,
  conversationId: string,
  keyChangeEvent?: string,
): VerifiedInboundText | undefined {
  if (
    event.verified !== true ||
    event.type !== "message" ||
    event.content?.contentType !== "text" ||
    typeof event.content.text !== "string" ||
    !event.content.text.trim() ||
    typeof event.id !== "string" ||
    typeof event.senderId !== "string"
  ) return undefined;
  const occurredAt = event.createdAtMsec;
  if (!Number.isSafeInteger(occurredAt) || occurredAt! < 0 || occurredAt! > Date.now() + 5 * 60_000) {
    throw new Error("X Chat event timestamp is invalid");
  }
  const text = event.content.text.trim();
  if (text.length > 16_000) throw new Error("X Chat message exceeds the text limit");
  return {
    eventUuid,
    providerMessageId: event.id,
    senderId: event.senderId,
    conversationId,
    occurredAt: occurredAt!,
    text,
    ...(keyChangeEvent ? { keyChangeEvent } : {}),
  };
}

async function vaultId(conversationId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(conversationId));
  return Buffer.from(digest).toString("hex");
}
