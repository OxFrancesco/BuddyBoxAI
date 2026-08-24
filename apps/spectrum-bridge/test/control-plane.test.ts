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

  test("carries the opaque lease from claim through settlement", async () => {
    const requests: unknown[] = [];
    const adapter = new ConvexHttpControlPlane({
      bridgeUrl: "https://example.convex.site/v1/spectrum/bridge",
      bridgeSecret: "bridge_secret_value",
      fetcher: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        requests.push(request);
        return Response.json({
          ok: true,
          result: request.operation === "claim_outbound"
            ? { status: "claimed", leaseToken: "l".repeat(43) }
            : null,
        });
      },
    });

    const claim = await adapter.claimOutbound({
      outboundId: "outbound-1",
      idempotencyKey: "outbound-key-1",
    });
    expect(claim).toEqual({ status: "claimed", leaseToken: "l".repeat(43) });
    if (claim.status !== "claimed") throw new Error("expected claimed outbound");
    await adapter.settleOutbound({
      outboundId: "outbound-1",
      leaseToken: claim.leaseToken,
      status: "delivered",
      attempts: 1,
      providerMessageId: "provider-message-1",
    });

    expect(requests[1]).toEqual({
      operation: "settle_outbound",
      input: {
        outboundId: "outbound-1",
        leaseToken: "l".repeat(43),
        status: "delivered",
        attempts: 1,
        providerMessageId: "provider-message-1",
      },
    });
  });

  test("preserves an explicit reconciliation-required claim result", async () => {
    const adapter = new ConvexHttpControlPlane({
      bridgeUrl: "https://example.convex.site/v1/spectrum/bridge",
      bridgeSecret: "bridge_secret_value",
      fetcher: async () => Response.json({
        ok: true,
        result: { status: "reconciliation_required" },
      }),
    });

    expect(await adapter.claimOutbound({
      outboundId: "outbound-ambiguous-1",
      idempotencyKey: "outbound-ambiguous-key-1",
    })).toEqual({ status: "reconciliation_required" });
  });
});
