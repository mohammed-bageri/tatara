---
"@tatara/realtime": minor
"@tatara/cli": patch
---

Realtime events reach clients as one `rt` envelope (`{ id, v, ch, ev, ts, data }`). Subscribe and
unsubscribe acks are `{ ok, channel, code? }` with a machine deny code. `disconnectUser` and
`disconnectOrg` take a reason and send `rt:closed { reason }` before closing; the socket lifetime
is jittered by ±10% and closes with `session_invalid`. Channels may declare `permission` and
`feature`, checked by the new `checkPermission` and `featureAllowed` options; `authorize` is
optional; `attach` rejects reserved, malformed and duplicate names. `publishTo` is typed by the
channel and never throws: a bad param, event or payload is logged and dropped. `SocketIdentity`
takes an optional `sessionId`. The CLI's realtime template and agent notes follow the new format.
