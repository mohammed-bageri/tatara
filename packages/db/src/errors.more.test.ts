/**
 * Postgres error-introspection helpers.
 *
 * drizzle wraps the underlying postgres-js error, so the SQLSTATE `code` and the violated
 * `constraint` name can sit either directly on the error or one level down on `cause`.
 * These helpers must read both shapes and never throw on a non-database value.
 */

import { describe, expect, it } from "vitest";
import { extractDbError, isUniqueViolation, likePattern } from "./index.ts";

describe("extractDbError", () => {
	it("reads code + constraint directly off the error", () => {
		const err = { code: "23505", constraint: "organization_slug_unique" };
		expect(extractDbError(err)).toEqual({
			code: "23505",
			constraint: "organization_slug_unique",
		});
	});

	it("reads code + constraint off `cause` when the error is wrapped", () => {
		const err = {
			message: "insert failed",
			cause: { code: "23505", constraint: "user_email_unique" },
		};
		expect(extractDbError(err)).toEqual({ code: "23505", constraint: "user_email_unique" });
	});

	it("returns an empty object for non-database values", () => {
		expect(extractDbError(null)).toEqual({});
		expect(extractDbError("boom")).toEqual({});
		expect(extractDbError(new Error("plain"))).toEqual({});
	});
});

describe("isUniqueViolation", () => {
	it("is true for a unique violation regardless of constraint when none is required", () => {
		expect(isUniqueViolation({ code: "23505" })).toBe(true);
		expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
	});

	it("matches a specific constraint name (slug and owner email)", () => {
		const slugErr = { code: "23505", constraint: "organization_slug_unique" };
		const emailErr = { cause: { code: "23505", constraint: "user_email_unique" } };
		expect(isUniqueViolation(slugErr, "organization_slug_unique")).toBe(true);
		expect(isUniqueViolation(emailErr, "user_email_unique")).toBe(true);
	});

	it("is false when the constraint name does not match", () => {
		const err = { code: "23505", constraint: "organization_slug_unique" };
		expect(isUniqueViolation(err, "user_email_unique")).toBe(false);
	});

	it("is false for a different SQLSTATE or a non-database error", () => {
		expect(isUniqueViolation({ code: "23503" })).toBe(false); // foreign_key_violation
		expect(isUniqueViolation(new Error("plain"))).toBe(false);
		expect(isUniqueViolation(null)).toBe(false);
	});
});

describe("likePattern", () => {
	it("wraps the term in wildcards", () => {
		expect(likePattern("growth")).toBe("%growth%");
	});

	it("escapes the LIKE metacharacters so they match literally", () => {
		expect(likePattern("50%")).toBe("%50\\%%");
		expect(likePattern("Exit_Feedback")).toBe("%Exit\\_Feedback%");
	});

	it("escapes the backslash itself, so an escape cannot be forged", () => {
		expect(likePattern("a\\b")).toBe("%a\\\\b%");
	});
});
