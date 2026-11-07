/** Its own file: OpenTelemetry's tracer provider is a process global, one SDK per test file. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { httpTracing, startTelemetry } from "./index.ts";

/** An OTLP/HTTP receiver that keeps what it's sent. */
async function receiver() {
	const received: { path: string; body: string }[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			received.push({ path: req.url ?? "", body });
			res.writeHead(200, { "content-type": "application/json" }).end("{}");
		});
	});
	await new Promise<void>((r) => server.listen(0, r));
	return {
		received,
		url: `http://localhost:${(server.address() as AddressInfo).port}`,
		close: () => server.close(),
	};
}

describe("telemetry span processors", () => {
	it("runs the app's span processors before export", async () => {
		const otlp = await receiver();
		const sdk = startTelemetry({
			serviceName: "test-app",
			endpoint: otlp.url,
			autoInstrument: false,
			spanProcessors: [
				{
					onStart() {},
					onEnding(span) {
						span.setAttribute("redacted.by", "processor");
					},
					onEnd() {},
					forceFlush: async () => {},
					shutdown: async () => {},
				},
			],
		});
		const app = new Hono();
		app.use(httpTracing("test-app"));
		app.get("/secret", (c) => c.text("ok"));
		expect((await app.request("/secret")).status).toBe(200);
		await sdk?.shutdown();
		otlp.close();
		const body = otlp.received
			.filter((r) => r.path === "/v1/traces")
			.map((r) => r.body)
			.join("");
		expect(body).toContain("redacted.by");
	});
});
