import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

const workspace = "/workspace";
const sessionDirectory = `${workspace}/.ichef/pi-sessions`;
const encoder = new TextEncoder();
const activeRuns = new Map<string, { abort: () => Promise<void> }>();

type Milestone = {
  at: string;
  kind: "started" | "tool-started" | "tool-finished" | "finished" | "aborted" | "failed";
  summary: string;
};

function milestone(event: AgentSessionEvent): Milestone | undefined {
  const at = new Date().toISOString();
  switch (event.type) {
    case "agent_start":
      return { at, kind: "started", summary: "Pi started the coding turn." };
    case "tool_execution_start":
      return {
        at,
        kind: "tool-started",
        summary: `Pi started ${event.toolName}.`,
      };
    case "tool_execution_end":
      return {
        at,
        kind: "tool-finished",
        summary: `${event.toolName} ${event.isError ? "failed" : "finished"}.`,
      };
    case "agent_end":
      return { at, kind: "finished", summary: "Pi finished the coding turn." };
    default:
      return undefined;
  }
}

function line(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

async function runPi(
  runId: string,
  prompt: string,
  scenario: "build" | "slow",
  controller: ReadableStreamDefaultController<Uint8Array>,
) {
  const credentials = new InMemoryCredentialStore();
  const faux = fauxProvider({ tokensPerSecond: scenario === "slow" ? 1 : 30 });
  const model = faux.getModel();
  await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));

  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  faux.setResponses(
    scenario === "slow"
      ? [fauxAssistantMessage("I am deliberately producing a long response for the cancellation probe. ".repeat(100))]
      : [
          fauxAssistantMessage(
            [
              fauxThinking("Create the requested generated module first."),
              fauxToolCall("write", {
                path: "src/generated.ts",
                content:
                  'export const headline = "Dinner is served by iChef";\nexport const generatedAt = "prototype";\n',
              }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage(
            fauxToolCall("bash", {
              command: "bun install && bun test && bun run build",
            }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Implemented the requested page and verified it with Bun."),
        ],
  );

  const sessionManager = SessionManager.continueRecent(workspace, sessionDirectory);
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: `${workspace}/.ichef/pi-agent`,
    model,
    modelRuntime,
    thinkingLevel: "off",
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });

  const unsubscribe = session.subscribe((event) => {
    const safe = milestone(event);
    if (safe) controller.enqueue(line({ type: "milestone", runId, ...safe }));
  });
  activeRuns.set(runId, { abort: () => session.abort() });

  try {
    controller.enqueue(
      line({
        type: "accepted",
        runId,
        sessionId: session.sessionId,
        promptLength: prompt.length,
      }),
    );
    await session.prompt(prompt);
    const last = session.messages.at(-1);
    const stopReason = last?.role === "assistant" ? last.stopReason : undefined;
    controller.enqueue(
      line({
        type: "outcome",
        runId,
        outcome: stopReason === "aborted" ? "cancelled" : stopReason === "error" ? "failed" : "succeeded",
        sessionFile: session.sessionFile,
      }),
    );
  } catch (error) {
    controller.enqueue(
      line({
        type: "outcome",
        runId,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    activeRuns.delete(runId);
    unsubscribe();
    session.dispose();
    controller.close();
  }
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 8790,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const sessions = await SessionManager.list(workspace, sessionDirectory);
      return Response.json({ ok: true, activeRuns: [...activeRuns.keys()], persistedSessions: sessions.length });
    }

    if (request.method === "POST" && url.pathname === "/runs") {
      const body = (await request.json()) as { runId?: string; prompt?: string; scenario?: "build" | "slow" };
      if (!body.runId || !body.prompt) return Response.json({ error: "runId and prompt are required" }, { status: 400 });
      if (activeRuns.has(body.runId)) return Response.json({ error: "run already active" }, { status: 409 });

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          void runPi(body.runId!, body.prompt!, body.scenario ?? "build", controller);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    }

    const abortMatch = url.pathname.match(/^\/runs\/([^/]+)\/abort$/);
    if (request.method === "POST" && abortMatch) {
      const active = activeRuns.get(abortMatch[1]);
      if (!active) return Response.json({ aborted: false, reason: "not active" }, { status: 404 });
      await active.abort();
      return Response.json({ aborted: true });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`iChef Pi prototype runner listening on ${server.port}`);
