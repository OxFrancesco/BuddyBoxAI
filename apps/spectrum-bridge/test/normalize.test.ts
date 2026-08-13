import { describe, expect, test } from "bun:test";

import { normalizeSpectrumInbound } from "../src/normalize";

const envelope = {
  event: "messages",
  space: { id: "any;-;+15551234567", platform: "iMessage" },
  message: {
    id: "spc-msg-00000000-0000-4000-8000-000000000001",
    platform: "iMessage",
    direction: "inbound",
    timestamp: "2026-05-14T19:06:32.000Z",
    sender: { id: "+1 (555) 123-4567", platform: "iMessage" },
    space: { id: "any;-;+15551234567", platform: "iMessage" },
    content: { type: "text", text: "  Build me a restaurant site.  " },
  },
};

describe("inbound normalization seam", () => {
  test("bounds content and replaces the provider address with a stable keyed hash", async () => {
    const result = await normalizeSpectrumInbound(envelope, {
      addressPepper: "address_pepper_that_is_long_enough",
      webhookId: "60d6d04f-f9fa-4a7b-9c97-37c9c90ce91c",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        source: "imessage",
        idempotencyKey: "spectrum:imessage:spc-msg-00000000-0000-4000-8000-000000000001",
        providerMessageId: "spc-msg-00000000-0000-4000-8000-000000000001",
        providerWebhookId: "60d6d04f-f9fa-4a7b-9c97-37c9c90ce91c",
        addressHash: expect.stringMatching(/^addr_[0-9a-f]{64}$/),
        spaceId: "any;-;+15551234567",
        sentAt: "2026-05-14T19:06:32.000Z",
        text: "Build me a restaurant site.",
        attachments: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain("+1 (555) 123-4567");
  });

  test("rejects content beyond configured limits without truncating user intent", async () => {
    const tooLong = structuredClone(envelope);
    tooLong.message.content.text = "x".repeat(17);
    const result = await normalizeSpectrumInbound(tooLong, {
      addressPepper: "address_pepper_that_is_long_enough",
      maxTextCharacters: 16,
      webhookId: "60d6d04f-f9fa-4a7b-9c97-37c9c90ce91c",
    });
    expect(result).toEqual({ ok: false, reason: "message_too_large" });
  });
});
