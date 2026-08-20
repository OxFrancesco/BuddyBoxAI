import { expect, test } from "bun:test";
import { convexTest } from "convex-test";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./connections.ts": () => import("./connections"),
  "./projects.ts": () => import("./projects"),
  "./users.ts": () => import("./users"),
};

test("project readiness rejects expired or mismatched provider credentials", async () => {
  const t = convexTest(schema, modules);
  const authenticated = t.withIdentity({
    subject: "readiness-user",
    tokenIdentifier: "https://issuer.ichef.test|readiness-user",
  });
  const user = await authenticated.mutation(api.users.syncCurrent, {});
  const now = Date.now();
  await t.run((ctx) => ctx.db.insert("xchatConnections", {
    ownerId: user._id,
    senderIdHash: "readiness-sender",
    providerConversationIdHash: "readiness-conversation",
    maskedSender: "X Chat user",
    status: "verified",
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  }));
  await t.mutation(internal.connections.setServiceConnection, {
    ownerId: user._id,
    provider: "chatgpt",
    status: "connected",
    scopes: ["codex:responses"],
  });

  const connections = new Map<"github" | "convex", Id<"serviceConnections">>();
  const credentials = new Map<"github" | "convex", Id<"providerCredentials">>();
  for (const provider of ["github", "convex"] as const) {
    const externalAccountIdHash = `${provider}-account-hash`;
    const credentialId = await t.run((ctx) => ctx.db.insert("providerCredentials", {
      ownerId: user._id,
      provider,
      accessTokenCiphertext: `${provider}-encrypted-access`,
      tokenType: "bearer",
      scopes: [],
      externalAccountIdHash,
      expiresAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    }));
    const connectionId = await t.mutation(internal.connections.setServiceConnection, {
      ownerId: user._id,
      provider,
      status: "connected",
      scopes: [],
      externalAccountIdHash,
      credentialRef: String(credentialId),
      expiresAt: now + 60_000,
    });
    credentials.set(provider, credentialId);
    connections.set(provider, connectionId);
  }

  expect((await authenticated.query(api.connections.listMine, {})).readiness)
    .toEqual({ ready: true, missing: [] });

  await t.run((ctx) => ctx.db.patch(connections.get("github")!, {
    expiresAt: now - 1,
  }));
  expect((await authenticated.query(api.connections.listMine, {})).readiness)
    .toEqual({ ready: false, missing: ["github"] });

  await t.run((ctx) => ctx.db.patch(connections.get("github") as never, {
    expiresAt: now + 60_000,
    credentialRef: String(credentials.get("convex")!),
  }));
  expect((await authenticated.query(api.connections.listMine, {})).readiness)
    .toEqual({ ready: false, missing: ["github"] });

  await t.run((ctx) => ctx.db.patch(connections.get("github")!, {
    credentialRef: String(credentials.get("github")!),
  }));
  await t.run((ctx) => ctx.db.patch(credentials.get("convex")!, {
    expiresAt: now - 1,
  }));
  expect((await authenticated.query(api.connections.listMine, {})).readiness)
    .toEqual({ ready: false, missing: ["convex"] });

  await expect(authenticated.mutation(api.projects.propose, {
    name: "Blocked proposal",
    brief: "This must not pass with an expired backend credential.",
    planJson: "{}",
    payloadHash: "expired-provider-binding",
    expiresAt: now + 60_000,
  })).rejects.toThrow("Missing required connections: convex");
});
