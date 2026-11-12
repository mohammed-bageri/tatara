import { createRoute, z } from "@hono/zod-openapi";
import { registerReadinessCheck } from "@tatara/core";
import { HTTPException } from "hono/http-exception";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
	ConflictError,
	createApp,
	createRouter,
	defineRoutes,
	type HttpEnv,
	handleErrors,
	jsonBody,
	jsonContent,
	mountRoutes,
	NotFoundError,
	serveOpenApi,
	success,
} from "./index.ts";

interface Env extends HttpEnv {
	Variables: HttpEnv["Variables"] & { language: string };
}

const logger = pino({ level: "silent" });

function app(extra: { bodyLimitBytes?: number } = {}) {
	return createApp<Env>({
		logger,
		cors: { origins: ["https://web.example"], exposeHeaders: ["X-Request-Id", "set-auth-token"] },
		bodyLimitBytes: extra.bodyLimitBytes ?? 1024,
		defaults: { language: "en" },
	});
}

describe("createApp", () => {
	it("serves /health", async () => {
		const res = await app().request("/health");
		expect(await res.json()).toEqual({ status: "ok" });
	});

	it("serves /ready from the readiness checks", async () => {
		registerReadinessCheck("http-test", async () => {
			throw new Error("down");
		});
		const res = await app().request("/ready");
		expect(res.status).toBe(503);
		expect((await res.json()).checks["http-test"]).toBe("failed");
		registerReadinessCheck("http-test", async () => {});
		expect((await app().request("/ready")).status).toBe(200);
	});

	it("keeps a valid incoming request id and replaces an invalid one", async () => {
		const ok = await app().request("/health", { headers: { "x-request-id": "abcdefgh-1234" } });
		expect(ok.headers.get("x-request-id")).toBe("abcdefgh-1234");
		const bad = await app().request("/health", { headers: { "x-request-id": "<script>" } });
		expect(bad.headers.get("x-request-id")).not.toBe("<script>");
	});

	it("sets the default variables", async () => {
		const a = app();
		a.get("/lang", (c) => c.text(c.get("language")));
		expect(await (await a.request("/lang")).text()).toBe("en");
	});

	it("allows the configured origins and exposes the configured headers", async () => {
		const res = await app().request("/health", { headers: { origin: "https://web.example" } });
		expect(res.headers.get("access-control-allow-origin")).toBe("https://web.example");
		expect(res.headers.get("access-control-expose-headers")).toContain("set-auth-token");
	});

	it("rejects a body over the limit with 413", async () => {
		const a = app({ bodyLimitBytes: 10 });
		a.post("/echo", (c) => c.text("ok"));
		const res = await a.request("/echo", { method: "POST", body: "x".repeat(100) });
		expect(res.status).toBe(413);
	});
});

describe("handleErrors", () => {
	function failing(error: Error) {
		const a = app();
		a.get("/boom", () => {
			throw error;
		});
		return a;
	}

	it("returns the error envelope for an AppError", async () => {
		const a = failing(new ConflictError("Role is assigned"));
		handleErrors(a);
		const res = await a.request("/boom");
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			success: false,
			error: "Role is assigned",
			code: "CONFLICT",
		});
	});

	it("lets the app rewrite the message", async () => {
		const a = failing(new NotFoundError());
		handleErrors(a, { message: (err, c) => `${c.get("language")}:${err.code}` });
		expect((await (await a.request("/boom")).json()).error).toBe("en:NOT_FOUND");
	});

	it("keeps an HTTPException's status", async () => {
		const a = failing(new HTTPException(418, { message: "teapot" }));
		handleErrors(a);
		const res = await a.request("/boom");
		expect(res.status).toBe(418);
		expect((await res.json()).code).toBe("HTTP_ERROR");
	});

	it("hides unknown errors behind a 500 and logs them", async () => {
		const log = pino({ level: "error" }, { write: () => {} });
		const spy = vi.spyOn(log, "error");
		const a = createApp<Env>({
			logger: log,
			cors: { origins: [] },
			bodyLimitBytes: 1024,
			defaults: { language: "en" },
		});
		a.get("/boom", () => {
			throw new Error("database password is hunter2");
		});
		handleErrors(a);
		const res = await a.request("/boom");
		expect(res.status).toBe(500);
		expect(JSON.stringify(await res.json())).not.toContain("hunter2");
		expect(spy).toHaveBeenCalled();
	});

	it("answers unknown routes with a 404 envelope", async () => {
		const a = app();
		handleErrors(a);
		const res = await a.request("/nope");
		expect(res.status).toBe(404);
		expect((await res.json()).code).toBe("NOT_FOUND");
	});
});

describe("routes and OpenAPI", () => {
	const router = createRouter<Env>();
	router.openapi(
		createRoute({
			method: "post",
			path: "/",
			request: { body: jsonBody(z.object({ name: z.string().min(1) }), "A note") },
			responses: {
				200: jsonContent(z.object({ success: z.literal(true), data: z.string() }), "Created"),
			},
		}),
		(c) => c.json(success(c.req.valid("json").name), 200),
	);
	const routes = [
		defineRoutes({ app: "api", basePath: "/notes", router }),
		defineRoutes({ app: "admin", basePath: "/secret", router }),
	];

	function mounted() {
		const a = app();
		mountRoutes(a, routes, { app: "api", prefix: "/api" });
		serveOpenApi(a, {
			title: "Test API",
			extend(document) {
				document.info.description = "extended";
			},
		});
		handleErrors(a);
		return a;
	}

	it("mounts only the routes for this app", async () => {
		const a = mounted();
		const post = (path: string) =>
			a.request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: '{"name":"x"}',
			});
		expect((await post("/api/notes")).status).toBe(200);
		expect((await post("/api/secret")).status).toBe(404);
	});

	it("allows one base path on both apps", async () => {
		const ping = (name: string) => {
			const r = createRouter<Env>();
			r.get("/", (c) => c.text(name));
			return r;
		};
		const shared = [
			defineRoutes({ app: "api", basePath: "/support", router: ping("api") }),
			defineRoutes({ app: "admin", basePath: "/support", router: ping("admin") }),
		];
		const api = app();
		mountRoutes(api, shared, { app: "api", prefix: "/api" });
		const admin = app();
		mountRoutes(admin, shared, { app: "admin", prefix: "/admin" });
		expect(await (await api.request("/api/support")).text()).toBe("api");
		expect((await api.request("/admin/support")).status).toBe(404);
		expect(await (await admin.request("/admin/support")).text()).toBe("admin");
	});

	it("validates bodies and rejects a missing one with 400", async () => {
		const a = mounted();
		expect((await a.request("/api/notes", { method: "POST" })).status).toBe(400);
		const empty = await a.request("/api/notes", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"name":""}',
		});
		expect((await empty.json()).code).toBe("VALIDATION_ERROR");
	});

	it("serves the OpenAPI document after extend, and the docs page", async () => {
		const a = mounted();
		const doc = await (await a.request("/openapi.json")).json();
		expect(doc.info).toMatchObject({ title: "Test API", description: "extended" });
		expect(Object.keys(doc.paths)).toContain("/api/notes");
		expect((await a.request("/docs")).status).toBe(200);
	});

	it("caches the OpenAPI document after first request, not rebuilding on every hit", async () => {
		const a = app();
		mountRoutes(a, routes, { app: "api", prefix: "/api" });
		let buildCount = 0;
		const originalGet = a.getOpenAPI31Document.bind(a);
		a.getOpenAPI31Document = (...args: Parameters<typeof originalGet>) => {
			buildCount++;
			return originalGet(...args);
		};
		serveOpenApi(a, { title: "Test API" });
		handleErrors(a);
		const first = await (await a.request("/openapi.json")).json();
		const second = await (await a.request("/openapi.json")).json();
		expect(buildCount).toBe(1);
		expect(first).toEqual(second);
	});
});
