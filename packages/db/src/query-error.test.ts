import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isDbQueryError, redactDbQueryErrors, sanitizeDbQueryError } from "./index.ts";

const SECRET = "line-one\n    at fake (frame-looking-param.ts:1:1)\nline-three";

describe("sanitizeDbQueryError", () => {
	it("drops the whole message header from the stack, even when params span lines", () => {
		const err = new DrizzleQueryError("select $1", [SECRET], new Error("pg"));
		const sanitized = sanitizeDbQueryError(err);

		expect(sanitized.stack).not.toContain("line-one");
		expect(sanitized.stack).not.toContain("frame-looking-param");
		expect(sanitized.stack).not.toContain("line-three");
		const [header, firstFrame] = sanitized.stack.split("\n");
		expect(header).toBe(`${err.name}: Database query failed`);
		expect(firstFrame).toMatch(/^\s+at /);
	});
});

describe("isDbQueryError", () => {
	it("rejects non-errors that merely look like query errors", () => {
		expect(isDbQueryError({ query: "select 1", params: [] })).toBe(false);
		expect(isDbQueryError(null)).toBe(false);
	});
});

describe("redactDbQueryErrors", () => {
	it("returns errors with nothing to redact unchanged", () => {
		const err = new Error("plain", { cause: new Error("inner") });
		expect(redactDbQueryErrors(err)).toBe(err);
		expect(redactDbQueryErrors("text")).toBe("text");
	});

	it("keeps the prototype and own fields of a copied wrapper", () => {
		class SyncError extends Error {
			readonly connectionId = "conn-1";
		}
		const err = new SyncError("sync", { cause: new DrizzleQueryError("q", [SECRET]) });
		const redacted = redactDbQueryErrors(err) as SyncError;

		expect(redacted).not.toBe(err);
		expect(redacted).toBeInstanceOf(SyncError);
		expect(redacted.connectionId).toBe("conn-1");
		expect(redacted.message).toBe("sync");
		expect(JSON.stringify((redacted.cause as Error).stack)).not.toContain("line-one");
	});
});

describe("redactDbQueryErrors: aggregates, arrays and raw Postgres errors", () => {
	const VALUE = "jane.doe@example.com";

	function rawPgError() {
		return Object.assign(new Error("duplicate key value violates unique constraint"), {
			severity: "ERROR",
			code: "23505",
			constraint: "user_email_uq",
			detail: `Key (email)=(${VALUE}) already exists.`,
			where: `SQL statement "insert ... values ('${VALUE}')"`,
		});
	}

	it("drops detail and where from a raw Postgres error but keeps code and constraint", () => {
		const err = rawPgError();
		const redacted = redactDbQueryErrors(err) as Record<string, unknown>;

		expect(redacted).not.toBe(err);
		expect(redacted.detail).toBeUndefined();
		expect(redacted.where).toBeUndefined();
		expect(redacted.code).toBe("23505");
		expect(redacted.constraint).toBe("user_email_uq");
		expect(err.detail).toContain(VALUE);
	});

	it("leaves an error with a code but no severity alone", () => {
		const err = Object.assign(new Error("x"), { code: "E_APP", detail: "kept" });
		expect(redactDbQueryErrors(err)).toBe(err);
	});

	it("walks AggregateError.errors", () => {
		const agg = new AggregateError([new DrizzleQueryError("q", [SECRET]), rawPgError()], "many");
		const redacted = redactDbQueryErrors(agg) as AggregateError;

		expect(redacted).toBeInstanceOf(AggregateError);
		const rendered = JSON.stringify(
			redacted.errors.map((e: Error & { detail?: string }) => [e.message, e.stack, e.detail]),
		);
		expect(rendered).not.toContain("line-one");
		expect(rendered).not.toContain(VALUE);
		expect(JSON.stringify(redacted.errors)).not.toContain(VALUE);
	});

	it("walks arrays of errors held on enumerable properties", () => {
		const err = Object.assign(new Error("batch"), {
			failures: [new Error("fine"), new DrizzleQueryError("q", [VALUE])],
		});
		const redacted = redactDbQueryErrors(err) as typeof err;

		expect(redacted.failures[0]).toBe(err.failures[0]);
		expect((redacted.failures[1] as Error).message).toBe("Database query failed");
		expect(JSON.stringify((redacted.failures[1] as Error).stack)).not.toContain(VALUE);
	});
});
