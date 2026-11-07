import type { Principal } from "@tatara/auth";
import type { Cache } from "@tatara/cache";
import {
	AppError,
	BusinessRuleError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	UnauthorizedError,
} from "@tatara/http";
import type { Env, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { createPermissionCache } from "./cache.ts";
import { assertGrantValid, type Catalog, InvalidGrantError, META_RESOURCES } from "./catalog.ts";
import {
	type AuditChangeType,
	type OverlayEffect,
	SCOPE_RANK,
	type Scope,
	SYSTEM_ACTOR,
	SYSTEM_ORG_ID,
} from "./constants.ts";
import {
	type AuthzStore,
	type EffectivePermissions,
	grantKey,
	type PermissionGrant,
	type RoleRow,
} from "./types.ts";

type Who = Pick<Principal, "userId" | "orgId" | "roles"> & { orgRole?: string | null };

/** 400 ORG_REQUIRED: a permission check needs the org the caller acts in. */
export class OrgRequiredError extends AppError {
	constructor() {
		super(400, "ORG_REQUIRED", "Choose an organization (x-org-id header)", undefined, true);
	}
}

export interface SystemRole {
	readonly key: string;
	readonly name: string;
	readonly description: string;
	/**
	 * Who holds it without an assignment: `"members"`, every member of the org the caller acts in;
	 * `"identity"`, anyone whose identity-provider roles include the key (staff, Keycloak roles).
	 * Otherwise only those it's assigned to.
	 */
	readonly heldBy?: "members" | "identity";
}

export interface AuthzOptions {
	store: AuthzStore;
	catalog: Catalog;
	/** built-in roles; every org has them */
	systemRoles: readonly SystemRole[];
	/** how long a resolved permission set is cached in-process (default 30 s) */
	cacheTtlMs?: number;
	/**
	 * Shared cache for permission sets. When provided, uses versioned keys so invalidation on one
	 * process is seen by all others. Without it, each process has its own cache (multi-replica
	 * deployments may see up to `cacheTtlMs` of stale permissions after a revocation).
	 */
	sharedCache?: Cache;
	/**
	 * TTL for the local in-memory layer when `sharedCache` is set (default 1 s). Ignored without
	 * a shared cache.
	 */
	localCacheTtlMs?: number;
	/**
	 * Single-tenant apps: the one org every check runs in. Without it, a check with no org is a
	 * 400 ORG_REQUIRED; nothing falls back to a default org.
	 */
	singleTenant?: string;
}

export interface RoleInput {
	key: string;
	name: string;
	description?: string | null;
	grants: { resource: string; action: string; scope?: string | null }[];
}

export interface OverlayInput {
	resource: string;
	action: string;
	scope?: Scope | null;
	effect: OverlayEffect;
	reason?: string | null;
	expiresAt?: Date | null;
}

/** The org a principal acts in; 400 ORG_REQUIRED when it acts in none. */
export function orgOf(principal: Pick<Principal, "orgId">): string {
	if (!principal.orgId) throw new OrgRequiredError();
	return principal.orgId;
}

/** Pure check against a resolved set: deny wins; scoped checks honour org > team > own. */
export function allows(
	permissions: EffectivePermissions,
	resource: string,
	action: string,
	scope?: Scope,
): boolean {
	if (permissions.denies.has(`${resource}:${action}:${scope ?? "*"}`)) return false;
	if (scope && permissions.denies.has(`${resource}:${action}:*`)) return false;
	// a denied grant can never satisfy a check, even a narrower one
	const live = permissions.grants.filter(
		(g) =>
			!permissions.denies.has(grantKey(g)) &&
			!permissions.denies.has(`${g.resource}:${g.action}:*`),
	);
	if (!scope) {
		return live.some((g) => g.resource === resource && g.action === action);
	}
	const required = SCOPE_RANK[scope];
	return live.some(
		(g) =>
			g.resource === resource &&
			g.action === action &&
			g.scope !== null &&
			SCOPE_RANK[g.scope] >= required,
	);
}

/**
 * Authorization for one app: its store, permission catalog and built-in roles.
 * `K` is the app's generated `PermissionKey`, so `requirePermission` only takes known keys.
 */
export function createAuthz<K extends string = string>(options: AuthzOptions) {
	const { store, catalog, systemRoles } = options;
	const systemRoleKeys: ReadonlySet<string> = new Set(systemRoles.map((r) => r.key));
	for (const role of Object.keys(catalog.roleGrants)) {
		if (!systemRoleKeys.has(role))
			throw new Error(`Permission files grant to "${role}", which is not a built-in role`);
	}
	const cache = createPermissionCache(options.cacheTtlMs ?? 30_000, {
		sharedCache: options.sharedCache,
		localTtlMs: options.localCacheTtlMs,
	});
	const orgFor = (principal: Pick<Principal, "orgId">): string =>
		principal.orgId ?? options.singleTenant ?? orgOf(principal);

	const byMembers = systemRoles.filter((r) => r.heldBy === "members").map((r) => r.key);
	const byIdentity: ReadonlySet<string> = new Set(
		systemRoles.filter((r) => r.heldBy === "identity").map((r) => r.key),
	);
	/**
	 * Built-in roles held without an assignment (`SystemRole.heldBy`). better-auth's member role
	 * only says the caller is a member (`orgRole` set): its value grants nothing.
	 */
	const impliedRoles = (principal: Who) => [
		...new Set([
			...principal.roles.map((role) => role.trim()).filter((role) => byIdentity.has(role)),
			...(principal.orgRole != null ? byMembers : []),
		]),
	];

	/**
	 * Effective permissions = grants of the member's roles (assigned in the org, plus built-in
	 * roles implied by the identity provider) + active grant overlays − active deny overlays.
	 */
	async function effectivePermissions(principal: Who): Promise<EffectivePermissions> {
		const orgId = orgFor(principal);
		const implied = impliedRoles(principal);
		const cached = await cache.get(orgId, principal.userId, implied);
		if (cached) return cached;

		const [{ roles, grants }, overlays] = await Promise.all([
			store.roleGrants(orgId, principal.userId, implied),
			store.activeOverlays(orgId, principal.userId, new Date()),
		]);
		const all: PermissionGrant[] = [...grants];
		const denies = new Set<string>();
		for (const overlay of overlays) {
			const grant = { resource: overlay.resource, action: overlay.action, scope: overlay.scope };
			if (overlay.effect === "deny") denies.add(grantKey(grant));
			else all.push(grant);
		}
		const value = { grants: all, denies, roles };
		await cache.set(orgId, principal.userId, implied, value);
		return value;
	}

	async function checkPermission(principal: Who, permission: K, scope?: Scope): Promise<boolean> {
		const [resource = "", action = ""] = permission.split(":");
		return allows(await effectivePermissions(principal), resource, action, scope);
	}

	/**
	 * The widest scope the principal holds for a scoped action. Middleware proves the caller
	 * may act at some scope; services use this to decide which rows to return.
	 */
	async function resolveScope(principal: Who, permission: K): Promise<Scope | null> {
		const [resource = "", action = ""] = permission.split(":");
		const permissions = await effectivePermissions(principal);
		let best: Scope | null = null;
		for (const g of permissions.grants) {
			if (g.resource !== resource || g.action !== action || g.scope === null) continue;
			if (permissions.denies.has(grantKey(g))) continue;
			if (!best || SCOPE_RANK[g.scope] > SCOPE_RANK[best]) best = g.scope;
		}
		return best;
	}

	/**
	 * 401 without a principal, 403 unless it holds `resource:action` (at `scope` or wider).
	 * Pair with `security: [{ bearerAuth: ["resource:action"] }]` so the route documents it.
	 */
	function requirePermission(permission: K, scope?: Scope): MiddlewareHandler<Env> {
		const handler = createMiddleware<{ Variables: { principal: Principal | null } }>(
			async (c, next) => {
				const principal = c.get("principal");
				if (!principal) throw new UnauthorizedError();
				if (!(await checkPermission(principal, permission, scope))) {
					throw new ForbiddenError(`Missing permission ${permission}${scope ? ` (${scope})` : ""}`);
				}
				await next();
			},
		);
		// typed as adding nothing to the env, so routes keep the app's context types
		return handler as unknown as MiddlewareHandler<Env>;
	}

	/** Validates grants against the catalog; custom roles and overlays may not grant meta resources. */
	function validateGrants(
		grants: { resource: string; action: string; scope?: string | null }[],
		opts: { allowMeta: boolean },
	): PermissionGrant[] {
		return grants.map((grant) => {
			try {
				assertGrantValid(catalog, grant);
			} catch (error) {
				if (error instanceof InvalidGrantError) {
					throw new BusinessRuleError("INVALID_GRANT", error.message);
				}
				throw error;
			}
			if (!opts.allowMeta && META_RESOURCES.has(grant.resource)) {
				throw new BusinessRuleError(
					"META_GRANT_FORBIDDEN",
					`${grant.resource}:${grant.action} can only be granted by built-in roles`,
				);
			}
			return {
				resource: grant.resource,
				action: grant.action,
				scope: (grant.scope as Scope) ?? null,
			};
		});
	}

	async function audit(input: {
		orgId: string;
		actorId: string;
		targetUserId?: string | null;
		changeType: AuditChangeType;
		before?: unknown;
		after?: unknown;
	}): Promise<void> {
		await store.writeAudit({
			orgId: input.orgId,
			actorId: input.actorId,
			targetUserId: input.targetUserId ?? null,
			changeType: input.changeType,
			before: input.before,
			after: input.after,
		});
	}

	function listAudit(orgId: string, limit = 50) {
		return store.listAudit(orgId, limit);
	}

	function listRoles(orgId: string): Promise<RoleRow[]> {
		return store.listRoles(orgId);
	}

	async function customRole(orgId: string, roleId: string): Promise<RoleRow> {
		const role = await store.findRole(orgId, roleId);
		if (!role) throw new NotFoundError("Role");
		if (role.isSystem)
			throw new BusinessRuleError("SYSTEM_ROLE_IMMUTABLE", "Built-in roles cannot be changed");
		return role;
	}

	async function createRole(actorId: string, orgId: string, input: RoleInput): Promise<RoleRow> {
		if (systemRoleKeys.has(input.key)) {
			throw new ConflictError(`"${input.key}" is a built-in role key`);
		}
		if (await store.findRoleByKey(orgId, input.key))
			throw new ConflictError(`Role "${input.key}" exists`);
		const grants = validateGrants(input.grants, { allowMeta: false });
		const id = await store.createRole({
			orgId,
			key: input.key,
			name: input.name,
			description: input.description ?? null,
			isSystem: false,
			grants,
		});
		const role = await store.findRole(orgId, id);
		if (!role) throw new NotFoundError("Role");
		await audit({ orgId, actorId, changeType: "role_created", after: role });
		return role;
	}

	async function updateRole(
		actorId: string,
		orgId: string,
		roleId: string,
		input: Partial<Omit<RoleInput, "key">>,
	): Promise<RoleRow> {
		const before = await customRole(orgId, roleId);
		await store.updateRole(roleId, {
			...(input.name === undefined ? {} : { name: input.name }),
			...(input.description === undefined ? {} : { description: input.description }),
			...(input.grants ? { grants: validateGrants(input.grants, { allowMeta: false }) } : {}),
		});
		await cache.invalidateAll();
		const after = await customRole(orgId, roleId);
		await audit({ orgId, actorId, changeType: "role_updated", before, after });
		return after;
	}

	async function deleteRole(actorId: string, orgId: string, roleId: string): Promise<void> {
		const role = await customRole(orgId, roleId);
		if (role.memberCount > 0) {
			throw new ConflictError(`Role "${role.key}" is assigned to ${role.memberCount} member(s)`);
		}
		await store.deleteRole(roleId);
		await cache.invalidateAll();
		await audit({ orgId, actorId, changeType: "role_deleted", before: role });
	}

	async function getMember(orgId: string, userId: string) {
		const [roles, overlays] = await Promise.all([
			store.memberRoles(orgId, userId),
			store.listOverlays(orgId, userId),
		]);
		return { userId, orgId, roles, overlays };
	}

	async function assignRole(actorId: string | null, orgId: string, userId: string, roleId: string) {
		const role = await store.findRole(orgId, roleId);
		if (!role) throw new NotFoundError("Role");
		const added = await store.assignRole(orgId, userId, roleId, actorId);
		await cache.invalidateMember(userId, orgId);
		if (added && actorId) {
			await audit({
				orgId,
				actorId,
				targetUserId: userId,
				changeType: "member_role_assigned",
				after: { roleId, key: role.key },
			});
		}
		return added;
	}

	/** Gives a member a built-in role by key (e.g. "admin" to an org's creator); false if they had it. */
	async function grantSystemRole(
		orgId: string,
		userId: string,
		key: string,
		actorId: string | null = null,
	): Promise<boolean> {
		// built-in roles live in code; a database that hasn't synced them yet gets them now (another
		// request syncing at the same moment may win the insert: then the role is there)
		const find = () => store.findRoleByKey(SYSTEM_ORG_ID, key);
		let role = await find();
		if (!role && systemRoleKeys.has(key)) {
			await syncSystemRoles().catch(() => undefined);
			role = await find();
		}
		if (!role) throw new Error(`No built-in role "${key}" in system-roles`);
		return assignRole(actorId, orgId, userId, role.id);
	}

	async function revokeRole(actorId: string, orgId: string, userId: string, roleId: string) {
		const removed = await store.revokeRole(orgId, userId, roleId);
		if (!removed) throw new NotFoundError("Role assignment");
		await cache.invalidateMember(userId, orgId);
		await audit({
			orgId,
			actorId,
			targetUserId: userId,
			changeType: "member_role_revoked",
			before: { roleId },
		});
	}

	/** Removes all of a user's access in an org; called when they stop being a member. */
	async function removeMemberAccess(orgId: string, userId: string, actorId = SYSTEM_ACTOR) {
		const removed = await store.removeMember(orgId, userId);
		await cache.invalidateMember(userId, orgId);
		if (removed.roles + removed.overlays > 0) {
			await audit({
				orgId,
				actorId,
				targetUserId: userId,
				changeType: "member_removed",
				before: removed,
			});
		}
		return removed;
	}

	/** Per-user grant or deny, optionally expiring. Deny always wins over any grant. */
	async function addOverlay(
		actorId: string | null,
		orgId: string,
		userId: string,
		input: OverlayInput,
	) {
		const [grant] = validateGrants([input], { allowMeta: input.effect === "deny" });
		if (!grant) throw new NotFoundError("Permission");
		const id = await store.addOverlay({
			orgId,
			userId,
			...grant,
			effect: input.effect,
			grantedBy: actorId,
			reason: input.reason ?? null,
			expiresAt: input.expiresAt ?? null,
		});
		await cache.invalidateMember(userId, orgId);
		if (actorId) {
			await audit({
				orgId,
				actorId,
				targetUserId: userId,
				changeType: "overlay_granted",
				after: { id, ...grant, effect: input.effect },
			});
		}
		return id;
	}

	async function removeOverlay(actorId: string, orgId: string, userId: string, overlayId: string) {
		const removed = await store.removeOverlay(orgId, userId, overlayId);
		if (!removed) throw new NotFoundError("Overlay");
		await cache.invalidateMember(userId, orgId);
		await audit({
			orgId,
			actorId,
			targetUserId: userId,
			changeType: "overlay_revoked",
			before: removed,
		});
	}

	/** Creates or updates every built-in role so its grants match the code. Idempotent. */
	async function syncSystemRoles(): Promise<{ created: string[]; updated: string[] }> {
		const created: string[] = [];
		const updated: string[] = [];
		for (const meta of systemRoles) {
			const grants = validateGrants(
				(catalog.roleGrants[meta.key] ?? []).map(([resource, action, scope]) => ({
					resource,
					action,
					scope,
				})),
				{ allowMeta: true },
			);
			const existing = await store.findRoleByKey(SYSTEM_ORG_ID, meta.key);
			if (!existing) {
				await store.createRole({
					orgId: SYSTEM_ORG_ID,
					key: meta.key,
					name: meta.name,
					description: meta.description,
					isSystem: true,
					grants,
				});
				created.push(meta.key);
				continue;
			}
			const want = new Set(grants.map(grantKey));
			const have = new Set(existing.grants.map(grantKey));
			const same = want.size === have.size && [...want].every((k) => have.has(k));
			if (!same || existing.name !== meta.name || existing.description !== meta.description) {
				await store.updateRole(existing.id, {
					name: meta.name,
					description: meta.description,
					grants,
				});
				updated.push(meta.key);
			}
		}
		if (created.length || updated.length) await cache.invalidateAll();
		return { created, updated };
	}

	return {
		store,
		catalog,
		systemRoleKeys,
		orgOf: orgFor,
		effectivePermissions,
		checkPermission,
		resolveScope,
		requirePermission,
		validateGrants,
		listAudit,
		listRoles,
		createRole,
		updateRole,
		deleteRole,
		getMember,
		assignRole,
		grantSystemRole,
		revokeRole,
		removeMemberAccess,
		addOverlay,
		removeOverlay,
		syncSystemRoles,
		invalidateMember: cache.invalidateMember,
		invalidateAll: cache.invalidateAll,
	};
}

export type Authz<K extends string = string> = ReturnType<typeof createAuthz<K>>;

/**
 * Hooks for better-auth's organization plugin, so authz rows go with the membership; spread them
 * into the app's own `organization({ organizationHooks })`.
 * @deprecated use `authzPlugin` from `@tatara/authz/better-auth`, which also keeps member roles
 * to owner and member
 */
export function authzOrganizationHooks(
	authz: Pick<Authz, "removeMemberAccess" | "grantSystemRole">,
	options: {
		/** the built-in role whoever creates an org gets (Sana: "admin"); false gives none */
		creatorRole?: string | false;
	} = {},
) {
	const creatorRole = options.creatorRole ?? "admin";
	return {
		...(creatorRole
			? {
					afterCreateOrganization: async ({
						organization,
						member,
					}: {
						organization: { id: string };
						member: { userId: string };
					}) => {
						// self-assigned, so the audit log shows who it was
						await authz.grantSystemRole(organization.id, member.userId, creatorRole, member.userId);
					},
				}
			: {}),
		// authz rows outlive better-auth's member row; without this, re-adding restores old roles
		afterRemoveMember: async ({
			member,
		}: {
			member: { organizationId: string; userId: string };
		}) => {
			await authz.removeMemberAccess(member.organizationId, member.userId);
		},
	};
}
