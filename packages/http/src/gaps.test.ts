import { createRoute, z } from "@hono/zod-openapi";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import {
	clientIp,
	corsOrigin,
	createApp,
	createRouter,
	cursorPage,
	decodeCursor,
	encodeCursor,
	type HttpEnv,
	handleErrors,
	jsonBody,
	type RateLimitCounter,
	rateLimit,
	trustedClientIp,
	tryDecodeCursor,
} from "./index.ts";

const logger = pino({ level: "silent" });

function app(options: Partial<Parameters<typeof createApp<HttpEnv>>[0]> = {}) {
	return createApp<HttpEnv>({
		logger,
		cors: { origins: ["https://web.example"] },
		bodyLimitBytes: 1024,
		...options,
	});
}

/** A counter like the cache's: a fixed window from the first hit. */
function memoryCounter(): RateLimitCounter & { failing?: boolean } {
	const counts = new Map<string, number>();
	const counter = {
		failing: false,
		async increment(key: string) {
			if (counter.failing) throw new Error("down");
			const next = (counts.get(key) ?? 0) + 1;
			counts.set(key, next);
			return next;
		},
	};
	return counter;
}

describe("rateLimit", () => {
	it("allows max requests per key, then answers 429 RATE_LIMITED with Retry-After", async () => {
		const counter = memoryCounter();
		const a = app();
		a.get(
			"/sign-in",
			rateLimit({
				counter,
				name: "sign-in",
				key: (c) => c.req.header("x-who"),
				windowMs: 60_000,
				max: 2,
			}),
			(c) => c.json({ ok: true }),
		);
		handleErrors(a);
		const hit = (who: string) => a.request("/sign-in", { headers: { "x-who": who } });
		expect((await hit("a")).headers.get("RateLimit-Remaining")).toBe("1");
		expect((await hit("a")).status).toBe(200);
		const limited = await hit("a");
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("60");
		expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" });
		expect((await hit("b")).status).toBe(200);
	});

	it("skips requests without a key, and lets traffic through when the counter fails", async () => {
		const counter = memoryCounter();
		const a = app();
		a.get(
			"/x",
			rateLimit({ counter, name: "x", key: (c) => c.req.header("x-who"), windowMs: 1000, max: 1 }),
			(c) => c.json({ ok: true }),
		);
		handleErrors(a);
		expect((await a.request("/x")).status).toBe(200);
		expect((await a.request("/x")).status).toBe(200);
		counter.failing = true;
		for (let i = 0; i < 3; i++)
			expect((await a.request("/x", { headers: { "x-who": "a" } })).status).toBe(200);
	});
});

describe("client addresses", () => {
	it("trusts only the hops it is told about", () => {
		expect(trustedClientIp("6.6.6.6, 1.2.3.4", 1)).toBe("1.2.3.4");
		expect(trustedClientIp("6.6.6.6, 1.2.3.4, 10.0.0.1", 2)).toBe("1.2.3.4");
		expect(trustedClientIp("1.2.3.4", 5)).toBe("1.2.3.4");
		expect(trustedClientIp("1.2.3.4", 0)).toBeUndefined();
	});

	it("ignores X-Forwarded-For unless proxies are trusted", async () => {
		const a = app();
		a.get("/ip", (c) =>
			c.json({ trusted: clientIp(c, { trustedHops: 1 }) ?? null, raw: clientIp(c) ?? null }),
		);
		const res = await a.request("/ip", { headers: { "x-forwarded-for": "6.6.6.6, 1.2.3.4" } });
		expect(await res.json()).toEqual({ trusted: "1.2.3.4", raw: null });
	});
});

describe("cursor pagination", () => {
	const position = z.object({ createdAt: z.string(), id: z.string() });

	it("round-trips a position and pages with limit + 1 rows", () => {
		const rows = [1, 2, 3].map((n) => ({ id: `r${n}`, createdAt: `2026-01-0${n}` }));
		const page = cursorPage(rows, 2, (r) => ({ createdAt: r.createdAt, id: r.id }));
		expect(page.data).toHaveLength(2);
		expect(decodeCursor(position, page.meta.nextCursor as string)).toEqual({
			createdAt: "2026-01-02",
			id: "r2",
		});
		expect(cursorPage(rows, 3, (r) => r.id).meta.nextCursor).toBeNull();
	});

	it("answers 400 INVALID_CURSOR for a cursor that doesn't decode to a position", async () => {
		const a = app();
		a.get("/list", (c) => c.json(decodeCursor(position, c.req.query("cursor") ?? "")));
		handleErrors(a);
		for (const cursor of ["not-base64!", encodeCursor({ id: 1 }), encodeCursor("x")]) {
			const res = await a.request(`/list?cursor=${encodeURIComponent(cursor)}`);
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ code: "INVALID_CURSOR" });
		}
	});

	it("gives null instead of a 400 from tryDecodeCursor", () => {
		const cursor = encodeCursor({ id: "r1", createdAt: "2026-01-01T00:00:00.000Z" });
		expect(tryDecodeCursor(position, cursor)).toEqual({
			id: "r1",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		for (const bad of ["not-base64!", encodeCursor({ id: 1 }), encodeCursor("x"), ""]) {
			expect(tryDecodeCursor(position, bad)).toBeNull();
		}
	});
});

describe("CORS origins", () => {
	it("matches exact origins and one-label subdomain patterns", () => {
		const allow = corsOrigin(["https://app.example.com", "https://*.schools.example.com"]);
		expect(allow("https://app.example.com")).toBe("https://app.example.com");
		expect(allow("https://alnoor.schools.example.com")).toBe("https://alnoor.schools.example.com");
		expect(allow("https://a.b.schools.example.com")).toBeNull();
		expect(allow("https://schools.example.com")).toBeNull();
		expect(allow("https://evilschools.example.com")).toBeNull();
		expect(allow("http://alnoor.schools.example.com")).toBeNull();
		expect(allow("https://alnoor.schools.example.com.evil.io")).toBeNull();
	});

	it("rejects patterns that would match more than one label", () => {
		expect(() => corsOrigin(["*"])).toThrow(/must look like/);
		expect(() => corsOrigin(["https://*.*.example.com"])).toThrow(/must look like/);
	});

	it("adds no CORS without the cors option: the app uses Hono's cors() itself", async () => {
		const plain = createApp<HttpEnv>({ logger, bodyLimitBytes: 1024 });
		plain.get("/x", (c) => c.text("x"));
		const res = await plain.request("/x", { headers: { origin: "https://web.example" } });
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("answers preflights for a pattern-matched origin", async () => {
		const res = await app({ cors: { origins: ["https://*.example.com"] } }).request("/health", {
			method: "OPTIONS",
			headers: { origin: "https://t1.example.com", "access-control-request-method": "GET" },
		});
		expect(res.headers.get("access-control-allow-origin")).toBe("https://t1.example.com");
	});
});

describe("timeouts", () => {
	const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it("answers 504 past the default, with longer limits for slow paths", async () => {
		const a = app({ timeouts: { defaultMs: 50, paths: { "/reports/*": 500 } } });
		a.get("/quick", async (c) => {
			await slow(150);
			return c.json({ ok: true });
		});
		a.get("/reports/annual", async (c) => {
			await slow(150);
			return c.json({ ok: true });
		});
		handleErrors(a);
		const late = await a.request("/quick");
		expect(late.status).toBe(504);
		expect(await late.json()).toMatchObject({ code: "REQUEST_TIMEOUT" });
		expect((await a.request("/reports/annual")).status).toBe(200);
	});
});

describe("request log", () => {
	it("hides what redactPath removes from the logged path", async () => {
		const entries: { path?: string }[] = [];
		const capture = pino(
			{ level: "info" },
			{ write: (line: string) => entries.push(JSON.parse(line)) },
		);
		const app = createApp<HttpEnv>({
			logger: capture,
			bodyLimitBytes: 1024,
			redactPath: (path) => path.replace(/\/unsubscribe\/[^/]+/, "/unsubscribe/[redacted]"),
		});
		app.get("/email/unsubscribe/:token", (c) => c.text("ok"));
		await app.request("/email/unsubscribe/secret-token");
		expect(entries.map((e) => e.path)).toContain("/email/unsubscribe/[redacted]");
		expect(JSON.stringify(entries)).not.toContain("secret-token");
	});
});

describe("configurable validation", () => {
	it("createRouter() uses first-issue message when configured", async () => {
		const router = createRouter({ validation: { message: "first-issue" } });
		router.openapi(
			createRoute({
				method: "post",
				path: "/test",
				request: { body: jsonBody(z.object({ name: z.string().min(3) }), "Test") },
				responses: { 200: { description: "OK" } },
			}),
			(c) => c.text("ok"),
		);
		const a = app();
		a.route("/", router);
		handleErrors(a);
		const res = await a.request("/test", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "ab" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("expected string to have");
		expect(body.code).toBe("VALIDATION_ERROR");
	});

	it("createRouter() uses custom detail when configured", async () => {
		const router = createRouter({
			validation: { detail: (issue) => ({ field: issue.path.join("."), msg: issue.message }) },
		});
		router.openapi(
			createRoute({
				method: "post",
				path: "/test",
				request: { body: jsonBody(z.object({ email: z.string().email() }), "Test") },
				responses: { 200: { description: "OK" } },
			}),
			(c) => c.text("ok"),
		);
		const a = app();
		a.route("/", router);
		handleErrors(a);
		const res = await a.request("/test", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "not-an-email" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.details).toEqual([{ field: "email", msg: expect.stringContaining("email") }]);
	});

	it("createRouter() defaults remain unchanged when no options given", async () => {
		const router = createRouter();
		router.openapi(
			createRoute({
				method: "post",
				path: "/test",
				request: { body: jsonBody(z.object({ name: z.string() }), "Test") },
				responses: { 200: { description: "OK" } },
			}),
			(c) => c.text("ok"),
		);
		const a = app();
		a.route("/", router);
		handleErrors(a);
		const res = await a.request("/test", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: 123 }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("Invalid request");
		expect(body.details).toEqual([
			{ path: "name", message: expect.any(String), code: "invalid_type" },
		]);
	});

	it("handleErrors() uses first-issue message for thrown ZodErrors when configured", async () => {
		const a = app();
		a.get("/boom", () => {
			const schema = z.object({ x: z.string().min(5) });
			schema.parse({ x: "ab" });
			return a.request("/never");
		});
		handleErrors(a, { validation: { message: "first-issue" } });
		const res = await a.request("/boom");
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("expected string to have");
	});

	it("handleErrors() uses custom detail for thrown ZodErrors when configured", async () => {
		const a = app();
		a.get("/boom", () => {
			const schema = z.object({ y: z.number() });
			schema.parse({ y: "not-a-number" });
			return a.request("/never");
		});
		handleErrors(a, {
			validation: { detail: (issue) => ({ at: issue.path.join("/"), reason: issue.message }) },
		});
		const res = await a.request("/boom");
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.details).toEqual([{ at: "y", reason: expect.stringContaining("number") }]);
	});

	it("handleErrors() defaults remain unchanged when no validation option given", async () => {
		const a = app();
		a.get("/boom", () => {
			const schema = z.object({ z: z.boolean() });
			schema.parse({ z: "yes" });
			return a.request("/never");
		});
		handleErrors(a);
		const res = await a.request("/boom");
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("Invalid request");
		expect(body.details).toEqual([
			{ path: "z", message: expect.any(String), code: "invalid_type" },
		]);
	});
});
