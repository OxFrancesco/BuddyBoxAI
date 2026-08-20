import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";

import { createCredentialBroker, testables } from "./index";

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

  test("signs an App JWT from GitHub's RSA private-key PEM format", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = await testables.createGitHubAppJwt({
      appId: "1234",
      privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      nowSeconds: 1_800_000_000,
    });
    const [header, payload, signature] = token.split(".") as [string, string, string];

    expect(verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    )).toBe(true);
  });

  test("rejects a lengthless Codex body that exceeds the streaming limit", async () => {
    let codexCalled = false;
    const accountPayload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account_123" },
    })).toString("base64url");
    const handler = createCredentialBroker({
      fetcher: async (input) => {
        const url = String(input);
        if (url === "https://convex.example/v1/credentials/codex") {
          return Response.json({ ok: true, result: {
            status: "ok",
            accessToken: `header.${accountPayload}.signature`,
            expiresAt: Date.now() + 60_000,
          } });
        }
        codexCalled = true;
        return new Response(null, { status: 200 });
      },
    });
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    const request = new Request(
      "https://broker.example/v1/egress/openai-codex/backend-api/codex/responses",
      {
        method: "POST",
        headers: { "x-ichef-run-capability": "run-capability" },
        body: new Blob([oversized]).stream(),
      },
    );
    expect(request.headers.get("content-length")).toBeNull();

    const response = await handler.fetch(request, githubEnv());

    expect(response.status).toBe(413);
    expect(codexCalled).toBe(false);
  });
});

describe("GitHub egress", () => {
  test("injects a repository-scoped installation token for Git smart HTTP", async () => {
    const upstream: Array<{ url: string; authorization: string; cookie: string | null }> = [];
    const handler = createCredentialBroker({
      now: () => 1_800_000_000_000,
      signAppJwt: async () => "app-jwt",
      fetcher: async (input, init) => {
        const url = String(input);
        if (url === "https://convex.example/v1/credentials/github") {
          return Response.json({ ok: true, result: {
            status: "ok",
            installationId: 42,
            repositoryId: 77,
            repositoryFullName: "octocat/menu",
          } });
        }
        if (url === "https://api.github.com/app/installations/42/access_tokens") {
          expect(JSON.parse(String(init?.body))).toEqual({
            repository_ids: [77],
            permissions: { contents: "write", metadata: "read" },
          });
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer app-jwt");
          return Response.json({ token: "ghs_short_lived", expires_at: "2027-01-15T08:59:00.000Z" });
        }
        upstream.push({
          url,
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          cookie: new Headers(init?.headers).get("cookie"),
        });
        return new Response("git-response", { headers: { "content-type": "application/x-git-upload-pack-result" } });
      },
    });
    const response = await handler.fetch(new Request(
      "https://broker.example/v1/egress/github/octocat/menu.git/info/refs?service=git-upload-pack",
      { headers: { authorization: "Bearer run-capability", cookie: "sandbox-secret" } },
    ), githubEnv());

    expect(response.status).toBe(200);
    expect(upstream).toEqual([{
      url: "https://github.com/octocat/menu.git/info/refs?service=git-upload-pack",
      authorization: `Basic ${btoa("x-access-token:ghs_short_lived")}`,
      cookie: null,
    }]);
  });

  test("fails closed before minting when the requested repository is not project-bound", async () => {
    let minted = false;
    const handler = createCredentialBroker({
      now: () => 1_800_000_000_000,
      signAppJwt: async () => "app-jwt",
      fetcher: async (input) => {
        const url = String(input);
        if (url === "https://convex.example/v1/credentials/github") {
          return Response.json({ ok: true, result: {
            status: "ok", installationId: 42, repositoryId: 77, repositoryFullName: "octocat/menu",
          } });
        }
        minted = true;
        return Response.json({});
      },
    });
    const response = await handler.fetch(new Request(
      "https://broker.example/v1/egress/github/octocat/other.git/info/refs?service=git-upload-pack",
      { headers: { authorization: "Bearer run-capability" } },
    ), githubEnv());

    expect(response.status).toBe(404);
    expect(minted).toBe(false);
  });

  test("does not follow GitHub redirects with an injected credential", async () => {
    const handler = createCredentialBroker({
      now: () => 1_800_000_000_000,
      signAppJwt: async () => "app-jwt",
      fetcher: async (input) => {
        const url = String(input);
        if (url === "https://convex.example/v1/credentials/github") {
          return Response.json({ ok: true, result: {
            status: "ok", installationId: 42, repositoryId: 77, repositoryFullName: "octocat/menu",
          } });
        }
        if (url.includes("/access_tokens")) {
          return Response.json({ token: "ghs_short_lived", expires_at: "2027-01-15T08:59:00.000Z" });
        }
        return new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } });
      },
    });
    const response = await handler.fetch(new Request(
      "https://broker.example/v1/egress/github/api/repos/octocat/menu/contents/package.json",
      { headers: { authorization: "Bearer run-capability" } },
    ), githubEnv());

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  });
});

function githubEnv() {
  return {
    CONTROL_PLANE: {
      fetch: async () => Response.json({ userId: "user_1", projectId: "project_1", action: "run" }),
    },
    CONVEX_CREDENTIAL_URL: "https://convex.example/v1/credentials/codex",
    CONVEX_GITHUB_CREDENTIAL_URL: "https://convex.example/v1/credentials/github",
    ICHEF_CREDENTIAL_BROKER_SECRET: "broker-secret-at-least-thirty-two-characters",
    GITHUB_APP_ID: "1234",
    GITHUB_APP_PRIVATE_KEY: "test-private-key",
  } as never;
}
