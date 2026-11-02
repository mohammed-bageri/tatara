import { corsOrigin, createApp, handleErrors, mountRoutes, serveOpenApi } from "@tatara/http";
import { cors } from "hono/cors";
import { env } from "#core/config/env";
import type { AppEnv } from "#core/http/context";
import type { AppName } from "#core/http/routes";
import { logger } from "#core/logging/logger";
import { routes } from "#generated/routes";
// tatara:slot imports

export const API_PREFIX = "/api";

/** The app's HTTP wiring: plain Hono, with tatara's defaults from @tatara/http. */
export function createHttpApp(name: AppName, options: { title: string }) {
	const app = createApp<AppEnv>({
		logger,
		bodyLimitBytes: env.BODY_LIMIT_BYTES,
		timeouts: {
			defaultMs: env.REQUEST_TIMEOUT_MS,
			paths: {
				// tatara:slot timeout-paths
			},
		},
		defaults: { principal: null, language: "en" },
	});
	// browsers on other origins (Hono's own middleware); corsOrigin matches exact origins and
	// one-label patterns like https://*.example.com
	app.use(
		cors({
			origin: corsOrigin(env.CORS_ORIGINS),
			credentials: true,
			allowHeaders: [
				"Content-Type",
				"Authorization",
				"X-Request-Id",
				"Accept-Language",
				// tatara:slot allow-headers
			],
			exposeHeaders: [
				"X-Request-Id",
				// tatara:slot expose-headers
			],
		}),
	);
	// tatara:slot middleware

	// tatara:slot routes

	mountRoutes(app, routes, { app: name, prefix: API_PREFIX });
	serveOpenApi(app, {
		title: options.title,
		// tatara:slot openapi-options
	});
	handleErrors(app, {
		// tatara:slot error-options
	});
	return app;
}
