# @tatara/realtime

Part of [tatara](https://github.com/mohammed-bageri/tatara-cli).

socket.io for tatara apps: a client trades a single-use ticket (from an authenticated route) for a
socket bound to its user and org. Every socket joins its user's and org's rooms; module channels
(`defineChannel`) add rooms a client subscribes to. `publishToUser`, `publishToOrg` and
`publishTo(channel)` work from any process (through Redis) and never throw, and
`disconnectUser` / `disconnectOrg` close sockets when access changes.

Wire format:

- Every event arrives on `"rt"` as `{ id, v: 1, ch, ev, ts, data }`. `ch` is `"org"`,
  `"user:<userId>"`, or the channel name with its params bound; `id` is for deduping.
- `emit("subscribe" | "unsubscribe", name, ack)` acks `{ ok, channel, code? }`. `code` is one of
  `CHANNEL_UNKNOWN`, `CHANNEL_INVALID` (both final), `ENTITLEMENT_DENIED`, `PERMISSION_DENIED`,
  `TOO_MANY_SUBSCRIPTIONS`, `FORBIDDEN`.
- Before the server closes a socket it sends `"rt:closed" { reason }`: the reason given to
  `disconnectUser` / `disconnectOrg`, or `session_invalid` when the socket's lifetime (±10%) ends.

A channel may declare a `permission` and a `feature`; subscribing checks them with the
`checkPermission` and `featureAllowed` options (feature, then permission, then `authorize`).
`attach` rejects reserved (`org`, `user`), malformed or duplicate channel names.
