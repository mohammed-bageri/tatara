import type { Violation } from "./check.ts";

const ROUTE_FILE = /\/routes\/[^/]+\.routes\.ts$/;
const DEFINE_ROUTES = /\bdefineRoutes\s*\(\s*/;
const MOUNT_KEYS = ["app", "basePath"] as const;

function lineOf(text: string, index: number): number {
	return text.slice(0, index).split("\n").length;
}

/** The `defineRoutes(...)` call: where it starts, and its object literal's top-level text, if any. */
function defineRoutesCall(text: string): { index: number; body: string | undefined } | undefined {
	const call = DEFINE_ROUTES.exec(text);
	if (!call) return undefined;
	const open = call.index + call[0].length;
	if (text[open] !== "{") return { index: call.index, body: undefined };
	let depth = 0;
	let body = "";
	for (let i = open; i < text.length; i++) {
		const ch = text[i] ?? "";
		if (ch === '"' || ch === "'" || ch === "`") {
			let end = i + 1;
			while (end < text.length && text[end] !== ch) end += text[end] === "\\" ? 2 : 1;
			body += depth === 1 ? text.slice(i, end + 1) : " ";
			i = end;
			continue;
		}
		if (ch === "{" || ch === "[" || ch === "(") depth++;
		else if (ch === "}" || ch === "]" || ch === ")") {
			depth--;
			if (depth === 0) return { index: call.index, body };
		} else if (depth === 1) body += ch;
		// nested text is blanked, so a key inside a nested object is not read as the mount's
		if (depth > 1) body += " ";
	}
	return { index: call.index, body: undefined };
}

const literal = (body: string, key: string) =>
	new RegExp(`\\b${key}:\\s*["']([^"']+)["']\\s*(?:,|$)`).exec(body)?.[1];

/**
 * Route files whose `defineRoutes` app or basePath is not a string literal: a constant or a
 * computed value hides the mount from the duplicate-base-path check.
 */
export function nonLiteralMounts(sources: ReadonlyMap<string, string>): Violation[] {
	const violations: Violation[] = [];
	for (const file of [...sources.keys()].sort()) {
		if (!ROUTE_FILE.test(file)) continue;
		const text = sources.get(file) ?? "";
		const call = defineRoutesCall(text);
		if (!call) continue;
		for (const key of MOUNT_KEYS) {
			if (call.body !== undefined && literal(call.body, key)) continue;
			violations.push({
				file,
				line: lineOf(text, call.index),
				rule: "literal-base-path",
				message: `${key} must be a string literal so duplicate mounts are detectable`,
			});
		}
	}
	return violations;
}

/** Route files that mount on an app + basePath already taken by an earlier file (sorted by path). */
export function routeMountCollisions(sources: ReadonlyMap<string, string>): Violation[] {
	const owners = new Map<string, string>();
	const violations: Violation[] = [];
	for (const file of [...sources.keys()].sort()) {
		if (!ROUTE_FILE.test(file)) continue;
		const text = sources.get(file) ?? "";
		const call = defineRoutesCall(text);
		const app = call?.body && literal(call.body, "app");
		const basePath = call?.body && literal(call.body, "basePath");
		if (!call || !app || !basePath) continue;
		const key = `${app} "${basePath}"`;
		const owner = owners.get(key);
		if (owner) {
			violations.push({
				file,
				line: lineOf(text, call.index),
				rule: "duplicate-base-path",
				message: `${key} is already mounted by ${owner}; routers on one base path shadow each other, so give this one its own basePath`,
			});
		} else {
			owners.set(key, file);
		}
	}
	return violations;
}
