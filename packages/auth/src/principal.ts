import { AppError, ForbiddenError, UnauthorizedError } from "@tatara/http";
import type { Context, Env, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";

export interface Principal {
	userId: string;
	orgId: string | null;
	/** the caller's role in `orgId` (better-auth member role), when they act in an org */
	orgRole?: string | null;
	/** orgs the credential itself names (e.g. a token's org claim); requireOrg allows only these */
	orgs?: string[];
	roles: string[];
	kind: "user" | "service";
	claims: Record<string, unknown>;
}

/** The variables these middlewares read and set; an app's env extends it. */
export interface AuthEnv {
	Variables: { principal: Principal | null };
}

/** Turns a request into a principal, or null when its credentials are not this resolver's. */
export type PrincipalResolver<E extends AuthEnv = AuthEnv> = (
	c: Context<E>,
) => Promise<Principal | null> | Principal | null;

/** Sets `c.var.principal` from the first resolver that recognises the request. */
export function principalMiddleware<E extends AuthEnv = AuthEnv>(
	resolvers: PrincipalResolver<E>[],
): MiddlewareHandler<E> {
	return createMiddleware<E>(async (c, next) => {
		for (const resolve of resolvers) {
			const principal = await resolve(c);
			if (principal) {
				c.set("principal", principal);
				break;
			}
		}
		await next();
	});
}

interface PrincipalReader {
	get(key: "principal"): Principal | null;
}

// Typed as adding nothing to the env: a guard typed with its own env would erase the app's
// context types in zod-openapi route handlers.
function guard(check: (principal: Principal | null) => void): MiddlewareHandler<Env> {
	const handler = createMiddleware<AuthEnv>(async (c, next) => {
		check(c.get("principal"));
		await next();
	});
	return handler as unknown as MiddlewareHandler<Env>;
}

/** 401 unless the request carries a valid session or token. */
export function requireAuth(): MiddlewareHandler<Env> {
	return guard((principal) => {
		if (!principal) throw new UnauthorizedError();
	});
}

/** 401 without a principal, 403 unless it has at least one of the roles. */
export function requireRole(...roles: string[]): MiddlewareHandler<Env> {
	return guard((principal) => {
		if (!principal) throw new UnauthorizedError();
		if (!principal.roles.some((role) => roles.includes(role))) throw new ForbiddenError();
	});
}

/** The authenticated principal; use in handlers behind requireAuth(). */
export function currentPrincipal(c: PrincipalReader): Principal {
	const principal = c.get("principal");
	if (!principal) throw new UnauthorizedError();
	return principal;
}

/** 400 ORG_REQUIRED: the route acts in an organization and the request didn't say which. */
export class OrgRequiredError extends AppError {
	constructor() {
		super(400, "ORG_REQUIRED", "Choose an organization (x-org-id header)", undefined, true);
	}
}

/** The org the request acts in, after `requireOrg`; 400 ORG_REQUIRED when it names none. */
export function currentOrgId(c: PrincipalReader): string {
	const { orgId } = currentPrincipal(c);
	if (!orgId) throw new OrgRequiredError();
	return orgId;
}
