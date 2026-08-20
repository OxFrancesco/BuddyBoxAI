# iChef Convex control plane

## Operator configuration

- `GITHUB_APP_SLUG` is the public GitHub App slug. GitHub connection starts at
  `https://github.com/apps/<slug>/installations/new`; the App must enable
  **Request user authorization (OAuth) during installation** so GitHub returns
  to `/v1/oauth/github/callback` with the stored single-use state and code.
- `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_ID`
  authenticate and verify the App authorization callback. This connection is
  for repository access only and is independent from Clerk sign-in.
- `ICHEF_SITES_BASE_DOMAIN` is the iChef-owned hosting suffix and defaults to
  `ichef-sites.buddytools.org`; project hosts append it inside a first-level DNS label.
- `ICHEF_SITE_HOST_SECRET` authenticates the private site-host broker. Use a
  distinct random value of at least 32 characters and never expose it to users.

This directory is the durable, multi-User control plane for iChef. Convex owns
identity bindings, connections, Projects, Conversations, Runs, sanitized Run
events, runtime leases, Previews, action-bound Approvals, Releases, delivery
receipts, quotas, audit history, retention, and resumable account deletion.

## Trust boundaries

- Public functions resolve the current Clerk identity and never accept an
  `ownerId` from the caller.
- Functions used by Spectrum, the Agent Gateway, OAuth callbacks, or deployment
  workers are `internalMutation`s. Expose them only through a separately
  authenticated Convex action/HTTP adapter; never change them to unauthenticated
  public mutations.
- `credentialRef` is an opaque identifier for a trusted credential broker. Raw
  GitHub, ChatGPT, Cloudflare, Convex, Clerk, and OpenRouter credentials must
  never be stored in these tables or passed to a Sandbox.
- Run event `dataJson`, Preview verification data, and audit metadata must be
  sanitized before crossing the trusted gateway boundary.

## Invariants

- `users.activeRunId` is the atomic one-active-Run lease. Terminal Run
  transitions clear it.
- `runs.commandKey`, provider delivery identities, and Run event identities make
  retries idempotent.
- A Run can become `succeeded` only from `verifying`, and terminal `status` and
  `outcome` must agree.
- An Approval binds one User, operation, target IDs, payload hash, expiry, and
  one consumption. Retried downstream operations must remain idempotent.
- Raw Run events and channel receipts expire after 30 days. The scheduled sweep
  is bounded to 50 rows per table per pass.
- An expired Spectrum outbound lease transitions to `reconciliation_required`,
  retains its exact lease hash for a late truthful settlement, and cannot be
  claimed again until the internal operator reconciliation path either marks
  it delivered or deliberately requeues it.
- Account deletion keeps a resumable cursor and removes child records in bounded
  batches before reducing the User to a non-PII tombstone.

## Required deployment configuration

Set `CLERK_JWT_ISSUER_DOMAIN` on every Convex deployment to the issuer for the
Clerk `convex` JWT template. Then regenerate and verify:

```sh
bunx convex codegen
bun run typecheck:convex
bun test convex/controlPlane.test.ts convex/domainPolicy.test.ts
```

The checked-in `_generated` files are compatible bootstrap output. A configured
Convex deployment should regenerate them before deployment.

## Spectrum outbound reconciliation

`internal.bridge.reconcileOutbound` is the operator-only resolution seam for an
ambiguous Spectrum delivery. Pass `disposition: "mark_delivered"` with the
provider-confirmed `providerMessageId`, or pass `disposition: "requeue"` only
after confirming Spectrum did not accept the send. Requeue clears the old lease,
so any later settlement carrying that stale token is rejected.
