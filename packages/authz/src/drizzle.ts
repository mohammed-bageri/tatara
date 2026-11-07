import { newId } from "@tatara/db";
import { and, count, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import type { OverlayEffect, Scope } from "./constants.ts";
import { SYSTEM_ORG_ID } from "./constants.ts";
import type { AuditRow, AuthzStore, OverlayRow, PermissionGrant, RoleRow } from "./types.ts";

/** The app's authz tables (src/core/authz/db/authz.schema.ts), Postgres or MySQL. */
export interface DrizzleAuthzTables {
	// biome-ignore lint/suspicious/noExplicitAny: the same queries run on pg and mysql tables
	authzRoles: any;
	// biome-ignore lint/suspicious/noExplicitAny: as above
	authzRolePermissions: any;
	// biome-ignore lint/suspicious/noExplicitAny: as above
	authzMemberRoles: any;
	// biome-ignore lint/suspicious/noExplicitAny: as above
	authzOverlays: any;
	// biome-ignore lint/suspicious/noExplicitAny: as above
	authzAuditLog: any;
}

/** The AuthzStore for Drizzle, over the app's database and its authz tables. */
// biome-ignore lint/suspicious/noExplicitAny: a pg or mysql drizzle database
export function drizzleAuthzStore(db: any, tables: DrizzleAuthzTables): AuthzStore {
	const { authzAuditLog, authzMemberRoles, authzOverlays, authzRolePermissions, authzRoles } =
		tables;
	const toScope = (scope: string): Scope | null => (scope === "" ? null : (scope as Scope));

	type RoleRecord = {
		id: string;
		orgId: string;
		key: string;
		name: string;
		description: string | null;
		isSystem: boolean;
	};
	type OverlayRecord = Omit<OverlayRow, "scope" | "effect"> & { scope: string; effect: string };
	type GrantRecord = { roleId: string; resource: string; action: string; scope: string };
	type AuditRecord = Omit<AuditRow, "before" | "after"> & {
		before: string | null;
		after: string | null;
	};

	function toOverlay(row: OverlayRecord): OverlayRow {
		return { ...row, scope: toScope(row.scope), effect: row.effect as OverlayEffect };
	}

	async function hydrate(roles: RoleRecord[], orgId: string): Promise<RoleRow[]> {
		if (roles.length === 0) return [];
		const ids = roles.map((r) => r.id);
		const [grants, members] = await Promise.all([
			db.select().from(authzRolePermissions).where(inArray(authzRolePermissions.roleId, ids)),
			db
				.select({ roleId: authzMemberRoles.roleId, total: count() })
				.from(authzMemberRoles)
				.where(and(eq(authzMemberRoles.orgId, orgId), inArray(authzMemberRoles.roleId, ids)))
				.groupBy(authzMemberRoles.roleId),
		]);
		return roles.map((role) => ({
			id: role.id,
			orgId: role.orgId,
			key: role.key,
			name: role.name,
			description: role.description,
			isSystem: role.isSystem,
			grants: grants
				.filter((g: GrantRecord) => g.roleId === role.id)
				.map((g: GrantRecord) => ({
					resource: g.resource,
					action: g.action,
					scope: toScope(g.scope),
				})),
			memberCount:
				members.find((m: { roleId: string; total: number }) => m.roleId === role.id)?.total ?? 0,
		}));
	}

	const visibleTo = (orgId: string) =>
		or(eq(authzRoles.orgId, SYSTEM_ORG_ID), eq(authzRoles.orgId, orgId));

	async function insertGrants(roleId: string, grants: PermissionGrant[]) {
		if (grants.length === 0) return;
		await db.insert(authzRolePermissions).values(
			grants.map((g) => ({
				id: newId(),
				roleId,
				resource: g.resource,
				action: g.action,
				scope: g.scope ?? "",
			})),
		);
	}

	return {
		async roleGrants(orgId, userId, impliedRoleKeys) {
			const assigned = await db
				.select({ roleId: authzMemberRoles.roleId })
				.from(authzMemberRoles)
				.where(and(eq(authzMemberRoles.orgId, orgId), eq(authzMemberRoles.userId, userId)));
			const implied = impliedRoleKeys.length
				? await db
						.select({ id: authzRoles.id })
						.from(authzRoles)
						.where(
							and(eq(authzRoles.orgId, SYSTEM_ORG_ID), inArray(authzRoles.key, impliedRoleKeys)),
						)
				: [];
			const roleIds = [
				...new Set([
					...assigned.map((r: { roleId: string }) => r.roleId),
					...implied.map((r: { id: string }) => r.id),
				]),
			];
			if (roleIds.length === 0) return { roles: [], grants: [] };
			const [roles, grants] = await Promise.all([
				db.select({ key: authzRoles.key }).from(authzRoles).where(inArray(authzRoles.id, roleIds)),
				db.select().from(authzRolePermissions).where(inArray(authzRolePermissions.roleId, roleIds)),
			]);
			return {
				roles: roles.map((r: { key: string }) => r.key),
				grants: grants.map((g: GrantRecord) => ({
					resource: g.resource,
					action: g.action,
					scope: toScope(g.scope),
				})),
			};
		},

		async activeOverlays(orgId, userId, now) {
			const rows = await db
				.select()
				.from(authzOverlays)
				.where(
					and(
						eq(authzOverlays.orgId, orgId),
						eq(authzOverlays.userId, userId),
						or(isNull(authzOverlays.expiresAt), gt(authzOverlays.expiresAt, now)),
					),
				);
			return rows.map(toOverlay);
		},

		async listRoles(orgId) {
			const roles = await db
				.select()
				.from(authzRoles)
				.where(visibleTo(orgId))
				.orderBy(authzRoles.key);
			return hydrate(roles, orgId);
		},

		async findRole(orgId, roleId) {
			const roles = await db
				.select()
				.from(authzRoles)
				.where(and(eq(authzRoles.id, roleId), visibleTo(orgId)));
			return (await hydrate(roles, orgId))[0] ?? null;
		},

		async findRoleByKey(orgId, key) {
			const roles = await db
				.select()
				.from(authzRoles)
				.where(and(eq(authzRoles.key, key), eq(authzRoles.orgId, orgId)));
			return (await hydrate(roles, orgId))[0] ?? null;
		},

		async createRole(input) {
			const id = newId();
			await db.insert(authzRoles).values({
				id,
				orgId: input.orgId,
				key: input.key,
				name: input.name,
				description: input.description,
				isSystem: input.isSystem,
			});
			await insertGrants(id, input.grants);
			return id;
		},

		async updateRole(roleId, input) {
			const fields = {
				...(input.name === undefined ? {} : { name: input.name }),
				...(input.description === undefined ? {} : { description: input.description }),
			};
			await db
				.update(authzRoles)
				.set({ ...fields, updatedAt: new Date() })
				.where(eq(authzRoles.id, roleId));
			if (input.grants) {
				await db.delete(authzRolePermissions).where(eq(authzRolePermissions.roleId, roleId));
				await insertGrants(roleId, input.grants);
			}
		},

		async deleteRole(roleId) {
			await db.delete(authzRoles).where(eq(authzRoles.id, roleId));
		},

		async memberRoles(orgId, userId) {
			const assigned = await db
				.select({ roleId: authzMemberRoles.roleId })
				.from(authzMemberRoles)
				.where(and(eq(authzMemberRoles.orgId, orgId), eq(authzMemberRoles.userId, userId)));
			if (assigned.length === 0) return [];
			const roles = await db
				.select()
				.from(authzRoles)
				.where(
					inArray(
						authzRoles.id,
						assigned.map((a: { roleId: string }) => a.roleId),
					),
				);
			return hydrate(roles, orgId);
		},

		async assignRole(orgId, userId, roleId, by) {
			const existing = await db
				.select({ id: authzMemberRoles.id })
				.from(authzMemberRoles)
				.where(
					and(
						eq(authzMemberRoles.orgId, orgId),
						eq(authzMemberRoles.userId, userId),
						eq(authzMemberRoles.roleId, roleId),
					),
				);
			if (existing.length > 0) return false;
			await db
				.insert(authzMemberRoles)
				.values({ id: newId(), orgId, userId, roleId, assignedBy: by });
			return true;
		},

		async revokeRole(orgId, userId, roleId) {
			const where = and(
				eq(authzMemberRoles.orgId, orgId),
				eq(authzMemberRoles.userId, userId),
				eq(authzMemberRoles.roleId, roleId),
			);
			const existing = await db
				.select({ id: authzMemberRoles.id })
				.from(authzMemberRoles)
				.where(where);
			if (existing.length === 0) return false;
			await db.delete(authzMemberRoles).where(where);
			return true;
		},

		async replaceMemberRoles(orgId, userId, add, remove, by) {
			// biome-ignore lint/suspicious/noExplicitAny: the app's pg or mysql transaction
			await db.transaction(async (tx: any) => {
				if (remove.length > 0)
					await tx
						.delete(authzMemberRoles)
						.where(
							and(
								eq(authzMemberRoles.orgId, orgId),
								eq(authzMemberRoles.userId, userId),
								inArray(authzMemberRoles.roleId, remove),
							),
						);
				if (add.length > 0)
					await tx
						.insert(authzMemberRoles)
						.values(add.map((roleId) => ({ id: newId(), orgId, userId, roleId, assignedBy: by })));
			});
		},

		async permissionHolders(orgId, resource, action, now, executor) {
			const exec = executor ?? db;
			const [assignments, overlays] = await Promise.all([
				exec
					.select({ userId: authzMemberRoles.userId, scope: authzRolePermissions.scope })
					.from(authzMemberRoles)
					.innerJoin(authzRolePermissions, eq(authzRolePermissions.roleId, authzMemberRoles.roleId))
					.where(
						and(
							eq(authzMemberRoles.orgId, orgId),
							eq(authzRolePermissions.resource, resource),
							eq(authzRolePermissions.action, action),
						),
					),
				exec
					.select({
						userId: authzOverlays.userId,
						scope: authzOverlays.scope,
						effect: authzOverlays.effect,
					})
					.from(authzOverlays)
					.where(
						and(
							eq(authzOverlays.orgId, orgId),
							eq(authzOverlays.resource, resource),
							eq(authzOverlays.action, action),
							or(isNull(authzOverlays.expiresAt), gt(authzOverlays.expiresAt, now)),
						),
					),
			]);
			return {
				assignments: assignments.map((a: { userId: string; scope: string }) => ({
					userId: a.userId,
					scope: toScope(a.scope),
				})),
				overlays: overlays.map((o: { userId: string; scope: string; effect: OverlayEffect }) => ({
					userId: o.userId,
					scope: toScope(o.scope),
					effect: o.effect,
				})),
			};
		},

		async removeMember(orgId, userId) {
			const roleWhere = and(eq(authzMemberRoles.orgId, orgId), eq(authzMemberRoles.userId, userId));
			const overlayWhere = and(eq(authzOverlays.orgId, orgId), eq(authzOverlays.userId, userId));
			// count first: MySQL has no RETURNING
			// biome-ignore lint/suspicious/noExplicitAny: the app's pg or mysql transaction
			return db.transaction(async (tx: any) => {
				const [roles] = await tx.select({ n: count() }).from(authzMemberRoles).where(roleWhere);
				const [overlays] = await tx.select({ n: count() }).from(authzOverlays).where(overlayWhere);
				await tx.delete(authzMemberRoles).where(roleWhere);
				await tx.delete(authzOverlays).where(overlayWhere);
				return { roles: roles?.n ?? 0, overlays: overlays?.n ?? 0 };
			});
		},

		async listOverlays(orgId, userId) {
			const rows = await db
				.select()
				.from(authzOverlays)
				.where(and(eq(authzOverlays.orgId, orgId), eq(authzOverlays.userId, userId)))
				.orderBy(desc(authzOverlays.createdAt));
			return rows.map(toOverlay);
		},

		async addOverlay(input) {
			const id = newId();
			const scope = input.scope ?? "";
			await db
				.delete(authzOverlays)
				.where(
					and(
						eq(authzOverlays.orgId, input.orgId),
						eq(authzOverlays.userId, input.userId),
						eq(authzOverlays.resource, input.resource),
						eq(authzOverlays.action, input.action),
						eq(authzOverlays.scope, scope),
						eq(authzOverlays.effect, input.effect),
					),
				);
			await db.insert(authzOverlays).values({ ...input, id, scope });
			return id;
		},

		async removeOverlay(orgId, userId, overlayId) {
			const where = and(
				eq(authzOverlays.orgId, orgId),
				eq(authzOverlays.userId, userId),
				eq(authzOverlays.id, overlayId),
			);
			const [row] = await db.select().from(authzOverlays).where(where);
			if (!row) return null;
			await db.delete(authzOverlays).where(where);
			return toOverlay(row);
		},

		async writeAudit(input) {
			await db.insert(authzAuditLog).values({
				id: newId(),
				orgId: input.orgId,
				actorId: input.actorId,
				targetUserId: input.targetUserId,
				changeType: input.changeType,
				before: input.before === undefined ? null : JSON.stringify(input.before),
				after: input.after === undefined ? null : JSON.stringify(input.after),
			});
		},

		async listAudit(orgId, limit, before) {
			const rows = await db
				.select()
				.from(authzAuditLog)
				.where(
					and(
						eq(authzAuditLog.orgId, orgId),
						before
							? or(
									lt(authzAuditLog.at, before.at),
									and(eq(authzAuditLog.at, before.at), lt(authzAuditLog.id, before.id)),
								)
							: undefined,
					),
				)
				.orderBy(desc(authzAuditLog.at), desc(authzAuditLog.id))
				.limit(limit);
			return rows.map((r: AuditRecord) => ({
				...r,
				before: r.before ? (JSON.parse(r.before) as unknown) : null,
				after: r.after ? (JSON.parse(r.after) as unknown) : null,
			}));
		},
	};
}
