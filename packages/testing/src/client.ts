type HttpApp = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

export interface ApiResponse<T = unknown> {
	status: number;
	headers: Headers;
	body: T;
}

export interface RequestOptions {
	headers?: Record<string, string>;
	body?: unknown;
}

async function send<T>(
	target: HttpApp,
	method: string,
	path: string,
	body: unknown,
	options: RequestOptions = {},
): Promise<ApiResponse<T>> {
	const headers: Record<string, string> = { ...options.headers };
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await target.request(path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: unknown = text;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {}
	return { status: res.status, headers: res.headers, body: parsed as T };
}

/** Calls a Hono app in-process (no network). */
export function client(target: HttpApp) {
	return {
		get: <T = unknown>(path: string, o?: RequestOptions) =>
			send<T>(target, "GET", path, undefined, o),
		post: <T = unknown>(path: string, body?: unknown, o?: RequestOptions) =>
			send<T>(target, "POST", path, body, o),
		put: <T = unknown>(path: string, body?: unknown, o?: RequestOptions) =>
			send<T>(target, "PUT", path, body, o),
		patch: <T = unknown>(path: string, body?: unknown, o?: RequestOptions) =>
			send<T>(target, "PATCH", path, body, o),
		delete: <T = unknown>(path: string, o?: RequestOptions) =>
			send<T>(target, "DELETE", path, o?.body, o),
	};
}
