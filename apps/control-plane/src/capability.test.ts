import { describe, expect, test } from "bun:test";

import { issueCapability, verifyCapability } from "./capability";

describe("gateway capabilities", () => {
  test("round-trips an action-bound short-lived capability", async () => {
    const token = await issueCapability({ sub: "user_1", projectId: "project_1", action: "run", exp: 1_800_000_120 }, "secret", 1_800_000_000);
    expect(await verifyCapability(token, "secret", 1_800_000_001)).toMatchObject({ sub: "user_1", projectId: "project_1", action: "run" });
  });

  test("fails closed for expiry and tampering", async () => {
    const token = await issueCapability({ sub: "user_1", projectId: "project_1", action: "run", exp: 1_800_000_010 }, "secret", 1_800_000_000);
    expect(await verifyCapability(token, "secret", 1_800_000_011)).toBeNull();
    expect(await verifyCapability(`${token}x`, "secret", 1_800_000_001)).toBeNull();
  });
});
