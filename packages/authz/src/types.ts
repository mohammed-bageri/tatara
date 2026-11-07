import type { OverlayEffect, Scope } from "./constants.ts";

export interface PermissionGrant {
	resource: string;
	action: string;
	scope: Scope | null;
}

export interface OverlayRow extends PermissionGrant {
	id: string;
	orgId: string;
	userId: string;
	effect: OverlayEffect;
	grantedBy: string | null;
	reason: string | null;
	expiresAt: Date | null;
	createdAt: Date;
}

export interface RoleRow {
	id: string;
	orgId: string;
	key: string;
	name: string;
	description: string | null;
	isSystem: boolean;
	grants: PermissionGrant[];
	memberCount: number;
}

export interface AuditRow {
	id: string;
	orgId: string;
	actorId: string;
	targetUserId: string | null;
	changeType: string;
	before: unknown;
	after: unknown;
	at: Date;
}

/** A member's resolved permissions in one org. */
export interface EffectivePermissions {
	grants: PermissionGrant[];
	/** "resource:action:scope|*" keys denied by overlays; deny always wins */
	denies: Set<string>;
	roles: string[];
}

/** Who holds one permission in an org, explicitly: role assignments and live overlays. */
export interface PermissionHolders {
	assignments: { userId: string; scope: Scope | null }[];
	overlays: { userId: string; scope: Scope | null; effect: OverlayEffect }[];
}

/** Where an audit page ends; the next page starts after it. */
export interface AuditCursor {
	at: Date;
	id: string;
}

export function grantKey(grant: PermissionGrant): string {
	return `${grant.resource}:${grant.action}:${grant.scope ?? "*"}`;
}

/** Everything authz reads and writes; implemented by the app for its ORM. */
export interface AuthzStore {
	roleGrants(
		orgId: string,
		userId: string,
		impliedRoleKeys: string[],
	): Promise<{
		roles: string[];
		grants: PermissionGrant[];
	}>;
	activeOverlays(orgId: string, userId: string, now: Date): Promise<OverlayRow[]>;
	listRoles(orgId: string): Promise<RoleRow[]>;
	findRole(orgId: string, roleId: string): Promise<RoleRow | null>;
	findRoleByKey(orgId: string, key: string): Promise<RoleRow | null>;
	createRole(input: {
		orgId: string;
		key: string;
		name: string;
		description: string | null;
		isSystem: boolean;
		grants: PermissionGrant[];
	}): Promise<string>;
	updateRole(
		roleId: string,
		input: { name?: string; description?: string | null; grants?: PermissionGrant[] },
	): Promise<void>;
	deleteRole(roleId: string): Promise<void>;
	/** How many members hold the role, across every org. */
	roleAssignmentCount(roleId: string): Promise<number>;
	memberRoles(orgId: string, userId: string): Promise<RoleRow[]>;
	assignRole(orgId: string, userId: string, roleId: string, by: string | null): Promise<boolean>;
	revokeRole(orgId: string, userId: string, roleId: string): Promise<boolean>;
	/** Adds and removes role assignments of one member in one step (atomic). */
	replaceMemberRoles(
		orgId: string,
		userId: string,
		add: string[],
		remove: string[],
		by: string | null,
	): Promise<void>;
	/**
	 * Explicit holders of `resource:action` in an org, read at decision time (no cache).
	 * `executor` is the caller's transaction, when it passes one, so it sees its own writes.
	 */
	permissionHolders(
		orgId: string,
		resource: string,
		action: string,
		now: Date,
		executor?: unknown,
	): Promise<PermissionHolders>;
	/** Deletes every role assignment and overlay the user has in the org. */
	removeMember(orgId: string, userId: string): Promise<{ roles: number; overlays: number }>;
	listOverlays(orgId: string, userId: string): Promise<OverlayRow[]>;
	addOverlay(input: Omit<OverlayRow, "id" | "createdAt">): Promise<string>;
	removeOverlay(orgId: string, userId: string, overlayId: string): Promise<OverlayRow | null>;
	writeAudit(input: Omit<AuditRow, "id" | "at">): Promise<void>;
	/** newest first; with `before`, only entries older than that cursor */
	listAudit(orgId: string, limit: number, before?: AuditCursor): Promise<AuditRow[]>;
}
