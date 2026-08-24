# BuddyBox managed site host

`buddybox-site-host` serves generated static TanStack frontends from one BuddyBox-owned
R2 bucket. Users never receive a Cloudflare credential and sandboxed agents never
call the Cloudflare API. Every public site is isolated by hostname and immutable
release prefix:

```text
https://<project-slug>-<stable-project-suffix>-buddybox-sites.buddytools.org
releases/<projectId>/<releaseId>/<manifestDigest>/<assetPath>
```

The frontend is static; generated applications use their own Convex deployment
for backend behavior. This Worker deliberately rejects arbitrary server code.

## Deployment flow

The Agent Gateway calls this Worker through a `SITE_HOST` service binding using
the internal URL `https://site-host.internal/v1/deployments`. The request needs a
short-lived `deploy` capability in `Authorization: Bearer ...` and this body:

```json
{
  "projectId": "...",
  "releaseId": "...",
  "sourceRunId": "...",
  "commitSha": "0123456789abcdef",
  "hostname": "my-site-project-id-buddybox-sites.buddytools.org",
  "artifactManifestDigest": "64-lowercase-hex-characters",
  "assets": [
    {
      "path": "index.html",
      "data": "PGh0bWw+Li4uPC9odG1sPg==",
      "sha256": "64-lowercase-hex-characters"
    }
  ]
}
```

Limits are intentionally small: 12 MiB encoded request, 8 MiB decoded release,
2 MiB per asset, 256 assets, and 240 ASCII characters per normalized path.
Hidden files, traversal, encoded separators, duplicate paths, and digest
mismatches are rejected. `index.html` is required.

The sequence is:

1. Authenticate a `deploy` capability bound to the Project, Sandbox generation,
   Release, source Run, commit, hostname, and exact canonical artifact manifest.
2. Atomically reserve that exact preauthorized upload in Convex before writing
   R2. A concurrent upload or alternate manifest fails closed.
3. Write every asset and the canonical manifest under a content-derived,
   immutable R2 prefix. Conditional puts make retries idempotent and conflicts
   fail closed.
4. Ask Convex to activate that exact reservation, `deploymentRef`, and live
   origin. Failed attempts release their reservation; stale reservations expire.

Public reads resolve the active release through Convex. Because activation is the
last operation, readers see either the complete previous release or the complete
new release. A partial write is reachable only by retrying the same manifest, so
immutable conditional puts complete it idempotently; alternate manifests cannot
create orphan prefixes. A scheduled retention job can remove abandoned exact-
manifest prefixes later.

## Convex broker contract

All calls are `POST $CONVEX_SITE_HOST_URL` with the secret
`BUDDYBOX_SITE_HOST_SECRET` and `{ "operation": "...", "input": { ... } }`.
Responses use `{ "ok": true, "result": ... }`.

- `reserve_upload`: input
  `{ projectId, releaseId, sourceRunId, commitSha, hostname, artifactManifestDigest, attemptId }`;
  result `{ status: "reserved" }` or the already-live exact deployment.
- `fail_upload`: input `{ releaseId, attemptId }`; releases a failed attempt.
- `activate_release`: input
  `{ projectId, releaseId, sourceRunId, deploymentRef, liveUrl, commitSha, hostname, artifactManifestDigest, attemptId }`; result
  `{ projectId, releaseId, status: "live" }`.
- `resolve_site`: input `{ hostname }`; result `null` or
  `{ projectId, releaseId, commitSha, deploymentRef, status: "live" }`.

Convex owns the canonical hostname and verifies the exact managed HTTPS origin on
activation. Its live pointer is the routing registry; R2 contains no mutable
tenant registry.

## Cloudflare setup

One-time operator steps (do not run from an agent sandbox):

```sh
bunx wrangler r2 bucket create buddybox-sites
bunx wrangler secret put BUDDYBOX_SITE_HOST_SECRET --config apps/site-host/wrangler.jsonc
bunx wrangler deploy --config apps/site-host/wrangler.jsonc
```

The zone already has a proxied `*.buddytools.org` DNS record. Keep the scoped
`*-buddybox-sites.buddytools.org/*` Worker route from `wrangler.jsonc`; this first-level
hostname shape is covered by Universal SSL without a paid nested-wildcard certificate. The `CONTROL_PLANE` service must
already exist. The Agent Gateway still needs this binding:

```jsonc
{ "binding": "SITE_HOST", "service": "buddybox-site-host" }
```

Do not expose `site-host.internal` in DNS. The management endpoint only accepts
that internal service-binding hostname; the public wildcard route can only serve
sites.

## Verification

```sh
bun run --cwd apps/site-host typecheck
bun run --cwd apps/site-host test
bunx wrangler deploy --dry-run --config apps/site-host/wrangler.jsonc
```

Wrangler-generated bindings are checked into `worker-configuration.d.ts` and
must be regenerated after changing `wrangler.jsonc`.
