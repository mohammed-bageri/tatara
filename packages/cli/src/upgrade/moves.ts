/**
 * Files later CLIs generate somewhere else. An older codemod that regenerates an old path gets
 * what this CLI generates at the new one; the codemod of the release that moved it moves it.
 */
export const MOVED_IN_0_10: Record<string, string> = {
	"src/core/http/app.ts": "src/apps/http.ts",
	"src/core/auth/auth.ts": "src/modules/users/services/auth.ts",
	"src/core/auth/adapter.ts": "src/modules/users/services/adapter.ts",
	"src/core/auth/delivery.ts": "src/modules/users/services/delivery.ts",
	"src/core/auth/sms.ts": "src/modules/users/services/sms.ts",
	"src/core/auth/keycloak.ts": "src/modules/users/services/keycloak.ts",
	"src/core/auth/db/seed.ts": "src/modules/users/db/seed.ts",
	"src/core/auth/db/auth.schema.ts": "src/modules/users/db/auth.schema.ts",
	"src/core/auth/db/organization.schema.ts": "src/modules/users/db/organization.schema.ts",
	"src/core/auth/routes/me.routes.ts": "src/modules/users/routes/me.routes.ts",
	"src/core/auth/commands/keycloak-token.ts": "src/modules/users/commands/keycloak-token.ts",
	"src/core/authz/routes/authorization.routes.ts":
		"src/modules/users/routes/authorization.routes.ts",
};

/** Merged into another file in 0.10: nothing is generated in its place. */
export const MERGED_IN_0_10: Record<string, string> = {
	"src/core/auth/principal.ts": "src/modules/users/services/auth.ts",
};

/** Tables never sit in core: authz and events became modules in 0.20. */
export const MOVED_IN_0_20: Record<string, string> = {
	"src/core/authz/index.ts": "src/modules/authz/services/authz.ts",
	"src/core/authz/system-roles.ts": "src/modules/authz/services/system-roles.ts",
	"src/core/authz/db/authz.schema.ts": "src/modules/authz/db/authz.schema.ts",
	"src/modules/users/routes/authorization.routes.ts":
		"src/modules/authz/routes/authorization.routes.ts",
	"src/core/events/index.ts": "src/modules/events/services/events.ts",
	"src/core/events/db/events.schema.ts": "src/modules/events/db/events.schema.ts",
	"src/core/events/consumers/dispatch.ts": "src/modules/events/consumers/dispatch.ts",
	"src/core/events/schedules/prune.ts": "src/modules/events/schedules/prune.ts",
	"src/core/events/schedules/reconcile.ts": "src/modules/events/schedules/reconcile.ts",
	"src/core/events/schedules/relay.ts": "src/modules/events/schedules/relay.ts",
	"src/core/events/schedules/retry.ts": "src/modules/events/schedules/retry.ts",
};

/** Where this CLI generates what used to be at `path` (the path itself if it never moved). */
export function currentPath(path: string): string {
	const moved = MOVED_IN_0_10[path] ?? path;
	return MOVED_IN_0_20[moved] ?? moved;
}
