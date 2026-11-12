import { OpenAPIHono } from "@hono/zod-openapi";
import { createApp, type HttpEnv, handleErrors } from "@tatara/http";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer, openAPI, organization } from "better-auth/plugins";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import {
	type AuthEnv,
	consoleSmsSender,
	createOutbox,
	currentPrincipal,
	mergeAuthOpenApi,
	type Principal,
	principalMiddleware,
	requireAuth,
	requireRole,
	sessionPrincipal,
} from "./index.ts";
import { createTestUser, sessionHeaders } from "./testing.ts";

const logger = pino({ level: "silent" });

const db: Record<string, Record<string, unknown>[]> = {
	user: [],
	session: [],
	account: [],
	verification: [],
	organization: [],
	member: [],
	invitation: [],
};
const auth = betterAuth({
	secret: "test-secret-that-is-at-least-32-characters",
	baseURL: "http://localhost",
	database: memoryAdapter(db),
	plugins: [bearer(), openAPI(), organization(), admin()],
});

interface Env extends HttpEnv {
	Variables: HttpEnv["Variables"] & AuthEnv["Variables"];
}

const service: Principal = {
	userId: "svc",
	orgId: null,
	orgRole: null,
	roles: [],
	kind: "service",
	claims: {},
};

function app() {
	const app = createApp<Env>({
		logger,
		cors: { origins: [] },
		bodyLimitBytes: 1024,
		defaults: { principal: null },
	});
	app.use(
		principalMiddleware([
			(c) => sessionPrincipal(auth, c.req.raw.headers),
			(c) => (c.req.header("x-service") ? service : null),
		]),
	);
	app.get("/me", requireAuth(), (c) => c.json(currentPrincipal(c)));
	app.get("/admin", requireRole("admin"), (c) => c.json({ ok: true }));
	app.get("/open", (c) => c.json({ principal: c.get("principal") }));
	handleErrors(app);
	return app;
}

describe("principalMiddleware + sessionPrincipal", () => {
	it("turns a bearer session into a user principal with the user's roles", async () => {
		const userId = await createTestUser(auth, { fields: { role: "admin, teacher" } });
		const res = await app().request("/me", { headers: await sessionHeaders(auth, userId) });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			userId,
			orgId: null,
			orgRole: null,
			roles: ["admin", "teacher"],
			kind: "user",
			claims: { id: userId, role: "admin, teacher" },
		});
	});

	it("carries the session user's attributes as claims", async () => {
		const userId = await createTestUser(auth, { email: "sara@example.com", name: "Sara" });
		const res = await app().request("/me", { headers: await sessionHeaders(auth, userId) });
		expect((await res.json()).claims).toMatchObject({ email: "sara@example.com", name: "Sara" });
	});

	it("includes session identity in claims", async () => {
		const userId = await createTestUser(auth);
		const res = await app().request("/me", { headers: await sessionHeaders(auth, userId) });
		const { claims } = await res.json();
		expect(claims.session).toMatchObject({
			id: expect.any(String),
			impersonatedBy: null,
			expiresAt: expect.any(String),
		});
	});

	it("carries impersonatedBy when session is impersonated", async () => {
		const userId = await createTestUser(auth);
		const headers = await sessionHeaders(auth, userId);
		// Simulate impersonation by directly modifying the session in the db
		const sessions = db.session as Array<{ userId: string; impersonatedBy?: string }>;
		const userSession = sessions.find((s) => s.userId === userId);
		if (userSession) userSession.impersonatedBy = "admin-user-id";
		const res = await app().request("/me", { headers });
		const { claims } = await res.json();
		expect(claims.session.impersonatedBy).toBe("admin-user-id");
	});

	it("defaults roles to user", async () => {
		const userId = await createTestUser(auth);
		const res = await app().request("/me", { headers: await sessionHeaders(auth, userId) });
		expect((await res.json()).roles).toEqual(["user"]);
	});

	it("keeps the active organization only while the user is a member", async () => {
		const userId = await createTestUser(auth);
		const headers = await sessionHeaders(auth, userId);
		const org = await auth.api.createOrganization({
			body: { name: "School", slug: "school", userId },
		});
		await auth.api.setActiveOrganization({ headers, body: { organizationId: org?.id } });
		expect((await (await app().request("/me", { headers })).json()).orgId).toBe(org?.id);

		db.member = db.member?.filter((m) => m.userId !== userId) ?? [];
		expect((await (await app().request("/me", { headers })).json()).orgId).toBeNull();
	});

	it("falls through to the next resolver without a session", async () => {
		const res = await app().request("/me", { headers: { "x-service": "1" } });
		const principal = await res.json();
		expect(principal).toMatchObject({ userId: "svc", kind: "service" });
		expect(principal.claims.session).toBeUndefined();
	});

	it("leaves the principal null when nothing matches", async () => {
		expect(await (await app().request("/open")).json()).toEqual({ principal: null });
		expect(
			await (await app().request("/open", { headers: { authorization: "Bearer nope" } })).json(),
		).toEqual({ principal: null });
	});
});

describe("guards", () => {
	it("requireAuth answers 401 without a principal", async () => {
		const res = await app().request("/me");
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ success: false, error: "Authentication required" });
	});

	it("requireRole answers 401 without a principal and 403 without the role", async () => {
		expect((await app().request("/admin")).status).toBe(401);
		const userId = await createTestUser(auth);
		const res = await app().request("/admin", { headers: await sessionHeaders(auth, userId) });
		expect(res.status).toBe(403);
	});

	it("requireRole lets any of the roles through", async () => {
		const userId = await createTestUser(auth, { fields: { role: "admin" } });
		const res = await app().request("/admin", { headers: await sessionHeaders(auth, userId) });
		expect(res.status).toBe(200);
	});
});

describe("mergeAuthOpenApi", () => {
	it("adds better-auth's paths under the base path with prefixed schemas", async () => {
		const api = new OpenAPIHono();
		api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
			type: "http",
			scheme: "bearer",
		});
		const document = api.getOpenAPI31Document({
			openapi: "3.1.0",
			info: { title: "t", version: "1" },
		});
		await mergeAuthOpenApi(document, auth, "/api/auth");

		const paths = Object.keys(document.paths ?? {});
		expect(paths).toContain("/api/auth/sign-in/social");
		expect(paths.every((p) => p.startsWith("/api/auth/"))).toBe(true);
		expect(Object.keys(document.components?.schemas ?? {})).toContain("AuthUser");
		expect(JSON.stringify(document)).not.toMatch(/"#\/components\/schemas\/User"/);
		expect(document.components?.securitySchemes?.bearerAuth).toMatchObject({ scheme: "bearer" });
		expect(document.tags?.map((t) => t.name)).toContain("Auth");
	});
});

describe("createOutbox", () => {
	it("keeps messages newest first, filtered by recipient", () => {
		const outbox = createOutbox({ enabled: true });
		outbox.record({ channel: "email", to: "a@x", text: "1" });
		outbox.record({ channel: "sms", to: "b", text: "2", code: "123" });
		outbox.record({ channel: "email", to: "a@x", text: "3" });
		expect(outbox.read("a@x").map((m) => m.text)).toEqual(["3", "1"]);
		expect(outbox.read()).toHaveLength(3);
		expect(outbox.read("b")[0]).toMatchObject({ code: "123", sentAt: expect.any(String) });
	});

	it("keeps nothing when disabled", () => {
		const outbox = createOutbox({ enabled: false });
		outbox.record({ channel: "email", to: "a@x", text: "1" });
		expect(outbox.enabled).toBe(false);
		expect(outbox.read()).toEqual([]);
	});

	it("drops the oldest past the limit", () => {
		const outbox = createOutbox({ enabled: true, limit: 2 });
		for (const text of ["1", "2", "3"]) outbox.record({ channel: "email", to: "a", text });
		expect(outbox.read().map((m) => m.text)).toEqual(["3", "2"]);
	});
});

describe("consoleSmsSender", () => {
	it("logs the recipient, never the text", async () => {
		const lines: string[] = [];
		const log = pino({}, { write: (line: string) => lines.push(line) });
		await consoleSmsSender(log).send("+966500000000", "code 123456");
		expect(lines.join("")).toContain("+966500000000");
		expect(lines.join("")).not.toContain("123456");
	});
});
