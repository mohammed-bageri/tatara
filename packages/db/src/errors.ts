/** Recognising and redacting database errors across node-postgres, mysql2/mariadb, Drizzle and Prisma. */

export interface DbErrorInfo {
	/** SQLSTATE (Postgres), driver code like `ER_DUP_ENTRY` (MySQL) or Prisma's `P2002` */
	code?: string;
	/** MySQL's numeric error */
	errno?: number;
	/** the violated constraint (Postgres), key (MySQL) or Prisma's `meta.target` */
	constraint?: string;
}

type Fields = {
	code?: unknown;
	errno?: unknown;
	constraint?: unknown;
	meta?: { target?: unknown };
	sqlMessage?: unknown;
	message?: unknown;
	cause?: unknown;
};

function constraintOf(err: Fields): string | undefined {
	if (typeof err.constraint === "string") return err.constraint;
	const target = err.meta?.target;
	if (typeof target === "string") return target;
	if (Array.isArray(target)) return target.join(",");
	const text = typeof err.sqlMessage === "string" ? err.sqlMessage : err.message;
	return typeof text === "string" ? /for key '([^']+)'/.exec(text)?.[1] : undefined;
}

/** The driver error's code and constraint, found on `err` or down its `cause` chain (Drizzle wraps the driver error). */
export function extractDbError(err: unknown): DbErrorInfo {
	let current = err;
	for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
		const fields = current as Fields;
		if (typeof fields.code === "string" || typeof fields.errno === "number") {
			return {
				...(typeof fields.code === "string" && { code: fields.code }),
				...(typeof fields.errno === "number" && { errno: fields.errno }),
				...(constraintOf(fields) !== undefined && { constraint: constraintOf(fields) }),
			};
		}
		current = fields.cause;
	}
	return {};
}

const UNIQUE_CODES = new Set(["23505", "ER_DUP_ENTRY", "P2002"]);
// Postgres deadlock / serialization failure, MySQL deadlock, Prisma write conflict
const RETRYABLE_CODES = new Set(["40P01", "40001", "ER_LOCK_DEADLOCK", "P2034"]);

/** A unique-constraint violation; with `constraint`, only that constraint (or MySQL key). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
	const info = extractDbError(err);
	const unique = (info.code !== undefined && UNIQUE_CODES.has(info.code)) || info.errno === 1062;
	return unique && (constraint === undefined || info.constraint === constraint);
}

/** A deadlock or serialization failure: the whole transaction may succeed if re-run. */
export function isRetryableTxConflict(err: unknown): boolean {
	const info = extractDbError(err);
	return (info.code !== undefined && RETRYABLE_CODES.has(info.code)) || info.errno === 1213;
}

/** Runs `fn` (which opens its own transaction) and re-runs it once if it lost a deadlock or serialization race. */
export async function retryOnceOnTxConflict<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (!isRetryableTxConflict(error)) throw error;
		return fn();
	}
}

/** `%term%` for LIKE/ILIKE with `\`, `%` and `_` escaped, so user input matches literally (backslash is the default escape in Postgres and MySQL). */
export function likePattern(term: string): string {
	return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** A query error carrying the SQL and its bound params, like Drizzle's `DrizzleQueryError`. */
export type DbQueryError = Error & { query: string; params: unknown[] };

export interface SanitizedDbQueryError {
	name: string;
	message: string;
	query: string;
	cause: DbErrorInfo;
	stack: string;
}

const SANITIZED_MESSAGE = "Database query failed";

/** Drizzle's DrizzleQueryError or anything shaped like it; its message, stack header and params carry row values. */
export function isDbQueryError(err: unknown): err is DbQueryError {
	if (!(err instanceof Error)) return false;
	const candidate = err as Partial<DbQueryError>;
	return typeof candidate.query === "string" && Array.isArray(candidate.params);
}

/** A loggable view of a query error: the parametrised SQL and the driver code/constraint; params, message and driver detail dropped. */
export function sanitizeDbQueryError(err: DbQueryError): SanitizedDbQueryError {
	const name = err.name || "DbQueryError";
	// the stack's header is `${name}: ${message}`, so drop as many lines as the message has
	const frames = (err.stack ?? "").split("\n").slice(err.message.split("\n").length);
	return {
		name,
		message: SANITIZED_MESSAGE,
		query: err.query,
		cause: extractDbError(err),
		stack: [`${name}: ${SANITIZED_MESSAGE}`, ...frames].join("\n"),
	};
}

// Postgres `detail` / `where` quote row values and statement context; MySQL drivers put the full SQL in `sql`.
function redactedFields(err: Error): ReadonlySet<PropertyKey> {
	const e = err as { code?: unknown; severity?: unknown; sqlState?: unknown; sql?: unknown };
	const fields = new Set<PropertyKey>();
	if (typeof e.code === "string" && typeof e.severity === "string") {
		fields.add("detail");
		fields.add("where");
	}
	if (typeof e.sqlState === "string" && typeof e.sql === "string") fields.add("sql");
	return fields;
}

/**
 * `err` with every database error in it redacted: query errors become their sanitised view (as
 * real Errors) and raw driver errors lose their value-quoting fields, wherever they sit — the
 * error itself, its `cause` chain, an AggregateError's `errors`, or its own properties. Errors
 * with nothing to redact come back as the same reference; otherwise a copy is returned.
 * For a logger's `err` serializer.
 */
export function redactDbQueryErrors(err: unknown): unknown {
	return redact(err, new Map());
}

function redact(value: unknown, seen: Map<object, unknown>): unknown {
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const out = redact(item, seen);
			if (out !== item) changed = true;
			return out;
		});
		return changed ? next : value;
	}
	if (!(value instanceof Error)) return value;
	if (seen.has(value)) return seen.get(value);

	if (isDbQueryError(value)) {
		const sanitized = Object.assign(new Error(SANITIZED_MESSAGE), sanitizeDbQueryError(value));
		seen.set(value, sanitized);
		return sanitized;
	}

	// map to itself first, so a cycle back to `value` ends
	seen.set(value, value);
	const dropped = redactedFields(value);
	const keys = Reflect.ownKeys(value);
	const replacements = new Map<PropertyKey, unknown>();
	for (const key of keys) {
		if (dropped.has(key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) continue;
		// `cause` and AggregateError's `errors` are non-enumerable but still serialized
		if (key !== "cause" && key !== "errors" && !descriptor.enumerable) continue;
		const next = redact(descriptor.value, seen);
		if (next !== descriptor.value) replacements.set(key, next);
	}
	if (replacements.size === 0 && !keys.some((key) => dropped.has(key))) return value;

	const copy = Object.create(Object.getPrototypeOf(value)) as Error;
	for (const key of keys) {
		if (dropped.has(key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) continue;
		if (replacements.has(key)) descriptor.value = replacements.get(key);
		Object.defineProperty(copy, key, descriptor);
	}
	seen.set(value, copy);
	return copy;
}
