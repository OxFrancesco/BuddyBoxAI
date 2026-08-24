# Pi in Cloudflare Sandbox — prototype result

Date: 2026-08-13

## Verdict

The full Pi coding-agent SDK can run inside a Cloudflare Sandbox and is a
viable execution runtime for BuddyBox. The production design must treat each
Sandbox as disposable: checkpoint Git state and Pi session files outside the
container before idle expiry, then restore into a fresh Sandbox identity.

The probe uses Pi 0.84.0 with its deterministic faux provider. This exercises
Pi's real agent loop, session manager, built-in `write` and `bash` tools, and
abort path without sending a model or service credential to the container.

## Measured evidence

| Check | Result |
| --- | --- |
| Pi instruction and edit | Pi wrote `src/generated.ts` through its built-in `write` tool. |
| Bun verification | Pi ran `bun install && bun test && bun run build`; the run succeeded. |
| Event boundary | 8 NDJSON events for the build run; no raw tool arguments, commands, or file contents crossed the boundary. |
| Cancellation | Abort returned `aborted: true`; Pi persisted a `cancelled` outcome. |
| Runtime | Bun 1.3.12, Node 22.23.2, Git 2.34.1, Pi 0.84.0. |
| Startup | 5.1–20.4 seconds locally across warm/cold Docker trials. |
| Pi build run | 3.6–4.9 seconds with the deterministic provider. |
| Image | 257,539,999 Docker content bytes; Docker reports 1.12 GB virtual size. The embedded runner directory is 156,698,783 bytes. |
| Preview | Internal port 4173 returned HTTP 200 with the generated headline on every passing run. A quick tunnel returned the same page with HTTP 200 in one matched-image trial, but other trials returned 530 or were locally unreachable. |
| Network | Outbound HTTPS was available from the Sandbox (`example.com` returned 200). |
| Idle loss | With `sleepAfter: 12s`, the next inspection found no processes, no generated file, and zero Pi sessions. One local wake also failed its control-plane port check. |
| Checkpoint recovery | A 14,250-byte archive restored the Git repository, generated file, and one Pi session into a new Sandbox identity in 5.4–15.0 seconds. |
| Cost signal | An 86.9-second instrumented lite-instance trial has a conservative container-only upper bound of about $0.000175 before included usage; Worker, Durable Object, logs, and network costs are excluded. |

The cost estimate applies Cloudflare's published lite allocation (1/16 vCPU,
256 MiB memory, 2 GB disk) and current usage rates to the entire wall-clock
trial, deliberately over-counting CPU as fully active. Cloudflare bills
Containers in 10 ms increments and stops container charges when an instance
sleeps: <https://developers.cloudflare.com/containers/pricing/>.

## Decisions this supports

- Keep full Pi in the Sandbox; do not reduce BuddyBox to a thin provider bridge.
- Bake Pi and its dependencies into a version-matched image. The Worker SDK and
  base image are both pinned to Cloudflare Sandbox 0.12.6 and use RPC transport.
- Use port 4173 or another non-reserved user port. Port 3000 belongs to the
  Sandbox control plane and cannot be exposed as an application tunnel.
- Checkpoint after every verified Run and before intentional sleep. Production
  checkpoints go to durable object storage; Git remains canonical for source.
- Restore to a fresh Sandbox identity. Destroying and recreating one identity
  inside the same request produced interrupted operations.
- Treat quick tunnels as development convenience. Production Preview requires
  a named tunnel/custom hostname plus readiness and retry handling.
- Enforce egress policy and provider access at BuddyBox's typed gateways. The
  Sandbox has general outbound network access, so the absence of standing
  credentials—not assumed network isolation—is the primary credential boundary.
- Persist sanitized milestones and terminal Run outcomes in Convex. The local
  Worker reported a benign RPC-stream disconnect diagnostic even when the
  client received the complete stream, so the production gateway should frame,
  sequence, acknowledge, and replay events rather than trusting a raw stream as
  the durable record.

## Reproduce

```sh
bun install
bun run typecheck
bun run dev
```

In another terminal:

```sh
bun run probe
```

The project is not yet a Git repository, so the prototype could not be captured
on the throwaway branch prescribed by the prototype workflow. The local
prototype directory is the primary source until the repository-foundation
ticket establishes Git.
