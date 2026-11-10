/** Its own file: OpenTelemetry's tracer provider is a process global, one SDK per test file. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { httpTracing, startTelemetry } from "./index.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

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

describe("startTelemetry with redactPath", () => {
	it("exports request spans with the secret path segment redacted, leaving other spans alone", async () => {
		const otlp = await receiver();
		const sdk = startTelemetry({
			serviceName: "test-app",
			endpoint: otlp.url,
			autoInstrument: false,
			redactPath: (text) => text.replace(/(\/offer\/)[^/?#\s]+/g, "$1[redacted]"),
		});
		const app = new Hono();
		app.use(httpTracing("test-app"));
		app.get("/offer/:token", (c) => c.text("ok"));
		app.get("/health", (c) => c.text("ok"));
		expect((await app.request(`http://localhost/offer/${TOKEN}`)).status).toBe(200);
		expect((await app.request("http://localhost/health")).status).toBe(200);
		await sdk?.shutdown();
		otlp.close();
		const body = otlp.received
			.filter((r) => r.path === "/v1/traces")
			.map((r) => r.body)
			.join("");
		expect(body).toContain("http://localhost/offer/[redacted]");
		expect(body).toContain("http://localhost/health");
		expect(body).not.toContain(TOKEN);
	});
});
