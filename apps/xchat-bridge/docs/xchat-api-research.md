# X Chat API implementation notes

Primary-source review performed 2026-08-14 and refreshed 2026-08-24 against
the official Chat XDK and xurl recovery implementations.

- X Chat transports encrypted, signed message events. The Chat XDK is the
  supported encryption/decryption/signature layer, while X API routes carry
  ciphertext and public/wrapped keys. [Introduction](https://docs.x.com/xchat/introduction)
- Live deliveries use `chat.received`, `chat.sent`, and
  `chat.conversation_join`. The live message is `payload.encoded_event`; an
  optional `conversation_key_change_event` must be verified/applied before its
  dependent message. Deduplicate delivery by `event_uuid` and message by the
  signed `message_id`. [Real-time events](https://docs.x.com/xchat/real-time-events)
- Webhook GET CRC is HMAC-SHA256 over `crc_token` with the App consumer secret,
  base64 encoded and prefixed `sha256=`. POST authenticity is the
  `x-twitter-webhooks-signature` HMAC over the exact raw body. Webhooks must
  acknowledge within ten seconds and can deliver duplicates.
  [Webhook quickstart](https://docs.x.com/x-api/webhooks/quickstart)
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
