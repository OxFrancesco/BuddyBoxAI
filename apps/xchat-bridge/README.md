# BuddyBox X Chat bridge

Production boundary for encrypted X Chat. It accepts X webhook CRC and signed
POST requests, decrypts with the official Chat XDK, admits only
signature-verified text into Convex, binds the X sender to a Clerk user through
the same `BUDDYBOX-<code>` return-message challenge as iMessage, and delivers
leased replies with durable provider idempotency.

## Security model

- `GET /v1/xchat/webhook` answers X's CRC challenge using the App consumer
  secret. `POST /v1/xchat/webhook` verifies
  `x-twitter-webhooks-signature` against the exact raw bytes before JSON parse.
- Webhook bodies are capped at 1 MiB. After signature verification, an
  encrypted, capacity-bounded exact-body digest ledger claims each body before
  XDK decryption. Completed captures survive process restart, concurrent copies
  stop at that cheap boundary, and failed work releases its owned claim so X
  can retry. Convex also durably deduplicates the hashed `event_uuid` and signed
  `message_id`; the process replay cache suppresses alternate-body hot
  duplicates after successful admission.
- `chat.received` is the only admitted event type. Key-change events are
  signature checked first. The decrypted event must itself have
  `verified === true`, type `message`, and text content.
- Raw X user IDs and conversation IDs never cross the bridge boundary. Their
  HMAC hashes are stored in Convex. Plaintext is AES-256-GCM encrypted with AAD
  `xchat:inbound:<hashed-event-uuid>` before admission.
- The Chat XDK bot PIN, OAuth tokens, private material, conversation keys,
  message bodies, and provider routing IDs are never logged.
- Every process start fetches the authenticated bot's current public-key
  records from X. The bridge selects the newest record carrying
  `juicebox_config`, validates and uses only its fresh `token_map` realm
  credentials, recovers the private identity with `X_CHAT_PIN`, then adopts
  the key version whose registered `public_key` matches the recovered key.
  Startup fails closed if the response, realm map, recovery, or key match is
  invalid. No static Juicebox config, realm-token map, or key version is read
  from Railway.
- `XCHAT_VAULT_ENCRYPTION_KEY` is intentionally distinct from the Convex route
  key. Rotate it only with an offline vault migration or after discarding the
  vault and rehydrating conversation keys through verified X events.

## Identity binding

An unbound verified sender receives an expiring
`https://buddybox.buddytools.org/connect/xchat?claim=...` URL. After Clerk attaches
that claim and displays a short code, the same X account sends exactly
`BUDDYBOX-<code>`. Convex compares the code hash and sender hash and consumes the
challenge atomically. Google remains the general Clerk login; the X OAuth token
here is only the BuddyBox bot's user-context authorization.

The bridge creates the claim token and commits the exact claim-reply intent to
its encrypted vault before Convex admission. Convex receives only the token
hash and expiry; the raw token exists only inside the encrypted bridge record
and the eventual X ciphertext. Preparation can therefore resume after an
ambiguous admission response or duplicate webhook without minting another
claim. The prepared SDK payload is persisted before any send, so all network
retries are byte-identical. If the pre-admission commit fails, Convex is not
called and the one-replica bridge retains the same intent for the provider
retry.

## Durable outbound delivery

The bridge polls the authenticated Convex operation `lease_outbound`. Each
lease carries an AES-GCM payload plus its exact AAD. Before the first X request,
the bridge decrypts it, invokes `encryptMessage` once, and persists the prepared
ciphertext, signature, and SDK-generated message ID in its encrypted vault.
Every retry sends those identical bytes. After X accepts the request, the vault
is marked accepted before settlement; if settlement fails, a reclaimed lease
settles without sending again.

Mount a persistent Railway volume at `/data`. Losing the volume does not expose
messages, but it removes the prepared-send recovery record and verified
conversation-key cache. Do not run multiple replicas against the same local
vault; use one replica or replace `SecureVault` with a transactional encrypted
shared store.

## Control-plane operations

All requests are `{ operation, input }` to `CONVEX_XCHAT_BROKER_URL`, authorized
with `Bearer $BUDDYBOX_BRIDGE_SECRET`:

- `admit_inbound`
- `complete_challenge`
- `lease_outbound`
- `settle_outbound`

Convex stores only hashes and AES-GCM envelopes. Outbound producers seal
`{ conversationId, text }` using AAD
`xchat:outbound:<idempotencyKey>`; `lease_outbound` returns that AAD verbatim.

## Deploy

```sh
bun install
bun run --cwd apps/xchat-bridge verify
docker build -f apps/xchat-bridge/Dockerfile -t buddybox-xchat-bridge .
```

Provisioning is an idempotent JSON command with five phases:

```sh
bun run --cwd apps/xchat-bridge provision -- status
bun run --cwd apps/xchat-bridge provision -- identity
bun run --cwd apps/xchat-bridge provision -- identity-rotate
bun run --cwd apps/xchat-bridge provision -- webhook
bun run --cwd apps/xchat-bridge provision -- subscription
bun run --cwd apps/xchat-bridge provision -- all
```

`status` only inspects. `webhook` reuses a registration only when its URL is an
exact `X_WEBHOOK_URL` match, and `subscription` reuses only the exact
`chat.received` + bot user + webhook + `buddybox-xchat` tag tuple. X Activity
listing and creation use the App bearer; the bot's OAuth user grant and scopes
authorize its private Chat event eligibility. `all` may create the webhook and
subscription, but never generates or registers identity keys. The explicit
`identity` phase performs the official first-boot sequence: generate a key,
reconcile it against the account, register it once when absent, fetch the new
Juicebox config, store the private identity under `X_CHAT_PIN`, and only then
write a completion marker to the encrypted `/data` vault. Weak PINs are rejected
before the rate-limited public-key write. A pending marker is written before the
POST so a crash or ambiguous response can never cause an automatic second key;
definite non-application responses such as `429` clear that marker for a safe
retry in the next window.

If the account already has keys that the configured PIN cannot recover, rotation
is never automatic. Run `identity-rotate` only with the one-command environment
confirmation `X_CHAT_ROTATION_CONFIRM_USER_ID=<exact numeric bot user id>`; this
deliberately consumes the account's limited public-key registration budget.

Webhook and Activity management use the separate provisioning-only
`X_APP_BEARER_TOKEN`; the long-running bridge does not read or require it.
Provider JSON is validated before use, and command failures emit only redacted
machine-readable codes. Identity status is ready only when the OAuth grant
resolves to `X_CHAT_USER_ID`, fresh Juicebox material unlocks with the configured
PIN, and the recovered key matches an account public key. The runtime repeats
those recovery checks before accepting traffic.

Copy `.env.example` into Railway secrets, mount `/data`, deploy one replica,
register `https://<railway-host>/v1/xchat/webhook`, then create the
`chat.received` activity subscription for `X_CHAT_USER_ID`. Production is ready
only after the X developer App, OAuth user grant, PIN-backed public Chat key
record, webhook, and subscription exist and `/readyz` succeeds.

Current official sources and implementation conclusions are captured in
[`docs/xchat-api-research.md`](./docs/xchat-api-research.md).
