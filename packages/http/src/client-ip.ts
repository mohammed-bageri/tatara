import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * The client address from X-Forwarded-For, counting `trustedHops` proxies from the right.
 * Entries to the left of those were sent by the client and can be forged.
 */
export function trustedClientIp(
	forwardedFor: string | null | undefined,
	trustedHops: number,
): string | undefined {
	if (!forwardedFor || trustedHops <= 0) return undefined;
	const hops = forwardedFor
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (hops.length === 0) return undefined;
	return hops[Math.max(0, hops.length - trustedHops)];
}

/**
 * The caller's address: from `trustedHeader` when the app's own proxy sets the client address in
 * one (x-real-ip, cf-connecting-ip), else from X-Forwarded-For when `trustedHops` proxies sit in
 * front (Cloud Run, a load balancer: 1), else the socket's peer. Undefined when none is known.
 */
export function clientIp(
	c: Context,
	options: { trustedHops?: number; trustedHeader?: string } = {},
): string | undefined {
	if (options.trustedHeader) {
		const value = c.req.header(options.trustedHeader)?.trim();
		if (value && isIP(value) !== 0) return value;
	}
	const forwarded = trustedClientIp(c.req.header("x-forwarded-for"), options.trustedHops ?? 0);
	if (forwarded) return forwarded;
	try {
		return getConnInfo(c).remote.address;
	} catch {
		return undefined;
	}
}

/**
 * A copy of `request` whose X-Forwarded-For is only `ip`, for handlers like better-auth that key
 * rate limits on that header and would otherwise trust whatever the client sent.
 */
export function withClientIp(request: Request, ip: string | undefined): Request {
	const headers = new Headers(request.headers);
	if (ip) headers.set("x-forwarded-for", ip);
	else headers.delete("x-forwarded-for");
	return new Request(request, { headers });
}
