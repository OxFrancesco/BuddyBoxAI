import { describe, expect, test } from "bun:test";

import { serializeGrpcInbound } from "../src/spectrum-adapter";

describe("Spectrum gRPC adapter seam", () => {
  test("projects an SDK message into the same bounded webhook envelope", () => {
    expect(
      serializeGrpcInbound(
        { id: "opaque-space", __platform: "imessage", phone: "shared" },
        {
          id: "spc-msg-1",
          __platform: "imessage",
          direction: "inbound",
          timestamp: new Date("2026-05-14T19:06:32.000Z"),
          sender: { id: "+15551234567", __platform: "imessage" },
          content: { type: "text", text: "Build it" },
        },
      ),
    ).toEqual({
      event: "messages",
      space: { id: "opaque-space", platform: "iMessage", phone: "shared" },
      message: {
        id: "spc-msg-1",
        platform: "iMessage",
        direction: "inbound",
        timestamp: "2026-05-14T19:06:32.000Z",
        sender: { id: "+15551234567", platform: "iMessage" },
        content: { type: "text", text: "Build it" },
      },
    });
  });
});
