import { boolean, index, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

const ts = () => timestamp({ withTimezone: true, mode: "date" });

/** Built-in roles have orgId "" (they apply to every org); custom roles belong to one org. */
export const authzRoles = pgTable(
	"authz_roles",
	{
		id: text().primaryKey(),
		orgId: text().notNull().default(""),
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
export const authzRolePermissions = pgTable(
	"authz_role_permissions",
	{
		id: text().primaryKey(),
		roleId: text()
			.notNull()
			.references(() => authzRoles.id, { onDelete: "cascade" }),
		resource: varchar({ length: 64 }).notNull(),
		action: varchar({ length: 64 }).notNull(),
		scope: varchar({ length: 16 }).notNull().default(""),
	},
	(t) => [uniqueIndex("authz_role_permissions_grant").on(t.roleId, t.resource, t.action, t.scope)],
);

export const authzMemberRoles = pgTable(
	"authz_member_roles",
	{
		id: text().primaryKey(),
		orgId: text().notNull(),
		userId: text().notNull(),
		roleId: text()
			.notNull()
			.references(() => authzRoles.id, { onDelete: "cascade" }),
		assignedBy: text(),
		assignedAt: ts().notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("authz_member_roles_member_role").on(t.orgId, t.userId, t.roleId),
		index("authz_member_roles_member").on(t.orgId, t.userId),
	],
);

export const authzOverlays = pgTable(
	"authz_overlays",
	{
		id: text().primaryKey(),
		orgId: text().notNull(),
		userId: text().notNull(),
		resource: varchar({ length: 64 }).notNull(),
		action: varchar({ length: 64 }).notNull(),
		scope: varchar({ length: 16 }).notNull().default(""),
		effect: varchar({ length: 8 }).notNull(),
		grantedBy: text(),
		reason: text(),
		expiresAt: ts(),
		createdAt: ts().notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("authz_overlays_grant").on(t.orgId, t.userId, t.resource, t.action, t.scope, t.effect),
		index("authz_overlays_member").on(t.orgId, t.userId),
	],
);

export const authzAuditLog = pgTable(
	"authz_audit_log",
	{
		id: text().primaryKey(),
		orgId: text().notNull(),
		actorId: text().notNull(),
		targetUserId: text(),
		changeType: varchar({ length: 48 }).notNull(),
		before: text(),
		after: text(),
		at: ts().notNull().defaultNow(),
	},
	(t) => [index("authz_audit_log_org_at").on(t.orgId, t.at)],
);
