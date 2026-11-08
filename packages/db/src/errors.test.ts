import { describe, expect, it, vi } from "vitest";
import {
	extractDbError,
	isDbQueryError,
	isRetryableTxConflict,
	isUniqueViolation,
	likePattern,
	redactDbQueryErrors,
	retryOnceOnTxConflict,
	sanitizeDbQueryError,
} from "./index.ts";

function pgError(code: string, extra: Record<string, unknown> = {}) {
	return Object.assign(new Error("duplicate key value"), { code, severity: "ERROR", ...extra });
}

function queryError(cause: unknown) {
	const err = Object.assign(
		new Error('Failed query: insert into "users" values ($1)\nparams: secret@example.com'),
		{ query: 'insert into "users" values ($1)', params: ["secret@example.com"], cause },
	);
	err.name = "DrizzleQueryError";
	return err;
}

describe("extractDbError / isUniqueViolation", () => {
	it("reads Postgres, Drizzle-wrapped, MySQL and Prisma errors", () => {
		const pg = pgError("23505", { constraint: "users_email_unique" });
		expect(extractDbError(pg)).toEqual({ code: "23505", constraint: "users_email_unique" });
		expect(extractDbError(queryError(pg))).toEqual({
			code: "23505",
			constraint: "users_email_unique",
		});
		const mysql = Object.assign(new Error("x"), {
			code: "ER_DUP_ENTRY",
			errno: 1062,
			sqlMessage: "Duplicate entry 'a@b.c' for key 'users.email'",
		});
		expect(extractDbError(mysql)).toEqual({
			code: "ER_DUP_ENTRY",
			errno: 1062,
			constraint: "users.email",
		});
		const prisma = Object.assign(new Error("x"), { code: "P2002", meta: { target: ["email"] } });
		expect(extractDbError(prisma)).toEqual({ code: "P2002", constraint: "email" });
		expect(extractDbError("nope")).toEqual({});
		expect(extractDbError(new Error("plain"))).toEqual({});
	});

	it("matches unique violations, optionally on one constraint", () => {
		const pg = queryError(pgError("23505", { constraint: "users_email_unique" }));
		expect(isUniqueViolation(pg)).toBe(true);
		expect(isUniqueViolation(pg, "users_email_unique")).toBe(true);
		expect(isUniqueViolation(pg, "other")).toBe(false);
		expect(isUniqueViolation(Object.assign(new Error(), { errno: 1062 }))).toBe(true);
		expect(isUniqueViolation(pgError("23503"))).toBe(false);
	});
});

describe("transaction conflicts", () => {
	it("recognises deadlocks and serialization failures", () => {
		expect(isRetryableTxConflict(queryError(pgError("40P01")))).toBe(true);
		expect(isRetryableTxConflict(pgError("40001"))).toBe(true);
		expect(isRetryableTxConflict(Object.assign(new Error(), { errno: 1213 }))).toBe(true);
		expect(isRetryableTxConflict(pgError("23505"))).toBe(false);
	});

	it("re-runs once on a conflict and rethrows anything else", async () => {
		const fn = vi.fn().mockRejectedValueOnce(pgError("40001")).mockResolvedValueOnce("ok");
		expect(await retryOnceOnTxConflict(fn)).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
		const twice = vi.fn().mockRejectedValue(pgError("40001"));
		await expect(retryOnceOnTxConflict(twice)).rejects.toMatchObject({ code: "40001" });
		expect(twice).toHaveBeenCalledTimes(2);
		const other = vi.fn().mockRejectedValue(new Error("boom"));
		await expect(retryOnceOnTxConflict(other)).rejects.toThrow("boom");
		expect(other).toHaveBeenCalledTimes(1);
	});
});

describe("likePattern", () => {
	it("escapes wildcards and backslashes", () => {
		expect(likePattern("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
	});
});

describe("query error redaction", () => {
	it("sanitises a query error: no params, message or driver detail", () => {
		const err = queryError(
			pgError("23505", { constraint: "c", detail: "Key (email)=(secret@example.com)" }),
		);
		expect(isDbQueryError(err)).toBe(true);
		expect(isDbQueryError(new Error("x"))).toBe(false);
		const clean = sanitizeDbQueryError(err);
		expect(clean).toMatchObject({
			name: "DrizzleQueryError",
			message: "Database query failed",
			query: 'insert into "users" values ($1)',
			cause: { code: "23505", constraint: "c" },
		});
		expect(clean.stack.startsWith("DrizzleQueryError: Database query failed\n")).toBe(true);
		expect(JSON.stringify(clean)).not.toContain("secret");
	});

	it("redacts query and raw driver errors anywhere in an error, leaving clean errors alone", () => {
		const plain = new Error("fine");
		expect(redactDbQueryErrors(plain)).toBe(plain);
		expect(redactDbQueryErrors("text")).toBe("text");

		const raw = pgError("23505", { detail: "Key (email)=(secret@example.com)", where: "secret" });
		const redactedRaw = redactDbQueryErrors(raw) as Record<string, unknown>;
		expect(redactedRaw).not.toBe(raw);
		expect(redactedRaw).toBeInstanceOf(Error);
		expect(redactedRaw.detail).toBeUndefined();
		expect(redactedRaw.code).toBe("23505");
		expect((raw as { detail?: string }).detail).toContain("secret");

		const mysql = Object.assign(new Error("x"), { sqlState: "23000", sql: "insert ... 'secret'" });
		expect((redactDbQueryErrors(mysql) as { sql?: string }).sql).toBeUndefined();

		const wrapper = new Error("job failed", { cause: queryError(raw) });
		const aggregate = new AggregateError([wrapper, plain], "many");
		const holder = Object.assign(new Error("holder"), { failures: [queryError(raw)] });
		for (const err of [wrapper, aggregate, holder]) {
			const out = redactDbQueryErrors(err);
			expect(out).not.toBe(err);
			const seen = new Set<unknown>();
			const text = JSON.stringify(out, (_k, v) => {
				if (v instanceof Error) {
					if (seen.has(v)) return "[cycle]";
					seen.add(v);
					return {
						...v,
						message: v.message,
						cause: (v as { cause?: unknown }).cause,
						errors: (v as { errors?: unknown }).errors,
					};
				}
				return v;
			});
			expect(text).not.toContain("secret");
			expect(text).toContain("Database query failed");
		}

		const cyclic = new Error("cycle") as Error & { self?: unknown };
		cyclic.self = cyclic;
		expect(redactDbQueryErrors(cyclic)).toBe(cyclic);
	});
});
