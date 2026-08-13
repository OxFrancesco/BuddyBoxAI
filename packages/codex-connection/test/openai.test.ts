import { describe, expect, test } from "bun:test";
import {
  accountIdFromAccessToken,
  CodexAuthError,
  OpenAiCodexAuthClient,
} from "../src/openai.ts";

function jwt(accountId: string): string {
  return [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");
}

describe("OpenAiCodexAuthClient", () => {
  test("implements Pi's headless device-code request contract", async () => {
    let captured: Request | undefined;
    const client = new OpenAiCodexAuthClient({
      now: () => 10_000,
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return Response.json({
          device_auth_id: "device-id",
          user_code: "ABCD-EFGH",
          interval: "5",
        });
      },
    });

    await expect(client.startDeviceAuthorization()).resolves.toEqual({
      deviceAuthId: "device-id",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      intervalMs: 5_000,
      expiresAt: 910_000,
    });
    expect(captured?.url).toBe(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
    );
    expect(captured?.method).toBe("POST");
    expect(await captured?.json()).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
  });

  test("exchanges the device grant and extracts its ChatGPT account", async () => {
    const accessToken = jwt("account-fixture");
    const client = new OpenAiCodexAuthClient({
      now: () => 100_000,
      fetch: async () =>
        Response.json({
          access_token: accessToken,
          refresh_token: "refresh-value",
          expires_in: 3600,
        }),
    });

    await expect(
      client.exchangeDeviceAuthorization("authorization-code", "verifier"),
    ).resolves.toEqual({
      accessToken,
      refreshToken: "refresh-value",
      expiresAt: 3_700_000,
      accountId: "account-fixture",
    });
    expect(accountIdFromAccessToken(accessToken)).toBe("account-fixture");
    expect(accountIdFromAccessToken("not-a-token")).toBeNull();
  });

  test("classifies upstream outages without copying response secrets into errors", async () => {
    const client = new OpenAiCodexAuthClient({
      fetch: async () =>
        new Response(
          JSON.stringify({ error: "server_error", refresh_token: "LEAK-ME" }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    });

    try {
      await client.refreshCredentials("also-secret");
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexAuthError);
      expect(error).toMatchObject({ code: "upstream_unavailable", retryable: true });
      expect(String(error)).not.toContain("LEAK-ME");
      expect(String(error)).not.toContain("also-secret");
    }
  });
});
