/** @tatara/observability: OpenTelemetry over OTLP, Hono request tracing, and trace ids in logs. */
import { httpInstrumentationMiddleware } from "@hono/otel";
import { trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
	BatchSpanProcessor,
	ParentBasedSampler,
	type SpanProcessor,
	TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace";
import { onShutdown } from "@tatara/core";
import type { MiddlewareHandler } from "hono";

export interface TelemetryOptions {
	serviceName: string;
	serviceVersion?: string;
	/** the OTLP/HTTP base URL, e.g. http://localhost:4318; without it nothing starts */
	endpoint?: string;
	/** e.g. an API key header for a hosted backend (Honeycomb, Grafana Cloud…) */
	headers?: Record<string, string>;
	/** share of new traces to keep, 0–1 (default 1); a request's parent decides for it */
	sampleRatio?: number;
	/** how often metrics go out (default 60s) */
	metricsIntervalMs?: number;
	/** auto-instrument the libraries the app uses (pg, ioredis, http, fetch…); default true */
	autoInstrument?: boolean;
	/** run on every span before it is exported, in order (e.g. to redact secrets from attributes) */
	spanProcessors?: SpanProcessor[];
}

/** Starts OpenTelemetry for this process and flushes it on shutdown; null when no endpoint is set. */
export function startTelemetry(options: TelemetryOptions): NodeSDK | null {
	if (!options.endpoint) return null;
	const base = options.endpoint.replace(/\/$/, "");
	const sdk = new NodeSDK({
		resource: resourceFromAttributes({
			"service.name": options.serviceName,
			...(options.serviceVersion ? { "service.version": options.serviceVersion } : {}),
		}),
		spanProcessors: [
			...(options.spanProcessors ?? []),
			new BatchSpanProcessor({
				exporter: new OTLPTraceExporter({ url: `${base}/v1/traces`, headers: options.headers }),
			}),
		],
		metricReaders: [
			new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers: options.headers }),
				exportIntervalMillis: options.metricsIntervalMs ?? 60_000,
			}),
		],
		// a caller's "sampled" flag can't push sampling past the ratio (it would bill you for its traffic)
		sampler: new ParentBasedSampler({
			root: new TraceIdRatioBasedSampler(options.sampleRatio ?? 1),
			remoteParentSampled: new TraceIdRatioBasedSampler(options.sampleRatio ?? 1),
		}),
		instrumentations:
			options.autoInstrument === false
				? []
				: [
						getNodeAutoInstrumentations({
							// noisy, and file reads are rarely what's slow
							"@opentelemetry/instrumentation-fs": { enabled: false },
							// httpTracing makes the server span, with the route. Not patching the server at all:
							// an *ignored* request would suppress tracing for everything inside it
							"@opentelemetry/instrumentation-http": {
								disableIncomingRequestInstrumentation: true,
							},
						}),
					],
	});
	sdk.start();
	onShutdown("telemetry", () => sdk.shutdown());
	return sdk;
}

/** Traces each Hono request (route, status, duration) as a span, joining an incoming trace. */
export function httpTracing(serviceName: string): MiddlewareHandler {
	// typed with the app's own Hono, not the one @hono/otel was built against
	return httpInstrumentationMiddleware({ serviceName }) as unknown as MiddlewareHandler;
}

/** For pino's `mixin`: the active trace and span ids, so a log line links to its trace. */
export function traceIds(): Record<string, string> {
	const span = trace.getActiveSpan()?.spanContext();
	return span ? { trace_id: span.traceId, span_id: span.spanId } : {};
}
