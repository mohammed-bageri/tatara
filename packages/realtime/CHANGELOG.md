# @tatara/realtime

## 0.1.1

### Patch Changes

- c0671ca: Publishing never throws or hangs: failures are logged and dropped

## 0.1.0

### Minor Changes

- 3d71569: `@tatara/realtime`: socket.io with single-use tickets (through the cache), per-user and per-org rooms, module channels (`defineChannel`: a name pattern, `authorize`, zod-checked events), `publishToUser` / `publishToOrg` / `publishTo` from any process (Redis adapter and emitter; a publish has left the process when it resolves), `disconnectUser` / `disconnectOrg`, and a `realtime:publish` command. New `realtime` add-on: `POST /api/realtime/ticket`, the api attaches sockets on its own port (`startServer({ onServer })`), `channels/*.ts` convention, and with notifications every inbox entry is pushed as `notification.created`.

### Patch Changes

- Updated dependencies [315003d]
  - @tatara/core@0.1.2
