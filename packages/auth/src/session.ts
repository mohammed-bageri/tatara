import type { Principal } from "./principal.ts";

type Where = { field: string; value: string }[];

/** The parts of a better-auth instance tatara reads; any `betterAuth({...})` satisfies it. */
export interface SessionAuth {
	api: {
		getSession(input: { headers: Headers }): Promise<{
			user: { id: string };
			session: object;
		} | null>;
	};
	$context: Promise<{
		adapter: { findOne<T>(input: { model: string; where: Where }): Promise<T | null> };
	}>;
}

/**
 * The session's active organization, or null once the user stops being a member of it.
 * better-auth leaves `activeOrganizationId` on the removed member's session.
 */
async function activeMembership(auth: SessionAuth, userId: string, orgId: unknown) {
	if (typeof orgId !== "string" || !orgId) return null;
	const { adapter } = await auth.$context;
	const member = await adapter.findOne({
		model: "member",
		where: [
			{ field: "organizationId", value: orgId },
			{ field: "userId", value: userId },
		],
	});
	return member ? { orgId, role: (member as { role?: string }).role ?? null } : null;
}

/**
 * The better-auth session (cookie or bearer token) as a principal; none while the admin plugin's ban
 * is in force (better-auth keeps a banned user's live sessions). Roles come from the plugin's `role`;
 * `claims` holds the session user (email, name, the app's additional fields) and the session identity
 * (id, impersonatedBy, expiresAt) under the `session` key.
 */
export async function sessionPrincipal(
	auth: SessionAuth,
	headers: Headers,
): Promise<Principal | null> {
	const session = await auth.api.getSession({ headers });
	if (!session || isBannedNow(session.user)) return null;
	const user = session.user as { id: string; role?: string | null };
	const sessionObj = session.session as {
		id: string;
		expiresAt: Date;
		impersonatedBy?: string;
		activeOrganizationId?: string | null;
	};
	const membership = await activeMembership(auth, user.id, sessionObj.activeOrganizationId);
	return {
		userId: user.id,
		orgId: membership?.orgId ?? null,
		orgRole: membership?.role ?? null,
		roles: (user.role ?? "user")
			.split(",")
			.map((role) => role.trim())
			.filter(Boolean),
		kind: "user",
		// the identity's attributes (email, name, the app's own user fields), as a token carries claims
		claims: {
			...(session.user as Record<string, unknown>),
			session: {
				id: sessionObj.id,
				impersonatedBy: sessionObj.impersonatedBy ?? null,
				expiresAt: sessionObj.expiresAt,
			},
		},
	};
}

/**
 * Whether the admin plugin's ban is in force on `user` at `now`. As in better-auth's sign-in check,
 * a ban whose `banExpires` has passed no longer counts; a user without the fields is never banned.
 */
export function isBannedNow(user: unknown, now: Date = new Date()): boolean {
	const { banned, banExpires } = (user ?? {}) as { banned?: unknown; banExpires?: unknown };
	if (banned !== true) return false;
	if (banExpires === null || banExpires === undefined) return true;
	const expires = new Date(banExpires as string | number | Date).getTime();
	return Number.isNaN(expires) || expires >= now.getTime();
}
