import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { chromium } from "playwright";
import { parseRunRequest, publicAgentEvent, RUNNER_LIMITS, type RunnerRunRequest } from "./protocol";

const workspace = "/workspace";
const sessionDirectory = `${workspace}/.ichef/pi-sessions`;
const encoder = new TextEncoder();

function brokeredCodexToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "ichef-broker" },
  })).toString("base64url");
  return `${header}.${payload}.brokered`;
}

interface ActiveRun {
  state: "starting" | "running" | "stopping";
  lastEventSequence: number;
  startedAt: string;
  abort(): Promise<void>;
}

const activeRuns = new Map<string, ActiveRun>();

function line(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function safeEnqueue(controller: ReadableStreamDefaultController<Uint8Array>, value: unknown): boolean {
  try {
    controller.enqueue(line(value));
    return true;
  } catch {
    return false;
  }
}

function assistantSummary(session: AgentSession): string | undefined {
  const last = session.messages.at(-1);
  if (last?.role !== "assistant") return undefined;
  const text = last.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join(" ")
    .trim();
  return text.length > 0 ? text.slice(0, 512) : undefined;
}

async function modelFor(request: RunnerRunRequest, signal: AbortSignal): Promise<{ model: Model<Api>; runtime: ModelRuntime }> {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(
    request.provider,
    async () =>
      request.provider === "openai-codex"
        ? {
            type: "oauth",
            access: brokeredCodexToken(),
            refresh: "run-capabilities-cannot-refresh",
            expires: Date.now() + 15 * 60 * 1000,
          }
        : { type: "api_key", key: request.capability },
    { signal },
  );
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, signal });
  const base = runtime.getModel(request.provider, request.model);
  if (!base) throw new Error("Requested model is not present in Pi's catalog.");
  const model: Model<Api> = {
    ...base,
    headers: {
      ...base.headers,
      "x-ichef-run-capability": request.capability,
    },
    baseUrl:
      request.provider === "openai-codex"
        ? "http://codex.ichef.internal/backend-api"
        : "http://models.ichef.internal/v1",
  };
  return { model, runtime };
}

async function verify(
  commands: string[],
  signal: AbortSignal,
): Promise<{ status: "succeeded" | "failed" | "cancelled"; summary: string }> {
  for (const command of commands) {
    if (signal.aborted) return { status: "cancelled", summary: "Verification was cancelled." };
    const child = Bun.spawn(["bash", "-lc", command], {
      cwd: workspace,
      env: process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    const exitCode = await child.exited;
    signal.removeEventListener("abort", stop);
    if (signal.aborted) return { status: "cancelled", summary: "Verification was cancelled." };
    if (exitCode !== 0) return { status: "failed", summary: "A required Bun verification command failed." };
  }
  return { status: "succeeded", summary: "All required Bun verification commands passed." };
}

async function executeRun(
  request: RunnerRunRequest,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let emitted = 0;
  const abortController = new AbortController();
  const active: ActiveRun = {
    state: "starting",
    lastEventSequence: 0,
    startedAt: new Date().toISOString(),
    abort: async () => {
      abortController.abort();
      await session?.abort();
    },
  };
  activeRuns.set(request.runId, active);

  const emit = (value: unknown): boolean => {
    emitted += 1;
    active.lastEventSequence = emitted;
    if (emitted > RUNNER_LIMITS.eventCount) {
      void active.abort();
      return false;
    }
    return safeEnqueue(controller, value);
  };

  try {
    emit({ type: "accepted", runId: request.runId });
    const { model, runtime } = await modelFor(request, abortController.signal);
    abortController.signal.throwIfAborted();
    const sessionManager = request.resume
      ? SessionManager.continueRecent(workspace, sessionDirectory)
      : SessionManager.create(workspace, sessionDirectory);
    const created = await createAgentSession({
      cwd: workspace,
      agentDir: `${workspace}/.ichef/pi-agent`,
      model,
      modelRuntime: runtime,
      thinkingLevel: "high",
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
      }),
    });
    session = created.session;
    active.state = "running";
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      const publicEvent = publicAgentEvent(event);
      if (publicEvent) emit(publicEvent);
    });
    await session.prompt(request.prompt);
    const last = session.messages.at(-1);
    const stopped = last?.role === "assistant" ? last.stopReason : "error";
    if (stopped === "aborted") {
      emit({ type: "outcome", outcome: "cancelled", summary: "The Run was cancelled." });
      return;
    }
    if (stopped === "error") {
      emit({ type: "outcome", outcome: "failed", summary: "Pi could not complete the coding turn." });
      return;
    }
    const verification = await verify(request.verificationCommands, abortController.signal);
    emit({ type: "verification", ...verification });
    if (verification.status === "cancelled") {
      emit({ type: "outcome", outcome: "cancelled", summary: verification.summary });
      return;
    }
    emit({
      type: "outcome",
      outcome: verification.status === "succeeded" ? "succeeded" : "needs_attention",
      summary: verification.status === "succeeded" ? assistantSummary(session) : verification.summary,
    });
  } catch {
    emit({
      type: "outcome",
      outcome: abortController.signal.aborted ? "cancelled" : "failed",
      summary: abortController.signal.aborted
        ? "The Run was cancelled."
        : "The isolated Pi runtime failed.",
    });
  } finally {
    activeRuns.delete(request.runId);
    unsubscribe?.();
    session?.dispose();
    try {
      controller.close();
    } catch {
      // The client may have disconnected after cancellation.
    }
  }
}

async function boundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > RUNNER_LIMITS.bodyBytes) throw new Error("request body is too large");
  if (!request.body) throw new Error("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > RUNNER_LIMITS.bodyBytes) {
      await reader.cancel("request body limit exceeded");
      throw new Error("request body is too large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function heartbeat(runId?: string) {
  const active = runId ? activeRuns.get(runId) : undefined;
  return {
    ...(runId ? { runId } : {}),
    state: active?.state ?? (runId ? "missing" : activeRuns.size > 0 ? "running" : "idle"),
    lastEventSequence: active?.lastEventSequence ?? 0,
    observedAt: new Date().toISOString(),
  };
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 8790,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/health") return Response.json(heartbeat());

    if (request.method === "POST" && url.pathname === "/v1/runs") {
      let run: RunnerRunRequest;
      try {
        run = parseRunRequest(await boundedJson(request));
      } catch {
        return Response.json({ code: "invalid_run" }, { status: 400 });
      }
      if (activeRuns.has(run.runId)) return Response.json({ code: "run_conflict" }, { status: 409 });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          void executeRun(run, controller);
        },
        cancel() {
          return activeRuns.get(run.runId)?.abort();
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
    }

    const runAction = /^\/v1\/runs\/([^/]+)\/(cancel|heartbeat)$/.exec(url.pathname);
    if (runAction) {
      const runId = runAction[1] ?? "";
      const active = activeRuns.get(runId);
      if (request.method === "GET" && runAction[2] === "heartbeat") {
        return active ? Response.json(heartbeat(runId)) : Response.json(heartbeat(runId), { status: 404 });
      }
      if (request.method === "POST" && runAction[2] === "cancel") {
        if (!active) return Response.json({ accepted: false }, { status: 404 });
        active.state = "stopping";
        await active.abort();
        return Response.json({ accepted: true });
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/screenshots") {
      try {
        const body = (await boundedJson(request)) as Record<string, unknown>;
        const port = Number(body.port);
        const path = typeof body.path === "string" ? body.path : "/";
        const width = Number(body.width ?? 1440);
        const height = Number(body.height ?? 900);
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage({ viewport: { width, height } });
          await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: "networkidle", timeout: 30_000 });
          const bytes = await page.screenshot({ type: "png", fullPage: true });
          if (bytes.byteLength > 8 * 1024 * 1024) return Response.json({ code: "screenshot_too_large" }, { status: 413 });
          return Response.json({ base64: bytes.toString("base64") });
        } finally {
          await browser.close();
        }
      } catch {
        return Response.json({ code: "screenshot_failed" }, { status: 500 });
      }
    }

    return Response.json({ code: "not_found" }, { status: 404 });
  },
});

console.log(JSON.stringify({ message: "iChef agent runner ready", port: server.port }));
