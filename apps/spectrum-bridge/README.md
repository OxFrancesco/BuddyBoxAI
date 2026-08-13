# iChef Spectrum bridge

The Spectrum bridge is iChef's persistent iMessage channel adapter. It verifies
Photon Spectrum webhook deliveries or consumes Spectrum's authenticated gRPC
stream, normalizes them into one bounded message contract, and admits each
message through the trusted Convex control plane. It also delivers queued
outbound replies through `spectrum-ts`.

The bridge is deliberately not an identity authority. An iMessage address is a
routing identifier until Convex binds it to a Clerk User through the expiring
return-message challenge below.

## Interfaces

- `GET /healthz` — process liveness only; it never reports credentials or
  provider identifiers.
- `POST /v1/spectrum/webhook` — Spectrum's raw JSON webhook. The bridge verifies
  `X-Spectrum-Signature` against the exact raw bytes, checks the five-minute
  timestamp window and optional webhook ID, bounds the body, then waits for
  durable Convex admission before returning `202`.
- `POST /v1/outbound` — trusted Convex-to-bridge delivery. Requires
  `Authorization: Bearer $ICHEF_BRIDGE_SECRET`; the JSON body is limited to 32
  KiB and the text to 6,000 characters.

Webhook mode is the production default because Spectrum can retry a non-2xx
response. `grpc` is available for environments that cannot register a webhook;
`hybrid` is a migration mode, with message-ID deduplication in Convex suppressing
the second delivery.

## Clerk-bound iMessage connection flow

1. An unbound address sends iChef a message. `accept_inbound` atomically records
   the provider message ID and creates an expiring, one-use claim URL bound to
   the keyed address hash. The returned outbound copy contains that URL.
2. The User opens the URL and signs in with Clerk. The portal attaches the
   pending challenge to that Clerk User and displays a short code. The raw
   address is not identity proof.
3. The User sends exactly `ICHEF-<code>` from the same iMessage address.
4. The bridge calls `complete_challenge`; Convex verifies the code, expiry,
   one-use state, address hash, and Clerk owner in one transaction before it
   marks the iMessage Connection verified.

Ordinary messages from an unverified address carry no User authority. Sensitive
connection changes should create a fresh challenge even after initial binding.

## Convex broker contract

Set `CONVEX_BRIDGE_URL` to a private Convex HTTP action that accepts this
envelope and authenticates the bearer credential before reading its body:

```ts
type BrokerRequest =
  | { operation: "accept_inbound"; input: NormalizedInbound }
  | { operation: "complete_challenge"; input: ChallengeAttempt }
  | {
      operation: "claim_outbound";
      input: { outboundId: string; idempotencyKey: string };
    }
  | { operation: "settle_outbound"; input: OutboundSettlement };

type BrokerResponse<T> = { ok: true; result: T };
```

The exact result unions live in [`src/types.ts`](./src/types.ts). Required
control-plane behavior:

- `accept_inbound` deduplicates on `spectrum:imessage:<message.id>` and resolves
  exactly one verified iMessage Connection by `addressHash`. It persists the
  body and attachment metadata only after ownership resolution, then schedules
  the Conversation/Run or returns an onboarding reply.
- `complete_challenge` consumes an expiring challenge atomically. Hash and
  compare the received code server-side; never store it in plaintext.
- `claim_outbound` leases an outbound delivery by its idempotency key. Return
  `claimed`, `in_flight`, or `already_delivered`.
- `settle_outbound` makes `delivered` terminal. `failed_retryable` remains
  eligible for a later Convex-scheduled call to `/v1/outbound`.

If Spectrum accepts a send but Convex settlement is temporarily unavailable,
the bridge returns `settlement_pending` and does not send the provider message
again. Keep the outbound lease in-flight and reconcile that ambiguous record;
expiring the lease into an automatic resend can duplicate a message because
Spectrum does not expose a send idempotency key.

The broker is intentionally a small typed seam. It prevents the bridge from
learning Convex table layout or receiving a Clerk session, while Convex retains
all identity and idempotency invariants.

## Message and attachment bounds

The normalizer accepts text, one attachment, or a non-nested Spectrum group.
Text is limited to 16,000 characters. At most four attachments are accepted,
each must advertise an integer byte size no greater than 10 MiB, and the group
total may not exceed 20 MiB. Only stable attachment ID, filename, MIME type,
kind, and size cross the interface; webhook payloads never contain attachment
bytes. Fetching bytes later must use Spectrum's `getAttachment` and enforce the
same limit while streaming.

Unknown content arms receive a successful no-op so a future Spectrum addition
does not create a retry storm. Invalid and oversized signed payloads receive
`400` and `413` respectively.

## Privacy and logging

The bridge never logs message bodies, addresses, space/line identifiers,
challenge codes, authorization headers, or secrets. The logger accepts a fixed
set of operational event names and safe error codes only. Spectrum telemetry is
disabled and its SDK logger is set to `silent`; enable external telemetry only
after auditing its redaction policy.

The normalized address is HMAC-SHA256 pseudonymized with
`ICHEF_ADDRESS_PEPPER`. Rotate that key only with a migration plan because it is
part of the connection lookup identity. Spectrum `spaceId` and `lineId` remain
sensitive provider routing references (a DM space ID may embed an address), so
the control plane must encrypt them at rest and must never place them in logs.

## Local verification

```sh
bun install
bun run --cwd apps/spectrum-bridge verify
```

Copy `.env.example` to an ignored environment file, register
`https://<host>/v1/spectrum/webhook` in Spectrum Cloud, and preserve the signing
secret returned at webhook creation. The production image and Railway service
use the repository root as build context:

```sh
docker build -f apps/spectrum-bridge/Dockerfile -t ichef-spectrum-bridge .
docker run --env-file apps/spectrum-bridge/.env.local -p 3000:3000 ichef-spectrum-bridge
```

Official protocol references:

- [Spectrum webhook events](https://photon.codes/docs/webhooks/events)
- [Spectrum TypeScript SDK](https://github.com/photon-hq/spectrum-ts)
