import { z } from "zod";

export const RUNTIME_PROTOCOL_VERSION = 1 as const;
export const MAX_INSTRUCTION_BYTES = 32 * 1024;
export const MAX_LOG_CHUNK_BYTES = 8 * 1024;
export const MAX_SUMMARY_BYTES = 2 * 1024;
export const MAX_ERROR_MESSAGE_BYTES = 2 * 1024;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const boundedUtf8 = (label: string, maxBytes: number) =>
  z.string().refine((value) => utf8Bytes(value) <= maxBytes, `${label} must be at most ${maxBytes} UTF-8 bytes`);

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be an opaque identifier without whitespace");
const timestamp = z.iso.datetime({ offset: true });
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, "must be a hexadecimal SHA-256 digest");
const gitCommit = z.string().regex(/^[a-f0-9]{40}$/i, "must be a full Git commit hash");
const safeSummary = boundedUtf8("summary", MAX_SUMMARY_BYTES).min(1);

export const runReferenceSchema = z
  .object({
    runId: id,
    projectId: id,
    conversationId: id,
    attempt: positiveInteger,
  })
  .strict();

export type RunReference = z.infer<typeof runReferenceSchema>;

export const durableReferenceSchema = z
  .object({
    store: z.enum(["attachment", "artifact", "checkpoint"]),
    key: z.string().min(1).max(1024),
    digestSha256: sha256,
    bytes: nonNegativeInteger,
  })
  .strict();

export type DurableReference = z.infer<typeof durableReferenceSchema>;

export const attachmentReferenceSchema = durableReferenceSchema.extend({
  store: z.literal("attachment"),
  mediaType: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
});

export type AttachmentReference = z.infer<typeof attachmentReferenceSchema>;

export const checkpointManifestSchema = z
  .object({
    checkpointId: id,
    runId: id,
    projectId: id,
    attempt: positiveInteger,
    createdAt: timestamp,
    sourceCommit: gitCommit,
    lastSequence: nonNegativeInteger,
    archive: durableReferenceSchema.extend({ store: z.literal("checkpoint") }),
    includes: z.array(z.enum(["git", "pi-sessions"])).length(2),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (!checkpoint.includes.includes("git") || !checkpoint.includes.includes("pi-sessions")) {
      context.addIssue({
        code: "custom",
        path: ["includes"],
        message: "checkpoint must include Git state and Pi sessions",
      });
    }
  });

export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;

export const artifactManifestSchema = z
  .object({
    artifactId: id,
    kind: z.enum(["build", "diagnostics", "workspace"]),
    createdAt: timestamp,
    sourceCommit: gitCommit,
    archive: durableReferenceSchema.extend({ store: z.literal("artifact") }),
  })
  .strict();

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

const commandEnvelope = z.object({
  protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
  commandId: id,
  issuedAt: timestamp,
  run: runReferenceSchema,
});

const admitRunCommandSchema = commandEnvelope
  .extend({
    kind: z.literal("run.admit"),
    idempotencyKey: z.string().min(1).max(256),
    instruction: z
      .object({
        text: boundedUtf8("instruction", MAX_INSTRUCTION_BYTES).min(1),
        attachments: z.array(attachmentReferenceSchema).max(20),
      })
      .strict(),
    workspace: z
      .object({
        branch: z.string().min(1).max(255),
        baseCheckpoint: checkpointManifestSchema.nullable(),
      })
      .strict(),
    limits: z
      .object({
        deadlineAt: timestamp,
        maxLogBytes: positiveInteger.max(10_000_000),
        maxArtifactBytes: positiveInteger.max(1_000_000_000),
      })
      .strict(),
  })
  .strict();

const cancelRunCommandSchema = commandEnvelope
  .extend({
    kind: z.literal("run.cancel"),
    reason: boundedUtf8("cancellation reason", 1024).min(1),
  })
  .strict();

const resumeRunCommandSchema = commandEnvelope
  .extend({
    kind: z.literal("run.resume"),
    replacement: z
      .object({
        previousSandboxId: id,
        sandboxId: id,
      })
      .strict(),
    checkpoint: checkpointManifestSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.replacement.previousSandboxId === command.replacement.sandboxId) {
      context.addIssue({
        code: "custom",
        path: ["replacement", "sandboxId"],
        message: "resume requires a fresh Sandbox identity",
      });
    }
    if (command.checkpoint.runId !== command.run.runId || command.checkpoint.projectId !== command.run.projectId) {
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "checkpoint must belong to the resumed Run and Project",
      });
    }
    if (command.checkpoint.attempt >= command.run.attempt) {
      context.addIssue({
        code: "custom",
        path: ["checkpoint", "attempt"],
        message: "checkpoint must come from an earlier attempt",
      });
    }
  });

const createCheckpointCommandSchema = commandEnvelope
  .extend({
    kind: z.literal("checkpoint.create"),
    reason: z.enum(["verified-run", "intentional-sleep", "replacement"]),
  })
  .strict();

const previewCommandSchema = commandEnvelope
  .extend({
    kind: z.enum(["preview.start", "preview.stop"]),
    previewId: id,
    port: z.number().int().min(1024).max(65_535).refine((port) => port !== 3000, "port 3000 is reserved"),
  })
  .strict();

const exportArtifactCommandSchema = commandEnvelope
  .extend({
    kind: z.literal("artifact.export"),
    artifactId: id,
    artifactKind: z.enum(["build", "diagnostics", "workspace"]),
  })
  .strict();

export const runtimeCommandSchema = z.union([
  admitRunCommandSchema,
  cancelRunCommandSchema,
  resumeRunCommandSchema,
  createCheckpointCommandSchema,
  previewCommandSchema,
  exportArtifactCommandSchema,
]);

export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;

export function parseRuntimeCommand(input: unknown): RuntimeCommand {
  return runtimeCommandSchema.parse(input);
}

export const admissionReceiptSchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    commandId: id,
    run: runReferenceSchema,
    acceptedAt: timestamp,
    deduplicated: z.boolean(),
    nextSequence: nonNegativeInteger,
  })
  .strict();

export type AdmissionReceipt = z.infer<typeof admissionReceiptSchema>;

export const eventAcknowledgementSchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    run: runReferenceSchema,
    throughSequence: positiveInteger,
    acknowledgedAt: timestamp,
  })
  .strict();

export type EventAcknowledgement = z.infer<typeof eventAcknowledgementSchema>;

export const runtimeErrorCodeSchema = z.enum([
  "invalid-request",
  "unsupported-version",
  "admission-conflict",
  "run-not-found",
  "run-not-active",
  "sequence-conflict",
  "checkpoint-unavailable",
  "checkpoint-invalid",
  "artifact-export-failed",
  "preview-failed",
  "verification-failed",
  "deadline-exceeded",
  "resource-exhausted",
  "sandbox-interrupted",
  "sandbox-unavailable",
  "model-unavailable",
  "tool-failed",
  "internal-error",
]);

export type RuntimeErrorCode = z.infer<typeof runtimeErrorCodeSchema>;

export const runtimeErrorSchema = z
  .object({
    code: runtimeErrorCodeSchema,
    message: boundedUtf8("error message", MAX_ERROR_MESSAGE_BYTES).min(1),
    origin: z.enum(["gateway", "sandbox", "pi", "tool", "verification", "preview"]),
    retryable: z.boolean(),
    retryAfterMs: positiveInteger.optional(),
  })
  .strict()
  .superRefine((error, context) => {
    if (!error.retryable && error.retryAfterMs !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["retryAfterMs"],
        message: "retryAfterMs is only valid for retryable errors",
      });
    }
  });

export type RuntimeError = z.infer<typeof runtimeErrorSchema>;

export const runtimeFailureSchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    commandId: id.optional(),
    error: runtimeErrorSchema,
  })
  .strict();

export type RuntimeFailure = z.infer<typeof runtimeFailureSchema>;

const eventEnvelope = z.object({
  protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
  eventId: id,
  sequence: positiveInteger,
  emittedAt: timestamp,
  run: runReferenceSchema,
});

const event = <Shape extends z.ZodRawShape>(shape: Shape) => eventEnvelope.extend(shape).strict();

const runAcceptedEventSchema = event({
  type: z.literal("run.accepted"),
  commandId: id,
  sandboxId: id,
  deduplicated: z.boolean(),
});

const runStartedEventSchema = event({
  type: z.literal("run.started"),
  sandboxId: id,
  resumedFromCheckpointId: id.optional(),
});

const heartbeatEventSchema = event({
  type: z.literal("heartbeat"),
  phase: z.enum(["starting", "working", "verifying", "previewing", "checkpointing"]),
  idleForMs: nonNegativeInteger,
});

const phaseEventSchema = event({
  type: z.enum(["phase.started", "phase.completed"]),
  phase: z.enum(["prepare", "agent", "verify", "preview", "checkpoint", "export"]),
  durationMs: nonNegativeInteger.optional(),
});

const toolStartedEventSchema = event({
  type: z.literal("tool.started"),
  tool: z.string().min(1).max(128),
});

const toolCompletedEventSchema = event({
  type: z.literal("tool.completed"),
  tool: z.string().min(1).max(128),
  outcome: z.enum(["succeeded", "failed", "cancelled"]),
  durationMs: nonNegativeInteger,
});

const logChunkEventSchema = event({
  type: z.literal("log.chunk"),
  stream: z.enum(["stdout", "stderr", "system"]),
  chunk: boundedUtf8("log chunk", MAX_LOG_CHUNK_BYTES),
  truncated: z.boolean(),
});

const verificationEventSchema = event({
  type: z.literal("verification.completed"),
  passed: z.boolean(),
  checks: z
    .array(
      z
        .object({
          name: z.string().min(1).max(128),
          outcome: z.enum(["passed", "failed", "skipped"]),
          durationMs: nonNegativeInteger,
          summary: boundedUtf8("check summary", 1024).optional(),
        })
        .strict(),
    )
    .max(100),
});

const previewEventSchema = event({
  type: z.enum(["preview.starting", "preview.ready", "preview.stopped", "preview.failed"]),
  previewId: id,
  port: z.number().int().min(1024).max(65_535),
  url: z.url().optional(),
  error: runtimeErrorSchema.optional(),
}).superRefine((preview, context) => {
  if (preview.type === "preview.ready" && preview.url === undefined) {
    context.addIssue({ code: "custom", path: ["url"], message: "a ready Preview requires a URL" });
  }
  if (preview.type === "preview.failed" && preview.error === undefined) {
    context.addIssue({ code: "custom", path: ["error"], message: "a failed Preview requires an error" });
  }
});

const checkpointEventSchema = event({
  type: z.literal("checkpoint.created"),
  checkpoint: checkpointManifestSchema,
}).superRefine((checkpointEvent, context) => {
  if (
    checkpointEvent.checkpoint.runId !== checkpointEvent.run.runId ||
    checkpointEvent.checkpoint.projectId !== checkpointEvent.run.projectId ||
    checkpointEvent.checkpoint.attempt !== checkpointEvent.run.attempt
  ) {
    context.addIssue({
      code: "custom",
      path: ["checkpoint"],
      message: "checkpoint must belong to the emitting Run attempt",
    });
  }
});

const artifactEventSchema = event({
  type: z.literal("artifact.exported"),
  artifact: artifactManifestSchema,
});

const runtimeErrorEventSchema = event({
  type: z.literal("runtime.error"),
  error: runtimeErrorSchema,
});

const runOutcomeEventSchema = event({
  type: z.literal("run.outcome"),
  outcome: z.enum(["succeeded", "failed", "cancelled", "needs-attention"]),
  summary: safeSummary,
  verificationPassed: z.boolean(),
  error: runtimeErrorSchema.optional(),
}).superRefine((terminal, context) => {
  if (terminal.outcome === "succeeded" && !terminal.verificationPassed) {
    context.addIssue({
      code: "custom",
      path: ["verificationPassed"],
      message: "a succeeded Run must pass verification",
    });
  }
});

export const runtimeEventSchema = z.union([
  runAcceptedEventSchema,
  runStartedEventSchema,
  heartbeatEventSchema,
  phaseEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  logChunkEventSchema,
  verificationEventSchema,
  previewEventSchema,
  checkpointEventSchema,
  artifactEventSchema,
  runtimeErrorEventSchema,
  runOutcomeEventSchema,
]);

export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export function parseRuntimeEvent(input: unknown): RuntimeEvent {
  return runtimeEventSchema.parse(input);
}

export const eventReplaySchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    run: runReferenceSchema,
    fromSequence: positiveInteger,
    nextSequence: positiveInteger,
    events: z.array(runtimeEventSchema).max(500),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((replay, context) => {
    let expected = replay.fromSequence;
    for (const [index, replayedEvent] of replay.events.entries()) {
      if (replayedEvent.run.runId !== replay.run.runId || replayedEvent.run.attempt !== replay.run.attempt) {
        context.addIssue({ code: "custom", path: ["events", index, "run"], message: "event belongs to another Run attempt" });
      }
      if (replayedEvent.sequence !== expected) {
        context.addIssue({ code: "custom", path: ["events", index, "sequence"], message: `expected sequence ${expected}` });
      }
      expected += 1;
    }
    if (replay.nextSequence !== expected) {
      context.addIssue({ code: "custom", path: ["nextSequence"], message: `expected nextSequence ${expected}` });
    }
  });

export type EventReplay = z.infer<typeof eventReplaySchema>;
