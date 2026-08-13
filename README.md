# iChef

> Deployed technical preview · [live portal](https://ichef-portal.oddofrancesco000.workers.dev)

iChef is the deployed foundation of an iMessage-first coding agent for creating and operating owned
TanStack Start, Clerk, and Convex websites. A user signs in through Clerk,
proves their iMessage address, connects ChatGPT, GitHub, Cloudflare, and Convex, and then directs a
full Pi coding agent running in an isolated Cloudflare Sandbox.

The control plane, encrypted connection flows, sandbox runtime, starter, and
provider provisioning seams are implemented. This repository is public early
so the remaining account-level launch work is visible rather than hidden behind
buttons that pretend to be connected.

## Architecture

- `apps/portal` — secure TanStack Start account and project portal
- `apps/agent-gateway` — typed Cloudflare Worker/Sandbox admission gateway
- `apps/control-plane` — short-lived User/Project/operation capability authority
- `apps/credential-broker` — private token injection for Codex and provider APIs
- `apps/spectrum-bridge` — persistent Spectrum Cloud iMessage transport
- `convex` — identity, connections, projects, runs, events, approvals, releases,
  quotas, audits, and deletion state
- `packages/contracts` — versioned runtime and domain contracts
- `packages/codex-connection` — Pi-compatible ChatGPT device auth, encryption, and refresh leases
- `packages/provisioning` — user-owned GitHub repository provisioning
- `starters/tanstack-clerk-convex` — the generated-project baseline
- `prototypes/pi-sandbox-runtime` — disposable runtime proof and measurements

The Sandbox receives no standing GitHub, Clerk, Convex, Cloudflare, or model
credentials. YOLO access is confined to the checked-out Project. Privileged
operations cross typed gateways and are audited in Convex.

## Deployed control plane

- Portal: `https://ichef-portal.oddofrancesco000.workers.dev`
- Sandbox gateway: `https://ichef-agent-gateway.oddofrancesco000.workers.dev`
- Convex production: `https://wry-meerkat-833.convex.cloud`
- R2 checkpoints: `ichef-agent-checkpoints`

The Cloudflare control-plane and credential-broker Workers are intentionally
private service bindings. The Spectrum bridge remains a persistent Bun service
and needs a Spectrum Cloud project/webhook before its public ingress can be
enabled.

## Current launch limitations

- The public portal currently uses a Clerk development instance. Production
  sign-in requires completing Clerk's interactive production deploy and
  replacing the public and server keys.
- GitHub, Cloudflare, and Convex authorization-code + PKCE callbacks are
  implemented and fail closed, but their production OAuth applications still
  need to be registered and their server-side client credentials configured.
- The Spectrum bridge is built and container-verified, but no live Spectrum
  project, line, webhook, or Railway service has been supplied yet; iMessage
  delivery is therefore not live.
- Project and run domain APIs, the Pi Sandbox runtime, user-owned GitHub
  provisioning, previews, checkpoints, approvals, and release state exist, but
  the public portal does not yet expose a project-creation form and the live
  iMessage-to-run path cannot be exercised without Spectrum.
- Automated user-owned Clerk app provisioning depends on Clerk for Platforms
  private-beta access or the documented keyless/accountless claim handoff.

Until those external registrations are complete, treat the deployed URL as a
security-reviewed preview—not an operational end-to-end beta.

## Onboarding invariant

Project creation stays locked until the same Clerk User has a verified iMessage
connection and healthy `chatgpt`, `github`, `cloudflare`, and `convex` service
connections. GitHub is therefore connected before any first Project or owned
repository is created.

## Local development

Requirements: Bun, a Convex account, a Clerk application, and a Cloudflare
account with Workers Containers/Sandbox access.

```bash
bun install
bun run convex:dev
bun run dev
```

Copy `.env.example` to `.env.local` and provision values with the relevant
provider CLIs. Never commit `.env.local`, `.clerk/`, `.convex/`, or `.wrangler/`.

## Verification

```bash
bun run verify
```

See [CONTEXT.md](./CONTEXT.md) for product language and invariants and
[docs/research/user-owned-provisioning.md](./docs/research/user-owned-provisioning.md)
for the delegated provisioning analysis.
