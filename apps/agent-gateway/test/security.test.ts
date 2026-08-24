import { describe, expect, test } from "bun:test";
import { sanitizeEvent } from "../src/event-stream";
import { repositoryMaterialization } from "../src/repository";
import { checkpointKey, deriveSandboxId } from "../src/runtime";

describe("project isolation and credential boundary", () => {
  test("derives distinct Sandbox and checkpoint identities for different Users", async () => {
    const alice = await deriveSandboxId("user_alice", "project_shared", 1);
    const bob = await deriveSandboxId("user_bob", "project_shared", 1);
    expect(alice).not.toBe(bob);
    expect(checkpointKey("user_alice", "project_shared", "checkpoint_one")).toBe(
      "user_alice/project_shared/checkpoint_one",
    );
    expect(checkpointKey("user_bob", "project_shared", "checkpoint_one")).not.toBe(
      "user_alice/project_shared/checkpoint_one",
    );
  });

  test("keeps the short-lived GitHub capability out of commands and remotes", () => {
    const materialization = repositoryMaterialization({
      repository: "owner/site",
      branch: "main",
      capability: "short-lived-github-capability",
    });
    expect(materialization.command).not.toContain("short-lived-github-capability");
    expect(materialization.remote).not.toContain("short-lived-github-capability");
    expect(materialization.env).toEqual({ BUDDYBOX_RUN_CAPABILITY: "short-lived-github-capability" });
  });

  test("redacts credential-shaped text even from an allowed outcome summary", () => {
    const event = sanitizeEvent(
      {
        type: "outcome",
        outcome: "failed",
        summary: "Authorization: Bearer private-value token=another-private-value",
      },
      "run_one",
      1,
      () => new Date("2026-08-13T12:00:00.000Z"),
    );
    expect(JSON.stringify(event)).not.toContain("private-value");
    expect(JSON.stringify(event)).toContain("[REDACTED]");
  });
});
