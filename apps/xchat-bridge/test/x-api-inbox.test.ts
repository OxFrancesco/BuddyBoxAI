import { describe, expect, test } from "bun:test";

import { MemoryVault } from "../src/vault";
import { UserContextTokenProvider } from "../src/oauth";
import { XApiClient } from "../src/x-api";

function clientFor(handler: (request: Request) => Response | Promise<Response>): XApiClient {
  return new XApiClient({
    baseUrl: "https://api.x.test",
    tokens: new UserContextTokenProvider({ accessToken: "user-token", vault: new MemoryVault() }),
    fetcher: async (input, init) => await handler(new Request(input, init)),
  });
}

describe("official X Chat inbox transport", () => {
  test("lists the primary inbox and reads encrypted conversation events", async () => {
    const requests: Request[] = [];
    const api = clientFor((request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/2/chat/conversations") {
        return Response.json({
          data: [{ id: "123-456", type: "ONE_TO_ONE" }],
          meta: { has_message_requests: true },
        });
      }
      if (url.pathname === "/2/chat/conversations/123-456/events") {
        return Response.json({
          data: [{
            id: "outer-event-1",
            sender_id: "123",
            conversation_id: "123-456",
            created_at: "2026-08-28T12:00:00Z",
            encoded_event: "ciphertext",
          }],
          meta: { conversation_key_events: ["key-change"] },
        });
      }
      return new Response(null, { status: 404 });
    });

    expect(await api.listConversations()).toEqual({
      conversationIds: ["123-456"],
      hasMessageRequests: true,
    });
    expect(await api.getConversationEvents("123:456")).toEqual({
      events: [{
        id: "outer-event-1",
        senderId: "123",
        conversationId: "123-456",
        createdAt: "2026-08-28T12:00:00Z",
        encodedEvent: "ciphertext",
      }],
      conversationKeyEvents: ["key-change"],
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/2/chat/conversations",
      "/2/chat/conversations/123-456/events",
    ]);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer user-token")).toBe(true);
  });

  test("creates stream subscriptions without a webhook id", async () => {
    const bodies: unknown[] = [];
    const api = clientFor(async (request) => {
      if (request.method === "GET") return Response.json({ data: [] });
      if (request.method === "POST") bodies.push(await request.json());
      return Response.json({ data: { subscription: { subscription_id: "1" } } });
    });

    await api.ensureActivitySubscriptions("123456");

    expect(bodies).toEqual([
      { event_type: "chat.received", filter: { user_id: "123456" } },
      { event_type: "chat.conversation.join", filter: { user_id: "123456" } },
    ]);
  });
});
