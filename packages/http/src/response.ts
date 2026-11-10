import { z } from "@hono/zod-openapi";

export const errorSchema = z
	.object({
		success: z.literal(false),
		error: z.string(),
		code: z.string(),
		details: z.unknown().optional(),
	})
	.openapi("Error");

export const paginationMetaSchema = z
	.object({
		page: z.number().int(),
		pageSize: z.number().int(),
		total: z.number().int(),
		totalPages: z.number().int(),
	})
	.openapi("PaginationMeta");

export const paginationQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function successSchema<T extends z.ZodType>(data: T) {
	return z.object({ success: z.literal(true), data });
}

export function paginatedSchema<T extends z.ZodType>(item: T) {
	return z.object({ success: z.literal(true), data: z.array(item), meta: paginationMetaSchema });
}

/** `{ success: true, data, message }` */
export function success<T>(data: T, message: string): { success: true; data: T; message: string };
// the plain overload last, so ReturnType<typeof success<T>> stays `{ success: true; data: T }`
export function success<T>(data: T): { success: true; data: T };
export function success<T>(data: T, message?: string) {
	return { success: true as const, data, ...(message === undefined ? {} : { message }) };
}

/** The error envelope, for middleware that answers without throwing. An empty code is left out. */
export function errorBody(code: string, message: string, details?: unknown) {
	return {
		success: false as const,
		error: message,
		...(code === "" ? {} : { code }),
		...(details === undefined ? {} : { details }),
	};
}

export function paginated<T>(data: T[], page: number, pageSize: number, total: number) {
	return {
		success: true as const,
		data,
		meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
	};
}

export function jsonContent<T extends z.ZodType>(schema: T, description: string) {
	return { content: { "application/json": { schema } }, description };
}

/** A required JSON request body. Without `required`, a request with no body skips validation. */
export function jsonBody<T extends z.ZodType>(schema: T, description: string) {
	return { ...jsonContent(schema, description), required: true };
}

const ERROR_DESCRIPTIONS = {
	400: "Invalid request",
	401: "Authentication required",
	403: "Forbidden",
	404: "Not found",
	409: "Conflict",
	429: "Too many requests",
} as const;

type ErrorStatus = keyof typeof ERROR_DESCRIPTIONS;

/** OpenAPI error responses for the given statuses, all using the shared error envelope. */
export function errorResponses<const S extends ErrorStatus[]>(...statuses: S) {
	return Object.fromEntries(
		statuses.map((status) => [status, jsonContent(errorSchema, ERROR_DESCRIPTIONS[status])]),
	) as { [K in S[number]]: ReturnType<typeof jsonContent<typeof errorSchema>> };
}

export interface PaginationOptions<S extends string> {
	/** the page-size field in the query and meta (default "pageSize") */
	sizeKey?: S;
	defaultSize?: number;
	maxSize?: number;
	/** add `hasNext` / `hasPrev` to the meta (default false) */
	navigation?: boolean;
	/** `totalPages` when there are no rows: 1 (default) or 0 */
	emptyTotalPages?: 0 | 1;
	/** the meta's OpenAPI component name (default "PaginationMeta") */
	name?: string;
}

type Int = z.ZodNumber;
type SizeQuery<S extends string> = { page: z.ZodDefault<z.ZodCoercedNumber> } & {
	[K in S]: z.ZodDefault<z.ZodCoercedNumber>;
};
type Meta<S extends string, N extends boolean = false> = {
	page: number;
	total: number;
	totalPages: number;
} & {
	[K in S]: number;
} & (N extends true
		? { hasNext: boolean; hasPrev: boolean }
		: { hasNext?: never; hasPrev?: never });

/**
 * Offset pagination in the app's own shape: its query schema, meta schema, list schema and
 * response builder. `createPagination()` is the default `page` / `pageSize` shape;
 * `createPagination({ sizeKey: "limit", navigation: true, emptyTotalPages: 0 })` gives
 * `{ page, limit, total, totalPages, hasNext, hasPrev }`.
 */
export function createPagination<S extends string = "pageSize">(
	options: PaginationOptions<S> & { navigation: true },
): {
	querySchema: z.ZodObject<SizeQuery<S>>;
	metaSchema: z.ZodObject<
		{ page: Int; total: Int; totalPages: Int; hasNext: z.ZodBoolean; hasPrev: z.ZodBoolean } & {
			[K in S]: Int;
		}
	>;
	schema<T extends z.ZodType>(
		item: T,
	): z.ZodObject<{
		success: z.ZodLiteral<true>;
		data: z.ZodArray<T>;
		meta: z.ZodObject<
			{ page: Int; total: Int; totalPages: Int; hasNext: z.ZodBoolean; hasPrev: z.ZodBoolean } & {
				[K in S]: Int;
			}
		>;
	}>;
	meta(page: number, size: number, total: number): Meta<S, true>;
	offset(page: number, size: number): number;
	paginated<T, X extends object = Record<never, never>>(
		data: T[],
		position: { page: number; total: number } & { [K in S]: number },
		extra?: { message?: string; meta?: X },
	): {
		success: true;
		data: T[];
		meta: Meta<S, true> & X;
		message?: string;
	};
};
export function createPagination<S extends string = "pageSize">(
	options?: PaginationOptions<S> & { navigation?: false },
): {
	querySchema: z.ZodObject<SizeQuery<S>>;
	metaSchema: z.ZodObject<{ page: Int; total: Int; totalPages: Int } & { [K in S]: Int }>;
	schema<T extends z.ZodType>(
		item: T,
	): z.ZodObject<{
		success: z.ZodLiteral<true>;
		data: z.ZodArray<T>;
		meta: z.ZodObject<{ page: Int; total: Int; totalPages: Int } & { [K in S]: Int }>;
	}>;
	meta(page: number, size: number, total: number): Meta<S, false>;
	offset(page: number, size: number): number;
	paginated<T, X extends object = Record<never, never>>(
		data: T[],
		position: { page: number; total: number } & { [K in S]: number },
		extra?: { message?: string; meta?: X },
	): {
		success: true;
		data: T[];
		meta: Meta<S, false> & X;
		message?: string;
	};
};
export function createPagination<S extends string = "pageSize">(
	options: PaginationOptions<S> = {},
) {
	const sizeKey = (options.sizeKey ?? "pageSize") as S;
	const maxSize = options.maxSize ?? 100;
	const defaultSize = options.defaultSize ?? 20;
	const navigation = options.navigation ?? false;
	const emptyTotalPages = options.emptyTotalPages ?? 1;

	const querySchema = z.object({
		page: z.coerce.number().int().min(1).default(1),
		[sizeKey]: z.coerce.number().int().min(1).max(maxSize).default(defaultSize),
	} as SizeQuery<S>);

	const metaBase = {
		page: z.number().int(),
		[sizeKey]: z.number().int(),
		total: z.number().int(),
		totalPages: z.number().int(),
	};

	const metaSchema = navigation
		? z
				.object({
					...metaBase,
					hasNext: z.boolean(),
					hasPrev: z.boolean(),
				})
				.openapi(options.name ?? "PaginationMeta")
		: z.object(metaBase as Record<string, Int>).openapi(options.name ?? "PaginationMeta");

	function meta(page: number, size: number, total: number) {
		const totalPages = Math.max(emptyTotalPages, Math.ceil(total / size));
		return navigation
			? ({
					page,
					[sizeKey]: size,
					total,
					totalPages,
					hasNext: page < totalPages,
					hasPrev: page > 1,
				} as Meta<S, true>)
			: ({
					page,
					[sizeKey]: size,
					total,
					totalPages,
				} as Meta<S, false>);
	}

	return {
		querySchema,
		metaSchema,
		/** the list response schema for `item` */
		schema<T extends z.ZodType>(item: T) {
			return z.object({ success: z.literal(true), data: z.array(item), meta: metaSchema });
		},
		meta,
		/** rows to skip for a page */
		offset: (page: number, size: number) => (page - 1) * size,
		/** `{ success, data, meta }`; `extra` is merged into the meta (e.g. counts per status) */
		paginated<T, X extends object = Record<never, never>>(
			data: T[],
			position: { page: number; total: number } & { [K in S]: number },
			extra?: { message?: string; meta?: X },
		) {
			const size = (position as Record<string, number>)[sizeKey] as number;
			return {
				success: true as const,
				data,
				meta: { ...meta(position.page, size, position.total), ...extra?.meta } as any,
				...(extra?.message === undefined ? {} : { message: extra.message }),
			};
		},
	};
}

/**
 * A `Content-Disposition` value that survives any file name: an ASCII `filename=` fallback
 * and the real name as RFC 6266 `filename*=UTF-8''…` (a raw non-Latin-1 header value throws).
 */
export function contentDisposition(
	fileName: string,
	disposition: "inline" | "attachment" = "inline",
): string {
	const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_") || "download";
	// RFC 5987 also reserves ' ( ) *, which encodeURIComponent leaves alone
	const encoded = encodeURIComponent(fileName).replace(
		/['()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
