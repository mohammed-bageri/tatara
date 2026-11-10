import { beforeEach, describe, expect, it } from "vitest";
import { authz } from "#modules/authz/services/authz";
import { api } from "#tests/helpers/api";
import { keycloakToken } from "#tests/helpers/auth";
import { resetDatabase } from "#tests/helpers/db";

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
	await resetDatabase();
});

describe("Keycloak access tokens with authz", () => {
	it("lets token roles match built-in authz roles", async () => {
		await authz.syncSystemRoles();
		// the token names its org, as Keycloak's organization claim does
		const admin = await keycloakToken({ roles: ["admin"], organization: ["test-org"] });
		const user = await keycloakToken({ roles: ["user"], organization: ["test-org"] });
		expect((await api.get("/api/authorization/roles", { headers: bearer(admin) })).status).toBe(
			200,
		);
		expect((await api.get("/api/authorization/roles", { headers: bearer(user) })).status).toBe(403);
	});
});
