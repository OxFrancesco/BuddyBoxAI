import { describe, expect, test } from "bun:test";

import { testables } from "./index";

describe("credential broker boundaries", () => {
  test("accepts only run-scoped authority", () => {
    expect(testables.isRunAuthority({ userId: "u", projectId: "p", action: "run" })).toBe(true);
    expect(testables.isRunAuthority({ userId: "u", projectId: "p", action: "preview" })).toBe(false);
  });

  test("extracts the owner account without exposing the token", () => {
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account_123" },
    })).toString("base64url");
    expect(testables.accountIdFromAccessToken(`header.${payload}.signature`)).toBe("account_123");
    expect(testables.accountIdFromAccessToken("not-a-token")).toBeNull();
  });

  test("copies only explicitly allowed headers", () => {
    const source = new Headers({ authorization: "secret", accept: "text/event-stream", cookie: "private" });
    expect(Object.fromEntries(testables.selectedHeaders(source, ["accept"]))).toEqual({ accept: "text/event-stream" });
  });
});
