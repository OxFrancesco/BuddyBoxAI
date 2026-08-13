export const RUNNER_LIMITS = {
  bodyBytes: 96 * 1024,
  promptCharacters: 32_000,
  capabilityCharacters: 4_096,
  eventCount: 10_000,
  verificationCommands: 8,
  commandCharacters: 512,
} as const;

export type RunnerProvider = "openai-codex" | "openrouter";

export interface RunnerRunRequest {
  runId: string;
  prompt: string;
  provider: RunnerProvider;
  model: string;
  capability: string;
  resume: boolean;
  verificationCommands: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: Record<string, unknown>, key: string, max: number, pattern?: RegExp): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > max) {
    throw new Error(`${key} must be a non-empty string of at most ${max} characters.`);
  }
  if (pattern && !pattern.test(candidate)) throw new Error(`${key} has an invalid format.`);
  return candidate;
}

export function parseRunRequest(value: unknown): RunnerRunRequest {
  const body = record(value);
  if (!body) throw new Error("Run body must be an object.");
  const provider = string(body, "provider", 32);
  if (provider !== "openai-codex" && provider !== "openrouter") throw new Error("provider is not supported.");
  const commandsValue = body.verificationCommands;
  if (commandsValue !== undefined && (!Array.isArray(commandsValue) || commandsValue.length > RUNNER_LIMITS.verificationCommands)) {
    throw new Error("verificationCommands has an invalid format.");
  }
  const verificationCommands = (commandsValue ?? ["bun test", "bun run build"]).map((command: unknown) => {
    if (typeof command !== "string" || command.length === 0 || command.length > RUNNER_LIMITS.commandCharacters) {
      throw new Error("verification command has an invalid format.");
    }
    return command;
  });
  if (body.resume !== undefined && typeof body.resume !== "boolean") throw new Error("resume must be a boolean.");
  return {
    runId: string(body, "runId", 128, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
    prompt: string(body, "prompt", RUNNER_LIMITS.promptCharacters),
    provider,
    model: string(body, "model", 200, /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/),
    capability: string(body, "capability", RUNNER_LIMITS.capabilityCharacters),
    resume: body.resume === true,
    verificationCommands,
  };
}

export function publicAgentEvent(value: unknown): Record<string, unknown> | null {
  const event = record(value);
  if (!event || typeof event.type !== "string") return null;
  switch (event.type) {
    case "agent_start":
      return { type: "agent_start" };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolName: typeof event.toolName === "string" ? event.toolName : "tool",
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolName: typeof event.toolName === "string" ? event.toolName : "tool",
        isError: event.isError === true,
      };
    default:
      return null;
  }
}
