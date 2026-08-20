import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnvelopeProtector } from "../src/crypto";
import { createRequestHandler } from "../src/server";
import { WebhookReplayAdmission } from "../src/replay";
import { signXWebhookForTest } from "../src/security";
import { EncryptedFileVault, MemoryVault } from "../src/vault";

const SECRET = "consumer_secret_long_enough";

describe("HTTP boundary", () => {
  test("runs CRC and waits for authenticated admission before acknowledging", async () => {
    let admitted = false;
    const handler = createRequestHandler({
      consumerSecret: SECRET,
      replay: new WebhookReplayAdmission(new MemoryVault()),
      bridge: { acceptWebhookPayload: async () => { admitted = true; return "accepted"; } },
    });
    const crc = await handler(new Request("https://bridge.example/v1/xchat/webhook?crc_token=hello"));
    expect(crc.status).toBe(200);
    expect(await crc.json()).toHaveProperty("response_token");

    const body = JSON.stringify({ data: { event_uuid: "event-1" } });
    const response = await handler(new Request("https://bridge.example/v1/xchat/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twitter-webhooks-signature": await signXWebhookForTest(SECRET, body),
      },
      body,
    }));
    expect(response.status).toBe(200);
    expect(admitted).toBe(true);
  });

  test("rejects a captured exact body across handler restart before bridge decryption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ichef-xchat-replay-"));
    const path = join(directory, "vault.json");
    const vaultKey = Buffer.alloc(32, 12).toString("base64");
    const body = JSON.stringify({ data: { event_uuid: "event-replayed" } });
    const signature = await signXWebhookForTest(SECRET, body);
    let decryptions = 0;
    const request = () => new Request("https://bridge.example/v1/xchat/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twitter-webhooks-signature": signature,
      },
      body,
    });
    const handler = () => createRequestHandler({
      consumerSecret: SECRET,
      replay: new WebhookReplayAdmission(
        new EncryptedFileVault(path, new EnvelopeProtector(vaultKey)),
      ),
      bridge: {
        acceptWebhookPayload: async () => {
          decryptions += 1;
          return "accepted";
        },
      },
    });

    try {
      expect((await handler()(request())).status).toBe(200);
      expect((await handler()(request())).status).toBe(200);
      expect(decryptions).toBe(1);
      const encryptedVault = await readFile(path, "utf8");
      expect(encryptedVault).not.toContain("event-replayed");
      expect(encryptedVault).not.toContain("5a99715ac46b05720f2509ef6fd5096a66b775df1969ca378ac2a446ebc0d5ed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("releases the durable claim after a transient bridge failure so X can retry", async () => {
    const body = JSON.stringify({ data: { event_uuid: "event-retry" } });
    const signature = await signXWebhookForTest(SECRET, body);
    let attempts = 0;
    const handler = createRequestHandler({
      consumerSecret: SECRET,
      replay: new WebhookReplayAdmission(new MemoryVault()),
      bridge: {
        acceptWebhookPayload: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("control plane unavailable");
          return "accepted";
        },
      },
    });
    const request = () => new Request("https://bridge.example/v1/xchat/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twitter-webhooks-signature": signature,
      },
      body,
    });

    expect((await handler(request())).status).toBe(503);
    expect((await handler(request())).status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("admits only one concurrent copy of the same signed body", async () => {
    const body = JSON.stringify({ data: { event_uuid: "event-concurrent" } });
    const signature = await signXWebhookForTest(SECRET, body);
    let decryptions = 0;
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const handler = createRequestHandler({
      consumerSecret: SECRET,
      replay: new WebhookReplayAdmission(new MemoryVault()),
      bridge: {
        acceptWebhookPayload: async () => {
          decryptions += 1;
          await firstMayFinish;
          return "accepted";
        },
      },
    });
    const request = () => new Request("https://bridge.example/v1/xchat/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twitter-webhooks-signature": signature,
      },
      body,
    });

    const first = handler(request());
    await Bun.sleep(0);
    const second = await handler(request());
    expect(second.status).toBe(409);
    expect(decryptions).toBe(1);
    releaseFirst();
    expect((await first).status).toBe(200);
  });
});
