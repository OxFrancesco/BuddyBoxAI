import { describe, expect, test } from "bun:test";

import { WebhookReplayAdmission } from "../src/replay";
import { MemoryVault } from "../src/vault";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("durable exact-body replay admission", () => {
  test("lets an expired processing lease be reclaimed without letting the stale owner complete it", async () => {
    const replay = new WebhookReplayAdmission(new MemoryVault(), {
      leaseMs: 1_000,
      ttlMs: 60_000,
    });
    const first = await replay.claim(bytes("captured-body"), 10_000);
    expect(first.status).toBe("claimed");
    expect((await replay.claim(bytes("captured-body"), 10_999)).status).toBe("in_flight");

    const replacement = await replay.claim(bytes("captured-body"), 11_001);
    expect(replacement.status).toBe("claimed");
    if (first.status !== "claimed" || replacement.status !== "claimed") throw new Error("expected claims");
    expect(await replay.complete(first.claim, 11_002)).toBe(false);
    expect(await replay.complete(replacement.claim, 11_002)).toBe(true);
    expect((await replay.claim(bytes("captured-body"), 11_003)).status).toBe("duplicate");
  });

  test("fails closed at its configured persistent capacity instead of evicting replay evidence", async () => {
    const replay = new WebhookReplayAdmission(new MemoryVault(), {
      maxEntries: 100,
      ttlMs: 60_000,
      leaseMs: 1_000,
    });
    for (let index = 0; index < 100; index += 1) {
      const decision = await replay.claim(bytes(`body-${index}`), 10_000);
      expect(decision.status).toBe("claimed");
      if (decision.status === "claimed") expect(await replay.complete(decision.claim, 10_000)).toBe(true);
    }

    expect((await replay.claim(bytes("body-over-capacity"), 10_001)).status).toBe("full");
    expect((await replay.claim(bytes("body-0"), 10_001)).status).toBe("duplicate");
  });

  test("fails closed when the authenticated replay ledger has an invalid entry", async () => {
    const vault = new MemoryVault();
    await vault.put("webhook_replay", "exact_body_digests", {
      format: 1,
      entries: { "not-a-sha256-digest": { state: "accepted", expiresAt: 20_000 } },
    });
    const replay = new WebhookReplayAdmission(vault);

    await expect(replay.claim(bytes("new-body"), 10_000)).rejects.toThrow("malformed");
  });
});
