import { createApp, type HttpEnv, handleErrors } from "@tatara/http";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer, organization } from "better-auth/plugins";
import { pino } from "pino";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type AuthEnv,
	createAuthInstance,
	currentOrgId,
	currentPrincipal,
	type Principal,
	requireAuth,
} from "./index.ts";
import { createTestUser, sessionHeaders } from "./testing.ts";

interface Env extends HttpEnv {
	Variables: HttpEnv["Variables"] & AuthEnv["Variables"];
}

const db: Record<string, Record<string, unknown>[]> = {
	user: [],
	session: [],
	account: [],
	verification: [],
	organization: [],
	member: [],
	invitation: [],
};

const service: Principal = {
	userId: "svc",
	orgId: "org-svc",
	orgRole: null,
	roles: [],
	kind: "service",
	claims: {},
};

const { auth, attachPrincipal, requireOrg } = createAuthInstance(
	{
		secret: "test-secret-that-is-at-least-32-characters",
		baseURL: "http://localhost",
		database: memoryAdapter(db),
		plugins: [bearer(), organization(), admin()],
	},
	{
		resolvers: [
			() => (c) => (c.req.header("x-service") ? service : null),
			// a token user: the token's org claim names the orgs they may act in
			() => (c) => {
				const userId = c.req.header("x-token-user");
				if (!userId) return null;
				const orgs = [c.req.header("x-token-org") as string];
				return { userId, orgId: orgs[0] ?? null, orgs, roles: [], kind: "user", claims: {} };
			},
		],
	},
);

function app() {
	const app = createApp<Env>({
		logger: pino({ level: "silent" }),
		cors: { origins: [] },
		bodyLimitBytes: 1024,
		defaults: { principal: null },
	});
	app.use(attachPrincipal);
	app.get("/org", requireOrg(), (c) => c.json(currentPrincipal(c)));
	app.get("/org-id", requireOrg(), (c) => c.json({ orgId: currentOrgId(c) }));
	app.get("/me", requireAuth(), (c) => c.json(currentPrincipal(c)));
	app.get("/org-cookie", requireOrg({ cookie: "app_org" }), (c) => c.json(currentPrincipal(c)));
	app.get("/orgs/:orgId/me", requireOrg({ param: "orgId" }), (c) => c.json(currentPrincipal(c)));
	handleErrors(app);
	return app;
}

async function member(role = "member") {
	const owner = await createTestUser(auth);
	const org = await auth.api.createOrganization({
		body: { name: "School", slug: `s-${crypto.randomUUID()}`, userId: owner },
	});
	const userId = await createTestUser(auth);
	await auth.api.addMember({
		body: { userId, organizationId: org?.id as string, role: role as "member" },
	});
	return { orgId: org?.id as string, userId, headers: await sessionHeaders(auth, userId) };
}

describe("createAuthInstance", () => {
	it("returns the real better-auth instance, with its plugins' API typed", () => {
		expectTypeOf(auth.api.createOrganization).toBeFunction();
		expect(typeof auth.handler).toBe("function");
	});

	it("resolves the session first, then the app's resolvers", async () => {
		const res = await app().request("/org", {
			headers: { "x-service": "1", "x-org-id": "org-svc" },
		});
		expect(await res.json()).toMatchObject({ userId: "svc", kind: "service" });
	});
});

describe("requireOrg", () => {
	it("takes the org from x-org-id and checks membership, setting orgRole", async () => {
		const { orgId, userId, headers } = await member("teacher");
		const res = await app().request("/org", { headers: { ...headers, "x-org-id": orgId } });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ userId, orgId, orgRole: "teacher" });
	});

	it("answers 400 ORG_REQUIRED without an org, and 403 for a non-member", async () => {
		const { orgId } = await member();
		const outsider = await createTestUser(auth);
		const headers = await sessionHeaders(auth, outsider);
		const none = await app().request("/org", { headers });
		expect(none.status).toBe(400);
		expect(await none.json()).toMatchObject({ code: "ORG_REQUIRED" });
		const outsiderRes = await app().request("/org", { headers: { ...headers, "x-org-id": orgId } });
		expect(outsiderRes.status).toBe(403);
		expect(await outsiderRes.json()).toMatchObject({ code: "NOT_ORG_MEMBER" });
	});

	it("takes the org from the path when told to, and the header can't override it", async () => {
		const { orgId, userId, headers } = await member("teacher");
		const ok = await app().request(`/orgs/${orgId}/me`, { headers });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({ userId, orgId, orgRole: "teacher" });
		const { orgId: other } = await member();
		const spoofed = await app().request(`/orgs/${other}/me`, {
			headers: { ...headers, "x-org-id": orgId },
		});
		expect(spoofed.status).toBe(403);
	});

	it("falls back to the cookie when told to, and the header wins over it", async () => {
		const { orgId, userId, headers } = await member("teacher");
		const { orgId: other } = await member();
		const withCookie = (org: string) => ({
			...headers,
			cookie: [headers.cookie, `app_org=${org}`].filter(Boolean).join("; "),
		});
		const ok = await app().request("/org-cookie", { headers: withCookie(orgId) });
		expect(await ok.json()).toMatchObject({ userId, orgId });
		expect((await app().request("/org-cookie", { headers: withCookie(other) })).status).toBe(403);
		const header = await app().request("/org-cookie", {
			headers: { ...withCookie(other), "x-org-id": orgId },
		});
		expect(header.status).toBe(200);
	});

	it("gives the org the request acts in", async () => {
		const { orgId, headers } = await member();
		const res = await app().request("/org-id", { headers: { ...headers, "x-org-id": orgId } });
		expect(await res.json()).toEqual({ orgId });
	});

	it("401s without a principal", async () => {
		expect((await app().request("/org", { headers: { "x-org-id": "x" } })).status).toBe(401);
	});

	it("lets a service principal act only in its own org", async () => {
		expect(
			(await app().request("/org", { headers: { "x-service": "1", "x-org-id": "elsewhere" } }))
				.status,
		).toBe(403);
	});

	it("lets a token user act only in the orgs their token names, whatever member rows remain", async () => {
		const { orgId, userId } = await member();
		const token = { "x-token-user": userId, "x-token-org": "org-now" };
		const stale = await app().request("/org", { headers: { ...token, "x-org-id": orgId } });
		expect(stale.status).toBe(403);
		const now = await app().request("/org", { headers: { ...token, "x-org-id": "org-now" } });
		expect(now.status).toBe(200);
		expect(await now.json()).toMatchObject({ userId, orgId: "org-now", orgRole: null });
	});
});

describe("an instance whose principals act in one fixed org", () => {
	it("sets that org on every principal, e.g. staff in the platform org", async () => {
		const staff = createAuthInstance(
			{
				secret: "test-secret-that-is-at-least-32-characters",
				baseURL: "http://localhost",
				database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
				plugins: [bearer()],
			},
			{ org: "platform" },
		);
		const hono = createApp<Env>({
			logger: pino({ level: "silent" }),
			cors: { origins: [] },
			bodyLimitBytes: 1024,
			defaults: { principal: null },
		});
		hono.use(staff.attachPrincipal);
		hono.get("/me", (c) => c.json(currentPrincipal(c)));
		handleErrors(hono);
		const userId = await createTestUser(staff.auth);
		const res = await hono.request("/me", { headers: await sessionHeaders(staff.auth, userId) });
		expect(await res.json()).toMatchObject({ userId, orgId: "platform", orgRole: null });
	});
});

describe("a banned user's live session", () => {
	const hour = 3_600_000;
	async function banned(banExpires: Date | null) {
		const m = await member();
		const user = db.user?.find((u) => u.id === m.userId) as Record<string, unknown>;
		Object.assign(user, { banned: true, banExpires });
		return m;
	}

	it("gets no principal: requireAuth() and requireOrg() answer 401", async () => {
		const { orgId, headers } = await banned(null);
		expect((await app().request("/me", { headers })).status).toBe(401);
		expect(
			(await app().request("/org", { headers: { ...headers, "x-org-id": orgId } })).status,
		).toBe(401);
		const until = await banned(new Date(Date.now() + hour));
		expect((await app().request("/me", { headers: until.headers })).status).toBe(401);
	});

	it("passes once the ban has expired", async () => {
		const { orgId, userId, headers } = await banned(new Date(Date.now() - hour));
		expect((await app().request("/me", { headers })).status).toBe(200);
		const res = await app().request("/org", { headers: { ...headers, "x-org-id": orgId } });
		expect(await res.json()).toMatchObject({ userId, orgId });
	});
});
