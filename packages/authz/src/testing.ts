/** An in-memory AuthzStore with the same semantics as the generated ORM stores, for unit tests. */
import { SYSTEM_ORG_ID } from "./constants.ts";
import type {
	AuditRow,
	AuthzStore,
	OverlayRow,
	PermissionGrant,
	RoleLabels,
	RoleRow,
} from "./types.ts";

interface StoredRole {
	id: string;
	orgId: string;
	key: string;
	name: string;
	description: string | null;
	labels: RoleLabels;
	isSystem: boolean;
	grants: PermissionGrant[];
}

export function memoryAuthzStore(): AuthzStore {
	let seq = 0;
	const id = () => `id-${String(++seq).padStart(6, "0")}`;
	const roles: StoredRole[] = [];
	const members: { orgId: string; userId: string; roleId: string }[] = [];
	let overlays: OverlayRow[] = [];
	const audit: AuditRow[] = [];

	const toRow = (role: StoredRole, orgId: string): RoleRow => ({
		...role,
		labels: structuredClone(role.labels),
		grants: role.grants.map((g) => ({ ...g })),
		memberCount: members.filter((m) => m.roleId === role.id && m.orgId === orgId).length,
	});
	const assigned = (orgId: string, userId: string) =>
		roles.filter((r) =>
			members.some((m) => m.roleId === r.id && m.orgId === orgId && m.userId === userId),
		);
	const visible = (orgId: string) => (r: StoredRole) =>
		r.orgId === SYSTEM_ORG_ID || r.orgId === orgId;

	return {
		async roleGrants(orgId, userId, impliedRoleKeys) {
			const found = roles.filter(
				(r) =>
					assigned(orgId, userId).includes(r) ||
					(r.orgId === SYSTEM_ORG_ID && impliedRoleKeys.includes(r.key)),
			);
			return { roles: found.map((r) => r.key), grants: found.flatMap((r) => r.grants) };
		},
		async activeOverlays(orgId, userId, now) {
			return overlays.filter(
				(o) => o.orgId === orgId && o.userId === userId && (!o.expiresAt || o.expiresAt > now),
			);
		},
		async listRoles(orgId) {
			return roles
				.filter(visible(orgId))
				.sort((a, b) => a.key.localeCompare(b.key))
				.map((r) => toRow(r, orgId));
		},
		async findRole(orgId, roleId) {
			const role = roles.find((r) => r.id === roleId && visible(orgId)(r));
			return role ? toRow(role, orgId) : null;
		},
		async findRoleByKey(orgId, key) {
			const role = roles.find((r) => r.key === key && r.orgId === orgId);
			return role ? toRow(role, orgId) : null;
		},
		async createRole(input) {
			const roleId = id();
			roles.push({
				...input,
				labels: structuredClone(input.labels ?? {}),
				id: roleId,
				grants: input.grants.map((g) => ({ ...g })),
			});
			return roleId;
		},
		async updateRole(roleId, input) {
			const role = roles.find((r) => r.id === roleId);
			if (!role) return;
			if (input.name !== undefined) role.name = input.name;
			if (input.description !== undefined) role.description = input.description;
			if (input.labels !== undefined) role.labels = structuredClone(input.labels);
			if (input.grants) role.grants = input.grants.map((g) => ({ ...g }));
		},
		async deleteRole(roleId) {
			const index = roles.findIndex((r) => r.id === roleId);
			if (index >= 0) roles.splice(index, 1);
			for (let i = members.length - 1; i >= 0; i--)
				if (members[i]?.roleId === roleId) members.splice(i, 1);
		},
		async roleAssignmentCount(roleId) {
			return members.filter((m) => m.roleId === roleId).length;
		},
		async memberRoles(orgId, userId) {
			return assigned(orgId, userId).map((r) => toRow(r, orgId));
		},
		async assignRole(orgId, userId, roleId) {
			if (members.some((m) => m.orgId === orgId && m.userId === userId && m.roleId === roleId))
				return false;
			members.push({ orgId, userId, roleId });
			return true;
		},
		async revokeRole(orgId, userId, roleId) {
			const index = members.findIndex(
				(m) => m.orgId === orgId && m.userId === userId && m.roleId === roleId,
			);
			if (index < 0) return false;
			members.splice(index, 1);
			return true;
		},
		async replaceMemberRoles(orgId, userId, add, remove, _by) {
			for (let i = members.length - 1; i >= 0; i--) {
				const m = members[i];
				if (m?.orgId === orgId && m.userId === userId && remove.includes(m.roleId))
					members.splice(i, 1);
			}
			for (const roleId of add) {
				if (!members.some((m) => m.orgId === orgId && m.userId === userId && m.roleId === roleId))
					members.push({ orgId, userId, roleId });
			}
		},
		async permissionHolders(orgId, resource, action, now) {
			const assignments = members
				.filter((m) => m.orgId === orgId)
				.flatMap((m) => {
					const role = roles.find((r) => r.id === m.roleId);
					return (role?.grants ?? [])
						.filter((g) => g.resource === resource && g.action === action)
						.map((g) => ({ userId: m.userId, scope: g.scope }));
				});
			const live = overlays
				.filter(
					(o) =>
						o.orgId === orgId &&
						o.resource === resource &&
						o.action === action &&
						(!o.expiresAt || o.expiresAt > now),
				)
				.map((o) => ({ userId: o.userId, scope: o.scope, effect: o.effect }));
			return { assignments, overlays: live };
		},
		async removeMember(orgId, userId) {
			const before = { roles: members.length, overlays: overlays.length };
			for (let i = members.length - 1; i >= 0; i--) {
				const m = members[i];
				if (m?.orgId === orgId && m.userId === userId) members.splice(i, 1);
			}
			overlays = overlays.filter((o) => !(o.orgId === orgId && o.userId === userId));
			return {
				roles: before.roles - members.length,
				overlays: before.overlays - overlays.length,
			};
		},
		async listOverlays(orgId, userId) {
			return overlays
				.filter((o) => o.orgId === orgId && o.userId === userId)
				.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
		},
		async addOverlay(input) {
			// one overlay per (member, permission, scope, effect), as the ORM stores keep it
			overlays = overlays.filter(
				(o) =>
					!(
						o.orgId === input.orgId &&
						o.userId === input.userId &&
						o.resource === input.resource &&
						o.action === input.action &&
						o.scope === input.scope &&
						o.effect === input.effect
					),
			);
			const overlayId = id();
			overlays.push({ ...input, id: overlayId, createdAt: new Date() });
			return overlayId;
		},
		async removeOverlay(orgId, userId, overlayId) {
			const row = overlays.find(
				(o) => o.id === overlayId && o.orgId === orgId && o.userId === userId,
			);
			if (!row) return null;
			overlays = overlays.filter((o) => o !== row);
			return row;
		},
		async writeAudit(input) {
			audit.push({ ...input, id: id(), at: new Date() });
		},
		async listAudit(orgId, limit, before) {
			const newestFirst = (a: AuditRow, b: AuditRow) =>
				b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id);
			return audit
				.filter(
					(a) =>
						a.orgId === orgId &&
						(!before ||
							a.at.getTime() < before.at.getTime() ||
							(a.at.getTime() === before.at.getTime() && a.id.localeCompare(before.id) < 0)),
				)
				.sort(newestFirst)
				.slice(0, limit);
		},
	};
}
