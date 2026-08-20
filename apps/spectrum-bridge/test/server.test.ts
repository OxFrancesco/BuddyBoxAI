import { describe, expect, test } from "bun:test";

import type { Bridge } from "../src/bridge";
import { createRequestHandler } from "../src/server";
import { signSpectrumWebhookForTest } from "../src/security";

const NOW = 1_800_000_000_000;
const WEBHOOK_SECRET = "whsec_test_value_that_is_long_enough";

async function webhookRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(NOW / 1000);
  const signature = await signSpectrumWebhookForTest(WEBHOOK_SECRET, timestamp, body);
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

function fakeBridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    acceptInbound: async () => undefined,
    deliverOutbound: async () => ({ status: "delivered", attempts: 1, providerMessageId: "sent-1" }),
    ...overrides,
  };
}

describe("bridge HTTP seam", () => {
  test("durably admits a verified webhook before acknowledging it", async () => {
    let accepted = false;
    const handler = createRequestHandler({
      bridge: fakeBridge({ acceptInbound: async () => void (accepted = true) }),
      addressPepper: "address_pepper_that_is_long_enough",
      internalSecret: "internal_secret_value",
      webhookSecurity: { signingSecret: WEBHOOK_SECRET, now: () => NOW },
    });
    const response = await handler(
      await webhookRequest({
        event: "messages",
        space: { id: "any;-;+15551234567", platform: "iMessage", phone: "shared" },
        message: {
          id: "spc-msg-1",
          platform: "iMessage",
          direction: "inbound",
          timestamp: "2026-05-14T19:06:32.000Z",
          sender: { id: "+15551234567", platform: "iMessage" },
          content: { type: "text", text: "Create a site" },
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(accepted).toBe(true);
  });

  test("requires the bridge credential before accepting an outbound delivery", async () => {
    let delivered = false;
    const handler = createRequestHandler({
      bridge: fakeBridge({
        deliverOutbound: async () => {
          delivered = true;
          return { status: "delivered", attempts: 1, providerMessageId: "sent-1" };
        },
      }),
      addressPepper: "address_pepper_that_is_long_enough",
      internalSecret: "internal_secret_value",
      webhookSecurity: { signingSecret: WEBHOOK_SECRET, now: () => NOW },
    });
    const request = new Request("https://bridge.example/v1/outbound", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({
        outboundId: "delivery-out-1",
        idempotencyKey: "outbound:delivery-out-1",
        spaceId: "opaque-space",
        text: "Your preview is ready.",
      }),
    });

    expect((await handler(request)).status).toBe(401);
    expect(delivered).toBe(false);
  });

  test("returns a non-retryable conflict when outbound delivery needs reconciliation", async () => {
    const handler = createRequestHandler({
      bridge: fakeBridge({
        deliverOutbound: async () => ({ status: "reconciliation_required" }),
      }),
      addressPepper: "address_pepper_that_is_long_enough",
      internalSecret: "internal_secret_value",
      webhookSecurity: { signingSecret: WEBHOOK_SECRET, now: () => NOW },
    });
    const request = new Request("https://bridge.example/v1/outbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer internal_secret_value",
      },
      body: JSON.stringify({
        outboundId: "delivery-out-ambiguous-1",
        idempotencyKey: "outbound:delivery-out-ambiguous-1",
        spaceId: "opaque-space",
        text: "Your preview is ready.",
      }),
    });

    const response = await handler(request);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "reconciliation_required" });
    expect(response.headers.get("retry-after")).toBeNull();
  });
});
