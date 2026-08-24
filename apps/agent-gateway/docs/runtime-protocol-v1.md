# Agent Gateway runtime protocol

Protocol version: `2026-08-13`

All routes begin with:

```text
/v1/projects/:projectId/generations/:sandboxGeneration
```

Every request carries trusted control-plane bearer authority. `projectId`, generation, Run IDs, and checkpoint IDs are routing identifiers—not proof of ownership. Every capability is bound to one Sandbox generation; Run operations are also bound to one Run ID. Artifact reads, screenshots, and deployments use separate actions. A deployment capability additionally binds the Release, source Run, commit, managed hostname, and canonical artifact-manifest digest. The gateway derives the Sandbox identity from the authenticated User plus the Project and generation.

## Lifecycle

1. `POST /admission` materializes `owner/repository` at a branch with a short-lived GitHub capability. An optional checkpoint is restored after materialization.
2. `POST /runs` starts or resumes a Pi session and returns an NDJSON event stream.
3. `GET /runs/:runId/heartbeat` reports liveness and the latest internal event sequence. `POST /runs/:runId/cancel` cooperatively aborts Pi.
4. `POST /previews` starts a bounded dev-server command and returns a quick or named Cloudflare tunnel.
5. `POST /screenshots` captures a PNG from a running preview with Chromium inside the Sandbox.
6. `GET /artifacts?path=dist/result.json` exports one bounded, workspace-contained artifact. Symlinks cannot escape `/workspace`.
7. `POST /checkpoints` archives repository state, Git history, and Pi sessions to the User/Project R2 namespace.
8. `POST /replacement` restores a checkpoint into exactly the next generation and destroys the old Sandbox only after restore succeeds.
9. `POST /teardown` destroys the current Sandbox and its ephemeral state.
10. `POST /deployments` re-reads only the capability-bound artifact manifest,
    verifies every digest, and hands the exact Release to the private managed
    site host.

## Admission

```json
{
  "repository": "owner/site",
  "branch": "main",
  "capability": "opaque-short-lived-capability",
  "checkpointId": "optional-checkpoint"
}
```

The capability is supplied to `git` through the environment of one command. It is absent from the command string, remote URL, Git config, logs, and checkpoint.

## Run

```json
{
  "runId": "run_123",
  "prompt": "Make the hero warmer and verify the result",
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "capability": "opaque-short-lived-capability",
  "resume": true,
  "verificationCommands": ["bun test", "bun run build"]
}
```

The runner retains the capability only in process memory for that Run. Pi sends it to an internal egress hostname; the credential broker exchanges it for current delegated authority. The actual ChatGPT/Codex, OpenRouter, and GitHub credentials stay outside the container.

Default verification is `bun test` followed by `bun run build`. At most eight bounded commands may be supplied.

## Public events

The response content type is `application/x-ndjson`. Events are monotonically sequenced per stream and contain only the following stable fields:

```json
{"protocolVersion":"2026-08-13","sequence":1,"type":"run.accepted","runId":"run_123","at":"2026-08-13T12:00:00.000Z"}
{"protocolVersion":"2026-08-13","sequence":2,"type":"tool.started","runId":"run_123","at":"2026-08-13T12:00:01.000Z","tool":"bash"}
{"protocolVersion":"2026-08-13","sequence":3,"type":"tool.finished","runId":"run_123","at":"2026-08-13T12:00:03.000Z","tool":"bash","status":"succeeded"}
{"protocolVersion":"2026-08-13","sequence":4,"type":"verification.finished","runId":"run_123","at":"2026-08-13T12:00:05.000Z","status":"succeeded","summary":"All required Bun verification commands passed."}
{"protocolVersion":"2026-08-13","sequence":5,"type":"run.outcome","runId":"run_123","at":"2026-08-13T12:00:05.000Z","outcome":"succeeded","summary":"Implemented and verified the requested change."}
```

Allowed event types are `run.accepted`, `agent.started`, `tool.started`, `tool.finished`, `verification.finished`, `run.outcome`, and `runtime.warning`. Tool arguments, prompts, reasoning, stdout/stderr, raw errors, provider payloads, credentials, and internal paths are discarded. Credential-shaped summary text is redacted and summaries are truncated.

Run outcomes are `succeeded`, `failed`, `cancelled`, or `needs_attention`.

## Limits

| Value | Limit |
| --- | ---: |
| HTTP or runner JSON body | 96 KiB |
| Prompt | 32,000 characters |
| Opaque capability | 4,096 characters |
| Public event line | 16 KiB |
| Events per Run stream | 10,000 |
| Public summary | 512 characters |
| Checkpoint | 32 MiB |
| Exported artifact or screenshot | 8 MiB |

The gateway cancels an upstream stream that exceeds its line, buffer, or event count. Large request bodies are rejected before Pi starts.

## Heartbeats and resume

Heartbeat states are `idle`, `starting`, `running`, `stopping`, `stopped`, or `missing`. The control plane owns durable Run state and should treat a stale heartbeat as `needs_attention`, create a checkpoint when possible, and request replacement into generation `N + 1`.

Replacement is fenced: skipping or reusing a generation returns `409`. Restore verifies that archive entries cannot traverse out of `/workspace`. The old Sandbox is destroyed only after the new Sandbox restores successfully.

## Error envelope

```json
{
  "protocolVersion": "2026-08-13",
  "error": {
    "code": "runtime_unavailable",
    "message": "Pi did not accept the Run.",
    "retryable": true
  }
}
```

Stable codes are `unauthorized`, `not_found`, `bad_request`, `conflict`, `too_large`, `runtime_unavailable`, `checkpoint_failed`, and `internal`. Internal exceptions and upstream bodies are never reflected to callers.
