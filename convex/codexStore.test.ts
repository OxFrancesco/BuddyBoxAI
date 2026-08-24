import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./codexStore.ts": () => import("./codexStore"),
  "./users.ts": () => import("./users"),
};

describe("Codex connection CAS storage", () => {
  test("serializes credential refreshes and deletes locally before disconnect returns", async () => {
    const identity = { subject: "codex-user", tokenIdentifier: "https://issuer.buddybox.test|codex-user" };
    const t = convexTest(schema, modules);
    const user = await t.withIdentity(identity).mutation(api.users.syncCurrent, {});
    expect(await t.mutation(internal.codexStore.commit, {
      ownerId: user._id,
      expectedRevision: null,
      valueJson: JSON.stringify({ session: { status: "pending" } }),
    })).toBe(true);
    expect(await t.mutation(internal.codexStore.commit, {
      ownerId: user._id,
      expectedRevision: null,
      valueJson: JSON.stringify({ stale: true }),
    })).toBe(false);
    expect(await t.mutation(internal.codexStore.commit, {
      ownerId: user._id,
      expectedRevision: 1,
      valueJson: JSON.stringify({ credential: { status: "connected" } }),
    })).toBe(true);
    expect((await t.query(internal.codexStore.load, { ownerId: user._id }))?.revision).toBe(2);
    expect(await t.mutation(internal.codexStore.commit, {
      ownerId: user._id,
      expectedRevision: 2,
      valueJson: null,
    })).toBe(true);
    expect(await t.query(internal.codexStore.load, { ownerId: user._id })).toBeNull();
  });
});
