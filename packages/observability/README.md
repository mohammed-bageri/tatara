# @tatara/observability

Part of [tatara](https://github.com/mohammed-bageri/tatara).

`startTelemetry({ serviceName, endpoint })` starts OpenTelemetry (traces and metrics over OTLP/HTTP,
Node auto-instrumentation) and stops it on shutdown; without an endpoint it does nothing.
`httpTracing()` traces Hono requests, and `traceIds()` puts the trace and span ids on log lines.
Load it before the app (`node --import`) so instrumentation can patch the libraries it loads.
