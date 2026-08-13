import { describe, expect, test } from "bun:test";
import { parseRunRequest, publicAgentEvent } from "../src/protocol";

describe("runner protocol seam", () => {
  test("accepts a bounded short-lived capability without returning it", () => {
    const request = parseRunRequest({
      runId: "run_one",
      prompt: "Build and verify the landing page",
      provider: "openrouter",
      model: "openai/gpt-5.6-sol",
      capability: "ephemeral-capability",
      resume: true,
    });
    expect(request).toEqual({
      runId: "run_one",
      prompt: "Build and verify the landing page",
      provider: "openrouter",
      model: "openai/gpt-5.6-sol",
      capability: "ephemeral-capability",
      resume: true,
      verificationCommands: ["bun test", "bun run build"],
    });
    expect(JSON.stringify(publicAgentEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "private" }))).toBe(
      '{"type":"tool_execution_start","toolName":"bash"}',
    );
  });

  test("rejects oversized prompts and malformed provider input", () => {
    expect(() =>
      parseRunRequest({
        runId: "run_one",
        prompt: "x".repeat(32_001),
        provider: "openrouter",
        model: "openai/gpt-5.6-sol",
        capability: "ephemeral",
      }),
    ).toThrow("prompt");
    expect(() =>
      parseRunRequest({
        runId: "run_one",
        prompt: "hello",
        provider: "direct-secret-provider",
        model: "model",
        capability: "ephemeral",
      }),
    ).toThrow("provider");
  });
});
