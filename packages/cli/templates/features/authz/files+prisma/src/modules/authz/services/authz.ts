import { createAuthz } from "@tatara/authz";
import { prismaAuthzStore } from "@tatara/authz/prisma";
import { SYSTEM_ROLES } from "#modules/authz/services/system-roles";
import { db } from "#core/db/client";
import { catalog, type PermissionKey } from "#generated/permissions";

/** The app's authorization: its tables (prisma/models/authz.prisma), the catalog from `tatara sync`, built-in roles. */
export const authz = createAuthz<PermissionKey>({
	store: prismaAuthzStore(db),
	catalog,
	systemRoles: SYSTEM_ROLES,
	// tatara:slot options
});

export const { checkPermission, removeMemberAccess, requirePermission, resolveScope } = authz;
