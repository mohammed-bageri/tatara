import { boolean, index, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

const ts = () => timestamp({ fsp: 3, mode: "date" });
const id = () => varchar({ length: 36 });
const ref = () => varchar({ length: 255 });

/** Built-in roles have orgId "" (they apply to every org); custom roles belong to one org. */
export const authzRoles = mysqlTable(
	"authz_roles",
	{
		id: id().primaryKey(),
		orgId: ref().notNull().default(""),
		key: varchar({ length: 64 }).notNull(),
		name: varchar({ length: 120 }).notNull(),
		description: text(),
		/** name and description in other languages, JSON: { ar: { name, description } } */
		labels: text(),
		isSystem: boolean().notNull().default(false),
		createdAt: ts().notNull().defaultNow(),
		updatedAt: ts().notNull().defaultNow(),
	},
	(t) => [uniqueIndex("authz_roles_org_key").on(t.orgId, t.key)],
);

/** scope "" means the action is unscoped (keeps unique keys identical on every database). */
export const authzRolePermissions = mysqlTable(
	"authz_role_permissions",
	{
		id: id().primaryKey(),
		roleId: id()
			.notNull()
			.references(() => authzRoles.id, { onDelete: "cascade" }),
		resource: varchar({ length: 64 }).notNull(),
		action: varchar({ length: 64 }).notNull(),
		scope: varchar({ length: 16 }).notNull().default(""),
	},
	(t) => [uniqueIndex("authz_role_permissions_grant").on(t.roleId, t.resource, t.action, t.scope)],
);

export const authzMemberRoles = mysqlTable(
	"authz_member_roles",
	{
		id: id().primaryKey(),
		orgId: ref().notNull(),
		userId: ref().notNull(),
		roleId: id()
			.notNull()
			.references(() => authzRoles.id, { onDelete: "cascade" }),
		assignedBy: ref(),
		assignedAt: ts().notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("authz_member_roles_member_role").on(t.orgId, t.userId, t.roleId),
		index("authz_member_roles_member").on(t.orgId, t.userId),
	],
);

export const authzOverlays = mysqlTable(
	"authz_overlays",
	{
		id: id().primaryKey(),
		orgId: ref().notNull(),
		userId: ref().notNull(),
		resource: varchar({ length: 64 }).notNull(),
		action: varchar({ length: 64 }).notNull(),
		scope: varchar({ length: 16 }).notNull().default(""),
		effect: varchar({ length: 8 }).notNull(),
		grantedBy: ref(),
		reason: text(),
		expiresAt: ts(),
		createdAt: ts().notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("authz_overlays_grant").on(t.orgId, t.userId, t.resource, t.action, t.scope, t.effect),
		index("authz_overlays_member").on(t.orgId, t.userId),
	],
);

export const authzAuditLog = mysqlTable(
	"authz_audit_log",
	{
		id: id().primaryKey(),
		orgId: ref().notNull(),
		actorId: ref().notNull(),
		targetUserId: ref(),
		changeType: varchar({ length: 48 }).notNull(),
		before: text(),
		after: text(),
		at: ts().notNull().defaultNow(),
	},
	(t) => [index("authz_audit_log_org_at").on(t.orgId, t.at)],
);
