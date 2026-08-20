import { afterEach, describe, expect, test } from "bun:test";

import { decryptBridgePayload, encryptBridgePayload } from "./lib/bridgeCrypto";
import { parseRuntimeEvent } from "./orchestrator";

const previousRouteKey = process.env.ICHEF_ROUTE_ENCRYPTION_KEY;

afterEach(() => {
  if (previousRouteKey === undefined) delete process.env.ICHEF_ROUTE_ENCRYPTION_KEY;
  else process.env.ICHEF_ROUTE_ENCRYPTION_KEY = previousRouteKey;
});

describe("orchestrator boundaries", () => {
  test("opens only authenticated route payloads", async () => {
    process.env.ICHEF_ROUTE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const ciphertext = await encryptBridgePayload({ text: "Build a calmer dashboard." });
    await expect(decryptBridgePayload<{ text: string }>(ciphertext)).resolves.toEqual({
      text: "Build a calmer dashboard.",
    });
    await expect(decryptBridgePayload(`${ciphertext}x`)).rejects.toThrow();
  });

  test("accepts only versioned events bound to the expected Run", () => {
    expect(parseRuntimeEvent({
      protocolVersion: "2026-08-13",
      sequence: 1,
      type: "run.outcome",
      runId: "run_one",
      at: "2026-08-20T10:00:00.000Z",
      outcome: "succeeded",
      summary: "Verified.",
    }, "run_one")).toMatchObject({ sequence: 1, outcome: "succeeded" });
    expect(() => parseRuntimeEvent({
      protocolVersion: "2026-08-13",
      sequence: 1,
      type: "run.outcome",
      runId: "run_other",
      at: "2026-08-20T10:00:00.000Z",
      outcome: "succeeded",
    }, "run_one")).toThrow("runtime_stream_invalid");
  });
});
