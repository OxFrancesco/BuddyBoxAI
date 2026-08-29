import { createChat, type ChatWithJuicebox, type ConversationKeyMap, type Event, type SigningKeyEntry } from "@xdevplatform/chat-xdk";
import { z } from "zod";

import type { SecureVault } from "./vault";
import type { PreparedSend, VerifiedInboundText, XChatEventPage } from "./types";
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

type XChatSession = Pick<ChatWithJuicebox,
  | "decryptEvent"
  | "decryptEvents"
  | "encryptMessage"
  | "free"
  | "lock"
  | "matchesRegisteredKey"
  | "setCacheKeys"
  | "setIdentity"
  | "setRejectUnverified"
  | "setSigningKeys"
  | "unlock"
  | "verifyKeyBinding"
>;

export type XChatFactory = (
  options: Parameters<typeof createChat>[0],
) => Promise<XChatSession>;

export class XChatEngine {
  readonly #chat: XChatSession;
  readonly #api: XApiClient;
  readonly #vault: SecureVault;
  readonly #botUserId: string;
  readonly #keyVersion: string;

  private constructor(options: {
    chat: XChatSession;
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
    juiceboxPin: string;
    botUserId: string;
    api: XApiClient;
    vault: SecureVault;
    chatFactory?: XChatFactory;
  }): Promise<XChatEngine> {
    const material = await options.api.getXChatRecoveryMaterial(options.botUserId);
    const chatFactory = options.chatFactory ?? createChat;
    const chat = await chatFactory({
      juiceboxConfig: material.juiceboxConfig,
      getAuthToken: async (realmId) => {
        const token = material.realmTokens[realmId.toLowerCase()];
        if (!token) throw new Error("No fresh auth token is available for the requested Juicebox realm");
        return token;
      },
    });
    try {
      await chat.unlock(options.juiceboxPin);
      const registeredKey = material.registeredKeys.find((record) =>
        chat.matchesRegisteredKey(record.identityPublicKey)
      );
      if (!registeredKey) throw new Error("Recovered X Chat identity is not registered to this account");
      chat.setIdentity(options.botUserId, registeredKey.publicKeyVersion);
      chat.setRejectUnverified(true);
      chat.setCacheKeys(true);
      return new XChatEngine({
        chat,
        api: options.api,
        vault: options.vault,
        botUserId: options.botUserId,
        keyVersion: registeredKey.publicKeyVersion,
      });
    } catch (error: unknown) {
      chat.lock();
      chat.free();
      throw error;
    }
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

  async decryptPage(page: XChatEventPage): Promise<VerifiedInboundText[]> {
    if (page.events.length === 0) return [];
    const senderIds = [...new Set([this.#botUserId, ...page.events.map((event) => event.senderId)])];
    const signingKeys = await this.#signingKeys(senderIds);
    this.#chat.setSigningKeys(signingKeys);
    const batch = this.#chat.decryptEvents([
      ...page.conversationKeyEvents,
      ...page.events.map((event) => event.encodedEvent),
    ], signingKeys);
    const conversationIds = [...new Set(page.events.map((event) => event.conversationId))];
    for (const conversationId of conversationIds) {
      const stored = await this.#loadConversationKeys(conversationId);
      await this.#storeConversationKeys(conversationId, {
        ...stored,
        ...batch.conversationKeys.keys,
      });
    }

    const messages: VerifiedInboundText[] = [];
    for (const item of page.events) {
      try {
        const keys = await this.#loadConversationKeys(item.conversationId);
        const event = this.#chat.decryptEvent(item.encodedEvent, keys, signingKeys);
        const message = normalizeVerifiedText(event, item.id, item.conversationId);
        if (message) messages.push(message);
      } catch {
        // Invalid signatures and undecryptable historical records are permanent
        // for this exact provider event. The inbox marks the outer event seen.
      }
    }
    return messages;
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
