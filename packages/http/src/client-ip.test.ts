import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip.ts";

async function ipFor(headers: Record<string, string>, options: Parameters<typeof clientIp>[1]) {
	const app = new Hono();
	app.get("/", (c) => c.text(clientIp(c, options) ?? "none"));
	return (await app.request("/", { headers })).text();
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
});
