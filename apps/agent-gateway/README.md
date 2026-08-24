# BuddyBox Agent Gateway

The Agent Gateway is BuddyBox's trusted Cloudflare Worker boundary around the full Pi coding runtime. Every User/Project/generation gets a deterministically isolated Cloudflare Sandbox. The public API never exposes Pi RPC, tool arguments, command output, model credentials, or filesystem paths.

## Runtime boundary

- `CONTROL_PLANE` authenticates each request and returns the authoritative `userId`.
- Sandbox IDs are SHA-256-derived from `userId + projectId + generation`; a Project ID alone is never an authority boundary.
- `CREDENTIAL_BROKER` validates an opaque, short-lived Run capability and injects the User's actual GitHub, ChatGPT/Codex, or OpenRouter credential upstream. Those credentials never enter the Sandbox.
- Model and GitHub traffic can only reach fixed internal broker hosts. Package installation gets read-only access to `registry.npmjs.org`. Every other outbound destination returns `403`.
- R2 stores bounded workspace/Pi-session checkpoints under a User-and-Project-scoped key.
- Checkpoints exclude `node_modules` and all `.env` files. A restored runtime must reinstall dependencies and re-verify.

The Sandbox runs Pi with its ordinary coding tools in YOLO mode. A Run is only reported as `succeeded` after its bounded verification commands pass; an agent turn without passing verification becomes `needs_attention`.

## Commands

```bash
bun install
bun run cf-typegen
bun run typecheck
bun test
bun run dev
```

Docker is required for local Sandbox development. The default development port is `8788`; check that it is free before starting Wrangler.

## Cloudflare bindings

| Binding | Kind | Responsibility |
| --- | --- | --- |
| `Sandbox` | Durable Object / Container | Project-scoped runtime lifecycle |
| `CHECKPOINTS` | R2 | Durable, bounded checkpoint blobs |
| `CONTROL_PLANE` | Worker service | Bearer authentication and authoritative User identity |
| `CREDENTIAL_BROKER` | Worker service | Run-capability validation and provider/GitHub credential injection |

The R2 bucket and both service Workers must exist before deployment. No secret belongs in `wrangler.jsonc`; the gateway itself has no provider credentials.

See [the versioned protocol](docs/runtime-protocol-v1.md) for endpoints, events, limits, recovery, and error semantics.
