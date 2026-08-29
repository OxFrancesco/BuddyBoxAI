import { describe, expect, test } from "bun:test";

import { XActivityStreamClient } from "../src/activity-stream";

describe("X Activity stream", () => {
  test("parses newline-delimited activities across arbitrary chunks", async () => {
    let request: Request | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":{"event_type":"chat.rece'));
        controller.enqueue(new TextEncoder().encode('ived","event_uuid":"1","payload":{"sender_id":"123"}}}\n\n'));
        controller.enqueue(new TextEncoder().encode('{"data":{"event_type":"chat.conversation.join","event_uuid":"2","payload":{}}}\n'));
        controller.close();
      },
    });
    const client = new XActivityStreamClient({
      baseUrl: "https://api.x.test",
      bearerToken: "app-token",
      fetcher: async (input, init) => {
        request = new Request(input, init);
        return new Response(stream, { status: 200 });
      },
    });

    const events: unknown[] = [];
    let opened = false;
    for await (const event of client.events(undefined, () => { opened = true; })) events.push(event);

    expect(opened).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ data: { event_type: "chat.received", event_uuid: "1" } });
    expect(new URL(request!.url).searchParams.get("backfill_minutes")).toBe("5");
    expect(request!.headers.get("authorization")).toBe("Bearer app-token");
  });
});
