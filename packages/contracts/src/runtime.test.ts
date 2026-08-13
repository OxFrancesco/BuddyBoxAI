import { describe, expect, test } from "bun:test";

import {
  MAX_LOG_CHUNK_BYTES,
  admissionReceiptSchema,
  checkpointManifestSchema,
  parseRuntimeCommand,
  parseRuntimeEvent,
  runtimeEventSchema,
} from "./runtime";

const run = {
  runId: "run_01J1",
  projectId: "project_01J1",
  conversationId: "conversation_01J1",
  attempt: 1,
};

describe("runtime command seam", () => {
  test("admits a bounded instruction without provider credentials", () => {
    const command = parseRuntimeCommand({
      protocolVersion: 1,
      commandId: "command_01J1",
      kind: "run.admit",
      issuedAt: "2026-08-13T12:00:00.000Z",
      idempotencyKey: "spectrum-message-123",
      run,
      instruction: {
        text: "Build a dinner reservation site",
        attachments: [],
      },
      workspace: {
        branch: "ichef/run_01J1",
        baseCheckpoint: null,
      },
      limits: {
        deadlineAt: "2026-08-13T12:30:00.000Z",
        maxLogBytes: 1_000_000,
        maxArtifactBytes: 50_000_000,
      },
    });

    expect(command.kind).toBe("run.admit");
    expect(JSON.stringify(command)).not.toMatch(/token|secret|apiKey|credential/i);
  });

  test("rejects unknown fields so credentials cannot hitchhike into a Sandbox", () => {
    expect(() =>
      parseRuntimeCommand({
        protocolVersion: 1,
        commandId: "command_01J1",
        kind: "run.cancel",
        issuedAt: "2026-08-13T12:01:00.000Z",
        run,
        reason: "User requested cancellation",
        apiKey: "must-not-cross-the-seam",
      }),
    ).toThrow();
  });

  test("requires a fresh Sandbox identity when resuming a checkpoint", () => {
    expect(() =>
      parseRuntimeCommand({
        protocolVersion: 1,
        commandId: "command_01J2",
        kind: "run.resume",
        issuedAt: "2026-08-13T12:02:00.000Z",
        run: { ...run, attempt: 2 },
        replacement: {
          previousSandboxId: "sandbox_same",
          sandboxId: "sandbox_same",
        },
        checkpoint: {
          checkpointId: "checkpoint_01J1",
          runId: run.runId,
          projectId: run.projectId,
          attempt: 1,
          createdAt: "2026-08-13T12:01:30.000Z",
          sourceCommit: "0123456789abcdef0123456789abcdef01234567",
          lastSequence: 14,
          archive: {
            store: "checkpoint",
            key: "projects/project_01J1/checkpoints/checkpoint_01J1.tar.zst",
            digestSha256: "a".repeat(64),
            bytes: 14_250,
          },
          includes: ["git", "pi-sessions"],
        },
      }),
    ).toThrow(/fresh Sandbox identity/);
  });
});

describe("runtime event seam", () => {
  test("parses ordered, correlated, sanitized tool milestones", () => {
    const event = parseRuntimeEvent({
      protocolVersion: 1,
      eventId: "event_01J1",
      sequence: 3,
      emittedAt: "2026-08-13T12:03:00.000Z",
      run,
      type: "tool.started",
      tool: "bash",
    });

    expect(event.type).toBe("tool.started");
    expect(event.sequence).toBe(3);
    expect(event).not.toHaveProperty("arguments");
  });

  test("rejects raw commands and tool arguments at the milestone seam", () => {
    const unsafe = {
      protocolVersion: 1,
      eventId: "event_01J2",
      sequence: 4,
      emittedAt: "2026-08-13T12:03:01.000Z",
      run,
      type: "tool.completed",
      tool: "bash",
      outcome: "succeeded",
      durationMs: 400,
      command: "printenv",
    };

    expect(runtimeEventSchema.safeParse(unsafe).success).toBe(false);
  });

  test("enforces bounded UTF-8 log chunks", () => {
    const base = {
      protocolVersion: 1,
      eventId: "event_log",
      sequence: 5,
      emittedAt: "2026-08-13T12:03:02.000Z",
      run,
      type: "log.chunk",
      stream: "stdout",
      chunk: "x".repeat(MAX_LOG_CHUNK_BYTES),
      truncated: false,
    };

    expect(runtimeEventSchema.safeParse(base).success).toBe(true);
    expect(runtimeEventSchema.safeParse({ ...base, chunk: `€${"x".repeat(MAX_LOG_CHUNK_BYTES)}` }).success).toBe(false);
  });

  test("accepts every truthful terminal Run Outcome", () => {
    for (const outcome of ["succeeded", "failed", "cancelled", "needs-attention"] as const) {
      expect(
        runtimeEventSchema.safeParse({
          protocolVersion: 1,
          eventId: `event_${outcome}`,
          sequence: 9,
          emittedAt: "2026-08-13T12:04:00.000Z",
          run,
          type: "run.outcome",
          outcome,
          summary: "Truthful terminal result",
          verificationPassed: outcome === "succeeded",
        }).success,
      ).toBe(true);
    }
  });

  test("success requires verification to have passed", () => {
    expect(
      runtimeEventSchema.safeParse({
        protocolVersion: 1,
        eventId: "event_false_success",
        sequence: 10,
        emittedAt: "2026-08-13T12:04:01.000Z",
        run,
        type: "run.outcome",
        outcome: "succeeded",
        summary: "Agent stopped but checks failed",
        verificationPassed: false,
      }).success,
    ).toBe(false);
  });

  test("a ready Preview requires a URL and a failed Preview requires an error", () => {
    const preview = {
      protocolVersion: 1,
      eventId: "event_preview",
      sequence: 8,
      emittedAt: "2026-08-13T12:03:03.000Z",
      run,
      previewId: "preview_01J1",
      port: 4173,
    };

    expect(runtimeEventSchema.safeParse({ ...preview, type: "preview.ready" }).success).toBe(false);
    expect(runtimeEventSchema.safeParse({ ...preview, type: "preview.failed" }).success).toBe(false);
    expect(
      runtimeEventSchema.safeParse({ ...preview, type: "preview.ready", url: "https://preview.example.com" }).success,
    ).toBe(true);
  });
});

describe("durability seam", () => {
  test("checkpoint manifests cover Git and Pi session state", () => {
    const checkpoint = checkpointManifestSchema.parse({
      checkpointId: "checkpoint_01J1",
      runId: run.runId,
      projectId: run.projectId,
      attempt: 1,
      createdAt: "2026-08-13T12:05:00.000Z",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      lastSequence: 14,
      archive: {
        store: "checkpoint",
        key: "projects/project_01J1/checkpoints/checkpoint_01J1.tar.zst",
        digestSha256: "b".repeat(64),
        bytes: 14_250,
      },
      includes: ["git", "pi-sessions"],
    });

    expect(checkpoint.includes).toEqual(["git", "pi-sessions"]);
  });

  test("admission replay is explicitly marked as deduplicated", () => {
    const receipt = admissionReceiptSchema.parse({
      protocolVersion: 1,
      commandId: "command_01J1",
      run,
      acceptedAt: "2026-08-13T12:00:00.010Z",
      deduplicated: true,
      nextSequence: 15,
    });

    expect(receipt.deduplicated).toBe(true);
  });

  test("a checkpoint event cannot attach another Run's durable state", () => {
    expect(
      runtimeEventSchema.safeParse({
        protocolVersion: 1,
        eventId: "event_checkpoint",
        sequence: 14,
        emittedAt: "2026-08-13T12:05:01.000Z",
        run,
        type: "checkpoint.created",
        checkpoint: {
          checkpointId: "checkpoint_01J2",
          runId: "run_other",
          projectId: run.projectId,
          attempt: 1,
          createdAt: "2026-08-13T12:05:00.000Z",
          sourceCommit: "0123456789abcdef0123456789abcdef01234567",
          lastSequence: 13,
          archive: {
            store: "checkpoint",
            key: "foreign.tar.zst",
            digestSha256: "c".repeat(64),
            bytes: 100,
          },
          includes: ["git", "pi-sessions"],
        },
      }).success,
    ).toBe(false);
  });
});
