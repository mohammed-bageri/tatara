import { beforeEach, describe, expect, it } from "vitest";
import {
	authzPermissions,
	createAuthz,
	definePermissions,
	mergeCatalogs,
	type PermissionKeysOf,
	SYSTEM_ORG_ID,
} from "./index.ts";
import { memoryAuthzStore } from "./testing.ts";

const perms = definePermissions({
	resources: {
		report: { read: { scoped: true } },
		doc: { read: { scoped: true } },
		badge: { award: { scoped: false } },
	},
	roleGrants: {
		admin: [
			["report", "read", "org"],
			["doc", "read", "org"],
			["role", "update"],
		],
		member: [["doc", "read", "own"]],
		auditor: [["badge", "award"]],
	},
});
type Key = PermissionKeysOf<typeof authzPermissions> | PermissionKeysOf<typeof perms>;
const catalog = mergeCatalogs(authzPermissions, perms);
const SYSTEM_ROLES = [
	{ key: "admin", name: "Admin", description: "Full access" },
	{ key: "member", name: "Member", description: "Everyone", heldBy: "members" },
	{
		key: "auditor",
		name: "Auditor",
		description: "From the identity provider",
		heldBy: "identity",
	},
] as const;

let authz: ReturnType<typeof createAuthz<Key>>;
const members = new Map<string, string[]>();
const refused = new Set<string>();

beforeEach(async () => {
	members.clear();
	refused.clear();
	authz = createAuthz<Key>({
		store: memoryAuthzStore(),
		catalog,
		systemRoles: SYSTEM_ROLES,
		canHoldRoles: (_orgId, userId) =>
			refused.has(userId) ? "Candidates cannot hold org roles" : null,
		listMembers: async (orgId) => members.get(orgId) ?? [],
	});
	await authz.syncSystemRoles();
});

async function systemRoleId(key: string): Promise<string> {
	const role = await authz.store.findRoleByKey(SYSTEM_ORG_ID, key);
	if (!role) throw new Error(key);
	return role.id;
}

async function customRole(
	key: string,
	grants: { resource: string; action: string; scope?: string | null }[],
) {
	return authz.createRole("actor", "org1", { key, name: key, grants });
}

describe("setMemberRoles", () => {
	it("replaces a member's roles, writing and auditing only the difference", async () => {
		const reader = await customRole("reader", [
			{ resource: "report", action: "read", scope: "team" },
		]);
		const admin = await systemRoleId("admin");
		await authz.setMemberRoles("actor", "org1", "u1", [reader.id]);
		const member = await authz.setMemberRoles("actor", "org1", "u1", [admin, admin]);
		expect(member.roles.map((r) => r.key)).toEqual(["admin"]);
		const [latest] = await authz.listAudit("org1", 1);
		expect(latest).toMatchObject({
			changeType: "member_role_assigned",
			targetUserId: "u1",
			before: { roleIds: [reader.id] },
			after: { roleIds: [admin] },
		});
		// the same set again writes nothing
		const before = (await authz.listAudit("org1", 50)).length;
		await authz.setMemberRoles("actor", "org1", "u1", [admin]);
		expect((await authz.listAudit("org1", 50)).length).toBe(before);
	});

	it("refuses a role of another org, and a user the app says cannot hold roles", async () => {
		const elsewhere = await authz.createRole("actor", "org2", { key: "x", name: "x", grants: [] });
		await expect(authz.setMemberRoles("actor", "org1", "u1", [elsewhere.id])).rejects.toThrow(
			/another organization/,
		);
		refused.add("candidate");
		await expect(
			authz.setMemberRoles("actor", "org1", "candidate", [await systemRoleId("admin")]),
		).rejects.toThrow(/Candidates cannot hold org roles/);
	});
});

describe("addRolesToMembers", () => {
	it("adds to what each member has, and skips one that cannot hold roles", async () => {
		const reader = await customRole("reader", [
			{ resource: "report", action: "read", scope: "team" },
		]);
		const admin = await systemRoleId("admin");
		await authz.setMemberRoles("actor", "org1", "u1", [reader.id]);
		refused.add("candidate");
		const result = await authz.addRolesToMembers(
			"actor",
			"org1",
			["u1", "u2", "candidate", "u2"],
			[admin],
		);
		expect(result.updated).toBe(2);
		expect(result.skipped).toEqual([
			{ userId: "candidate", reason: "Candidates cannot hold org roles" },
		]);
		expect((await authz.getMember("org1", "u1")).roles.map((r) => r.key).sort()).toEqual([
			"admin",
			"reader",
		]);
	});

	it("fails the whole batch on a role it cannot use, before changing anyone", async () => {
		await expect(authz.addRolesToMembers("actor", "org1", ["u1"], ["missing"])).rejects.toThrow();
		expect((await authz.getMember("org1", "u1")).roles).toEqual([]);
	});
});

describe("duplicateRole", () => {
	it("copies a built-in role's grants into a custom role, without meta grants", async () => {
		const copy = await authz.duplicateRole("actor", "org1", await systemRoleId("admin"), {
			key: "admin-copy",
			name: "Admin copy",
		});
		expect(copy.isSystem).toBe(false);
		expect(copy.grants.map((g) => `${g.resource}:${g.action}`).sort()).toEqual([
			"doc:read",
			"report:read",
		]);
		const [latest] = await authz.listAudit("org1", 1);
		expect(latest?.changeType).toBe("role_duplicated");
	});
});

describe("listUsersWithPermission", () => {
	it("lists role holders and grant overlays, minus denies and expired overlays", async () => {
		const team = await customRole("team-reader", [
			{ resource: "report", action: "read", scope: "team" },
		]);
		await authz.setMemberRoles("actor", "org1", "admin", [await systemRoleId("admin")]);
		await authz.setMemberRoles("actor", "org1", "lead", [team.id]);
		await authz.setMemberRoles("actor", "org1", "denied", [await systemRoleId("admin")]);
		await authz.addOverlay("actor", "org1", "denied", {
			resource: "report",
			action: "read",
			scope: "org",
			effect: "deny",
		});
		await authz.addOverlay("actor", "org1", "guest", {
			resource: "report",
			action: "read",
			scope: "own",
			effect: "grant",
		});
		await authz.addOverlay("actor", "org1", "lapsed", {
			resource: "report",
			action: "read",
			scope: "org",
			effect: "grant",
			expiresAt: new Date(Date.now() - 1000),
		});
		expect((await authz.listUsersWithPermission("org1", "report:read")).sort()).toEqual([
			"admin",
			"guest",
			"lead",
		]);
		expect((await authz.listUsersWithPermission("org1", "report:read", "team")).sort()).toEqual([
			"admin",
			"lead",
		]);
		expect(await authz.listUsersWithPermission("org1", "report:read", "org")).toEqual(["admin"]);
		// the same rule as a check, for every listed user
		for (const userId of ["admin", "lead", "denied", "guest"]) {
			const listed = (await authz.listUsersWithPermission("org1", "report:read", "team")).includes(
				userId,
			);
			const allowed = await authz.checkPermission(
				{ userId, orgId: "org1", orgRole: null, roles: [] },
				"report:read",
				"team",
			);
			expect(listed, userId).toBe(allowed);
		}
	});

	it("includes every member for a permission a members-held role grants", async () => {
		members.set("org1", ["m1", "m2"]);
		expect((await authz.listUsersWithPermission("org1", "doc:read", "own")).sort()).toEqual([
			"m1",
			"m2",
		]);
		const noLister = createAuthz<Key>({ store: authz.store, catalog, systemRoles: SYSTEM_ROLES });
		await expect(noLister.listUsersWithPermission("org1", "doc:read")).rejects.toThrow(
			/listMembers/,
		);
	});

	it("refuses a permission only identity-provider roles grant", async () => {
		await expect(authz.listUsersWithPermission("org1", "badge:award")).rejects.toThrow(
			/identity-provider/,
		);
	});
});

describe("listAudit", () => {
	it("pages newest first from a cursor", async () => {
		for (let i = 0; i < 5; i++) await customRole(`r${i}`, []);
		const first = await authz.listAudit("org1", 2);
		const last = first.at(-1);
		if (!last) throw new Error("empty page");
		const second = await authz.listAudit("org1", 2, { at: last.at, id: last.id });
		const all = await authz.listAudit("org1", 50);
		expect([...first, ...second].map((a) => a.id)).toEqual(all.slice(0, 4).map((a) => a.id));
	});
});

describe("syncSystemRoles", () => {
	it("deletes built-in roles the code no longer has, with their assignments", async () => {
		const legacy = await createAuthz<Key>({
			store: authz.store,
			catalog,
			systemRoles: [...SYSTEM_ROLES, { key: "legacy", name: "Legacy", description: "" }],
		});
		await legacy.syncSystemRoles();
		await authz.store.assignRole("org1", "u1", await systemRoleId("legacy"), null);
		expect((await authz.syncSystemRoles()).deleted).toEqual(["legacy"]);
		expect(await authz.store.findRoleByKey(SYSTEM_ORG_ID, "legacy")).toBeNull();
		expect((await authz.getMember("org1", "u1")).roles).toEqual([]);
	});
});
