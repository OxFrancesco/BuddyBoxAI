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

Copy `.env.example` into Railway secrets, mount `/data`, deploy one replica,
register `https://<railway-host>/v1/xchat/webhook`, then create the
`chat.received` activity subscription for `X_CHAT_USER_ID`. Production remains
blocked until the X developer App, OAuth user grant, public Chat key record,
secure-backup realm tokens, webhook, and subscription exist.

Current official sources and implementation conclusions are captured in
[`docs/xchat-api-research.md`](./docs/xchat-api-research.md).
