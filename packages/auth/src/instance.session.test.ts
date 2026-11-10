import type { BetterAuthOptions } from "better-auth";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createAuthInstance, isBannedNow, withClientIpHeader } from "./index.ts";

const base = {
	secret: "test-secret-that-is-at-least-32-characters",
	baseURL: "http://localhost",
	basePath: "/api/auth",
} satisfies BetterAuthOptions;

const IP = "x-app-client-ip";

describe("withClientIpHeader", () => {
	it("points better-auth at the one header, keeping the other advanced settings", () => {
		const result = withClientIpHeader(
			{ advanced: { cookiePrefix: "staff", ipAddress: { ipv6Subnet: 48 } } },
			IP,
		);
		expect(result.advanced).toEqual({
			cookiePrefix: "staff",
			ipAddress: { ipv6Subnet: 48, ipAddressHeaders: [IP] },
		});
	});
});

describe("handleRequest with clientIp", () => {
	// better-auth's memory rate-limit store is process-wide: each test uses its own addresses
	function authApp(resolve: (c: { req: { header(name: string): string | undefined } }) => string) {
		const { handleRequest } = createAuthInstance(
			{
				...base,
				rateLimit: {
					enabled: true,
					storage: "memory",
					window: 60,
					max: 100,
					customRules: { "/ok": { window: 60, max: 1 } },
				},
			},
			{ clientIp: { header: IP, resolve: (c) => resolve(c) || undefined } },
		);
		const app = new Hono();
		app.all("/api/auth/*", (c) => handleRequest(c));
		return app;
	}

	it("keys rate limits on the resolved address, not on headers the client sent", async () => {
		const app = authApp((c) => c.req.header("x-real-ip") ?? "");
		const ok = (spoof: string) =>
			app.request("/api/auth/ok", {
				headers: { "x-real-ip": "5.6.7.8", "x-forwarded-for": spoof, [IP]: spoof },
			});
		expect((await ok("198.51.100.1")).status).toBe(200);
		expect((await ok("198.51.100.2")).status).toBe(429);
	});

	it("gives distinct resolved addresses distinct buckets", async () => {
		const app = authApp((c) => c.req.header("x-real-ip") ?? "");
		const ok = (ip: string) => app.request("/api/auth/ok", { headers: { "x-real-ip": ip } });
		expect((await ok("5.6.7.20")).status).toBe(200);
		expect((await ok("5.6.7.21")).status).toBe(200);
	});

	it("hands better-auth the resolved address, a fail-closed stand-in, and the body", async () => {
		const { auth, handleRequest } = createAuthInstance(base, {
			clientIp: { header: IP, resolve: (c) => c.req.header("x-real-ip") },
		});
		const seen: Request[] = [];
		vi.spyOn(auth, "handler").mockImplementation(async (request) => {
			seen.push(request);
			return new Response(await request.text());
		});
		const app = new Hono();
		app.post("/", (c) => handleRequest(c));
		const res = await app.request("/", {
			method: "POST",
			headers: { "x-real-ip": "5.6.7.8", [IP]: "6.6.6.6", "content-type": "text/plain" },
			body: "payload",
		});
		expect(await res.text()).toBe("payload");
		expect(seen[0]?.headers.get(IP)).toBe("5.6.7.8");
		expect(seen[0]?.headers.get("content-type")).toBe("text/plain");
		await app.request("/", { method: "POST", headers: { [IP]: "6.6.6.6" } });
		expect(seen[1]?.headers.get(IP)).toBe("0.0.0.0");
	});

	it("passes the request through untouched without clientIp", async () => {
		const { auth, handleRequest } = createAuthInstance(base);
		const handler = vi.spyOn(auth, "handler").mockResolvedValue(new Response("ok"));
		const app = new Hono();
		app.get("/", (c) => handleRequest(c));
		await app.request("/", { headers: { "x-forwarded-for": "1.2.3.4" } });
		expect(handler.mock.calls[0]?.[0].headers.get("x-forwarded-for")).toBe("1.2.3.4");
	});
});

describe("attachSession and requireSession", () => {
	function appWith(
		user: Record<string, unknown> | null,
		onUnauthorized?: (c: { json(body: unknown, status: 401): Response }) => Response,
	) {
		const instance = createAuthInstance(base, {
			clientIp: { header: IP, resolve: () => "5.6.7.8" },
			...(onUnauthorized ? { onUnauthorized: (c) => onUnauthorized(c as never) } : {}),
		});
		const getSession = vi
			.spyOn(instance.auth.api, "getSession")
			.mockResolvedValue((user ? { session: { id: "s1" }, user } : null) as never);
		const app = new Hono();
		app.onError((err, c) => c.json({ error: err.message }, 401));
		app.use("*", instance.attachSession, instance.requireSession);
		app.get("/", (c) => c.json({ user: c.get("user" as never) }));
		return { app, getSession };
	}
	const user = { id: "u1", email: "u1@example.com", name: "U" };
	const hour = 3_600_000;

	it("sets the session user, never forwarding a client-sent client-IP header", async () => {
		const { app, getSession } = appWith(user);
		const res = await app.request("/", { headers: { [IP]: "6.6.6.6", cookie: "a=b" } });
		expect(await res.json()).toEqual({ user });
		const headers = getSession.mock.calls[0]?.[0]?.headers as Headers;
		expect(headers.get(IP)).toBeNull();
		expect(headers.get("cookie")).toBe("a=b");
	});

	it("401s without a session, and for a ban in force", async () => {
		expect((await appWith(null).app.request("/")).status).toBe(401);
		expect((await appWith({ ...user, banned: true }).app.request("/")).status).toBe(401);
		const banExpires = new Date(Date.now() + hour).toISOString();
		expect((await appWith({ ...user, banned: true, banExpires }).app.request("/")).status).toBe(
			401,
		);
	});

	it("lets through a lapsed ban, an unbanned user and one without ban fields", async () => {
		const banExpires = new Date(Date.now() - hour).toISOString();
		expect((await appWith({ ...user, banned: true, banExpires }).app.request("/")).status).toBe(
			200,
		);
		expect((await appWith({ ...user, banned: false }).app.request("/")).status).toBe(200);
		expect((await appWith(user).app.request("/")).status).toBe(200);
	});

	it("answers with the app's own response when given onUnauthorized", async () => {
		const res = await appWith(null, (c) => c.json({ code: "UNAUTHORIZED" }, 401)).app.request("/");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ code: "UNAUTHORIZED" });
	});
});

describe("isBannedNow", () => {
	it("treats an unparseable expiry as in force", () => {
		expect(isBannedNow({ banned: true, banExpires: "not a date" })).toBe(true);
		expect(isBannedNow(undefined)).toBe(false);
	});
});
