import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import {
  GitHubAppProvisioner,
  createGitHubAppJwt,
  githubInstallationUrl,
} from "./github";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function decodePayload(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as {
    iss: string;
    iat: number;
    exp: number;
  };
}

describe("GitHub App provisioning", () => {
  test("mints a short-lived App JWT without embedding its private key", () => {
    const token = createGitHubAppJwt({ appId: "1234", privateKeyPem: pem, now: 1_800_000_000 });
    const payload = decodePayload(token);

    expect(payload.iss).toBe("1234");
    expect(payload.iat).toBe(1_799_999_940);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(token).not.toContain("PRIVATE KEY");
  });

  test("creates a personal repository with the connected User access token", async () => {
    const requests: Array<{ url: string; authorization: string; body: unknown }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ id: 77, full_name: "chef/first-dish", html_url: "https://github.com/chef/first-dish", default_branch: "main" });
    };
    const github = new GitHubAppProvisioner({ appId: "1234", privateKeyPem: pem, fetcher });

    const repo = await github.createOwnedRepository({
      installationId: 42,
      owner: { kind: "user", login: "chef" },
      userAccessToken: "ghu_ephemeral",
      name: "first-dish",
      description: "Created by iChef",
      visibility: "private",
    });

    expect(repo.fullName).toBe("chef/first-dish");
    expect(requests[0]).toMatchObject({
      url: "https://api.github.com/user/repos",
      authorization: "Bearer ghu_ephemeral",
    });
    expect(requests[0]?.body).toMatchObject({ name: "first-dish", private: true, auto_init: false });
  });

  test("creates an organization repository with a short-lived installation token", async () => {
    const requests: Array<{ url: string; authorization: string; body: unknown }> = [];
    const github = new GitHubAppProvisioner({
      appId: "1234",
      privateKeyPem: pem,
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "", body: init?.body ? JSON.parse(String(init.body)) : null });
        return url.endsWith("/access_tokens")
          ? Response.json({ token: "ghs_ephemeral", expires_at: "2026-08-13T22:00:00Z" })
          : Response.json({ id: 88, full_name: "chef-org/menu", html_url: "https://github.com/chef-org/menu", default_branch: "main" });
      },
    });

    await github.createOwnedRepository({
      installationId: 42,
      owner: { kind: "organization", login: "chef-org" },
      name: "menu",
      visibility: "public",
    });

    expect(requests[0]?.body).toEqual({ permissions: { administration: "write", contents: "write", metadata: "read" } });
    expect(requests[1]).toMatchObject({ url: "https://api.github.com/orgs/chef-org/repos", authorization: "Bearer ghs_ephemeral" });
  });

  test("rejects unsafe repository names before requesting any token", async () => {
    let called = false;
    const github = new GitHubAppProvisioner({
      appId: "1234",
      privateKeyPem: pem,
      fetcher: async () => {
        called = true;
        return Response.json({});
      },
    });

    await expect(
      github.createOwnedRepository({
        installationId: 42,
        owner: { kind: "organization", login: "chef-org" },
        name: "../../steal",
        visibility: "public",
      }),
    ).rejects.toThrow("repository name");
    expect(called).toBe(false);
  });

  test("builds the least-privilege installation URL", () => {
    expect(githubInstallationUrl("ichef-agent", "state-token")).toBe(
      "https://github.com/apps/ichef-agent/installations/new?state=state-token",
    );
  });
});
