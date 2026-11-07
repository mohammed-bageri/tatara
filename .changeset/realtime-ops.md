---
"@tatara/realtime": minor
---

Add `health()`, `metrics()` (with an optional OpenTelemetry-shaped `meter`), and `close()` that leaves the HTTP server running; socket options `transports`, `maxSocketsPerUser` (default 10, `rt:closed { reason: "too_many_connections" }`), `maxFrameBytes` (default 8 KB) and `requireOrigin`; compression off. New `realtime:channels` command lists the app's channels.
