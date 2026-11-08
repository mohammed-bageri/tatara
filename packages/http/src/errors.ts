import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AppError extends Error {
	readonly status: ContentfulStatusCode;
	readonly code: string;
	readonly details?: unknown;
	/** True when the message is generic, so the response may replace it with `errors.<code>` in the caller's language. */
	readonly translatable: boolean;

	constructor(
		status: ContentfulStatusCode,
		code: string,
		message: string,
		details?: unknown,
		translatable = false,
	) {
		super(message);
		this.name = new.target.name;
		this.status = status;
		this.code = code;
		this.details = details;
		this.translatable = translatable;
	}
}

export class ValidationError extends AppError {
	/** false when no status was passed, so `handleErrors({ validationStatus })` may choose it */
	readonly explicitStatus: boolean;
	constructor(message?: string, details?: unknown, status?: 400 | 422) {
		super(
			status ?? 400,
			"VALIDATION_ERROR",
			message ?? "Invalid request",
			details,
			message === undefined,
		);
		this.explicitStatus = status !== undefined;
	}
}

export class BusinessRuleError extends AppError {
	constructor(code: string, message: string, details?: unknown) {
		// codes are specific to the rule, so a translation for the code is never less precise
		super(400, code, message, details, true);
	}
}

export class UnauthorizedError extends AppError {
	constructor(message?: string) {
		super(
			401,
			"UNAUTHORIZED",
			message ?? "Authentication required",
			undefined,
			message === undefined,
		);
	}
}

export class ForbiddenError extends AppError {
	constructor(message?: string) {
		super(
			403,
			"FORBIDDEN",
			message ?? "You do not have permission to do this",
			undefined,
			message === undefined,
		);
	}
}

export class NotFoundError extends AppError {
	constructor(resource?: string) {
		super(
			404,
			"NOT_FOUND",
			`${resource ?? "Resource"} not found`,
			undefined,
			resource === undefined,
		);
	}
}

export class ConflictError extends AppError {
	constructor(message?: string, details?: unknown) {
		super(409, "CONFLICT", message ?? "Resource already exists", details, message === undefined);
	}
}

export class TooManyRequestsError extends AppError {
	/** seconds until the caller may try again, sent as Retry-After */
	readonly retryAfterSeconds: number;
	constructor(retryAfterSeconds: number) {
		super(429, "RATE_LIMITED", "Too many requests, try again later", undefined, true);
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export class RequestTimeoutError extends AppError {
	constructor() {
		super(504, "REQUEST_TIMEOUT", "The request took too long", undefined, true);
	}
}

/** 503: a dependency (queue, broker, provider) is unavailable; the request may be retried. */
export class ServiceUnavailableError extends AppError {
	constructor(message?: string, code = "SERVICE_UNAVAILABLE") {
		super(503, code, message ?? "Service unavailable", undefined, message === undefined);
	}
}
