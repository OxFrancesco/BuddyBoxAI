import { describe, expect, test } from "bun:test";

import { acceptSpectrumWebhook, signSpectrumWebhookForTest } from "../src/security";
import type { AcceptedSpectrumWebhook } from "../src/security";

const NOW = 1_800_000_000_000;
const SECRET = "whsec_test_value_that_is_long_enough";

async function signedRequest(body: string, timestamp = Math.floor(NOW / 1000)) {
  const signature = await signSpectrumWebhookForTest(SECRET, timestamp, body);
  return new Request("https://bridge.example/v1/spectrum/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-spectrum-event": "messages",
      "x-spectrum-webhook-id": "60d6d04f-f9fa-4a7b-9c97-37c9c90ce91c",
      "x-spectrum-timestamp": String(timestamp),
      "x-spectrum-signature": signature,
    },
    body,
  });
}

describe("Spectrum webhook admission seam", () => {
  test("accepts the exact signed raw body inside the replay window", async () => {
    const body = JSON.stringify({ event: "messages", message: { id: "spc-msg-1" } });
    const accepted = await acceptSpectrumWebhook(await signedRequest(body), {
      signingSecret: SECRET,
      now: () => NOW,
    });

    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(new TextDecoder().decode(accepted.rawBody)).toBe(body);
      expect(accepted.webhookId).toBe("60d6d04f-f9fa-4a7b-9c97-37c9c90ce91c");
    }
  });

  test("rejects modified, stale, oversized, and unexpected-webhook deliveries", async () => {
    const original = JSON.stringify({ event: "messages", message: { id: "spc-msg-1" } });
    const modified = await signedRequest(original);
    const modifiedHeaders = new Headers(modified.headers);
    const changed = new Request(modified.url, {
      method: "POST",
      headers: modifiedHeaders,
      body: `${original} `,
    });

    expect(rejectedStatus(await acceptSpectrumWebhook(changed, { signingSecret: SECRET, now: () => NOW }))).toBe(401);
    expect(
      rejectedStatus(
        await acceptSpectrumWebhook(await signedRequest(original, Math.floor(NOW / 1000) - 301), {
          signingSecret: SECRET,
          now: () => NOW,
        }),
      ),
    ).toBe(401);
    expect(
      rejectedStatus(
        await acceptSpectrumWebhook(await signedRequest(original), {
          signingSecret: SECRET,
          bodyLimitBytes: original.length - 1,
          now: () => NOW,
        }),
      ),
    ).toBe(413);
    expect(
      rejectedStatus(
        await acceptSpectrumWebhook(await signedRequest(original), {
          signingSecret: SECRET,
          expectedWebhookId: "f278698a-1c0d-4e02-bbe4-349643978bd9",
          now: () => NOW,
        }),
      ),
    ).toBe(403);
  });
});

function rejectedStatus(result: AcceptedSpectrumWebhook): number {
  if (result.ok) throw new Error("Expected the webhook to be rejected");
  return result.status;
}
