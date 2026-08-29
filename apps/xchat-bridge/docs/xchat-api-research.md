# X Chat API implementation notes

Primary-source review performed 2026-08-14 and refreshed 2026-08-28 against
the official Chat XDK, xurl recovery implementation, TypeScript XDK, and
`xchat-agent-skeleton`.

- X Chat transports encrypted, signed message events. The Chat XDK is the
  supported encryption/decryption/signature layer, while X API routes carry
  ciphertext and public/wrapped keys. [Introduction](https://docs.x.com/xchat/introduction)
- The official agent skeleton reads the primary inbox through
  `GET /2/chat/conversations`, hydrates ciphertext and key-change history from
  `GET /2/chat/conversations/{id}/events`, and uses `GET /2/activity/stream` to
  discover Message-request threads. X Chat agent delivery is not built around
  an Account Activity webhook.
- Direct Activity subscriptions are created for `chat.received` and
  `chat.conversation.join` with the bot user filter and no webhook ID. The
  user-context grant manages subscriptions; the app-only bearer reads the
  stream.
- Private chat subscriptions require OAuth 2.0 user context (including
  `dm.read`), and sending requires `dm.write`; DM scopes also require
  `users.read` and `tweet.read`. [Real-time events](https://docs.x.com/xchat/real-time-events)
- For sending, use the SDK-generated `message_id` and map
  `encryptedContent` to `encoded_message_create_event` and
  `encodedEventSignature` to `encoded_message_event_signature`. A retry must
  resend the same prepared ciphertext and message ID, never re-encrypt.
  [Getting started](https://docs.x.com/xchat/getting-started)
- Signature rejection is enabled by default in the Chat XDK. Signing keys must
  come from the public-key API, not an untrusted event, and their identity-key
  bindings should be verified. Only a verified text event may become agent
  input. [Chat XDK](https://docs.x.com/xchat/xchat-xdk)
- `GET /2/users/{id}/public_keys` returns every public-key field, including
  `juicebox_config`; the official xurl and Chat XDK examples intentionally send
  no `public_key.fields` query parameter.
- Bot/server private material may use a protected key blob or secure key
  backup. PINs, private keys, unwrapped conversation keys, OAuth tokens, and
  plaintext must never enter logs. OAuth revocation does not revoke private
  keys already obtained. [Private-key guidance](https://docs.x.com/xchat/handling-private-keys)

The bridge uses the official JavaScript Chat XDK secure-backup path. At each
startup it fetches the bot's current public-key records, selects the newest
record carrying `juicebox_config`, and derives the realm authorization map
only from that response's `token_map`. After PIN recovery it matches the
recovered identity public key against the account's registered keys and adopts
that record's version. The PIN remains a deployment secret; Juicebox config,
realm tokens, and key version are not static deployment inputs. Verified
conversation keys, OAuth refresh state, and prepared outbound ciphertext are
encrypted again in a persistent local vault.

The delivery loop ports the skeleton's safety behavior: hydrate all available
history once, reply only to the newest inbound event from the last 48 hours,
persist seen outer event IDs, then process new events in chronological order.
Activity notifications trigger an authenticated conversation read instead of
trusting notification payloads as agent input.
