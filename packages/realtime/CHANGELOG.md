# @tatara/realtime

## 0.4.0

### Minor Changes

- e3b78b2: 4xx errors take `(message?, { code?, details? })`: a specific code for the client (translated as `errors.<code>`), and details. NotFoundError's argument is its message now ("Job not found"); `tatara upgrade` rewrites existing calls (0.21 codemod). `realtime.attach(server, { channels, checkPermission, featureAllowed })` takes the channel checks, for apps whose authz lives in a module.

## 0.3.2

### Patch Changes

- 9b9ac7f: The repository moved to github.com/mohammed-bageri/tatara (was tatara-cli); package metadata and docs point there.
- Updated dependencies [9b9ac7f]
  - @tatara/core@0.2.1

## 0.3.1

### Patch Changes

- Updated dependencies [1882c35]
  - @tatara/core@0.2.0

## 0.3.0

### Minor Changes

- 49c20e5: Add `health()`, `metrics()` (with an optional OpenTelemetry-shaped `meter`), and `close()` that leaves the HTTP server running; socket options `transports`, `maxSocketsPerUser` (default 10, `rt:closed { reason: "too_many_connections" }`), `maxFrameBytes` (default 8 KB) and `requireOrigin`; compression off. New `realtime:channels` command lists the app's channels.

## 0.2.0

### Minor Changes

- 641e260: Realtime events reach clients as one `rt` envelope (`{ id, v, ch, ev, ts, data }`). Subscribe and
  unsubscribe acks are `{ ok, channel, code? }` with a machine deny code. `disconnectUser` and
  `disconnectOrg` take a reason and send `rt:closed { reason }` before closing; the socket lifetime
  is jittered by ±10% and closes with `session_invalid`. Channels may declare `permission` and
  `feature`, checked by the new `checkPermission` and `featureAllowed` options; `authorize` is
  optional; `attach` rejects reserved, malformed and duplicate names. `publishTo` is typed by the
  channel and never throws: a bad param, event or payload is logged and dropped. `SocketIdentity`
  takes an optional `sessionId`. The CLI's realtime template and agent notes follow the new format.

## 0.1.1

### Patch Changes

- c0671ca: Publishing never throws or hangs: failures are logged and dropped

## 0.1.0

### Minor Changes

- 3d71569: `@tatara/realtime`: socket.io with single-use tickets (through the cache), per-user and per-org rooms, module channels (`defineChannel`: a name pattern, `authorize`, zod-checked events), `publishToUser` / `publishToOrg` / `publishTo` from any process (Redis adapter and emitter; a publish has left the process when it resolves), `disconnectUser` / `disconnectOrg`, and a `realtime:publish` command. New `realtime` add-on: `POST /api/realtime/ticket`, the api attaches sockets on its own port (`startServer({ onServer })`), `channels/*.ts` convention, and with notifications every inbox entry is pushed as `notification.created`.

### Patch Changes

- Updated dependencies [315003d]
  - @tatara/core@0.1.2
