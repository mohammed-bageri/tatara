import { createAuthz } from "@tatara/authz";
import { drizzleAuthzStore } from "@tatara/authz/drizzle";
import * as tables from "#modules/authz/db/authz.schema";
import { SYSTEM_ROLES } from "#modules/authz/services/system-roles";
import { db } from "#core/db/client";
import { catalog, type PermissionKey } from "#generated/permissions";

/** The app's authorization: its tables (authz.schema.ts), the catalog from `tatara sync`, built-in roles. */
export const authz = createAuthz<PermissionKey>({
	store: drizzleAuthzStore(db, tables),
	catalog,
	systemRoles: SYSTEM_ROLES,
	// tatara:slot options
});

export const { checkPermission, removeMemberAccess, requirePermission, resolveScope } = authz;
