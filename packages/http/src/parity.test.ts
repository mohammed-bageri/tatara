import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
	AppError,
	codeTranslator,
	contentDisposition,
	corsOrigin,
	createPagination,
	createValidationHook,
	cursorPage,
	errorBody,
	type HandleErrorsOptions,
	type HttpEnv,
	handleErrors,
	idParamSchema,
	isUuid,
	NotFoundError,
	paginated,
	rejectCrossSite,
	ServiceUnavailableError,
	success,
	TooManyRequestsError,
	uuidParams,
	ValidationError,
} from "./index.ts";

interface Env extends HttpEnv {
	Variables: HttpEnv["Variables"] & { language: string };
}

const silent = pino({ level: "silent" });
const AR: Record<string, string> = {
	"errors:notFound": "غير موجود",
	"errors:validation": "خطأ في التحقق",
	"errors:tooManyRequests": "طلبات كثيرة",
	"errors:internal": "خطأ داخلي",
};

function appThrowing(error: unknown, options: HandleErrorsOptions<Env> = {}) {
	const app = new OpenAPIHono<Env>();
	app.use(async (c, next) => {
		c.set("language", "ar");
		await next();
	});
	app.get("/boom", () => {
		throw error;
	});
	handleErrors(app, { logger: silent, ...options });
	return app;
}

async function send(error: unknown, options: HandleErrorsOptions<Env> = {}, path = "/boom") {
	const res = await appThrowing(error, options).request(path);
	return { res, body: (await res.json()) as Record<string, unknown> };
}

const translate = codeTranslator<Env>(
	{
		NOT_FOUND: "errors:notFound",
		VALIDATION_ERROR: "errors:validation",
		RATE_LIMIT_EXCEEDED: "errors:tooManyRequests",
		INTERNAL_SERVER_ERROR: "errors:internal",
	},
	(key, c) => (c.get("language") === "ar" ? (AR[key] ?? key) : key),
);

describe("handleErrors hooks", () => {
	it("translates translatable errors by their (renamed) code and keeps specific messages", async () => {
		const options = { translate, codes: { RATE_LIMITED: "RATE_LIMIT_EXCEEDED" } };
		const limited = await send(new TooManyRequestsError(7), options);
		expect(limited.res.status).toBe(429);
		expect(limited.res.headers.get("retry-after")).toBe("7");
		expect(limited.body).toEqual({
			success: false,
			error: "طلبات كثيرة",
			code: "RATE_LIMIT_EXCEEDED",
		});
		const specific = await send(new NotFoundError("Job"), options);
		expect(specific.body).toEqual({ success: false, error: "Job not found", code: "NOT_FOUND" });
		const generic = await send(new NotFoundError(), options);
		expect(generic.body.error).toBe("غير موجود");
		const unknown = await send(new AppError(400, "OTHER", "Other", undefined, true), options);
		expect(unknown.body.error).toBe("Other");
	});

	it("lets `message` win over `translate`", async () => {
		const { body } = await send(new NotFoundError(), { translate, message: () => "custom" });
		expect(body.error).toBe("custom");
	});

	it("leaves an empty code out", async () => {
		const { body } = await send(new AppError(409, "", "Already archived"));
		expect(body).toEqual({ success: false, error: "Already archived" });
	});

	it("maps app errors first, in order", async () => {
		class ProviderError extends Error {
			status = 402;
		}
		const mapError = [
			(err: unknown) =>
				err instanceof ProviderError ? new AppError(402, "AI_QUOTA", "Out of quota") : undefined,
			(err: unknown) =>
				err instanceof HTTPException
					? new AppError(err.status, `HTTP_${err.status}`, "mapped")
					: undefined,
		];
		expect((await send(new ProviderError(), { mapError })).body).toEqual({
			success: false,
			error: "Out of quota",
			code: "AI_QUOTA",
		});
		const http = await send(new HTTPException(401), { mapError });
		expect(http.res.status).toBe(401);
		expect(http.body.code).toBe("HTTP_401");
		expect((await send(new HTTPException(401))).body.code).toBe("HTTP_ERROR");
	});

	it("answers thrown ZodErrors and default-status ValidationErrors with validationStatus", async () => {
		const zodError = z.object({ title: z.string() }).safeParse({}).error;
		const zod = await send(zodError, { translate, validationStatus: 422 });
		expect(zod.res.status).toBe(422);
		expect(zod.body).toMatchObject({
			error: "خطأ في التحقق",
			code: "VALIDATION_ERROR",
			details: [{ path: "title" }],
		});
		expect((await send(zodError)).res.status).toBe(400);
		expect((await send(new ValidationError(), { validationStatus: 422 })).res.status).toBe(422);
		expect(
			(await send(new ValidationError("x", undefined, 400), { validationStatus: 422 })).res.status,
		).toBe(400);
	});

	it("logs unhandled errors redacted, and exposes them only when asked", async () => {
		const logged: unknown[] = [];
		const logger = {
			error: (entry: { err: unknown }) => logged.push(entry.err),
		} as unknown as typeof silent;
		const redact = (_err: unknown) => Object.assign(new Error("redacted"), { name: "Redacted" });
		const options = {
			logger,
			redact,
			translate,
			codes: { INTERNAL_ERROR: "INTERNAL_SERVER_ERROR" },
		};
		const hidden = await send(new Error("secret"), options);
		expect(hidden.res.status).toBe(500);
		expect(hidden.body).toEqual({
			success: false,
			error: "خطأ داخلي",
			code: "INTERNAL_SERVER_ERROR",
		});
		expect((logged[0] as Error).message).toBe("redacted");
		const shown = await send(new Error("secret"), { ...options, exposeErrors: true });
		expect(shown.body).toMatchObject({
			error: "redacted",
			details: { name: "Redacted", message: "redacted" },
		});
		expect(JSON.stringify(shown.body)).not.toContain("secret");
	});

	it("translates the 404 for unknown routes", async () => {
		const { res, body } = await send(new Error(), { translate }, "/nope");
		expect(res.status).toBe(404);
		expect(body).toEqual({ success: false, error: "غير موجود", code: "NOT_FOUND" });
	});

	it("has a 503", () => {
		expect(new ServiceUnavailableError()).toMatchObject({
			status: 503,
			code: "SERVICE_UNAVAILABLE",
			translatable: true,
		});
		expect(new ServiceUnavailableError("Queue down", "QUEUE_DOWN")).toMatchObject({
			code: "QUEUE_DOWN",
			translatable: false,
		});
	});
});

describe("createValidationHook", () => {
	function app(options: Parameters<typeof createValidationHook>[0]) {
		const app = new OpenAPIHono<Env>({ defaultHook: createValidationHook(options) });
		app.openapi(
			createRoute({
				method: "get",
				path: "/items",
				request: { query: z.object({ name: z.string().min(2, "Name is too short") }) },
				responses: { 200: { description: "ok" } },
			}),
			(c) => c.json({}, 200),
		);
		handleErrors(app, { logger: silent, validationStatus: 422 });
		return app;
	}

	it("can send the first issue's message, its own status and its own details", async () => {
		const res = await app({
			message: "first-issue",
			status: 400,
			detail: (i) => ({ path: i.path.join("."), message: i.message }),
		}).request("/items?name=x");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			success: false,
			error: "Name is too short",
			code: "VALIDATION_ERROR",
			details: [{ path: "name", message: "Name is too short" }],
		});
		const generic = await app({}).request("/items?name=x");
		expect(generic.status).toBe(422);
		expect(await generic.json()).toMatchObject({
			error: "Invalid request",
			details: [{ path: "name", code: "too_small" }],
		});
	});
});

describe("createPagination", () => {
	it("defaults to the existing shape", () => {
		const p = createPagination();
		expect(p.querySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
		expect(p.paginated([], { page: 1, pageSize: 20, total: 0 })).toEqual(paginated([], 1, 20, 0));
	});

	it("takes the app's shape: limit, navigation, 0 pages when empty, extra meta and message", () => {
		const p = createPagination({
			sizeKey: "limit",
			navigation: true,
			emptyTotalPages: 0,
			maxSize: 50,
			name: "LimitMeta",
		});
		expect(p.querySchema.parse({ page: "2", limit: "10" })).toEqual({ page: 2, limit: 10 });
		expect(p.querySchema.safeParse({ limit: 51 }).success).toBe(false);
		expect(
			p.paginated(["a"], { page: 2, limit: 10, total: 25 }, { message: "ok", meta: { drafts: 3 } }),
		).toEqual({
			success: true,
			data: ["a"],
			meta: {
				page: 2,
				limit: 10,
				total: 25,
				totalPages: 3,
				hasNext: true,
				hasPrev: true,
				drafts: 3,
			},
			message: "ok",
		});
		expect(p.meta(1, 10, 0)).toEqual({
			page: 1,
			limit: 10,
			total: 0,
			totalPages: 0,
			hasNext: false,
			hasPrev: false,
		});
		expect(p.offset(3, 10)).toBe(20);
		const shape = p.schema(z.string()).parse({ success: true, data: [], meta: p.meta(1, 10, 0) });
		expect(shape.meta).toMatchObject({ limit: 10 });
	});
});

describe("response helpers", () => {
	it("adds a message to success and builds error bodies", () => {
		expect(success(1)).toEqual({ success: true, data: 1 });
		expect(success(1, "Saved")).toEqual({ success: true, data: 1, message: "Saved" });
		expect(errorBody("X", "m", { a: 1 })).toEqual({
			success: false,
			error: "m",
			code: "X",
			details: { a: 1 },
		});
	});

	it("extends cursor meta with limit and hasNext", () => {
		const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
		expect(cursorPage(rows, 2, (r) => r.id, { extended: true }).meta).toMatchObject({
			limit: 2,
			hasNext: true,
		});
		expect(cursorPage(rows, 5, (r) => r.id, { extended: true }).meta).toEqual({
			limit: 5,
			nextCursor: null,
			hasNext: false,
		});
		expect(cursorPage(rows, 5, (r) => r.id).meta).toEqual({ nextCursor: null });
	});

	it("builds a Content-Disposition that any file name survives", () => {
		expect(contentDisposition("report.pdf")).toBe(
			`inline; filename="report.pdf"; filename*=UTF-8''report.pdf`,
		);
		const value = contentDisposition('عقد "أ" (1).pdf', "attachment");
		expect(value).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
		expect(value).toContain("%281%29.pdf");
		expect(() => new Headers({ "content-disposition": value })).not.toThrow();
	});

	it("validates uuids and uuid params", () => {
		const id = "0190b0a8-0e1f-7c3a-8f5e-6f2a1b3c4d5e";
		expect(isUuid(id)).toBe(true);
		expect(isUuid("nope")).toBe(false);
		expect(idParamSchema.parse({ id })).toEqual({ id });
		expect(uuidParams("orgId", "id").safeParse({ orgId: id, id: "x" }).success).toBe(false);
	});
});

describe("rejectCrossSite", () => {
	function app(onRefused = vi.fn()) {
		const app = new OpenAPIHono<Env>();
		app.use(
			rejectCrossSite({
				trusted: corsOrigin(["https://app.example"]),
				skip: (c) => c.req.path.startsWith("/auth/"),
				onRefused,
			}),
		);
		app.post("/write", (c) => c.json({ ok: true }));
		app.get("/write", (c) => c.json({ ok: true }));
		app.post("/auth/sign-in", (c) => c.json({ ok: true }));
		handleErrors(app, { logger: silent });
		return app;
	}

	it.each<[string, string | undefined, string, number]>([
		["POST", "https://app.example", "/write", 200],
		["POST", undefined, "/write", 200],
		["POST", "https://evil.example", "/write", 403],
		["POST", "null", "/write", 403],
		["GET", "https://evil.example", "/write", 200],
		["POST", "https://evil.example", "/auth/sign-in", 200],
	])("%s from %s to %s → %i", async (method, origin, path, status) => {
		const onRefused = vi.fn();
		const res = await app(onRefused).request(path, { method, headers: origin ? { origin } : {} });
		expect(res.status).toBe(status);
		if (status === 403) {
			expect(await res.json()).toEqual({
				success: false,
				error: "Cross-site request refused",
				code: "CROSS_SITE_REQUEST_REFUSED",
			});
			expect(onRefused).toHaveBeenCalledOnce();
		}
	});
});
