import { describe, expect, test } from "bun:test";

import { normalizeVerifiedText } from "../src/normalize";

describe("X Chat normalization", () => {
  test("accepts only a signature-verified encrypted text event", async () => {
    const result = await normalizeVerifiedText(
      {
        type: "message",
        verified: true,
        id: "message-1",
        senderId: "1843439638876491776",
        conversationId: "1215441834412953600-1843439638876491776",
        createdAtMsec: 1_800_000_000_000,
        content: { contentType: "text", text: "  build me a site  " },
      },
      { eventId: "event-1", addressPepper: "address-pepper-at-least-32-characters" },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        source: "xchat",
        eventId: "event-1",
        providerMessageId: "message-1",
        text: "build me a site",
        occurredAt: 1_800_000_000_000,
      },
    });
    if (result.ok) {
      expect(result.value.senderIdHash).toMatch(/^xusr_[a-f0-9]{64}$/);
      expect(result.value.providerConversationIdHash).toMatch(/^xconv_[a-f0-9]{64}$/);
      expect(JSON.stringify(result.value)).not.toContain("1843439638876491776");
    }
  });

  test("rejects unverified and non-text events", async () => {
    expect((await normalizeVerifiedText({ type: "message", verified: false }, {
      eventId: "event-1",
      addressPepper: "address-pepper-at-least-32-characters",
    })).ok).toBe(false);
    expect((await normalizeVerifiedText({ type: "typing", verified: true }, {
      eventId: "event-2",
      addressPepper: "address-pepper-at-least-32-characters",
    })).ok).toBe(false);
  });
});
