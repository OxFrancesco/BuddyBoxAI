import { issueCapability } from "./capability";

const MAX_BODY_BYTES = 96 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;

export interface OrchestratorEnv {
  AGENT_GATEWAY: Fetcher;
  GATEWAY_CAPABILITY_SECRET: string;
  BUDDYBOX_ORCHESTRATOR_SECRET: string;
}

interface RunCommand {
  ownerId: string;
  projectId: string;
  runId: string;
  sandboxGeneration: number;
  repository: string;
  branch: string;
  prompt: string;
  provider: "openai-codex" | "openrouter";
  model: string;
  verificationCommands?: string[];
}

export async function orchestrateRun(
  request: Request,
  env: OrchestratorEnv,
  now: () => number,
): Promise<Response> {
  if (!await authorized(request, env.BUDDYBOX_ORCHESTRATOR_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return error("too_large", 413);
  }
  let command: RunCommand;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return error("too_large", 413);
    command = parseRunCommand(JSON.parse(raw));
  } catch {
    return error("bad_request", 400);
  }

  const issuedAt = now();
  const common = {
    sub: command.ownerId,
    projectId: command.projectId,
    sandboxGeneration: command.sandboxGeneration,
    exp: issuedAt + 180,
  } as const;
  const admissionCapability = await issueCapability(
    { ...common, action: "admission" },
    env.GATEWAY_CAPABILITY_SECRET,
    issuedAt,
  );
  const root = `https://agent-gateway.internal/v1/projects/${encodeURIComponent(command.projectId)}/generations/${command.sandboxGeneration}`;
  const admission = await env.AGENT_GATEWAY.fetch(new Request(`${root}/admission`, {
    method: "POST",
    headers: bearerJson(admissionCapability),
    body: JSON.stringify({
      repository: command.repository,
      branch: command.branch,
      capability: admissionCapability,
    }),
  }));
  if (!admission.ok) return gatewayFailure(admission.status);

  const runCapability = await issueCapability(
    { ...common, action: "run", runId: command.runId },
    env.GATEWAY_CAPABILITY_SECRET,
    issuedAt,
  );
  const run = await env.AGENT_GATEWAY.fetch(new Request(`${root}/runs`, {
    method: "POST",
    headers: bearerJson(runCapability),
    body: JSON.stringify({
      runId: command.runId,
      prompt: command.prompt,
      provider: command.provider,
      model: command.model,
      capability: runCapability,
      verificationCommands: command.verificationCommands,
    }),
  }));
  if (!run.ok || !run.body) return gatewayFailure(run.status);
  return new Response(run.body, {
    status: 202,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-buddybox-protocol-version": "2026-08-13",
    },
  });
}

function parseRunCommand(value: unknown): RunCommand {
  const row = record(value);
  if (!row) throw new Error("object required");
  const provider = string(row, "provider", 32);
  if (provider !== "openai-codex" && provider !== "openrouter") throw new Error("provider");
  const sandboxGeneration = row.sandboxGeneration;
  if (!Number.isSafeInteger(sandboxGeneration) || Number(sandboxGeneration) < 1 || Number(sandboxGeneration) > 1_000_000) {
    throw new Error("sandboxGeneration");
  }
  const commands = row.verificationCommands;
  if (commands !== undefined && (!Array.isArray(commands) || commands.length > 8)) throw new Error("verificationCommands");
  const verificationCommands = commands?.map((command) => {
    if (typeof command !== "string" || command.length < 1 || command.length > 512) throw new Error("verificationCommand");
    return command;
  });
  return {
    ownerId: patterned(row, "ownerId", ID),
    projectId: patterned(row, "projectId", ID),
    runId: patterned(row, "runId", ID),
    sandboxGeneration: Number(sandboxGeneration),
    repository: patterned(row, "repository", REPOSITORY),
    branch: patterned(row, "branch", BRANCH),
    prompt: string(row, "prompt", 32_000),
    provider,
    model: patterned(row, "model", MODEL),
    ...(verificationCommands ? { verificationCommands } : {}),
  };
}

async function authorized(request: Request, expected: string): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (expected.length < 32 || actual.length > 256) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: Record<string, unknown>, key: string, max: number): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > max) throw new Error(key);
  return candidate;
}

function patterned(value: Record<string, unknown>, key: string, pattern: RegExp): string {
  const candidate = string(value, key, 256);
  if (!pattern.test(candidate)) throw new Error(key);
  return candidate;
}

function bearerJson(capability: string): HeadersInit {
  return {
    authorization: `Bearer ${capability}`,
    "content-type": "application/json",
  };
}

function gatewayFailure(status: number): Response {
  return error("gateway_unavailable", status >= 400 && status <= 599 ? status : 503);
}

function error(code: string, status: number): Response {
  return Response.json({ error: { code } }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
