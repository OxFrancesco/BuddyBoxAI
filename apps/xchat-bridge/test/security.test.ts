import { describe, expect, test } from "bun:test";

import { acceptXWebhook, crcResponse, signXWebhookForTest } from "../src/security";

const SECRET = "consumer_secret_long_enough";

describe("X webhook security", () => {
  test("answers CRC with the documented HMAC shape", async () => {
    expect(await crcResponse("challenge", SECRET)).toMatch(/^sha256=[A-Za-z0-9+/]+=*$/);
  });

  test("verifies the exact raw body and enforces the one MiB cap", async () => {
    const body = JSON.stringify({ data: { event_uuid: "event-1" } });
    const signature = await signXWebhookForTest(SECRET, body);
    const request = new Request("https://bridge.example/v1/xchat/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-twitter-webhooks-signature": signature },
      body,
    });
    const result = await acceptXWebhook(request, SECRET);
    expect(result.ok).toBe(true);

    const changed = new Request("https://bridge.example/v1/xchat/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-twitter-webhooks-signature": signature },
      body: `${body} `,
    });
    expect(await acceptXWebhook(changed, SECRET)).toEqual({ ok: false, status: 401 });

    const huge = new Request("https://bridge.example/v1/xchat/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(1024 * 1024 + 1),
        "x-twitter-webhooks-signature": signature,
      },
      body: "{}",
    });
    expect(await acceptXWebhook(huge, SECRET)).toEqual({ ok: false, status: 413 });
  });
});
