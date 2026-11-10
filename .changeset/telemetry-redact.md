---
"@tatara/observability": minor
---

`startTelemetry({ redactPath })` hides path secrets from span names and attributes (`RedactingSpanProcessor`); an endpoint given with its `/v1/traces` path works too.
