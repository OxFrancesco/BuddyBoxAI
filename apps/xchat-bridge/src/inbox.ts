import { z } from "zod";

import { sha256 } from "./crypto";
import type { VerifiedInboundText, XChatEventPage } from "./types";
import type { SecureVault } from "./vault";

const activitySchema = z.object({
  data: z.object({
    event_type: z.enum(["chat.received", "chat.conversation.join", "chat.conversation_join", "chat.sent"]),
    event_uuid: z.string().min(1).max(256),
    payload: z.object({
      conversation_id: z.string().min(1).max(256).optional(),
      sender_id: z.string().regex(/^\d{1,19}$/).optional(),
    }).catchall(z.unknown()),
  }).catchall(z.unknown()),
});

interface InboxState {
  conversationId: string;
  bootstrapped: boolean;
  seenEventIds: string[];
}

interface InboxApi {
  listConversations(): Promise<{ conversationIds: string[]; hasMessageRequests: boolean }>;
  getConversationEvents(conversationId: string, options?: { allPages?: boolean }): Promise<XChatEventPage>;
  getCanonicalConversationId(peerOrConversationId: string): Promise<string | undefined>;
}

interface InboxEngine {
  decryptPage(page: XChatEventPage): Promise<VerifiedInboundText[]>;
}

interface InboxBridge {
  acceptInboundMessage(message: VerifiedInboundText): Promise<"accepted" | "duplicate" | "ignored">;
}

const MAX_SEEN_EVENTS = 2_000;
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1_000;

export class XChatInbox {
  readonly #api: InboxApi;
  readonly #engine: InboxEngine;
  readonly #bridge: InboxBridge;
  readonly #vault: SecureVault;
  readonly #botUserId: string;
  readonly #now: () => number;
  #operation: Promise<void> = Promise.resolve();

  constructor(options: {
    api: InboxApi;
    engine: InboxEngine;
    bridge: InboxBridge;
    vault: SecureVault;
    botUserId: string;
    now?: () => number;
  }) {
    this.#api = options.api;
    this.#engine = options.engine;
    this.#bridge = options.bridge;
    this.#vault = options.vault;
    this.#botUserId = options.botUserId;
    this.#now = options.now ?? Date.now;
  }

  async pollOnce(): Promise<{ conversations: number; hasMessageRequests: boolean }> {
    return await this.#enqueue(async () => await this.#pollOnce());
  }

  async #pollOnce(): Promise<{ conversations: number; hasMessageRequests: boolean }> {
    const inbox = await this.#api.listConversations();
    const watched = await this.#watchedConversations();
    const ids = [...new Set([...inbox.conversationIds, ...watched])];
    for (const id of ids) await this.#pollConversation(id);
    return { conversations: ids.length, hasMessageRequests: inbox.hasMessageRequests };
  }

  async noteActivity(input: unknown): Promise<boolean> {
    return await this.#enqueue(async () => await this.#noteActivity(input));
  }

  async #noteActivity(input: unknown): Promise<boolean> {
    const parsed = activitySchema.safeParse(input);
    if (!parsed.success || parsed.data.data.event_type === "chat.sent") return false;
    const payload = parsed.data.data.payload;
    let conversationId = payload.conversation_id?.replaceAll(":", "-");
    if (!conversationId && payload.sender_id && payload.sender_id !== this.#botUserId) {
      conversationId = await this.#api.getCanonicalConversationId(payload.sender_id);
    }
    if (!conversationId) return false;
    await this.#pollConversation(conversationId);
    return true;
  }

  async #pollConversation(conversationId: string): Promise<void> {
    const id = await sha256(conversationId);
    const state = await this.#vault.get<InboxState>("inbox_state", id) ?? {
      conversationId,
      bootstrapped: false,
      seenEventIds: [],
    };
    const page = await this.#api.getConversationEvents(conversationId, { allPages: !state.bootstrapped });
    const seen = new Set(state.seenEventIds);
    const newEvents = page.events.filter((event) => !seen.has(event.id));
    if (newEvents.length === 0) {
      if (!state.bootstrapped) {
        await this.#vault.put("inbox_state", id, { ...state, bootstrapped: true });
      }
      return;
    }

    const messages = await this.#engine.decryptPage({ ...page, events: newEvents });
    const inbound = messages
      .filter((message) => message.senderId !== this.#botUserId)
      .sort((left, right) => left.occurredAt - right.occurredAt);
    if (state.bootstrapped) {
      for (const message of inbound) await this.#bridge.acceptInboundMessage(message);
    } else {
      const cutoff = this.#now() - RECENT_WINDOW_MS;
      const latest = inbound.filter((message) => message.occurredAt >= cutoff).at(-1);
      if (latest) await this.#bridge.acceptInboundMessage(latest);
    }

    for (const event of newEvents) seen.add(event.id);
    const seenEventIds = [...seen].slice(-MAX_SEEN_EVENTS);
    await this.#vault.put("inbox_state", id, {
      conversationId,
      bootstrapped: true,
      seenEventIds,
    } satisfies InboxState);
  }

  async #watchedConversations(): Promise<string[]> {
    const ids = await this.#vault.listIds("inbox_state");
    const values = await Promise.all(ids.map((id) => this.#vault.get<InboxState>("inbox_state", id)));
    return values.flatMap((value) => value?.conversationId ? [value.conversationId] : []);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }
}
