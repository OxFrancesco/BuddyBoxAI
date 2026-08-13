# @ichef/codex-connection

Production-shaped ChatGPT/Codex subscription connection logic for iChef. The
package follows Pi's native OpenAI Codex device-code contract and BeeGreat's
hosted credential-broker design: each user connects their own ChatGPT account,
durable storage contains only AES-256-GCM ciphertext, refresh rotation is
serialized by a lease, and an agent receives only the current access token.

This package does not turn a ChatGPT subscription into a shared API. Use it
only for the account owner and keep the runtime/broker private. OpenAI may
change or disable the device flow; surface `CodexAuthError.code` without
logging upstream bodies.

## Interface

`CodexConnectionManager` is the application seam:

- `start(userId)` starts or reuses a 15-minute device authorization and returns
  the verification URL plus user code.
- `status(userId)` reads the durable cross-device state.
- `poll(userId, sessionId)` respects the provider interval, exchanges an
  approved device grant, and atomically stores encrypted OAuth credentials.
- `resolveAccess(userId)` returns a current short-lived access token. Near
  expiry it claims a 30-second compare-and-swap lease, rotates both tokens, and
  makes concurrent callers return `busy`.
- `revoke(userId)` removes local credentials before any best-effort upstream
  revocation. The built-in OpenAI client intentionally reports `unsupported`
  because there is no documented Codex device-token revocation endpoint.

`OpenAiCodexAuthClient` mirrors the device flow in the checked-in Pi reference:

- client ID `app_EMoamEEZ73f0CkXaXp7hrann`
- `POST /api/accounts/deviceauth/usercode`
- `POST /api/accounts/deviceauth/token`
- authorization-code exchange at `POST /oauth/token`
- refresh-token rotation at `POST /oauth/token`
- verification URL `https://auth.openai.com/codex/device`

## Required adapters

The Convex integration must implement `CodexConnectionRepository`:

1. Store one opaque `PersistedCodexConnection` per Clerk user ID.
2. Return a monotonically increasing `revision` from `load`.
3. Implement `commit` as one Convex mutation that writes only when the current
   revision equals `expectedRevision`; creation uses `null`.
4. Never expose repository documents through public Convex queries. Public
   functions should project only `DeviceConnectionStatus`.
5. Call `resolveAccess` only from a trusted internal action or authenticated
   credential broker. Never return its result to the browser or iMessage.

Create one 32-byte production key and initialize
`AesGcmSecretVault.fromBase64Key`. Keep that key in Convex's server environment
as `ICHEF_CODEX_CREDENTIAL_KEY`; never in Clerk metadata, Worker vars exposed to
the client, logs, checkpoints, or a sandbox. Associated data binds every
ciphertext to its Clerk user, purpose, and (for device secrets) session.

The agent gateway integration should request an access token per run through a
short-lived, user-and-run-scoped broker capability. Hold the returned token in
memory, register Pi's `openai-codex-responses` provider, and discard it when the
run ends. The refresh token never leaves the trusted broker process.

Use `redactForLog` for structured context and `safeAuthError` for failures.
Neither access/refresh tokens, device IDs/codes, authorization headers, request
bodies, nor raw upstream error bodies may enter logs or tracing.

## Verification

```sh
bun run verify
```

The suite covers encryption/AAD isolation, device flow persistence, Pi request
shape, safe upstream errors, access resolution, refresh leases and rotation,
permanent/transient failures, local-first revocation, and recursive redaction.
