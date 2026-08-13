import { describe, expect, test } from "bun:test";

import { ConvexHttpControlPlane, ControlPlaneUnavailableError } from "../src/control-plane";
import type { NormalizedInbound } from "../src/types";

const inbound: NormalizedInbound = {
  source: "imessage",
  idempotencyKey: "spectrum:imessage:message-1",
  providerMessageId: "message-1",
  providerWebhookId: "webhook-1",
  addressHash: `addr_${"b".repeat(64)}`,
  spaceId: "opaque-space",
  sentAt: "2026-05-14T19:06:32.000Z",
  text: "Create a site",
  attachments: [],
};

describe("Convex HTTP adapter seam", () => {
  test("sends one typed operation through the authenticated broker endpoint", async () => {
    let observed: { authorization: string | null; body: unknown } | undefined;
    const adapter = new ConvexHttpControlPlane({
      bridgeUrl: "https://example.convex.site/bridge/spectrum",
      bridgeSecret: "bridge_secret_value",
      fetcher: async (_input, init) => {
        observed = {
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        };
        return Response.json({
          ok: true,
          result: { status: "accepted", deliveryId: "delivery-in-1" },
        });
      },
    });

    expect(await adapter.acceptInbound(inbound)).toEqual({
      status: "accepted",
      deliveryId: "delivery-in-1",
    });
    expect(observed).toEqual({
      authorization: "Bearer bridge_secret_value",
      body: { operation: "accept_inbound", input: inbound },
    });
  });

  test("fails closed when the broker response does not satisfy the operation contract", async () => {
    const adapter = new ConvexHttpControlPlane({
      bridgeUrl: "https://example.convex.site/bridge/spectrum",
      bridgeSecret: "bridge_secret_value",
      fetcher: async () => Response.json({ ok: true, result: { status: "accepted" } }),
    });

    expect(adapter.acceptInbound(inbound)).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  });
});
