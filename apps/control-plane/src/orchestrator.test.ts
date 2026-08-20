import { describe, expect, test } from "bun:test";

import { verifyCapability } from "./capability";
import { createHandler } from "./index";

const gatewaySecret = "gateway-secret-that-is-long-enough";
const orchestratorSecret = "orchestrator-secret-that-is-long-enough";

function orchestrationRequest(body: unknown, secret = orchestratorSecret) {
  return new Request("https://ichef.buddytools.org/v1/orchestration/runs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function command() {
  return {
    ownerId: "user_1",
    projectId: "project_1",
    runId: "run_1",
    sandboxGeneration: 1,
    repository: "owner/site",
    branch: "main",
    prompt: "Build the first verified version.",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    verificationCommands: ["bun test", "bun run build"],
  };
}

describe("production Run orchestration", () => {
  test("materializes source and starts Pi with distinct exact capabilities", async () => {
    const calls: Array<{ url: URL; authorization: string; body: Record<string, unknown> }> = [];
    const gateway = {
      async fetch(request: Request) {
        const authorization = request.headers.get("authorization") ?? "";
        const body = await request.json<Record<string, unknown>>();
        calls.push({ url: new URL(request.url), authorization, body });
        const capability = await verifyCapability(
          authorization.replace(/^Bearer /, ""),
          gatewaySecret,
          1_800_000_001,
        );
        expect(body.capability).toBe(authorization.slice(7));
        if (calls.length === 1) {
          expect(capability).toMatchObject({
            sub: "user_1",
            projectId: "project_1",
            sandboxGeneration: 1,
            action: "admission",
          });
          return Response.json({ protocolVersion: "2026-08-13", commitSha: "a".repeat(40), restored: false }, { status: 201 });
        }
        expect(capability).toMatchObject({
          sub: "user_1",
          projectId: "project_1",
          sandboxGeneration: 1,
          action: "run",
          runId: "run_1",
        });
        return new Response(
          `${JSON.stringify({ protocolVersion: "2026-08-13", sequence: 0, type: "run.accepted", runId: "run_1", at: "2026-08-20T10:00:00.000Z" })}\n`,
          { status: 202, headers: { "content-type": "application/x-ndjson" } },
        );
      },
    };
    const handler = createHandler(() => 1_800_000_000);
    const response = await handler.fetch(orchestrationRequest(command()), {
      AGENT_GATEWAY: gateway,
      GATEWAY_CAPABILITY_SECRET: gatewaySecret,
      ICHEF_ORCHESTRATOR_SECRET: orchestratorSecret,
    } as never);

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/v1/projects/project_1/generations/1/admission",
      "/v1/projects/project_1/generations/1/runs",
    ]);
    expect(await response.text()).toContain('"type":"run.accepted"');
  });

  test("requires the dedicated orchestrator secret", async () => {
    const handler = createHandler(() => 1_800_000_000);
    const response = await handler.fetch(orchestrationRequest(command(), "wrong"), {
      AGENT_GATEWAY: { fetch: () => Promise.resolve(new Response(null, { status: 500 })) },
      GATEWAY_CAPABILITY_SECRET: gatewaySecret,
      ICHEF_ORCHESTRATOR_SECRET: orchestratorSecret,
    } as never);
    expect(response.status).toBe(401);
  });

  test("does not start Pi when repository admission fails", async () => {
    let calls = 0;
    const handler = createHandler(() => 1_800_000_000);
    const response = await handler.fetch(orchestrationRequest(command()), {
      AGENT_GATEWAY: {
        fetch: () => {
          calls += 1;
          return Promise.resolve(Response.json({ error: { code: "runtime_unavailable" } }, { status: 503 }));
        },
      },
      GATEWAY_CAPABILITY_SECRET: gatewaySecret,
      ICHEF_ORCHESTRATOR_SECRET: orchestratorSecret,
    } as never);
    expect(response.status).toBe(503);
    expect(calls).toBe(1);
  });
});
