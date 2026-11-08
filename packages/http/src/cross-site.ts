import type { Context, MiddlewareHandler } from "hono";
import { AppError } from "./errors.ts";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface CrossSiteOptions {
	/** whether `origin` may send writes; `corsOrigin(origins)` fits (it returns the origin or null) */
	trusted(origin: string): boolean | string | null | undefined;
	/** requests left to someone else, e.g. an auth library that checks origins itself */
	skip?(c: Context): boolean;
	/** called before the 403, e.g. to log it */
	onRefused?(c: Context, origin: string): void;
}

/**
 * Refuses POST/PUT/PATCH/DELETE from an untrusted browser origin with 403
 * CROSS_SITE_REQUEST_REFUSED: with cookie sessions (`SameSite=None`) any site could otherwise
 * make a signed-in browser write. No `Origin` (non-browser callers) passes; `Origin: null` does not.
 */
export function rejectCrossSite(options: CrossSiteOptions): MiddlewareHandler {
	return async (c, next) => {
		const origin = c.req.header("origin");
		if (
			origin !== undefined &&
			UNSAFE.has(c.req.method) &&
			!options.skip?.(c) &&
			(origin === "null" || !options.trusted(origin))
		) {
			options.onRefused?.(c, origin);
			throw new AppError(403, "CROSS_SITE_REQUEST_REFUSED", "Cross-site request refused");
		}
		await next();
	};
}
