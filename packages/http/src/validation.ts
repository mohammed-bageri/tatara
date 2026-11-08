import type { Hook } from "@hono/zod-openapi";
import { ValidationError } from "./errors.ts";

/** The parts of a zod issue the error details use. */
export interface IssueLike {
	path: readonly PropertyKey[];
	message: string;
	code?: string;
}

const defaultDetail = (issue: IssueLike) => ({
	path: issue.path.map(String).join("."),
	message: issue.message,
	code: issue.code,
});

export interface ValidationHookOptions {
	/** "generic" (default): the translatable "Invalid request"; "first-issue": the first issue's message */
	message?: "generic" | "first-issue";
	/** the response status; unset leaves it to `handleErrors({ validationStatus })` (400 by default) */
	status?: 400 | 422;
	/** one `details` entry per issue (default `{ path, message, code }`) */
	detail?: (issue: IssueLike) => unknown;
}

/** A ValidationError for a list of zod issues. */
export function validationError(
	issues: readonly IssueLike[],
	options: ValidationHookOptions = {},
): ValidationError {
	const details = issues.map(options.detail ?? defaultDetail);
	const message = options.message === "first-issue" ? issues[0]?.message : undefined;
	return new ValidationError(message, details, options.status);
}

// biome-ignore lint/suspicious/noExplicitAny: the hook is shared by every route schema
type AnyHook = Hook<any, any, any, any>;

/** A `defaultHook` for OpenAPIHono that throws a ValidationError, so `handleErrors` shapes it. */
export function createValidationHook(options: ValidationHookOptions = {}): AnyHook {
	return (result) => {
		if (!result.success) throw validationError(result.error.issues, options);
	};
}

export const validationHook: AnyHook = createValidationHook();
