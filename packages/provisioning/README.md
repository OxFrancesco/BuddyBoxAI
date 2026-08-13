# iChef provisioning

Typed user-owned resource provisioning. The GitHub seam deliberately separates
two short-lived authorities:

- a GitHub App User access token creates a personal repository on the User's
  behalf;
- an Installation access token creates organization repositories and operates
  repositories after creation.

The GitHub App must request repository `Administration: write`, `Contents:
write`, and `Metadata: read`. For the MVP, installation must cover all
repositories so a newly created personal repository is immediately available to
the App. Tokens are request-local, are never returned to the Sandbox, and must
never be logged or persisted as Git remotes.
