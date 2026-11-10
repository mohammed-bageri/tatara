import { beforeEach, describe, expect, it } from "vitest";
import { authz } from "#modules/authz/services/authz";
import { api } from "#tests/helpers/api";
import { authenticate } from "#tests/helpers/auth";
import { resetDatabase } from "#tests/helpers/db";

beforeEach(async () => {
	await resetDatabase();
	await authz.syncSystemRoles();
});

describe("an organization's creator", () => {
	it("is its admin", async () => {
		const user = await authenticate();
		const created = await api.post<{ id: string }>(
			"/api/auth/organization/create",
			{ name: "New School", slug: `new-${crypto.randomUUID()}` },
			{ headers: user.headers },
		);
		expect(created.status).toBe(200);
		const me = await api.get<{ data: { roles: string[] } }>("/api/authorization/me", {
			headers: { ...user.headers, "x-org-id": created.body.id },
		});
		expect(me.body.data.roles).toContain("admin");
	});
});
