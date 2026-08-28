import { describe, expect, test } from "bun:test";

import { runXChatProvisionCommand } from "../src/provision-command";
import { provisionXChat, type XProvisioningHttp } from "../src/provision";

const baseEnv = {
  X_OAUTH_ACCESS_TOKEN: "user-token-secret",
  X_APP_BEARER_TOKEN: "app-token-secret",
  X_WEBHOOK_URL: "https://buddybox-xchat.example/v1/xchat/webhook",
  X_CHAT_USER_ID: "2244994945",
  X_CHAT_PIN: "private-pin",
};

describe("X Chat provisioning", () => {
  test("command rejects unknown phases as redacted JSON without making HTTP calls", async () => {
    let calls = 0;
    const command = await runXChatProvisionCommand({
      args: ["destroy"],
      env: baseEnv,
      fetcher: async () => {
        calls += 1;
        return Response.json({});
      },
    });

    expect(command).toEqual({
      exitCode: 1,
      output: '{"status":"error","code":"invalid_phase","allowedPhases":["status","identity","identity-rotate","webhook","subscription","all"]}\n',
    });
    expect(calls).toBe(0);
  });

  test("identity status verifies the OAuth user and reports an existing public-key identity ready", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetcher: XProvisioningHttp = async (input, init) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, authorization: request.headers.get("authorization") });
      if (request.url.endsWith("/2/users/me")) {
        return Response.json({ data: { id: "2244994945", username: "BuddyBoxAI", name: "BuddyBox" } });
      }
      return Response.json({
        data: [{
          public_key_version: "7",
          public_key: "identity-public-key",
          signing_public_key: "signing-public-key",
          identity_public_key_signature: "binding-signature",
          juicebox_config: { realms: ["durable"] },
        }],
      });
    };

    const result = await provisionXChat({
      phase: "identity",
      env: baseEnv,
      fetcher,
      identityVerification: async () => ({ publicKeyVersion: "7" }),
    });

    expect(result).toEqual({
      status: "ready",
      requestedPhase: "identity",
      phases: [{
        phase: "identity",
        status: "ready",
        userId: "2244994945",
        username: "BuddyBoxAI",
        publicKeyVersions: ["7"],
      }],
    });
    expect(calls).toEqual([
      { url: "https://api.x.com/2/users/me", authorization: "Bearer user-token-secret" },
      {
        url: "https://api.x.com/2/users/2244994945/public_keys",
        authorization: "Bearer user-token-secret",
      },
    ]);
  });

  test("identity status accepts legacy account keys without Juicebox recovery material", async () => {
    const result = await provisionXChat({
      phase: "identity",
      env: baseEnv,
      identityVerification: async () => ({ publicKeyVersion: "8" }),
      fetcher: async (input) => String(input).endsWith("/2/users/me")
        ? Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } })
        : Response.json({ data: [
            { public_key_version: "7", public_key: "legacy-public-key", juicebox_config: null },
            { public_key_version: "8", public_key: "current-public-key" },
          ] }),
    });

    expect(result).toEqual({
      status: "ready",
      requestedPhase: "identity",
      phases: [{
        phase: "identity",
        status: "ready",
        userId: "2244994945",
        username: "BuddyBoxAI",
        publicKeyVersions: ["7", "8"],
      }],
    });
  });

  test("rejects a non-numeric users/me identity at the JSON boundary without exposing credentials", async () => {
    const calls: string[] = [];
    const result = await provisionXChat({
      phase: "identity",
      env: baseEnv,
      fetcher: async (input) => {
        calls.push(String(input));
        return Response.json({ data: { id: "BuddyBoxAI", username: "BuddyBoxAI" } });
      },
    });

    expect(result).toEqual({
      status: "error",
      requestedPhase: "identity",
      phases: [{ phase: "identity", status: "error", code: "invalid_x_response" }],
    });
    expect(JSON.stringify(result)).not.toContain("user-token-secret");
    expect(calls).toEqual(["https://api.x.com/2/users/me"]);
  });

  test("stops when the OAuth grant belongs to a different X user", async () => {
    let callCount = 0;
    const result = await provisionXChat({
      phase: "identity",
      env: baseEnv,
      fetcher: async () => {
        callCount += 1;
        return Response.json({ data: { id: "999999", username: "SomeoneElse" } });
      },
    });

    expect(result).toEqual({
      status: "blocked",
      requestedPhase: "identity",
      phases: [{
        phase: "identity",
        status: "blocked",
        code: "oauth_identity_mismatch",
        expectedUserId: "2244994945",
        actualUserId: "999999",
      }],
    });
    expect(callCount).toBe(1);
  });

  test("never generates or registers an identity without an explicit durable setup", async () => {
    const methods: string[] = [];
    const result = await provisionXChat({
      phase: "identity",
      env: baseEnv,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        methods.push(request.method);
        if (request.url.endsWith("/2/users/me")) {
          return Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } });
        }
        return Response.json({ data: [] });
      },
    });

    expect(result).toEqual({
      status: "blocked",
      requestedPhase: "identity",
      phases: [{
        phase: "identity",
        status: "blocked",
        code: "identity_setup_required",
        userId: "2244994945",
        username: "BuddyBoxAI",
        publicKeyVersions: [],
      }],
    });
    expect(methods).toEqual(["GET", "GET"]);
  });

  test("does not depend on a statically configured signing-key version", async () => {
    const result = await provisionXChat({
      phase: "identity",
      env: baseEnv,
      identityVerification: async () => ({ publicKeyVersion: "6" }),
      fetcher: async (input) => String(input).endsWith("/2/users/me")
        ? Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } })
        : Response.json({ data: [{
            public_key_version: "6",
            public_key: "identity-public-key",
            signing_public_key: "signing-public-key",
            identity_public_key_signature: "binding-signature",
            juicebox_config: { realms: ["durable"] },
          }] }),
    });

    expect(result).toEqual({
      status: "ready",
      requestedPhase: "identity",
      phases: [{
        phase: "identity",
        status: "ready",
        userId: "2244994945",
        username: "BuddyBoxAI",
        publicKeyVersions: ["6"],
      }],
    });
  });

  test("does not report a present key ready until PIN recovery is verified", async () => {
    const result = await provisionXChat({
      phase: "identity",
      env: baseEnv,
      fetcher: async (input) => String(input).endsWith("/2/users/me")
        ? Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } })
        : Response.json({ data: [{
            public_key_version: "6",
            public_key: "identity-public-key",
            signing_public_key: "signing-public-key",
            identity_public_key_signature: "binding-signature",
            juicebox_config: { realms: ["durable"] },
          }] }),
    });

    expect(result).toEqual({
      status: "blocked",
      requestedPhase: "identity",
      phases: [{
        phase: "identity",
        status: "blocked",
        code: "identity_recovery_unverified",
        userId: "2244994945",
        username: "BuddyBoxAI",
        publicKeyVersions: ["6"],
      }],
    });
  });

  test("an explicit identity phase delegates first boot to the durable registration boundary", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const result = await provisionXChat({
      phase: "identity",
      env: baseEnv,
      identityRegistration: async (input) => {
          expect(input).toEqual({
            userId: "2244994945",
            pin: "private-pin",
            accessToken: "user-token-secret",
            fetcher: expect.any(Function),
            forceRotation: false,
          });
          return { publicKeyVersion: "8", status: "created" };
      },
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push({ method: request.method, url: request.url });
        if (request.url.endsWith("/2/users/me")) {
          return Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } });
        }
        return Response.json({ data: [] });
      },
    });

    expect(result).toEqual({
      status: "changed",
      requestedPhase: "identity",
      phases: [{
        phase: "identity",
        status: "created",
        userId: "2244994945",
        username: "BuddyBoxAI",
        publicKeyVersions: ["8"],
      }],
    });
    expect(requests.at(-1)).toEqual({
      method: "GET",
      url: "https://api.x.com/2/users/2244994945/public_keys",
    });
  });

  test("identity rotation requires an exact user-id confirmation before the registration boundary", async () => {
    let registrationCalls = 0;
    const result = await provisionXChat({
      phase: "identity-rotate",
      env: baseEnv,
      identityRegistration: async () => {
        registrationCalls += 1;
        return { publicKeyVersion: "9", status: "created" };
      },
      fetcher: async (input) => String(input).endsWith("/2/users/me")
        ? Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } })
        : Response.json({ data: [] }),
    });

    expect(result).toEqual({
      status: "error",
      requestedPhase: "identity-rotate",
      phases: [{
        phase: "identity-rotate",
        status: "error",
        code: "invalid_configuration",
      }],
    });
    expect(registrationCalls).toBe(0);
  });

  test("identity rotation forwards the deliberate force only after exact confirmation", async () => {
    let registrationInput: unknown;
    const result = await provisionXChat({
      phase: "identity-rotate",
      env: { ...baseEnv, X_CHAT_ROTATION_CONFIRM_USER_ID: "2244994945" },
      identityRegistration: async (input) => {
        registrationInput = input;
        return { publicKeyVersion: "9", status: "created" };
      },
      fetcher: async (input) => String(input).endsWith("/2/users/me")
        ? Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } })
        : Response.json({ data: [] }),
    });

    expect(result).toMatchObject({
      status: "changed",
      requestedPhase: "identity-rotate",
      phases: [{ phase: "identity-rotate", status: "created" }],
    });
    expect(registrationInput).toMatchObject({ userId: "2244994945", forceRotation: true });
  });

  test("webhook provisioning reuses the existing exact URL with the separate app bearer", async () => {
    const requests: Array<{ method: string; authorization: string | null }> = [];
    const result = await provisionXChat({
      phase: "webhook",
      env: baseEnv,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push({ method: request.method, authorization: request.headers.get("authorization") });
        return Response.json({
          data: [
            { id: "101", url: "https://other.example/v1/xchat/webhook", valid: true, created_at: "2026-08-24T10:00:00Z" },
            { id: "202", url: baseEnv.X_WEBHOOK_URL, valid: true, created_at: "2026-08-24T11:00:00Z" },
          ],
          meta: { result_count: 2 },
        });
      },
    });

    expect(result).toEqual({
      status: "ready",
      requestedPhase: "webhook",
      phases: [{
        phase: "webhook",
        status: "ready",
        webhookId: "202",
        url: baseEnv.X_WEBHOOK_URL,
      }],
    });
    expect(requests).toEqual([{ method: "GET", authorization: "Bearer app-token-secret" }]);
  });

  test("webhook provisioning creates the stable URL once when no exact registration exists", async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    const result = await provisionXChat({
      phase: "webhook",
      env: baseEnv,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          method: request.method,
          body: request.body ? JSON.parse(await request.text()) : undefined,
        });
        if (request.method === "GET") return Response.json({ data: [], meta: { result_count: 0 } });
        return Response.json({
          data: {
            id: "303",
            url: baseEnv.X_WEBHOOK_URL,
            valid: true,
            created_at: "2026-08-24T12:00:00Z",
          },
        });
      },
    });

    expect(result).toEqual({
      status: "changed",
      requestedPhase: "webhook",
      phases: [{
        phase: "webhook",
        status: "created",
        webhookId: "303",
        url: baseEnv.X_WEBHOOK_URL,
      }],
    });
    expect(requests).toEqual([
      { method: "GET", body: undefined },
      { method: "POST", body: { url: baseEnv.X_WEBHOOK_URL } },
    ]);
  });

  test("webhook provisioning does not duplicate an exact URL that X marks invalid", async () => {
    let calls = 0;
    const result = await provisionXChat({
      phase: "webhook",
      env: baseEnv,
      fetcher: async () => {
        calls += 1;
        return Response.json({ data: [{ id: "303", url: baseEnv.X_WEBHOOK_URL, valid: false }] });
      },
    });

    expect(result).toEqual({
      status: "blocked",
      requestedPhase: "webhook",
      phases: [{
        phase: "webhook",
        status: "blocked",
        code: "webhook_invalid",
        webhookId: "303",
        url: baseEnv.X_WEBHOOK_URL,
      }],
    });
    expect(calls).toBe(1);
  });

  test("subscription provisioning reuses the exact chat.received user and webhook subscription", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const result = await provisionXChat({
      phase: "subscription",
      env: baseEnv,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push({ url: request.url, authorization: request.headers.get("authorization") });
        if (request.url.endsWith("/2/users/me")) {
          return Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } });
        }
        if (request.url.endsWith("/2/webhooks")) {
          return Response.json({
            data: [{ id: "303", url: baseEnv.X_WEBHOOK_URL, valid: true }],
          });
        }
        return Response.json({
          data: [
            { subscription_id: "401", event_type: "chat.received", filter: { user_id: "2244994945" }, tag: "wrong-tag", webhook_id: "303" },
            { subscription_id: "402", event_type: "chat.received", filter: { user_id: "2244994945" }, tag: "buddybox-xchat", webhook_id: "303" },
          ],
          meta: { result_count: 2 },
        });
      },
    });

    expect(result).toEqual({
      status: "ready",
      requestedPhase: "subscription",
      phases: [{
        phase: "subscription",
        status: "ready",
        subscriptionId: "402",
        userId: "2244994945",
        webhookId: "303",
      }],
    });
    expect(requests).toEqual([
      { url: "https://api.x.com/2/users/me", authorization: "Bearer user-token-secret" },
      { url: "https://api.x.com/2/webhooks", authorization: "Bearer app-token-secret" },
      { url: "https://api.x.com/2/activity/subscriptions", authorization: "Bearer app-token-secret" },
    ]);
  });

  test("subscription provisioning creates the exact chat.received filter instead of reusing a near match", async () => {
    const posts: Array<{ authorization: string | null; body: unknown }> = [];
    const result = await provisionXChat({
      phase: "subscription",
      env: baseEnv,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/2/users/me")) {
          return Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } });
        }
        if (request.url.endsWith("/2/webhooks")) {
          return Response.json({ data: [{ id: "303", url: baseEnv.X_WEBHOOK_URL, valid: true }] });
        }
        if (request.method === "GET") {
          return Response.json({
            data: [{
              subscription_id: "402",
              event_type: "chat.received",
              filter: { user_id: "2244994945", direction: "inbound" },
              tag: "buddybox-xchat",
              webhook_id: "303",
            }],
            meta: { result_count: 1 },
          });
        }
        posts.push({
          authorization: request.headers.get("authorization"),
          body: JSON.parse(await request.text()),
        });
        return Response.json({
          data: {
            subscription_id: "403",
            event_type: "chat.received",
            filter: { user_id: "2244994945" },
            tag: "buddybox-xchat",
            webhook_id: "303",
          },
        });
      },
    });

    expect(result).toEqual({
      status: "changed",
      requestedPhase: "subscription",
      phases: [{
        phase: "subscription",
        status: "created",
        subscriptionId: "403",
        userId: "2244994945",
        webhookId: "303",
      }],
    });
    expect(posts).toEqual([{
      authorization: "Bearer user-token-secret",
      body: {
        event_type: "chat.received",
        filter: { user_id: "2244994945" },
        tag: "buddybox-xchat",
        webhook_id: "303",
      },
    }]);
  });

  test("subscription provisioning searches every bounded page before deciding to create", async () => {
    const requests: string[] = [];
    const result = await provisionXChat({
      phase: "subscription",
      env: baseEnv,
      fetcher: async (input) => {
        const url = new URL(String(input));
        requests.push(url.toString());
        if (url.pathname.endsWith("/users/me")) {
          return Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } });
        }
        if (url.pathname.endsWith("/webhooks")) {
          return Response.json({ data: [{ id: "303", url: baseEnv.X_WEBHOOK_URL, valid: true }] });
        }
        if (!url.searchParams.has("pagination_token")) {
          return Response.json({ data: [], meta: { next_token: "page-two" } });
        }
        expect(url.searchParams.get("pagination_token")).toBe("page-two");
        return Response.json({ data: [{
          subscription_id: "499",
          event_type: "chat.received",
          filter: { user_id: "2244994945" },
          tag: "buddybox-xchat",
          webhook_id: "303",
        }] });
      },
    });

    expect(result).toEqual({
      status: "ready",
      requestedPhase: "subscription",
      phases: [{
        phase: "subscription",
        status: "ready",
        subscriptionId: "499",
        userId: "2244994945",
        webhookId: "303",
      }],
    });
    expect(requests.filter((url) => url.includes("/activity/subscriptions"))).toHaveLength(2);
  });

  test("status inspects every phase without generating keys or creating X resources", async () => {
    const methods: string[] = [];
    let identityRegistrationCalls = 0;
    const result = await provisionXChat({
      phase: "status",
      env: baseEnv,
      identityRegistration: async () => {
        identityRegistrationCalls += 1;
        throw new Error("status must not set up identity");
      },
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        methods.push(request.method);
        if (request.url.endsWith("/2/users/me")) {
          return Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } });
        }
        if (request.url.endsWith("/2/webhooks")) {
          return Response.json({ meta: { result_count: 0 } });
        }
        return Response.json({ data: [] });
      },
    });

    expect(result).toEqual({
      status: "blocked",
      requestedPhase: "status",
      phases: [
        {
          phase: "identity",
          status: "blocked",
          code: "identity_setup_required",
          userId: "2244994945",
          username: "BuddyBoxAI",
          publicKeyVersions: [],
        },
        { phase: "webhook", status: "blocked", code: "webhook_missing", url: baseEnv.X_WEBHOOK_URL },
        { phase: "subscription", status: "blocked", code: "webhook_required" },
      ],
    });
    expect(identityRegistrationCalls).toBe(0);
    expect(methods.every((method) => method === "GET")).toBe(true);
  });

  test("all provisions webhook and subscription but never treats it as an identity setup phase", async () => {
    let webhookExists = false;
    let identityRegistrationCalls = 0;
    const result = await provisionXChat({
      phase: "all",
      env: baseEnv,
      identityRegistration: async () => {
        identityRegistrationCalls += 1;
        throw new Error("all must not set up identity");
      },
      identityVerification: async () => ({ publicKeyVersion: "7" }),
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/2/users/me")) {
          return Response.json({ data: { id: "2244994945", username: "BuddyBoxAI" } });
        }
        if (request.url.includes("/public_keys")) {
          return Response.json({ data: [{
            public_key_version: "7",
            public_key: "identity-public-key",
            signing_public_key: "signing-public-key",
            identity_public_key_signature: "binding-signature",
            juicebox_config: { realms: ["durable"] },
          }] });
        }
        if (request.url.endsWith("/2/webhooks")) {
          if (request.method === "POST") {
            webhookExists = true;
            return Response.json({ data: { id: "303", url: baseEnv.X_WEBHOOK_URL, valid: true } });
          }
          return Response.json({
            data: webhookExists ? [{ id: "303", url: baseEnv.X_WEBHOOK_URL, valid: true }] : [],
          });
        }
        if (request.method === "GET") return Response.json({ data: [], meta: { result_count: 0 } });
        return Response.json({
          data: {
            subscription: {
              subscription_id: "403",
              event_type: "chat.received",
              filter: { user_id: "2244994945" },
              tag: "buddybox-xchat",
              webhook_id: "303",
            },
          },
        });
      },
    });

    expect(result).toEqual({
      status: "changed",
      requestedPhase: "all",
      phases: [
        {
          phase: "identity",
          status: "ready",
          userId: "2244994945",
          username: "BuddyBoxAI",
          publicKeyVersions: ["7"],
        },
        {
          phase: "webhook",
          status: "created",
          webhookId: "303",
          url: baseEnv.X_WEBHOOK_URL,
        },
        {
          phase: "subscription",
          status: "created",
          subscriptionId: "403",
          userId: "2244994945",
          webhookId: "303",
        },
      ],
    });
    expect(identityRegistrationCalls).toBe(0);
  });
});
