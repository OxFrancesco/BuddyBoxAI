import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./providerOAuthStore.ts": () => import("./providerOAuthStore"),
  "./users.ts": () => import("./users"),
};

function identity(subject: string) {
  return { subject, tokenIdentifier: `https://issuer.ichef.test|${subject}` };
}

describe("provider OAuth storage", () => {
  test("binds an expiring OAuth state to one User and consumes it once", async () => {
    const t = convexTest(schema, modules);
    const user = await t.withIdentity(identity("oauth-user")).mutation(api.users.syncCurrent, {});
    const expiresAt = Date.now() + 5 * 60_000;
    await t.mutation(internal.providerOAuthStore.createState, {
      ownerId: user._id,
      provider: "github",
      stateHash: "state-hash",
      codeVerifierCiphertext: "v1.encrypted.verifier",
      redirectUri: "https://control.example/v1/oauth/github/callback",
      expiresAt,
    });
    expect(await t.mutation(internal.providerOAuthStore.consumeState, {
      provider: "github",
      stateHash: "state-hash",
    })).toEqual({
      ownerId: user._id,
      codeVerifierCiphertext: "v1.encrypted.verifier",
      redirectUri: "https://control.example/v1/oauth/github/callback",
    });
    await expect(t.mutation(internal.providerOAuthStore.consumeState, {
      provider: "github",
      stateHash: "state-hash",
    })).rejects.toThrow("already used");
    await expect(t.mutation(internal.providerOAuthStore.consumeState, {
      provider: "cloudflare",
      stateHash: "state-hash",
    })).rejects.toThrow("already used");
  });

  test("only marks a connection ready after encrypted credentials and verified identity are stored", async () => {
    const t = convexTest(schema, modules);
    const user = await t.withIdentity(identity("connected-user")).mutation(api.users.syncCurrent, {});
    const connectionId = await t.mutation(internal.providerOAuthStore.finalizeConnection, {
      ownerId: user._id,
      provider: "github",
      accessTokenCiphertext: "v1.encrypted.access",
      externalAccountRefCiphertext: "v1.encrypted.installation",
      tokenType: "bearer",
      scopes: ["contents:write"],
      externalAccountIdHash: "account-hash",
      accountLabel: "octocat",
    });
    const connection = await t.run(async (ctx) => ctx.db.get(connectionId));
    const credential = await t.run(async (ctx) => ctx.db.query("providerCredentials").collect());
    expect(connection?.status).toBe("connected");
    expect(connection?.accountLabel).toBe("octocat");
    expect(credential).toHaveLength(1);
    expect(JSON.stringify(credential[0])).not.toContain("octocat-token");

    await t.mutation(internal.providerOAuthStore.revokeConnection, {
      ownerId: user._id,
      provider: "github",
    });
    expect((await t.run(async (ctx) => ctx.db.get(connectionId)))?.status).toBe("revoked");
    expect(await t.run(async (ctx) => ctx.db.query("providerCredentials").collect())).toHaveLength(0);
  });

  test("scopes a GitHub installation binding to its active owner and project", async () => {
    const t = convexTest(schema, modules);
    const user = await t.withIdentity(identity("github-owner")).mutation(api.users.syncCurrent, {});
    const other = await t.withIdentity(identity("other-owner")).mutation(api.users.syncCurrent, {});
    const connectionId = await t.mutation(internal.providerOAuthStore.finalizeConnection, {
      ownerId: user._id,
      provider: "github",
      accessTokenCiphertext: "v1.encrypted.access",
      externalAccountRefCiphertext: "v1.encrypted.installation",
      tokenType: "bearer",
      scopes: [],
      externalAccountIdHash: "github-account-hash",
      accountLabel: "octocat",
    });
    const projectId = await t.run(async (ctx) => ctx.db.insert("projects", {
      ownerId: user._id,
      name: "Scoped app",
      slug: "scoped-app",
      status: "active",
      githubRepositoryId: "12345",
      githubRepositoryFullName: "octocat/scoped-app",
      defaultBranch: "main",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    expect(await t.query(internal.providerOAuthStore.loadGitHubInstallationBinding, {
      ownerId: user._id,
      projectId,
    })).toEqual({
      status: "ok",
      externalAccountRefCiphertext: "v1.encrypted.installation",
      repositoryId: "12345",
      repositoryFullName: "octocat/scoped-app",
    });
    await expect(t.query(internal.providerOAuthStore.loadGitHubInstallationBinding, {
      ownerId: other._id,
      projectId,
    })).rejects.toThrow("Credential scope is invalid");
    await t.mutation(internal.providerOAuthStore.revokeConnection, { ownerId: user._id, provider: "github" });
    expect(await t.query(internal.providerOAuthStore.loadGitHubInstallationBinding, {
      ownerId: user._id,
      projectId,
    })).toEqual({ status: "reauth" });
    expect(connectionId).toBeTruthy();
  });
});
