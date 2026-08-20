import { describe, expect, test } from "bun:test";

import { EnvelopeProtector } from "../src/crypto";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("encrypted persistence envelope", () => {
  test("round trips only with the exact purpose AAD", async () => {
    const protector = new EnvelopeProtector(KEY);
    const sealed = await protector.seal({ conversationId: "1-2", text: "private" }, "xchat:outbound:id-1");
    expect(JSON.stringify(sealed)).not.toContain("private");
    expect(await protector.open<{ conversationId: string; text: string }>(sealed, "xchat:outbound:id-1")).toEqual({ conversationId: "1-2", text: "private" });
    expect(protector.open(sealed, "xchat:outbound:id-2")).rejects.toThrow();
  });
});
