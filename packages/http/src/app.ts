import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { type CoreLogger, runReadinessChecks } from "@tatara/core";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { AppError, TooManyRequestsError, ValidationError } from "./errors.ts";
import { errorBody } from "./response.ts";
import { requestTimeout, type TimeoutOptions } from "./timeout.ts";
import {
	createValidationHook,
	type IssueLike,
	type ValidationHookOptions,
	validationError,
	validationHook,
} from "./validation.ts";

/** Variables every tatara app has; apps extend them with their own (principal, language, …). */
export interface HttpEnv {
	Variables: { requestId: string; logger: CoreLogger };
}

type Defaults<E extends HttpEnv> = Partial<Omit<E["Variables"], "requestId" | "logger">>;

const REQUEST_ID = /^[\w-]{8,128}$/;

/** Sets requestId, a request-scoped logger and default variables; logs one line per request. */
export function requestContext<E extends HttpEnv>(
	logger: CoreLogger,
	defaults: Defaults<E> = {},
	redactPath: (path: string) => string = (path) => path,
) {
	return createMiddleware<E>(async (c, next) => {
		const incoming = c.req.header("x-request-id");
		const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
		const log = logger.child({ requestId });
		const set = c.set as (key: string, value: unknown) => void;
		set("requestId", requestId);
		set("logger", log);
		for (const [key, value] of Object.entries(defaults)) set(key, value);
		c.header("x-request-id", requestId);
		const start = performance.now();
		await next();
		const ms = Math.round(performance.now() - start);
		const status = c.res.status;
		const entry = { method: c.req.method, path: redactPath(c.req.path), status, ms };
		if (status >= 500) log.error(entry, "request failed");
		else log.info(entry, "request");
	});
}

export interface CreateAppOptions<E extends HttpEnv> {
	logger: CoreLogger;
	/**
	 * Deprecated: call Hono's `cors()` in the app instead (with `corsOrigin` for the origin check),
	 * so its headers and origins are the app's. Kept so existing apps keep working.
	 */
	cors?: { origins: string[]; exposeHeaders?: string[]; allowHeaders?: string[] };
	bodyLimitBytes: number;
	/** a limit on how long a handler may take, with longer ones for slow paths */
	timeouts?: TimeoutOptions;
	/** initial values for the app's own variables, e.g. `{ principal: null, language: "en" }` */
	defaults?: Defaults<E>;
	/** hides secrets that travel in paths (tokens in links) from the request log */
	redactPath?: (path: string) => string;
}

/** Matches exact origins and `*.`-patterns, where `*` is exactly one DNS label (tenant subdomains). */
export function corsOrigin(origins: string[]): (origin: string) => string | null {
	const exact = new Set(origins.filter((o) => !o.includes("*")));
	const patterns = origins
		.filter((o) => o.includes("*"))
		.map((o) => {
			if (!/^https?:\/\/\*\.[^*]+$/.test(o))
				throw new Error(`CORS origin pattern "${o}" must look like https://*.example.com`);
			const escaped = o.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", "[a-z0-9-]+");
			return new RegExp(`^${escaped}$`, "i");
		});
	return (origin) => (exact.has(origin) || patterns.some((p) => p.test(origin)) ? origin : null);
}

/** A plain OpenAPIHono app with request context, secure headers, body limit, /health and /ready. CORS is the app's: Hono's `cors()`. */
export function createApp<E extends HttpEnv>(options: CreateAppOptions<E>): OpenAPIHono<E> {
	const app = new OpenAPIHono<E>({ defaultHook: validationHook });
	app.use(
		requestContext<E>(options.logger, options.defaults, options.redactPath) as MiddlewareHandler<E>,
	);
	app.use(secureHeaders());
	if (options.cors)
		app.use(
			cors({
				origin: corsOrigin(options.cors.origins),
				credentials: true,
				allowHeaders: options.cors.allowHeaders ?? [
					"Content-Type",
					"Authorization",
					"X-Request-Id",
					"Accept-Language",
				],
				exposeHeaders: options.cors.exposeHeaders ?? ["X-Request-Id"],
			}),
		);
	app.use(bodyLimit({ maxSize: options.bodyLimitBytes }));
	if (options.timeouts) app.use(requestTimeout(options.timeouts));
	app.get("/health", (c) => c.json({ status: "ok" }));
	app.get("/ready", async (c) => {
		const result = await runReadinessChecks();
		return c.json(result, result.ready ? 200 : 503);
	});
	return app;
}

export interface RouteDefinition<A extends string = string, E extends HttpEnv = HttpEnv> {
	/** which HTTP app serves these routes */
	app: A;
	/** mounted under the prefix + basePath, e.g. "/notes" */
	basePath: string;
	router: OpenAPIHono<E>;
}

/** Default export of every `routes/*.routes.ts`; discovered by `tatara sync`. */
export function defineRoutes<D extends RouteDefinition<string, any>>(definition: D): D {
	return definition;
}

export interface CreateRouterOptions {
	/** Options for validation hook behavior (message format, status code, detail shape) */
	validation?: ValidationHookOptions;
}

/** A router for one routes file. Attach middleware per route or per path, never `use("*")`. */
export function createRouter<E extends HttpEnv>(options: CreateRouterOptions = {}): OpenAPIHono<E> {
	const hook = options.validation ? createValidationHook(options.validation) : validationHook;
	return new OpenAPIHono<E>({ defaultHook: hook });
}

/** Mounts the discovered routes that belong to `app` under `prefix`. */
export function mountRoutes<E extends HttpEnv>(
	app: OpenAPIHono<E>,
	routes: readonly RouteDefinition<string, any>[],
	options: { app: string; prefix: string },
): void {
	for (const definition of routes) {
		if (definition.app === options.app)
			app.route(`${options.prefix}${definition.basePath}`, definition.router);
	}
}

type OpenApiDocument = ReturnType<OpenAPIHono["getOpenAPI31Document"]>;

/** `/openapi.json` (built once on first request, cached after) and the Scalar UI at `/docs`. */
export function serveOpenApi<E extends HttpEnv>(
	app: OpenAPIHono<E>,
	options: {
		title: string;
		version?: string;
		extend?: (document: OpenApiDocument) => void | Promise<void>;
	},
): void {
	const config = {
		openapi: "3.1.0",
		info: { title: options.title, version: options.version ?? "1.0.0" },
	} as const;
	// One build (and one stringify) for the life of the app; concurrent first requests share it.
	let cached: Promise<string> | undefined;
	const build = async () => {
		const document = app.getOpenAPI31Document(config);
		await options.extend?.(document);
		return JSON.stringify(document);
	};
	app.get("/openapi.json", async (c) => {
		cached ??= build().catch((error) => {
			cached = undefined;
			throw error;
		});
		return c.body(await cached, 200, { "Content-Type": "application/json" });
	});
	app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: options.title }));
}

/** Turns an error the handler does not know (an SDK's, the database's) into an AppError, or passes. */
export type ErrorMapper<E extends HttpEnv = HttpEnv> = (
	err: unknown,
	c: Context<E>,
) => AppError | undefined;

export interface HandleErrorsOptions<E extends HttpEnv> {
	/** the message for an AppError; overrides `translate` for AppErrors */
	message?: (err: AppError, c: Context<E>) => string;
	/**
	 * The localised message for an error code, or undefined to keep the error's own. Used for
	 * translatable AppErrors and for the handler's own errors (NOT_FOUND, INTERNAL_ERROR).
	 * `codeTranslator(keys, t)` builds one from a code → i18n key map.
	 */
	translate?: (code: string, c: Context<E>) => string | undefined;
	/** tried in order before the built-in handling; the first AppError returned is answered */
	mapError?: readonly ErrorMapper<E>[];
	/** codes renamed in responses (and before `translate`), e.g. `{ RATE_LIMITED: "RATE_LIMIT_EXCEEDED" }` */
	codes?: Record<string, string>;
	/** the status for ValidationErrors without an explicit one and for thrown ZodErrors (default 400) */
	validationStatus?: 400 | 422;
	/** Options for validation errors converted from thrown ZodErrors (message format, detail shape) */
	validation?: ValidationHookOptions;
	/** put unhandled errors' message, name and stack in the response: development only */
	exposeErrors?: boolean;
	/** applied to an unhandled error before it is logged or exposed, e.g. `redactDbQueryErrors` from @tatara/db */
	redact?: (err: unknown) => unknown;
	/** used when the request has no `c.var.logger` */
	logger?: CoreLogger;
}

/** A `translate` for `handleErrors` from a code → i18n key map. */
export function codeTranslator<E extends HttpEnv>(
	keys: Record<string, string>,
	t: (key: string, c: Context<E>) => string,
): (code: string, c: Context<E>) => string | undefined {
	return (code, c) => {
		const key = keys[code];
		return key === undefined ? undefined : t(key, c);
	};
}

function isZodError(err: unknown): err is Error & { issues: IssueLike[] } {
	return (
		err instanceof Error &&
		err.name === "ZodError" &&
		Array.isArray((err as { issues?: unknown }).issues)
	);
}

/** The error envelope for every error, plus a 404 for unknown routes. */
export function handleErrors<E extends HttpEnv>(
	app: OpenAPIHono<E>,
	options: HandleErrorsOptions<E> = {},
): void {
	const rename = (code: string) => options.codes?.[code] ?? code;
	app.onError((thrown, ctx) => {
		const c = ctx as Context<E>;
		let err: unknown = thrown;
		for (const mapper of options.mapError ?? []) {
			const mapped = mapper(thrown, c);
			if (mapped) {
				err = mapped;
				break;
			}
		}
		if (!(err instanceof AppError) && isZodError(err))
			err = validationError(err.issues, options.validation);
		if (err instanceof AppError) {
			if (err instanceof TooManyRequestsError)
				c.header("Retry-After", String(err.retryAfterSeconds));
			const code = rename(err.code);
			const message = options.message
				? options.message(err, c)
				: ((err.translatable ? options.translate?.(code, c) : undefined) ?? err.message);
			const status =
				err instanceof ValidationError && !err.explicitStatus && options.validationStatus
					? options.validationStatus
					: err.status;
			return c.json(errorBody(code, message, err.details), status);
		}
		if (err instanceof HTTPException) {
			return c.json(errorBody("HTTP_ERROR", err.message || "Request failed"), err.status);
		}
		const logged = options.redact ? options.redact(err) : err;
		((c.get("logger") as CoreLogger | undefined) ?? options.logger)?.error(
			{ err: logged },
			"unhandled error",
		);
		const code = rename("INTERNAL_ERROR");
		const generic = options.translate?.(code, c) ?? "Something went wrong";
		if (options.exposeErrors && logged instanceof Error) {
			const details = { name: logged.name, message: logged.message, stack: logged.stack };
			return c.json(errorBody(code, logged.message || generic, details), 500);
		}
		return c.json(errorBody(code, generic), 500);
	});
	app.notFound((ctx) => {
		const c = ctx as Context<E>;
		const code = rename("NOT_FOUND");
		return c.json(errorBody(code, options.translate?.(code, c) ?? "Route not found"), 404);
	});
}
