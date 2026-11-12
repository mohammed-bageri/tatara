import { ForbiddenError, UnauthorizedError } from "@tatara/http";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import type { Context, Env, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import {
	type AuthEnv,
	OrgRequiredError,
	type PrincipalResolver,
	principalMiddleware,
} from "./principal.ts";

export { OrgRequiredError } from "./principal.ts";

import { isBannedNow, type SessionAuth, sessionPrincipal } from "./session.ts";

export interface AuthInstanceOptions<A> {
	/** other credentials besides the session, tried in order (e.g. Keycloak tokens) */
	resolvers?: ((auth: A) => PrincipalResolver)[];
	/**
	 * Every principal of this instance acts in this org, e.g. internal staff in "platform": their
	 * permissions live apart from any customer org's.
	 */
	org?: string;
	/**
	 * Rate limits and session IPs key on the address the app resolved, never on a header the client
	 * sent: better-auth reads only `header`, which `handleRequest` sets from `resolve` after dropping
	 * any inbound copy. better-auth otherwise takes the first, client-controlled X-Forwarded-For entry.
	 */
	clientIp?: ClientIpOptions;
	/** What `requireSession` answers without a (non-banned) session user; default: throws UnauthorizedError. */
	onUnauthorized?: (c: Context) => Response | Promise<Response>;
}

export interface ClientIpOptions {
	/** the caller's address, e.g. `(c) => clientIp(c, { trustedHops: 1 })`; nullish when unknown */
	resolve: (c: Context) => string | null | undefined;
	/** default "x-tatara-client-ip" */
	header?: string;
	/** sent when `resolve` finds nothing, so such requests share one rate-limit bucket; default "0.0.0.0" */
	unresolved?: string;
}

/** The variables `attachSession` sets: pass `typeof auth.$Infer.Session`. */
export interface SessionEnv<S extends { user: unknown } = { user: unknown; session: unknown }> {
	Variables: { session: S | null; user: S["user"] | undefined };
}

/** `options` with better-auth's client-IP lookup pointed at `header` only; other settings kept. */
export function withClientIpHeader<O extends BetterAuthOptions>(options: O, header: string): O {
	return {
		...options,
		advanced: {
			...options.advanced,
			ipAddress: { ...options.advanced?.ipAddress, ipAddressHeaders: [header] },
		},
	};
}

/**
 * The app's better-auth instance plus the middleware every app needs. The options are the app's
 * own (adapter, plugins, cookies, hooks); tatara adds to them only the client-IP header, with
 * `extra.clientIp`. Mount `handleRequest` (or, without `clientIp`, `auth.handler`) where the app
 * wants it.
 */
export function createAuthInstance<O extends BetterAuthOptions>(
	options: O,
	extra: AuthInstanceOptions<ReturnType<typeof betterAuth<O>>> = {},
) {
	const ipHeader = extra.clientIp ? (extra.clientIp.header ?? "x-tatara-client-ip") : undefined;
	const auth = betterAuth(ipHeader ? withClientIpHeader(options, ipHeader) : options);

	/** The request's headers without a client-sent copy of the client-IP header. */
	const inbound = (c: Context): Headers => {
		if (!ipHeader) return c.req.raw.headers;
		const headers = new Headers(c.req.raw.headers);
		headers.delete(ipHeader);
		return headers;
	};

	/** Pass a request to better-auth, carrying the resolved client IP when `clientIp` is set. */
	function handleRequest(c: Context): Promise<Response> {
		if (!extra.clientIp || !ipHeader) return auth.handler(c.req.raw);
		const headers = inbound(c);
		headers.set(ipHeader, extra.clientIp.resolve(c) || (extra.clientIp.unresolved ?? "0.0.0.0"));
		// Node's fetch needs duplex whenever the copied body is a stream
		return auth.handler(new Request(c.req.raw, { headers, duplex: "half" } as RequestInit));
	}

	const getSession = (c: Context) =>
		(auth as unknown as SessionAuth).api.getSession({ headers: inbound(c) });

	/** Sets `c.var.session` (null without one) and `c.var.user` (undefined without one), as better-auth returns them. */
	const attachSession = createMiddleware(async (c, next) => {
		const session = await getSession(c);
		c.set("session" as never, session as never);
		c.set("user" as never, session?.user as never);
		await next();
	}) as unknown as MiddlewareHandler<Env>;

	/**
	 * 401 without a session user, or when the admin plugin's ban is in force: better-auth refuses a
	 * banned user new sessions but keeps the ones they hold. Runs after `attachSession`; with the
	 * cookie cache on, a ban or revocation lands within its maxAge.
	 */
	const requireSession = createMiddleware(async (c, next) => {
		const user = c.get("user" as never) as unknown;
		if (!user || isBannedNow(user)) {
			if (extra.onUnauthorized) return extra.onUnauthorized(c);
			throw new UnauthorizedError();
		}
		await next();
	}) as unknown as MiddlewareHandler<Env>;

	const inOrg = (resolve: PrincipalResolver): PrincipalResolver =>
		extra.org
			? async (c) => {
					const principal = await resolve(c);
					return principal ? { ...principal, orgId: extra.org as string, orgRole: null } : null;
				}
			: resolve;

	/** Sets `c.var.principal` from the session, then from the extra resolvers. */
	const attachPrincipal = principalMiddleware<AuthEnv>(
		(
			[
				(c) => sessionPrincipal(auth as never, inbound(c)),
				...(extra.resolvers ?? []).map((resolver) => resolver(auth)),
			] as PrincipalResolver[]
		).map(inOrg),
	) as unknown as MiddlewareHandler<Env>;

	/**
	 * The org the request acts in: the `x-org-id` header, else `cookie` when set (links a browser
	 * opens without headers), else the session's active org; or, with
	 * `param`, the path's (`/orgs/:orgId/...`), which nothing else overrides. The caller must be a
	 * member; `principal.orgId` and `orgRole` are set from the member row.
	 */
	function requireOrg(
		opts: { header?: string; param?: string; cookie?: string } = {},
	): MiddlewareHandler<Env> {
		const header = opts.header ?? "x-org-id";
		return createMiddleware<AuthEnv>(async (c, next) => {
			const principal = c.get("principal");
			if (!principal) throw new UnauthorizedError();
			const orgId = opts.param
				? c.req.param(opts.param)
				: c.req.header(header)?.trim() ||
					(opts.cookie ? getCookie(c, opts.cookie) : undefined) ||
					principal.orgId;
			if (!orgId) throw new OrgRequiredError();
			// a service token is issued for one org; a token's org claim beats member rows it left behind
			const vouched =
				principal.kind === "service" ? [principal.orgId] : (principal.orgs ?? undefined);
			if (vouched && !vouched.includes(orgId))
				throw new ForbiddenError("Not a member of this organization", { code: "NOT_ORG_MEMBER" });
			if (principal.kind !== "service") {
				const { adapter } = await (
					auth as unknown as { $context: Promise<{ adapter: MemberLookup }> }
				).$context;
				const member = await adapter.findOne<{ role?: string }>({
					model: "member",
					where: [
						{ field: "organizationId", value: orgId },
						{ field: "userId", value: principal.userId },
					],
				});
				if (!member && !vouched)
					throw new ForbiddenError("Not a member of this organization", { code: "NOT_ORG_MEMBER" });
				c.set("principal", { ...principal, orgId, orgRole: member?.role ?? null });
			}
			await next();
		}) as unknown as MiddlewareHandler<Env>;
	}

	return { auth, attachPrincipal, requireOrg, attachSession, requireSession, handleRequest };
}

interface MemberLookup {
	findOne<T>(input: {
		model: string;
		where: { field: string; value: string }[];
	}): Promise<T | null>;
}
