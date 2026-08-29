import { describe, expect, test } from "bun:test";

import { XChatInbox } from "../src/inbox";
import type { VerifiedInboundText, XChatEventPage } from "../src/types";
import { MemoryVault } from "../src/vault";

function message(id: string, occurredAt: number): VerifiedInboundText {
  return {
    eventUuid: id,
    providerMessageId: `message-${id}`,
    senderId: "123",
    conversationId: "123-456",
    occurredAt,
    text: `text-${id}`,
  };
}

describe("X Chat inbox delivery", () => {
  test("bootstraps history without replaying a backlog, then admits each new event once", async () => {
    const now = Date.parse("2026-08-28T12:00:00Z");
    const pages: XChatEventPage[] = [{
      events: [
        { id: "old", senderId: "123", conversationId: "123-456", createdAt: "2026-08-20T12:00:00Z", encodedEvent: "old" },
        { id: "recent-1", senderId: "123", conversationId: "123-456", createdAt: "2026-08-28T11:00:00Z", encodedEvent: "recent-1" },
        { id: "recent-2", senderId: "123", conversationId: "123-456", createdAt: "2026-08-28T11:30:00Z", encodedEvent: "recent-2" },
      ],
      conversationKeyEvents: ["key-change"],
    }];
    const admitted: string[] = [];
    const inbox = new XChatInbox({
      api: {
        listConversations: async () => ({ conversationIds: ["123-456"], hasMessageRequests: false }),
        getConversationEvents: async () => pages.at(-1)!,
        getCanonicalConversationId: async () => undefined,
      },
      engine: {
        decryptPage: async (page) => page.events.map((event) => {
          const occurredAt = Date.parse(event.createdAt ?? "");
          return message(event.id, occurredAt);
        }),
      },
      bridge: { acceptInboundMessage: async (value) => { admitted.push(value.eventUuid); return "accepted"; } },
      vault: new MemoryVault(),
      botUserId: "456",
      now: () => now,
    });

    await inbox.pollOnce();
    expect(admitted).toEqual(["recent-2"]);

    pages.push({
      events: [
        { id: "recent-2", senderId: "123", conversationId: "123-456", createdAt: "2026-08-28T11:30:00Z", encodedEvent: "recent-2" },
        { id: "new", senderId: "123", conversationId: "123-456", createdAt: "2026-08-28T12:01:00Z", encodedEvent: "new" },
      ],
      conversationKeyEvents: [],
    });
    await inbox.pollOnce();
    await inbox.pollOnce();
    expect(admitted).toEqual(["recent-2", "new"]);
  });

  test("uses Activity stream notifications to discover message-request conversations", async () => {
    const polled: string[] = [];
    const inbox = new XChatInbox({
      api: {
        listConversations: async () => ({ conversationIds: [], hasMessageRequests: true }),
        getConversationEvents: async (conversationId) => {
          polled.push(conversationId);
          return { events: [], conversationKeyEvents: [] };
        },
        getCanonicalConversationId: async (peerId) => `${peerId}-456`,
      },
      engine: { decryptPage: async () => [] },
      bridge: { acceptInboundMessage: async () => "accepted" },
      vault: new MemoryVault(),
      botUserId: "456",
    });

    expect(await inbox.noteActivity({
      data: {
        event_type: "chat.received",
        event_uuid: "activity-1",
        payload: { sender_id: "123" },
      },
    })).toBe(true);
    expect(polled).toEqual(["123-456"]);
  });
});
