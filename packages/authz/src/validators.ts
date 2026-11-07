import { z } from "@hono/zod-openapi";
import { OVERLAY_EFFECTS, SCOPES } from "./constants.ts";

export const grantSchema = z
	.object({
		resource: z.string().min(1),
		action: z.string().min(1),
		scope: z.enum(SCOPES).nullable().optional(),
	})
	.openapi("PermissionGrant");

export const roleLabelsSchema = z
	.record(
		z.string().min(2).max(16),
		z.object({
			name: z.string().trim().min(1).max(120),
			description: z.string().max(1000).nullable(),
		}),
	)
	.openapi("RoleLabels");

export const roleSchema = z
	.object({
		id: z.string(),
		key: z.string(),
		name: z.string(),
		description: z.string().nullable(),
		labels: roleLabelsSchema,
		isSystem: z.boolean(),
		grants: z.array(grantSchema),
		memberCount: z.number().int(),
	})
	.openapi("Role");

export const createRoleSchema = z
	.object({
		key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, "lowercase letters, digits and underscores"),
		name: z.string().trim().min(1).max(120),
		description: z.string().max(1000).nullable().optional(),
		labels: roleLabelsSchema.optional(),
		grants: z.array(grantSchema).default([]),
	})
	.openapi("CreateRole");

export const updateRoleSchema = createRoleSchema
	.omit({ key: true })
	.partial()
	.openapi("UpdateRole");

export const overlayInputSchema = z
	.object({
		resource: z.string().min(1),
		action: z.string().min(1),
		scope: z.enum(SCOPES).nullable().optional(),
		effect: z.enum(OVERLAY_EFFECTS),
		reason: z.string().max(500).nullable().optional(),
		expiresAt: z.iso.datetime().nullable().optional(),
	})
	.openapi("OverlayInput");

export const overlaySchema = z
	.object({
		id: z.string(),
		resource: z.string(),
		action: z.string(),
		scope: z.enum(SCOPES).nullable(),
		effect: z.enum(OVERLAY_EFFECTS),
		reason: z.string().nullable(),
		expiresAt: z.string().nullable(),
	})
	.openapi("Overlay");

export const memberSchema = z
	.object({
		userId: z.string(),
		orgId: z.string(),
		roles: z.array(roleSchema),
		overlays: z.array(overlaySchema),
	})
	.openapi("Member");

export const myPermissionsSchema = z
	.object({
		orgId: z.string(),
		roles: z.array(z.string()),
		grants: z.array(grantSchema),
		denies: z.array(z.string()),
	})
	.openapi("MyPermissions");

export const auditEntrySchema = z
	.object({
		id: z.string(),
		actorId: z.string(),
		targetUserId: z.string().nullable(),
		changeType: z.string(),
		before: z.unknown(),
		after: z.unknown(),
		at: z.string(),
	})
	.openapi("AuditEntry");

export const idParams = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
export const userParams = z.object({
	userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
});
export const userRoleParams = userParams.extend({
	roleId: z.string().openapi({ param: { name: "roleId", in: "path" } }),
});
export const userOverlayParams = userParams.extend({
	overlayId: z.string().openapi({ param: { name: "overlayId", in: "path" } }),
});
