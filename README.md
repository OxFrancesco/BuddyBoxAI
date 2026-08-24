# BuddyBox

> Deployed technical preview · [live portal](https://buddybox.buddytools.org)

BuddyBox is the deployed foundation of an iMessage-first coding agent for creating and operating owned
TanStack Start, Clerk, and Convex websites. A user signs in with Google through Clerk,
proves their iMessage address, connects ChatGPT, GitHub, and Convex, and then directs a
full Pi coding agent running in an isolated Cloudflare Sandbox. GitHub is used only for
repository access; it is not an BuddyBox login method.

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
- `apps/xchat-bridge` — persistent X Chat XDK/Juicebox transport
- `apps/site-host` — immutable R2-backed managed static-site host
- `convex` — identity, connections, projects, runs, events, approvals, releases,
  quotas, audits, and deletion state
- `packages/contracts` — versioned runtime and domain contracts
- `packages/codex-connection` — Pi-compatible ChatGPT device auth, encryption, and refresh leases
- `packages/provisioning` — user-owned GitHub repository and BuddyBox-managed hosting provisioning
- `starters/tanstack-clerk-convex` — the generated-project baseline
- `prototypes/pi-sandbox-runtime` — disposable runtime proof and measurements

The Sandbox receives no standing GitHub, Clerk, Convex, Cloudflare, or model
credentials. BuddyBox's Cloudflare account hosts generated sites, but its deployment
authority remains behind the trusted control plane. YOLO access is confined to the checked-out Project. Privileged
operations cross typed gateways and are audited in Convex.

## Deployed control plane

- Portal: `https://buddybox.buddytools.org`
- Managed project sites: `https://<project>-buddybox-sites.buddytools.org` (reserved convention)
- Sandbox gateway: `https://buddybox-agent-gateway.oddofrancesco000.workers.dev`
- Convex production: `https://wry-meerkat-833.convex.cloud`
- R2 checkpoints: `buddybox-agent-checkpoints`

The Cloudflare control-plane, credential-broker, and site-host Workers are intentionally
private service bindings. The Spectrum bridge remains a persistent Bun service
and needs a Spectrum Cloud project/webhook before its public ingress can be
enabled.

## Current launch limitations

- The public technical preview currently uses BuddyBox's real Clerk development
  instance; Google is intentionally the only general login method. The Clerk
  production instance and custom domain exist, but production Google OAuth
  credentials and the key cutover are intentionally deferred.
- GitHub and Convex authorization-code + PKCE callbacks are
  implemented and fail closed, but their production OAuth applications still
  need to be registered and their server-side client credentials configured.
- Managed project hosting is deployed under `*-buddybox-sites.buddytools.org` with
  immutable R2 releases and a private publish boundary. The portal can save a
  bounded, approval-bound Project proposal. The production orchestrator can
  provision its repository and start the first sandbox Run once the required
  GitHub, Convex, ChatGPT, and messaging operator integrations are live. Users
  are never asked for Cloudflare OAuth.
- The Spectrum bridge is built and container-verified, but no live Spectrum
  project, line, webhook, or Railway service has been supplied yet; iMessage
  delivery is therefore not live.
- The X Chat bridge and first-class Convex/portal connection flow are built, but
  a live X developer application, API credits, OAuth grant, X Chat key registration,
  Juicebox realm, webhook, and persistent Railway volume are still required.
- Project and run domain APIs, the Pi Sandbox runtime, user-owned GitHub
  provisioning, previews, checkpoints, approvals, release state, and the
  production capability issuer/orchestrator are wired. The live iMessage-to-run
  path still cannot be exercised without Spectrum, and X Chat requires its own
  operator application and durable bridge deployment.
- Automated user-owned Clerk app provisioning depends on Clerk for Platforms
  private-beta access or the documented keyless/accountless claim handoff.

Until those external registrations are complete, treat the deployed URL as a
security-reviewed preview—not an operational end-to-end beta.

## Onboarding invariant

Project creation stays locked until the same Google-backed Clerk User has a verified iMessage or X Chat
connection and healthy `chatgpt`, `github`, and `convex` service connections.
GitHub is therefore connected before any first Project or owned repository is
created. Cloudflare is an BuddyBox-managed platform capability, not a User Service
Connection and not a readiness gate.

## Local development

Operator requirements: Bun, a Convex account, a Clerk application with Google
sign-in, and the BuddyBox Cloudflare account with Workers Containers/Sandbox access.
Users do not need a Cloudflare account.

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
