import { createTestUser, sessionHeaders } from "@tatara/auth/testing";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer, organization } from "better-auth/plugins";
import { beforeEach, describe, expect, it } from "vitest";
import { authzPlugin } from "./better-auth.ts";
import { createAuthz, definePermissions, mergeCatalogs } from "./index.ts";
import { memoryAuthzStore } from "./testing.ts";

const members = definePermissions({
	resources: { people: { list: { scoped: false }, review: { scoped: false } } },
	roleGrants: { admin: [["people", "list"]], reviewer: [["people", "review"]] },
});
const SYSTEM_ROLES = [
	{ key: "admin", name: "Admin", description: "Full access" },
	{ key: "member", name: "Member", description: "Everyone", heldBy: "members" },
	{ key: "reviewer", name: "Reviewer", description: "Reviews people" },
] as const;

function setup(pluginOptions: { creatorRole?: string | readonly string[] | false } = {}) {
	const authz = createAuthz<"people:list" | "people:review">({
		store: memoryAuthzStore(),
		catalog: mergeCatalogs(members),
		systemRoles: SYSTEM_ROLES,
	});
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
		plugins: [
			bearer(),
			organization(),
			authzPlugin(authz, {
				...pluginOptions,
				endpoints: { "/organization/list-members": "people:list" },
			}),
		],
	});
	const call = async (path: string, headers: Record<string, string>, body?: unknown) => {
		const res = await auth.handler(
			new Request(`http://localhost/api/auth/organization/${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { ...headers, "content-type": "application/json", origin: "http://localhost" },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);
		return { status: res.status, body: (await res.json().catch(() => null)) as never };
	};
	const user = async () => {
		const id = await createTestUser(auth);
		return { id, headers: await sessionHeaders(auth, id) };
	};
	return { authz, auth, db, call, user };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
	t = setup();
});

async function orgWithMember() {
	const owner = await t.user();
	const created = await t.call("create", owner.headers, { name: "Acme", slug: `acme-${owner.id}` });
	expect(created.status).toBe(200);
	const orgId = (created.body as { id: string }).id;
	const member = await t.user();
	await t.auth.api.addMember({
		body: { organizationId: orgId, userId: member.id, role: "member" },
	});
	const row = t.db.member?.find((m) => m.userId === member.id) as { id: string };
	return { orgId, owner, member, memberRowId: row.id };
}

const asMember = (userId: string, orgId: string) => ({
	userId,
	orgId,
	orgRole: "member",
	roles: [],
});

describe("authzPlugin", () => {
	it("gives an org's creator every creatorRole when there are several", async () => {
		t = setup({ creatorRole: ["admin", "reviewer"] });
		const { orgId, owner, member } = await orgWithMember();
		expect(await t.authz.checkPermission(asMember(owner.id, orgId), "people:list")).toBe(true);
		expect(await t.authz.checkPermission(asMember(owner.id, orgId), "people:review")).toBe(true);
		expect(await t.authz.checkPermission(asMember(member.id, orgId), "people:review")).toBe(false);
	});

	it("makes an org's creator its admin", async () => {
		const { orgId, owner, member } = await orgWithMember();
		expect(await t.authz.checkPermission(asMember(owner.id, orgId), "people:list")).toBe(true);
		expect(await t.authz.checkPermission(asMember(member.id, orgId), "people:list")).toBe(false);
	});

	it("keeps member roles to owner and member", async () => {
		const { orgId, owner, memberRowId } = await orgWithMember();
		for (const role of ["admin", "member,admin", "manager"]) {
			const updated = await t.call("update-member-role", owner.headers, {
				organizationId: orgId,
				memberId: memberRowId,
				role,
			});
			expect(updated.status, role).toBe(400);
			const invited = await t.call("invite-member", owner.headers, {
				organizationId: orgId,
				email: `${crypto.randomUUID()}@example.com`,
				role,
			});
			expect(invited.status, role).toBe(400);
		}
		const ok = await t.call("invite-member", owner.headers, {
			organizationId: orgId,
			email: "new@example.com",
			role: "member",
		});
		expect(ok.status).toBe(200);
	});

	it("guards better-auth endpoints with an authz permission, for bearer sessions too", async () => {
		const { orgId, owner, member } = await orgWithMember();
		expect((await t.call(`list-members?organizationId=${orgId}`, member.headers)).status).toBe(403);
		expect((await t.call(`list-members?organizationId=${orgId}`, owner.headers)).status).toBe(200);
		await t.authz.addOverlay(null, orgId, member.id, {
			resource: "people",
			action: "list",
			effect: "grant",
		});
		expect((await t.call(`list-members?organizationId=${orgId}`, member.headers)).status).toBe(200);
	});

	it("checks every org a request names, so one can't vouch for another", async () => {
		const { orgId, member } = await orgWithMember();
		const own = await t.call("create", member.headers, { name: "Mine", slug: `mine-${member.id}` });
		const mine = own.body as { id: string; slug: string };
		const sneaky = await t.call(
			`list-members?organizationSlug=${mine.slug}&organizationId=${orgId}`,
			member.headers,
		);
		expect(sneaky.status).toBe(403);
	});

	it("gives an owner made later the creator's role, and takes it from one who stops being owner", async () => {
		const { orgId, owner, member, memberRowId } = await orgWithMember();
		const promote = (role: string) =>
			t.call("update-member-role", owner.headers, {
				organizationId: orgId,
				memberId: memberRowId,
				role,
			});
		expect((await promote("owner")).status).toBe(200);
		expect(await t.authz.checkPermission(asMember(member.id, orgId), "people:list")).toBe(true);
		expect((await promote("member")).status).toBe(200);
		expect(await t.authz.checkPermission(asMember(member.id, orgId), "people:list")).toBe(false);
		// admin given through authz, to someone who was never owner, stays when their member role changes
		await t.authz.grantSystemRole(orgId, member.id, "admin", owner.id);
		expect((await promote("member")).status).toBe(200);
		expect(await t.authz.checkPermission(asMember(member.id, orgId), "people:list")).toBe(true);
	});

	it("gives someone invited as owner the creator's role when they accept", async () => {
		const { orgId, owner } = await orgWithMember();
		const invitee = await t.user();
		const row = (t.db.user ?? []).find((u) => u.id === invitee.id) as { email: string };
		const email = row.email;
		const invited = await t.call("invite-member", owner.headers, {
			organizationId: orgId,
			email,
			role: "owner",
		});
		expect(invited.status).toBe(200);
		const accepted = await t.call("accept-invitation", invitee.headers, {
			invitationId: (invited.body as { id: string }).id,
		});
		expect(accepted.status).toBe(200);
		expect(await t.authz.checkPermission(asMember(invitee.id, orgId), "people:list")).toBe(true);
	});

	it("clears authz access when a member is removed or leaves", async () => {
		const { orgId, owner, member, memberRowId } = await orgWithMember();
		await t.authz.addOverlay(null, orgId, member.id, {
			resource: "people",
			action: "list",
			effect: "grant",
		});
		const removed = await t.call("remove-member", owner.headers, {
			organizationId: orgId,
			memberIdOrEmail: memberRowId,
		});
		expect(removed.status).toBe(200);
		expect(await t.authz.checkPermission(asMember(member.id, orgId), "people:list")).toBe(false);
		const again = await t.user();
		await t.auth.api.addMember({
			body: { organizationId: orgId, userId: again.id, role: "member" },
		});
		await t.authz.addOverlay(null, orgId, again.id, {
			resource: "people",
			action: "list",
			effect: "grant",
		});
		expect((await t.call("leave", again.headers, { organizationId: orgId })).status).toBe(200);
		expect(await t.authz.checkPermission(asMember(again.id, orgId), "people:list")).toBe(false);
	});
});
