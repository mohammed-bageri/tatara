import { newId } from "@tatara/db";
import type { OverlayEffect, Scope } from "./constants.ts";
import { SYSTEM_ORG_ID } from "./constants.ts";
import type { AuthzStore, OverlayRow, PermissionGrant, RoleRow } from "./types.ts";

interface OverlayRecord {
	id: string;
	orgId: string;
	userId: string;
	resource: string;
	action: string;
	scope: string;
	effect: string;
	grantedBy: string | null;
	reason: string | null;
	expiresAt: Date | null;
	createdAt: Date;
}

interface RoleRecord {
	id: string;
	orgId: string;
	key: string;
	name: string;
	description: string | null;
	isSystem: boolean;
	permissions: { resource: string; action: string; scope: string }[];
	_count: { members: number };
}

interface AuditRecord {
	id: string;
	orgId: string;
	actorId: string;
	targetUserId: string | null;
	changeType: string;
	before: string | null;
	after: string | null;
	at: Date;
}

interface Model<Row> {
	findMany(args: object): Promise<Row[]>;
	findFirst(args: object): Promise<Row | null>;
	create(args: object): Promise<unknown>;
	createMany(args: object): Promise<unknown>;
	update(args: object): Promise<unknown>;
	delete(args: object): Promise<unknown>;
	deleteMany(args: object): Promise<{ count: number }>;
	count(args: object): Promise<number>;
}

/** What the store needs from the app's PrismaClient: the models in prisma/models/authz.prisma. */
interface PrismaAuthzClient {
	authzRole: Model<RoleRecord>;
	authzRolePermission: Model<{ roleId: string; scope: string }>;
	authzMemberRole: Model<{ id: string; userId: string; roleId: string }>;
	authzOverlay: Model<OverlayRecord>;
	authzAuditLog: Model<AuditRecord>;
	$transaction<T>(fn: (tx: PrismaAuthzClient) => Promise<T>): Promise<T>;
	$transaction(
		operations: [Promise<{ count: number }>, Promise<{ count: number }>],
	): Promise<[{ count: number }, { count: number }]>;
}

/**
 * The AuthzStore for Prisma, over the app's client. Prisma generates the client's type per app,
 * so only the models' presence is checked here; the e2e matrix runs the store against real clients.
 */
export function prismaAuthzStore(
	client: {
		[K in keyof PrismaAuthzClient]: unknown;
	},
): AuthzStore {
	const db = client as unknown as PrismaAuthzClient;
	const toScope = (scope: string): Scope | null => (scope === "" ? null : (scope as Scope));

	function toOverlay(row: OverlayRecord): OverlayRow {
		return { ...row, scope: toScope(row.scope), effect: row.effect as OverlayEffect };
	}

	const roleInclude = (orgId: string) => ({
		permissions: true,
		_count: { select: { members: { where: { orgId } } } },
	});

	function toRole(role: RoleRecord): RoleRow {
		return {
			id: role.id,
			orgId: role.orgId,
			key: role.key,
			name: role.name,
			description: role.description,
			isSystem: role.isSystem,
			grants: role.permissions.map((g) => ({
				resource: g.resource,
				action: g.action,
				scope: toScope(g.scope),
			})),
			memberCount: role._count.members,
		};
	}

	const grantRows = (grants: PermissionGrant[]) =>
		grants.map((g) => ({
			id: newId(),
			resource: g.resource,
			action: g.action,
			scope: g.scope ?? "",
		}));

	return {
		async roleGrants(orgId, userId, impliedRoleKeys) {
			const roles = await db.authzRole.findMany({
				where: {
					OR: [
						{ members: { some: { orgId, userId } } },
						...(impliedRoleKeys.length
							? [{ orgId: SYSTEM_ORG_ID, key: { in: impliedRoleKeys } }]
							: []),
					],
				},
				include: { permissions: true },
			});
			return {
				roles: roles.map((r) => r.key),
				grants: roles.flatMap((r) =>
					r.permissions.map((g) => ({
						resource: g.resource,
						action: g.action,
						scope: toScope(g.scope),
					})),
				),
			};
		},

		async activeOverlays(orgId, userId, now) {
			const rows = await db.authzOverlay.findMany({
				where: { orgId, userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
			});
			return rows.map(toOverlay);
		},

		async listRoles(orgId) {
			const roles = await db.authzRole.findMany({
				where: { orgId: { in: [SYSTEM_ORG_ID, orgId] } },
				include: roleInclude(orgId),
				orderBy: { key: "asc" },
			});
			return roles.map(toRole);
		},

		async findRole(orgId, roleId) {
			const role = await db.authzRole.findFirst({
				where: { id: roleId, orgId: { in: [SYSTEM_ORG_ID, orgId] } },
				include: roleInclude(orgId),
			});
			return role ? toRole(role) : null;
		},

		async findRoleByKey(orgId, key) {
			const role = await db.authzRole.findFirst({
				where: { key, orgId },
				include: roleInclude(orgId),
			});
			return role ? toRole(role) : null;
		},

		async createRole(input) {
			const id = newId();
			await db.authzRole.create({
				data: {
					id,
					orgId: input.orgId,
					key: input.key,
					name: input.name,
					description: input.description,
					isSystem: input.isSystem,
					permissions: { create: grantRows(input.grants) },
				},
			});
			return id;
		},

		async updateRole(roleId, input) {
			await db.$transaction(async (tx) => {
				await tx.authzRole.update({
					where: { id: roleId },
					data: {
						...(input.name === undefined ? {} : { name: input.name }),
						...(input.description === undefined ? {} : { description: input.description }),
					},
				});
				if (input.grants) {
					await tx.authzRolePermission.deleteMany({ where: { roleId } });
					await tx.authzRolePermission.createMany({
						data: grantRows(input.grants).map((g) => ({ ...g, roleId })),
					});
				}
			});
		},

		async deleteRole(roleId) {
			await db.authzRole.delete({ where: { id: roleId } });
		},

		async roleAssignmentCount(roleId) {
			return db.authzMemberRole.count({ where: { roleId } });
		},

		async memberRoles(orgId, userId) {
			const roles = await db.authzRole.findMany({
				where: { members: { some: { orgId, userId } } },
				include: roleInclude(orgId),
			});
			return roles.map(toRole);
		},

		async assignRole(orgId, userId, roleId, by) {
			const existing = await db.authzMemberRole.findFirst({ where: { orgId, userId, roleId } });
			if (existing) return false;
			await db.authzMemberRole.create({
				data: { id: newId(), orgId, userId, roleId, assignedBy: by },
			});
			return true;
		},

		async revokeRole(orgId, userId, roleId) {
			const { count } = await db.authzMemberRole.deleteMany({ where: { orgId, userId, roleId } });
			return count > 0;
		},

		async replaceMemberRoles(orgId, userId, add, remove, by) {
			await db.$transaction(async (tx) => {
				if (remove.length > 0)
					await tx.authzMemberRole.deleteMany({ where: { orgId, userId, roleId: { in: remove } } });
				if (add.length > 0)
					await tx.authzMemberRole.createMany({
						data: add.map((roleId) => ({ id: newId(), orgId, userId, roleId, assignedBy: by })),
					});
			});
		},

		async permissionHolders(orgId, resource, action, now, executor) {
			const exec = (executor as PrismaAuthzClient | undefined) ?? db;
			const grants = await exec.authzRolePermission.findMany({
				where: { resource, action },
				select: { roleId: true, scope: true },
			});
			const scopesByRole = new Map<string, string[]>();
			for (const g of grants)
				scopesByRole.set(g.roleId, [...(scopesByRole.get(g.roleId) ?? []), g.scope]);
			const [assigned, overlays] = await Promise.all([
				scopesByRole.size
					? exec.authzMemberRole.findMany({
							where: { orgId, roleId: { in: [...scopesByRole.keys()] } },
							select: { userId: true, roleId: true },
						})
					: Promise.resolve([]),
				exec.authzOverlay.findMany({
					where: {
						orgId,
						resource,
						action,
						OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
					},
				}),
			]);
			return {
				assignments: assigned.flatMap((m) =>
					(scopesByRole.get(m.roleId) ?? []).map((scope) => ({
						userId: m.userId,
						scope: toScope(scope),
					})),
				),
				overlays: overlays.map((o) => ({
					userId: o.userId,
					scope: toScope(o.scope),
					effect: o.effect as OverlayEffect,
				})),
			};
		},

		async removeMember(orgId, userId) {
			const [roles, overlays] = await db.$transaction([
				db.authzMemberRole.deleteMany({ where: { orgId, userId } }),
				db.authzOverlay.deleteMany({ where: { orgId, userId } }),
			]);
			return { roles: roles.count, overlays: overlays.count };
		},
		async listOverlays(orgId, userId) {
			const rows = await db.authzOverlay.findMany({
				where: { orgId, userId },
				orderBy: { createdAt: "desc" },
			});
			return rows.map(toOverlay);
		},

		async addOverlay(input) {
			const id = newId();
			const scope = input.scope ?? "";
			await db.authzOverlay.deleteMany({
				where: {
					orgId: input.orgId,
					userId: input.userId,
					resource: input.resource,
					action: input.action,
					scope,
					effect: input.effect,
				},
			});
			await db.authzOverlay.create({ data: { ...input, id, scope } });
			return id;
		},

		async removeOverlay(orgId, userId, overlayId) {
			const row = await db.authzOverlay.findFirst({ where: { id: overlayId, orgId, userId } });
			if (!row) return null;
			await db.authzOverlay.deleteMany({ where: { id: overlayId, orgId, userId } });
			return toOverlay(row);
		},

		async writeAudit(input) {
			await db.authzAuditLog.create({
				data: {
					id: newId(),
					orgId: input.orgId,
					actorId: input.actorId,
					targetUserId: input.targetUserId,
					changeType: input.changeType,
					before: input.before === undefined ? null : JSON.stringify(input.before),
					after: input.after === undefined ? null : JSON.stringify(input.after),
				},
			});
		},

		async listAudit(orgId, limit, before) {
			const rows = await db.authzAuditLog.findMany({
				where: {
					orgId,
					...(before
						? {
								OR: [{ at: { lt: before.at } }, { at: before.at, id: { lt: before.id } }],
							}
						: {}),
				},
				orderBy: [{ at: "desc" }, { id: "desc" }],
				take: limit,
			});
			return rows.map((r) => ({
				...r,
				before: r.before ? (JSON.parse(r.before) as unknown) : null,
				after: r.after ? (JSON.parse(r.after) as unknown) : null,
			}));
		},
	};
}
