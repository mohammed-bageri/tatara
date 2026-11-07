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

Socket server: websocket only by default (`transports`), compression off, client frames capped at
8 KB (`maxFrameBytes`; clients only send subscribe/unsubscribe). A user holds at most 10 sockets per
org on one process (`maxSocketsPerUser`, 0: no cap); past that the new socket gets
`rt:closed { reason: "too_many_connections" }` and closes. The handshake Origin must pass
`allowOrigin`; set `requireOrigin` to also refuse handshakes without one (browsers always send it;
mobile and server-side clients don't, so it is off by default).

Operations:

- `health()` resolves `{ status, driver, adapter, connections, detail: { attached, closed }, error? }`;
  `status` is `"healthy"`, `"unhealthy"` (a Redis connection not ready, or closed) or `"disabled"`
  with the noop driver, which a readiness probe should skip.
- `metrics()` is this process's counts: connections open/opened/rejected (by reason), subscribes
  allowed/denied (by code), events published and failed, disconnects (by reason). Pass
  `meter: metrics.getMeter("app.realtime")` (from `@opentelemetry/api`) to record the same counts
  as `realtime.connections.*`, `realtime.subscribes`, `realtime.events.published` and
  `realtime.disconnects`.
- `close()` closes this process's sockets and Redis connections but not the HTTP server it is
  attached to, so an app can close realtime, then its server, then its database. It is idempotent
  and also runs on shutdown, before `@tatara/http`'s server hook.

Commands (wired by `tatara sync`): `realtime:publish --user <id> --event <name> [--org] [--data]`
sends to a user's sockets; `realtime:channels [--json]` lists the app's channels with their
permission, feature, row-level check and events.
