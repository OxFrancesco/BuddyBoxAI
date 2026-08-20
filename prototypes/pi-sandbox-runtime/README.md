# PROTOTYPE — Pi inside Cloudflare Sandbox

Throwaway runtime probe for Wayfinder ticket
[`Prove the full Pi runtime inside Cloudflare Sandbox`](../../.scratch/ichef-mvp/issues/03-prototype-pi-sandbox-runtime.md).

Measured verdict: [`RESULTS.md`](./RESULTS.md).

It answers one question: can iChef run the full Pi coding-agent SDK in a
Cloudflare Sandbox without placing a real model or service credential in the
container, stream sanitized milestones, verify a generated project, expose a
Preview, cancel work, and restore Git plus Pi session state after replacing the
container?

The probe uses Pi's deterministic faux provider. It executes Pi's real agent
loop and built-in `write` and `bash` tools, but it makes no LLM request.

## Run

Docker must be running. The prototype uses port `8877` only. Generate a local
shared secret in the ignored `.dev.vars` file before starting it:

```sh
bun install
openssl rand -hex 32 | sed 's/^/ICHEF_PROTOTYPE_SECRET=/' > .dev.vars
bun run dev
```

In another terminal:

```sh
set -a
source .dev.vars
set +a
bun run probe
```

`probe` seeds a tiny Git-backed Bun website, runs Pi, verifies the project,
starts its dev server, checks a Cloudflare quick tunnel, waits past the
prototype's 12-second idle timeout, checks filesystem/session survival, captures
a checkpoint, destroys the Sandbox, restores the checkpoint into a replacement
container, and reports the measurements as JSON.

## Deliberate limitations

- This is not the permanent iChef gateway protocol.
- Every `/api` lifecycle request requires the exact shared Bearer credential.
  The HTTP boundary fails closed when
  `ICHEF_PROTOTYPE_SECRET` is absent or shorter than 32 characters. The secret
  belongs in `.dev.vars` locally or in `wrangler secret put` if an operator
  deliberately deploys the proof.
- `workers.dev` publication is disabled. This proof is not deployed by the
  repository workflow and remains separate from the permanent iChef gateway.
- Quick-tunnel availability depends on local network policy. Internal Preview
  reachability is tested separately so a blocked tunnel is reported rather than
  hiding the rest of the result.
- The checkpoint is buffered in one Worker request for simplicity. Production
  must stream encrypted artifacts to durable object storage.
