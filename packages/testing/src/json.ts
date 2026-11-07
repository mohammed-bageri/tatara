import type { ApiResponse } from "./client.ts";

/** The bodies @tatara/http sends: `success()`, `paginated()` and the error handler. */
export interface SuccessBody<T = unknown> {
	success: true;
	data: T;
}

export interface PaginatedBody<T = unknown> {
	success: true;
	data: T[];
	meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface ErrorBody {
	success: false;
	error: string;
	code: string;
	details?: unknown;
}

type Source = Response | ApiResponse;

async function bodyOf(source: Source): Promise<{ status: number; body: unknown }> {
	if (typeof (source as Response).json === "function") {
		const res = source as Response;
		const text = await res.text();
		let body: unknown = text;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {}
		return { status: res.status, body };
	}
	return { status: source.status, body: (source as ApiResponse).body };
}

function mismatch(expected: string, status: number, body: unknown): Error {
	return new Error(`Expected ${expected}, got ${status}: ${JSON.stringify(body)}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The `{ success: true, data }` body of a `Response` or `client()` result; throws on any other shape. */
export async function jsonOk<T = unknown>(source: Source): Promise<SuccessBody<T>> {
	const { status, body } = await bodyOf(source);
	if (!isObject(body) || body.success !== true || !("data" in body))
		throw mismatch("a success body", status, body);
	return body as unknown as SuccessBody<T>;
}

/** A `paginated()` body; throws unless it has `data[]` and `meta`. */
export async function jsonPaginated<T = unknown>(source: Source): Promise<PaginatedBody<T>> {
	const { status, body } = await bodyOf(source);
	if (!isObject(body) || body.success !== true || !Array.isArray(body.data) || !isObject(body.meta))
		throw mismatch("a paginated body", status, body);
	return body as unknown as PaginatedBody<T>;
}

/** The `{ success: false, error, code }` body; throws on a success body. */
export async function jsonErr(source: Source): Promise<ErrorBody> {
	const { status, body } = await bodyOf(source);
	if (!isObject(body) || body.success !== false || typeof body.code !== "string")
		throw mismatch("an error body", status, body);
	return body as unknown as ErrorBody;
}
