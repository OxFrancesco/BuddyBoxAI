import { describe, expect, test } from "bun:test";

import { issueCapability, verifyCapability } from "./capability";

describe("gateway capabilities", () => {
  test("round-trips an action-bound short-lived capability", async () => {
    const token = await issueCapability({ sub: "user_1", projectId: "project_1", sandboxGeneration: 4, action: "run", runId: "run_1", exp: 1_800_000_120 }, "secret", 1_800_000_000);
    expect(await verifyCapability(token, "secret", 1_800_000_001)).toMatchObject({ sub: "user_1", projectId: "project_1", sandboxGeneration: 4, action: "run", runId: "run_1" });
  });

  test("fails closed for expiry and tampering", async () => {
    const token = await issueCapability({ sub: "user_1", projectId: "project_1", sandboxGeneration: 1, action: "run", runId: "run_1", exp: 1_800_000_010 }, "secret", 1_800_000_000);
    expect(await verifyCapability(token, "secret", 1_800_000_011)).toBeNull();
    expect(await verifyCapability(`${token}x`, "secret", 1_800_000_001)).toBeNull();
  });

  test("rejects capabilities missing generation or action-specific bindings", async () => {
    await expect(issueCapability({ sub: "user_1", projectId: "project_1", action: "run", exp: 1_800_000_120 } as never, "secret", 1_800_000_000)).rejects.toThrow("sandboxGeneration");
    await expect(issueCapability({ sub: "user_1", projectId: "project_1", sandboxGeneration: 1, action: "run", exp: 1_800_000_120 } as never, "secret", 1_800_000_000)).rejects.toThrow("runId");
    await expect(issueCapability({ sub: "user_1", projectId: "project_1", sandboxGeneration: 1, action: "artifact_read", exp: 1_800_000_120 }, "secret", 1_800_000_000)).resolves.toBeString();
    await expect(issueCapability({ sub: "user_1", projectId: "project_1", sandboxGeneration: 1, action: "deploy", exp: 1_800_000_120 } as never, "secret", 1_800_000_000)).rejects.toThrow("releaseId");
  });

  test("round-trips an exact release and artifact-manifest deployment authority", async () => {
    const token = await issueCapability({
      sub: "user_1",
      projectId: "project_1",
      sandboxGeneration: 7,
      action: "deploy",
      releaseId: "release_1",
      sourceRunId: "run_1",
      commitSha: "a".repeat(40),
      hostname: "project-buddybox-sites.buddytools.org",
      artifactManifestDigest: "b".repeat(64),
      exp: 1_800_000_120,
    }, "secret", 1_800_000_000);
    expect(await verifyCapability(token, "secret", 1_800_000_001)).toMatchObject({
      sandboxGeneration: 7,
      action: "deploy",
      releaseId: "release_1",
      sourceRunId: "run_1",
      artifactManifestDigest: "b".repeat(64),
    });
  });
});
