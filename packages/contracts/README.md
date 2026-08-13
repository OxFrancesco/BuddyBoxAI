# `@ichef/contracts`

The shared iChef contract module is the seam between the portal, Convex control
plane, iMessage bridge, trusted Agent Gateway, and disposable Pi Sandbox. It
contains data and validation only. It does not perform storage, networking,
authentication, or provider calls.

## Interface

`@ichef/contracts/domain` exports the canonical domain schemas and inferred
types from `CONTEXT.md`. `evaluateProjectReadiness` is the single eligibility
rule for starting a Project: the same User must own a verified iMessage
Connection and healthy ChatGPT, GitHub, Cloudflare, and Convex Service
Connections. OpenRouter is supported as an optional fallback and does not make
a User Project-ready by itself.

`@ichef/contracts/runtime` exports version 1 of the trusted Agent Gateway ↔ Pi
Sandbox protocol:

- `runtimeCommandSchema` admits, cancels, replaces/resumes, checkpoints,
  starts/stops Previews, and exports artifacts.
- `runtimeEventSchema` carries ordered milestones, bounded logs, heartbeats,
  verification, Preview state, durable manifests, classified errors, and one
  truthful terminal Run Outcome.
- `admissionReceiptSchema`, `eventAcknowledgementSchema`, and
  `eventReplaySchema` make at-least-once transport safe. Commands use an
  idempotency key; events use a monotonically increasing sequence per Run
  attempt; the trusted gateway acknowledges only after durable persistence and
  replays from the first missing sequence.
- `checkpointManifestSchema` binds Git and Pi session state to one Project, Run,
  and attempt. Resume is valid only into a fresh Sandbox identity and from an
  earlier attempt.
- `runtimeErrorSchema` classifies errors by stable code, origin, and
  retryability. Internal stack traces and unbounded provider responses are not
  part of the interface.

Call `parseRuntimeCommand` and `parseRuntimeEvent` at untrusted process seams.
All object schemas are strict, so unknown properties are rejected rather than
silently stripped.

## Security and durability invariants

- No standing Clerk, GitHub, ChatGPT, OpenRouter, Cloudflare, or Convex
  credential is representable by the Sandbox command schema. Provider and
  deployment authority stays behind typed Agent Gateway adapters.
- Tool events expose the tool name, duration, and outcome—not arguments,
  commands, file contents, model messages, environment variables, or raw Pi
  events.
- Each log chunk is at most 8 KiB of UTF-8. Admission also sets a cumulative
  per-Run log limit, which the runtime adapter must enforce before emitting.
- A Run cannot be `succeeded` unless verification passed. The only final Run
  Outcomes are `succeeded`, `failed`, `cancelled`, and `needs-attention`; the
  first durably recorded terminal outcome wins.
- Git remains canonical for Project source. A checkpoint is recovery state,
  not the Project itself, and must contain both Git state and Pi sessions.
- Preview port 3000 is rejected because it belongs to the Cloudflare Sandbox
  control plane. Production adapters should use stable named tunnels and treat
  Preview URLs as temporary.
- Heartbeats prove liveness only. They do not replace durable events,
  acknowledgements, deadlines, checkpoints, or terminal outcomes.

## Verification

```sh
bun install
bun run verify
```
