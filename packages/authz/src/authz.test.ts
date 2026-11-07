import { createRoute, z } from "@hono/zod-openapi";
import { type AuthEnv, type Principal, principalMiddleware } from "@tatara/auth";
import { createApp, createRouter, type HttpEnv, handleErrors } from "@tatara/http";
import { pino } from "pino";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
	allows,
	authorizationRoutes,
	authzPermissions,
	createAuthz,
	definePermissions,
	type EffectivePermissions,
	mergeCatalogs,
	type PermissionKeysOf,
	SYSTEM_ORG_ID,
} from "./index.ts";
import { memoryAuthzStore } from "./testing.ts";

const docs = definePermissions({
	resources: { doc: { read: { scoped: true }, publish: { scoped: false } } },
	roleGrants: {
		member: [["doc", "read", "own"]],
		admin: [["doc", "read", "org"]],
		support: [["doc", "read", "team"]],
	},
});
type Key = PermissionKeysOf<typeof authzPermissions> | PermissionKeysOf<typeof docs>;
const catalog = mergeCatalogs(authzPermissions, docs);
const SYSTEM_ROLES = [
	{ key: "admin", name: "Admin", description: "Full access" },
	{ key: "member", name: "Member", description: "Everyone", heldBy: "members" },
	{ key: "support", name: "Support", description: "Staff", heldBy: "identity" },
] as const;

interface Env extends HttpEnv {
	Variables: HttpEnv["Variables"] & AuthEnv["Variables"];
}

let authz: ReturnType<typeof createAuthz<Key>>;
beforeEach(() => {
	authz = createAuthz<Key>({ store: memoryAuthzStore(), catalog, systemRoles: SYSTEM_ROLES });
});

const who = (
	userId: string,
	roles: string[] = [],
	orgId: string | null = "default",
	orgRole: string | null = null,
): Principal => ({
	userId,
	orgId,
	orgRole,
	roles,
	kind: "user",
	claims: {},
});

async function grantSystemRole(userId: string, key: string, orgId = "default") {
	await authz.syncSystemRoles();
	const role = await authz.store.findRoleByKey(SYSTEM_ORG_ID, key);
	if (!role) throw new Error(key);
	await authz.assignRole(null, orgId, userId, role.id);
}

function app() {
	const app = createApp<Env>({
		logger: pino({ level: "silent" }),
		cors: { origins: [] },
		bodyLimitBytes: 10_000,
		defaults: { principal: null },
	});
	app.use(
		principalMiddleware<Env>([
			(c) => {
				const user = c.req.header("x-user");
				return user ? who(user, c.req.header("x-roles")?.split(",") ?? []) : null;
			},
		]),
	);
	const docsRouter = createRouter<Env>();
	docsRouter.openapi(
		createRoute({
			method: "get",
			path: "/",
			middleware: [authz.requirePermission("doc:publish")] as const,
			responses: { 200: { description: "ok" } },
		}),
		(c) => {
			expectTypeOf(c.get("principal")).toEqualTypeOf<Principal | null>();
			return c.json({ ok: true }, 200);
		},
	);
	app.route("/docs", docsRouter);
	app.route("/authorization", authorizationRoutes<Env>(authz));
	handleErrors(app);
	return app;
}

const set = (
	grants: EffectivePermissions["grants"],
	denies: string[] = [],
): EffectivePermissions => ({
	grants,
	denies: new Set(denies),
	roles: [],
});

describe("allows", () => {
	it("lets a deny overlay win over any grant", () => {
		const p = set([{ resource: "role", action: "read", scope: null }], ["role:read:*"]);
		expect(allows(p, "role", "read")).toBe(false);
	});

	it("does not let a denied wide grant satisfy a narrower check", () => {
		const p = set([{ resource: "doc", action: "read", scope: "org" }], ["doc:read:org"]);
		expect(allows(p, "doc", "read", "team")).toBe(false);
		expect(allows(p, "doc", "read")).toBe(false);
	});

	it("honours the scope hierarchy org > team > own", () => {
		const p = set([{ resource: "doc", action: "read", scope: "team" }]);
		expect(allows(p, "doc", "read", "own")).toBe(true);
		expect(allows(p, "doc", "read", "team")).toBe(true);
		expect(allows(p, "doc", "read", "org")).toBe(false);
	});
});

describe("createAuthz", () => {
	it("refuses permission files that grant to an unknown built-in role", () => {
		const typo = definePermissions({
			resources: { x: { y: { scoped: false } } },
			roleGrants: { admn: [["x", "y"]] },
		});
		expect(() =>
			createAuthz({
				store: memoryAuthzStore(),
				catalog: mergeCatalogs(typo),
				systemRoles: SYSTEM_ROLES,
			}),
		).toThrow(/"admn"/);
	});

	it("resolves assigned role grants and the widest scope", async () => {
		await grantSystemRole("u1", "member");
		expect(await authz.resolveScope(who("u1"), "doc:read")).toBe("own");
		await grantSystemRole("u1", "admin");
		expect(await authz.resolveScope(who("u1"), "doc:read")).toBe("org");
		expect(await authz.checkPermission(who("u2"), "doc:read", "own")).toBe(false);
	});

	it("implies an identity-provider role only for roles held by identity", async () => {
		await authz.syncSystemRoles();
		expect(await authz.resolveScope(who("u1", ["support"]), "doc:read")).toBe("team");
		// an identity-provider "admin" (better-auth's admin plugin) is not the org's admin
		expect(await authz.resolveScope(who("u1", ["admin"]), "doc:read")).toBeNull();
	});

	it("drops cached permissions when access changes", async () => {
		expect(await authz.checkPermission(who("u1"), "doc:publish")).toBe(false);
		await authz.addOverlay(null, "default", "u1", {
			resource: "doc",
			action: "publish",
			effect: "grant",
		});
		expect(await authz.checkPermission(who("u1"), "doc:publish")).toBe(true);
		await authz.removeMemberAccess("default", "u1");
		expect(await authz.checkPermission(who("u1"), "doc:publish")).toBe(false);
	});

	it("keeps access per org", async () => {
		await authz.addOverlay(null, "org-a", "u1", {
			resource: "doc",
			action: "publish",
			effect: "grant",
		});
		expect(await authz.checkPermission(who("u1", [], "org-a"), "doc:publish")).toBe(true);
		expect(await authz.checkPermission(who("u1", [], "org-b"), "doc:publish")).toBe(false);
	});

	it("syncs built-in roles idempotently", async () => {
		expect(await authz.syncSystemRoles()).toEqual({
			created: ["admin", "member", "support"],
			updated: [],
			deleted: [],
		});
		expect(await authz.syncSystemRoles()).toEqual({ created: [], updated: [], deleted: [] });
	});

	it("keeps instances separate", async () => {
		const other = createAuthz<Key>({
			store: memoryAuthzStore(),
			catalog,
			systemRoles: SYSTEM_ROLES,
		});
		await authz.addOverlay(null, "default", "u1", {
			resource: "doc",
			action: "publish",
			effect: "grant",
		});
		expect(await other.checkPermission(who("u1"), "doc:publish")).toBe(false);
	});
});

describe("tenant context", () => {
	it("refuses a check with no org instead of falling back to a default one", async () => {
		await expect(authz.checkPermission(who("u1", [], null), "doc:publish")).rejects.toMatchObject({
			code: "ORG_REQUIRED",
		});
	});

	it("uses the app's fixed org when it says it's single-tenant", async () => {
		const single = createAuthz<Key>({
			store: memoryAuthzStore(),
			catalog,
			systemRoles: SYSTEM_ROLES,
			singleTenant: "default",
		});
		await single.addOverlay(null, "default", "u1", {
			resource: "doc",
			action: "publish",
			effect: "grant",
		});
		expect(await single.checkPermission(who("u1", [], null), "doc:publish")).toBe(true);
	});

	it("gives every member of the org the roles held by members, whatever their member role", async () => {
		await authz.syncSystemRoles();
		expect(await authz.resolveScope(who("u1", [], "org-a", "member"), "doc:read")).toBe("own");
		// better-auth's member role is membership only: "admin" there is not authz's admin
		expect(await authz.resolveScope(who("u1", [], "org-a", "owner,admin"), "doc:read")).toBe("own");
		expect(await authz.resolveScope(who("u1", [], "org-a", null), "doc:read")).toBeNull();
	});

	it("removes a member's access through the organization hooks it gives better-auth", async () => {
		const { authzOrganizationHooks } = await import("./index.ts");
		await authz.addOverlay(null, "org-a", "u1", {
			resource: "doc",
			action: "publish",
			effect: "grant",
		});
		const hooks = authzOrganizationHooks(authz);
		await hooks.afterRemoveMember({ member: { organizationId: "org-a", userId: "u1" } });
		expect(await authz.checkPermission(who("u1", [], "org-a"), "doc:publish")).toBe(false);
	});

	it("grants a built-in role by key, once, syncing built-in roles if the database has none", async () => {
		expect(await authz.grantSystemRole("org-a", "u7", "admin")).toBe(true);
		expect(await authz.grantSystemRole("org-a", "u7", "admin")).toBe(false);
		expect(await authz.resolveScope(who("u7", [], "org-a"), "doc:read")).toBe("org");
		await expect(authz.grantSystemRole("org-a", "u7", "nope")).rejects.toThrow(
			/No built-in role "nope"/,
		);
	});

	it("makes an org's creator its admin through the organization hooks", async () => {
		await authz.syncSystemRoles();
		const { authzOrganizationHooks } = await import("./index.ts");
		const hooks = authzOrganizationHooks(authz, { creatorRole: "admin" });
		await hooks.afterCreateOrganization?.({
			organization: { id: "org-new" },
			member: { userId: "u8" },
		});
		expect(await authz.resolveScope(who("u8", [], "org-new"), "doc:read")).toBe("org");
	});
});

describe("requirePermission", () => {
	it("answers 401, then 403, then lets the holder through", async () => {
		expect((await app().request("/docs")).status).toBe(401);
		expect((await app().request("/docs", { headers: { "x-user": "u1" } })).status).toBe(403);
		await authz.addOverlay(null, "default", "u1", {
			resource: "doc",
			action: "publish",
			effect: "grant",
		});
		expect((await app().request("/docs", { headers: { "x-user": "u1" } })).status).toBe(200);
	});
});

describe("authorizationRoutes options", () => {
	it("runs the app's middleware first, e.g. its org check", async () => {
		const blocked = createApp<Env>({
			logger: pino({ level: "silent" }),
			cors: { origins: [] },
			bodyLimitBytes: 10_000,
			defaults: { principal: null },
		});
		blocked.route(
			"/authorization",
			authorizationRoutes<Env>(authz, {
				use: [async (c) => c.json({ error: "org first" }, 400)],
			}),
		);
		const res = await blocked.request("/authorization/roles", { headers: { "x-user": "u1" } });
		expect(res.status).toBe(400);
	});
});

describe("authorizationRoutes", () => {
	const admin = { "x-user": "admin-1", "content-type": "application/json" };
	beforeEach(() => grantSystemRole("admin-1", "admin"));

	it("forbids listing roles without role:read", async () => {
		const res = await app().request("/authorization/roles", { headers: { "x-user": "u1" } });
		expect(res.status).toBe(403);
	});

	it("lists built-in roles for an admin", async () => {
		await authz.syncSystemRoles();
		const res = await app().request("/authorization/roles", { headers: admin });
		const body = (await res.json()) as { data: { key: string; isSystem: boolean }[] };
		expect(body.data.filter((r) => r.isSystem).map((r) => r.key)).toEqual([
			"admin",
			"member",
			"support",
		]);
	});

	it("rejects custom roles and overlays that grant authorization itself", async () => {
		await authz.syncSystemRoles();
		const role = await app().request("/authorization/roles", {
			method: "POST",
			headers: admin,
			body: JSON.stringify({
				key: "sneaky",
				name: "S",
				grants: [{ resource: "role", action: "update" }],
			}),
		});
		expect(role.status).toBe(400);
		expect(await role.json()).toMatchObject({ code: "META_GRANT_FORBIDDEN" });
		const overlay = await app().request("/authorization/members/u1/overlays", {
			method: "POST",
			headers: admin,
			body: JSON.stringify({ resource: "role", action: "update", effect: "grant" }),
		});
		expect(overlay.status).toBe(400);
	});

	it("creates, assigns and audits a custom role", async () => {
		await authz.syncSystemRoles();
		const created = await app().request("/authorization/roles", {
			method: "POST",
			headers: admin,
			body: JSON.stringify({
				key: "editor",
				name: "Editor",
				grants: [{ resource: "doc", action: "publish" }],
			}),
		});
		expect(created.status).toBe(201);
		const { data } = (await created.json()) as { data: { id: string } };
		const assigned = await app().request("/authorization/members/u1/roles", {
			method: "POST",
			headers: admin,
			body: JSON.stringify({ roleId: data.id }),
		});
		expect(assigned.status).toBe(200);
		expect((await app().request("/docs", { headers: { "x-user": "u1" } })).status).toBe(200);
		const audit = (await (
			await app().request("/authorization/audit", { headers: admin })
		).json()) as {
			data: { changeType: string }[];
		};
		expect(audit.data.map((a) => a.changeType)).toEqual(["member_role_assigned", "role_created"]);
	});

	it("rejects a missing body with 400", async () => {
		await authz.syncSystemRoles();
		const res = await app().request("/authorization/roles", {
			method: "POST",
			headers: { "x-user": "admin-1" },
		});
		expect(res.status).toBe(400);
	});

	it("reports the caller's effective permissions", async () => {
		await authz.syncSystemRoles();
		const res = await app().request("/authorization/me", { headers: admin });
		const body = (await res.json()) as {
			data: { roles: string[]; grants: { resource: string }[] };
		};
		expect(body.data.roles).toEqual(["admin"]);
		expect(body.data.grants.map((g) => g.resource)).toContain("audit_log");
	});
});

it("types requirePermission with the app's keys", () => {
	// @ts-expect-error not a permission in the catalog
	authz.requirePermission("doc:nope");
	expectTypeOf(z).not.toBeAny();
});
