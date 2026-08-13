import { LIMITS, RUNTIME_PROTOCOL_VERSION, type PublicRuntimeEvent, type RunOutcome } from "./contracts/v1";

type Clock = () => Date;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeTool(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : "tool";
}

function safeSummary(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[a-zA-Z0-9._~-]+/gi, "$1[REDACTED]")
    .replace(/sk-[a-zA-Z0-9_-]{12,}/g, "[REDACTED]")
    .slice(0, LIMITS.eventSummaryCharacters);
}

function safeOutcome(value: unknown): RunOutcome {
  return value === "succeeded" || value === "failed" || value === "cancelled" || value === "needs_attention"
    ? value
    : "failed";
}

export function sanitizeEvent(
  raw: unknown,
  runId: string,
  sequence: number,
  now: Clock,
): PublicRuntimeEvent | null {
  const value = object(raw);
  if (!value || typeof value.type !== "string") return null;
  const base = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    sequence,
    runId,
    at: now().toISOString(),
  } as const;
  switch (value.type) {
    case "accepted":
      return { ...base, type: "run.accepted" };
    case "agent_start":
      return { ...base, type: "agent.started" };
    case "tool_execution_start":
      return { ...base, type: "tool.started", tool: safeTool(value.toolName) };
    case "tool_execution_end":
      return {
        ...base,
        type: "tool.finished",
        tool: safeTool(value.toolName),
        status: value.isError === true ? "failed" : "succeeded",
      };
    case "verification":
      return {
        ...base,
        type: "verification.finished",
        status: value.status === "succeeded" ? "succeeded" : "failed",
        summary: safeSummary(value.summary),
      };
    case "outcome":
      return {
        ...base,
        type: "run.outcome",
        outcome: safeOutcome(value.outcome),
        summary: safeSummary(value.summary),
      };
    case "warning":
      return {
        ...base,
        type: "runtime.warning",
        code: typeof value.code === "string" && /^[a-z0-9_.-]{1,64}$/.test(value.code) ? value.code : "runtime_warning",
        summary: safeSummary(value.summary),
      };
    default:
      return null;
  }
}

export function sanitizedEventStream(source: ReadableStream<Uint8Array>, runId: string, now: Clock): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let sequence = 0;
  let rawEvents = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.length === 0) continue;
          rawEvents += 1;
          if (rawEvents > LIMITS.eventCount) {
            await reader.cancel("event limit exceeded");
            controller.error(new Error("Runtime event limit exceeded."));
            return;
          }
          if (new TextEncoder().encode(line).byteLength > LIMITS.eventLineBytes) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch {
            continue;
          }
          const event = sanitizeEvent(parsed, runId, sequence + 1, now);
          if (!event) continue;
          sequence += 1;
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          return;
        }

        const chunk = await reader.read();
        if (chunk.done) {
          buffer += decoder.decode();
          if (buffer.length > 0) buffer += "\n";
          else controller.close();
          if (buffer.length === 0) return;
          continue;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        if (new TextEncoder().encode(buffer).byteLength > LIMITS.eventLineBytes * 2) {
          await reader.cancel("event buffer limit exceeded");
          controller.error(new Error("Runtime event buffer limit exceeded."));
          return;
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}
