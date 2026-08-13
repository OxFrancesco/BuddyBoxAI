import { describe, expect, test } from "bun:test";
import { createV1Handler, type GatewayDependencies } from "../src/http-v1";
import type { RuntimeHandle, RuntimeLocator } from "../src/runtime";

function ndjson(values: unknown[]): Response {
  return new Response(values.map((value) => `${JSON.stringify(value)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });
}

function harness(
  userId = "user_alice",
  sharedLocators: RuntimeLocator[] = [],
  authorityOverride: Partial<{ projectId: string; action: "admission" | "run" | "cancel" | "heartbeat" | "checkpoint" | "replacement" | "preview" | "artifact"; capability: string }> = {},
) {
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const runtime: RuntimeHandle = {
    async materialize(value) {
      calls.push({ operation: "materialize", value });
      return { commitSha: "abc123", restored: false };
    },
    async run(value) {
      calls.push({ operation: "run", value });
      return ndjson([
        { type: "accepted", runId: value.runId, prompt: "private prompt", token: "secret" },
        { type: "tool_execution_start", toolName: "bash", args: { command: "printenv" } },
        { type: "tool_execution_end", toolName: "bash", isError: false, output: "secret output" },
        { type: "outcome", outcome: "succeeded", summary: "Verified with Bun", sessionFile: "/secret" },
      ]);
    },
    async cancel(runId) {
      calls.push({ operation: "cancel", value: runId });
      return { accepted: true };
    },
    async heartbeat(runId) {
      calls.push({ operation: "heartbeat", value: runId });
      return { runId, state: "running", lastEventSequence: 7, observedAt: "2026-08-13T12:00:00.000Z" };
    },
    async createCheckpoint() {
      calls.push({ operation: "checkpoint" });
      return { bytes: new Uint8Array([1, 2, 3]), sha256: "checkpoint-sha" };
    },
    async restoreCheckpoint(bytes) {
      calls.push({ operation: "restore", value: [...bytes] });
      return { commitSha: "def456", sessionCount: 1 };
    },
    async startPreview(value) {
      calls.push({ operation: "preview", value });
      return { url: "https://preview.example", port: value.port };
    },
    async captureScreenshot(value) {
      calls.push({ operation: "screenshot", value });
      return { bytes: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" };
    },
    async readArtifact(path) {
      calls.push({ operation: "artifact", value: path });
      return { bytes: new TextEncoder().encode("artifact"), mediaType: "text/plain" };
    },
    async destroy() {
      calls.push({ operation: "destroy" });
    },
  };
  const locators = sharedLocators;
  const objects = new Map<string, Uint8Array>();
  const dependencies: GatewayDependencies = {
    authenticate: async (request) => {
      if (request.headers.get("authorization") !== "Bearer valid") return null;
      const path = new URL(request.url).pathname;
      const projectId = /^\/v1\/projects\/([^/]+)/.exec(path)?.[1] ?? "unknown";
      const action = path.endsWith("/admission") ? "admission"
        : path.endsWith("/runs") ? "run"
        : path.endsWith("/cancel") ? "cancel"
        : path.endsWith("/heartbeat") ? "heartbeat"
        : path.endsWith("/checkpoints") ? "checkpoint"
        : path.endsWith("/replacement") || path.endsWith("/teardown") ? "replacement"
        : path.endsWith("/previews") ? "preview"
        : "artifact";
      return { userId, projectId, action, capability: "valid", ...authorityOverride } as const;
    },
    runtimeFor(locator) {
      locators.push(locator);
      return runtime;
    },
    checkpoints: {
      async put(key, bytes) {
        objects.set(key, bytes);
      },
      async get(key) {
        return objects.get(key) ?? null;
      },
    },
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    randomId: () => "checkpoint-fixed",
  };
  return { calls, handler: createV1Handler(dependencies), locators, objects };
}

function api(path: string, init?: RequestInit) {
  return new Request(`https://gateway.test${path}`, {
    ...init,
    headers: { authorization: "Bearer valid", "content-type": "application/json", ...init?.headers },
  });
}

describe("v1 gateway HTTP seam", () => {
  test("rejects callers without trusted authority", async () => {
    const { handler } = harness();
    const response = await handler.fetch(new Request("https://gateway.test/v1/projects/project_one/heartbeat"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Trusted gateway authority is required.", retryable: false },
      protocolVersion: "2026-08-13",
    });
  });

  test("isolates the same project id by authenticated User", async () => {
    const locators: RuntimeLocator[] = [];
    const { handler } = harness("user_alice", locators);
    await handler.fetch(api("/v1/projects/project_same/generations/1/heartbeat"));
    const bobHandler = harness("user_bob", locators).handler;
    await bobHandler.fetch(api("/v1/projects/project_same/generations/1/heartbeat"));
    expect(locators).toHaveLength(2);
    expect(locators[0]?.sandboxId).toMatch(/^ichef-1-[a-f0-9]{24}$/);
    expect(locators[1]?.sandboxId).toMatch(/^ichef-1-[a-f0-9]{24}$/);
    expect(locators[0]?.sandboxId).not.toBe(locators[1]?.sandboxId);
  });

  test("rejects a valid capability replayed against another Project or operation", async () => {
    const wrongProject = harness("user_alice", [], { projectId: "project_two" });
    const projectResponse = await wrongProject.handler.fetch(api("/v1/projects/project_one/generations/1/heartbeat"));
    expect(projectResponse.status).toBe(401);
    expect(wrongProject.calls).toEqual([]);

    const wrongAction = harness("user_alice", [], { action: "artifact" });
    const actionResponse = await wrongAction.handler.fetch(api("/v1/projects/project_one/generations/1/heartbeat"));
    expect(actionResponse.status).toBe(401);
    expect(wrongAction.calls).toEqual([]);
  });

  test("rejects a nested Run capability that differs from the authenticated authority", async () => {
    const { handler, calls } = harness();
    const response = await handler.fetch(api("/v1/projects/project_one/generations/1/runs", {
      method: "POST",
      body: JSON.stringify({
        runId: "run_one",
        prompt: "Try to swap authority",
        provider: "openai-codex",
        model: "gpt-5.6",
        capability: "another-valid-looking-capability",
      }),
    }));
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("admits a bounded repository materialization", async () => {
    const { handler, calls } = harness();
    const response = await handler.fetch(
      api("/v1/projects/project_one/generations/1/admission", {
        method: "POST",
        body: JSON.stringify({ repository: "owner/site", branch: "main", capability: "valid" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      protocolVersion: "2026-08-13",
      sandboxGeneration: 1,
      commitSha: "abc123",
      restored: false,
    });
    expect(calls[0]).toEqual({
      operation: "materialize",
      value: { repository: "owner/site", branch: "main", capability: "valid" },
    });
  });

  test("streams only sequenced, sanitized Run events", async () => {
    const { handler } = harness();
    const response = await handler.fetch(
      api("/v1/projects/project_one/generations/1/runs", {
        method: "POST",
        body: JSON.stringify({
          runId: "run_one",
          prompt: "Make the hero warmer",
          provider: "openrouter",
          model: "openai/gpt-5.6-sol",
          capability: "valid",
        }),
      }),
    );
    expect(response.status).toBe(202);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      {
        protocolVersion: "2026-08-13",
        sequence: 1,
        type: "run.accepted",
        runId: "run_one",
        at: "2026-08-13T12:00:00.000Z",
      },
      {
        protocolVersion: "2026-08-13",
        sequence: 2,
        type: "tool.started",
        runId: "run_one",
        at: "2026-08-13T12:00:00.000Z",
        tool: "bash",
      },
      {
        protocolVersion: "2026-08-13",
        sequence: 3,
        type: "tool.finished",
        runId: "run_one",
        at: "2026-08-13T12:00:00.000Z",
        tool: "bash",
        status: "succeeded",
      },
      {
        protocolVersion: "2026-08-13",
        sequence: 4,
        type: "run.outcome",
        runId: "run_one",
        at: "2026-08-13T12:00:00.000Z",
        outcome: "succeeded",
        summary: "Verified with Bun",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("printenv");
  });

  test("rejects prompts beyond the protocol limit before starting Pi", async () => {
    const { handler, calls } = harness();
    const response = await handler.fetch(
      api("/v1/projects/project_one/generations/1/runs", {
        method: "POST",
        body: JSON.stringify({
          runId: "run_one",
          prompt: "x".repeat(32_001),
          provider: "openrouter",
          model: "openai/gpt-5.6-sol",
          capability: "valid",
        }),
      }),
    );
    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
  });

  test("checkpoints, replaces, restores, and destroys the old Sandbox", async () => {
    const { handler, calls, objects } = harness();
    const checkpointResponse = await handler.fetch(
      api("/v1/projects/project_one/generations/1/checkpoints", { method: "POST", body: "{}" }),
    );
    expect(checkpointResponse.status).toBe(201);
    const checkpoint = (await checkpointResponse.json()) as { checkpointId: string };
    expect(checkpoint.checkpointId).toBe("checkpoint-fixed");
    expect(objects.get("user_alice/project_one/checkpoint-fixed")).toEqual(new Uint8Array([1, 2, 3]));

    const replacement = await handler.fetch(
      api("/v1/projects/project_one/generations/1/replacement", {
        method: "POST",
        body: JSON.stringify({ checkpointId: checkpoint.checkpointId, nextGeneration: 2 }),
      }),
    );
    expect(replacement.status).toBe(201);
    expect(await replacement.json()).toEqual({
      protocolVersion: "2026-08-13",
      sandboxGeneration: 2,
      resumedFromCheckpoint: "checkpoint-fixed",
      commitSha: "def456",
      sessionCount: 1,
    });
    expect(calls.map((call) => call.operation)).toEqual(["checkpoint", "restore", "destroy"]);
  });

  test("supports cancellation and heartbeat", async () => {
    const { handler } = harness();
    const cancelled = await handler.fetch(
      api("/v1/projects/project_one/generations/1/runs/run_one/cancel", { method: "POST", body: "{}" }),
    );
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toEqual({ protocolVersion: "2026-08-13", runId: "run_one", accepted: true });
    const heartbeat = await handler.fetch(
      api("/v1/projects/project_one/generations/1/runs/run_one/heartbeat"),
    );
    expect(await heartbeat.json()).toEqual({
      protocolVersion: "2026-08-13",
      runId: "run_one",
      state: "running",
      lastEventSequence: 7,
      observedAt: "2026-08-13T12:00:00.000Z",
    });
  });
});
