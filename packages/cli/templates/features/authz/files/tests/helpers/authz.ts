import { DEFAULT_ORG_ID, SYSTEM_ORG_ID } from "@tatara/authz";
import { authz } from "#modules/authz/services/authz";
import type { SystemRoleKey } from "#modules/authz/services/system-roles";
import type { PermissionKey } from "#generated/permissions";

export interface TestAccess {
	/** unscoped permissions granted directly (as overlays) */
	permissions?: PermissionKey[];
	/** built-in roles assigned in the org */
	systemRoles?: SystemRoleKey[];
	orgId?: string;
}

export async function applyTestAccess(userId: string, access: TestAccess): Promise<void> {
	const orgId = access.orgId ?? DEFAULT_ORG_ID;
	for (const key of access.permissions ?? []) {
		const [resource = "", action = ""] = key.split(":");
		await authz.addOverlay(null, orgId, userId, { resource, action, effect: "grant" });
	}
	if (access.systemRoles?.length) {
		await authz.syncSystemRoles();
		for (const roleKey of access.systemRoles) {
			const role = await authz.store.findRoleByKey(SYSTEM_ORG_ID, roleKey);
			if (!role) throw new Error(`Unknown built-in role ${roleKey}`);
			await authz.assignRole(null, orgId, userId, role.id);
		}
	}
}
