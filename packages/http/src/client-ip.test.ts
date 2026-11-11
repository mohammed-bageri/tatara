import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip.ts";

/** Node-server bindings as @hono/node-server passes them, so getConnInfo resolves. */
const socket = { incoming: { socket: { remoteAddress: "10.0.0.1", remotePort: 51234 } } };

async function ipFor(
	headers: Record<string, string>,
	options: Parameters<typeof clientIp>[1],
	bindings?: unknown,
) {
	const app = new Hono();
	app.get("/", (c) => c.text(clientIp(c, options) ?? "none"));
	return (await app.request("/", { headers }, bindings)).text();
}

describe("clientIp", () => {
	it("reads the app's proxy header when it holds an address", async () => {
		expect(await ipFor({ "x-real-ip": "203.0.113.7" }, { trustedHeader: "x-real-ip" })).toBe(
			"203.0.113.7",
		);
	});

	it("ignores that header when it is not an address, and falls back to X-Forwarded-For", async () => {
		expect(
			await ipFor(
				{ "x-real-ip": "evil", "x-forwarded-for": "198.51.100.1, 203.0.113.9" },
				{ trustedHeader: "x-real-ip", trustedHops: 1 },
			),
		).toBe("203.0.113.9");
	});

	it("never reads a header it was not told to trust", async () => {
		expect(await ipFor({ "x-real-ip": "203.0.113.7" }, {})).toBe("none");
	});

	it("falls back to the socket address when the trusted header is not an IP", async () => {
		expect(
			await ipFor({ "x-forwarded-for": "1.2.3.4, not-an-ip" }, { trustedHops: 1 }, socket),
		).toBe("10.0.0.1");
	});

	it("falls back to the socket address when the trusted header is empty", async () => {
		// the proxy's (empty) entry must not hand trust to the client-sent one before it
		expect(await ipFor({ "x-forwarded-for": "1.2.3.4, " }, { trustedHops: 1 }, socket)).toBe(
			"10.0.0.1",
		);
	});
});
