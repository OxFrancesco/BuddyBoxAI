import { describe, expect, test } from "bun:test";
import { AesGcmSecretVault } from "../src/crypto.ts";
import { redactForLog, safeAuthError } from "../src/redaction.ts";
import { CodexAuthError } from "../src/openai.ts";

describe("credential security", () => {
  test("binds encrypted credentials to their user and purpose", async () => {
    const vault = await AesGcmSecretVault.fromRawKey(new Uint8Array(32).fill(11));
    const sealed = await vault.seal("refresh-secret", "user-1:refresh");

    await expect(vault.open(sealed, "user-1:refresh")).resolves.toBe(
      "refresh-secret",
    );
    await expect(vault.open(sealed, "user-2:refresh")).rejects.toThrow(
      "Credential decryption failed",
    );
    expect(JSON.stringify(sealed)).not.toContain("refresh-secret");
  });

  test("recursively redacts OAuth material, authorization headers, JWTs, and device codes", () => {
    const input = {
      access_token: "access-secret",
      nested: {
        authorization: "Bearer bearer-secret",
        cookie: "session=secret",
        user_code: "ABCD-EFGH",
        harmless: "request completed",
        message: "token eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1In0.signature",
      },
    };

    const redacted = redactForLog(input);
    expect(redacted).toEqual({
      access_token: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        cookie: "[REDACTED]",
        user_code: "[REDACTED]",
        harmless: "request completed",
        message: "token [REDACTED]",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("secret");
  });

  test("turns arbitrary thrown values into a fixed safe logging shape", () => {
    expect(
      safeAuthError(
        Object.assign(new Error("refresh_token=do-not-log"), {
          stack: "Bearer do-not-log",
        }),
      ),
    ).toEqual({
      name: "CodexAuthError",
      code: "unexpected_error",
      retryable: false,
      message: "ChatGPT authorization failed.",
    });
    expect(safeAuthError(new CodexAuthError("rate_limited", true))).toEqual({
      name: "CodexAuthError",
      code: "rate_limited",
      retryable: true,
      message: "ChatGPT authorization is temporarily rate limited.",
    });
  });
});
