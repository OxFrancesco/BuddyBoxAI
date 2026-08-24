# BuddyBox credential broker

This Worker is the only boundary that turns a run capability into provider
authorization. Sandboxes receive the capability, never GitHub or model tokens.

## GitHub runtime

For every Git request the broker authenticates the run capability with the
control plane, then calls the private Convex endpoint with both `ownerId` and
`projectId`. Convex returns only the verified installation ID and the Project's
repository identity. The broker signs a GitHub App JWT and mints a one-hour
installation token restricted to that single repository ID and to `Contents:
write` plus `Metadata: read`.

During the reversible BuddyBox cutover, `buddybox-credential-broker` keeps the
installation-token cache and calls the named `GitHubSigner` entrypoint on
`ichef-credential-broker` when no local GitHub App private key is present. The
legacy Worker still supports its original default fetch handler and secret
name.

The exposed routes are:

- `/v1/egress/github/<owner>/<repo>.git/...` for Git smart HTTP;
- `/v1/egress/github/api/repos/<owner>/<repo>/...` for the allowlisted Contents
  and Git database REST endpoints.

Inbound authorization, cookies, forwarding headers, and all non-allowlisted
headers are discarded. GitHub redirects are never followed or relayed.

## Configuration

- `CONTROL_PLANE`: service binding to `buddybox-control-plane`.
- `CONVEX_CREDENTIAL_URL`: trusted Codex credential endpoint.
- `CONVEX_GITHUB_CREDENTIAL_URL`: trusted project-bound GitHub metadata endpoint.
- `BUDDYBOX_CREDENTIAL_BROKER_SECRET`: BuddyBox shared secret set in both this
  Worker and Convex.
- `ICHEF_CREDENTIAL_BROKER_SECRET`: legacy shared-secret fallback used by the
  reversible `ichef-credential-broker` deployment.
- `GITHUB_APP_ID`: GitHub App numeric ID.
- `GITHUB_APP_PRIVATE_KEY`: GitHub App PEM private key. Both GitHub's PKCS#1 PEM
  and PKCS#8 PEM are accepted. Store it only as a Worker secret. It is optional
  on BuddyBox when `GITHUB_SIGNER` is bound.
- `GITHUB_SIGNER`: optional named RPC service binding to the legacy signer's
  `GitHubSigner` entrypoint.

`wrangler.jsonc` describes the BuddyBox deployment and
`wrangler.legacy.jsonc` describes the reversible legacy deployment.

The Convex GitHub response contract is
`{ok:true,result:{status:"ok",installationId,repositoryId,repositoryFullName}}`.
It must first prove the owner/project relationship, active Project state,
connected installation, and exact Project repository. It must never return the
GitHub User access or refresh token.
