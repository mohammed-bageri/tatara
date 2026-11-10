import { glob } from "tinyglobby";
import type { Codemod } from "../codemods.ts";

/** The argument list of the call whose `(` is at `open`, split at top-level commas, and its end. */
export function callArgs(text: string, open: number): { args: string[]; end: number } | null {
	const args: string[] = [];
	let depth = 0;
	let start = open + 1;
	let quote: string | null = null;
	for (let i = open; i < text.length; i++) {
		const ch = text[i] as string;
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth === 0) {
				const last = text.slice(start, i).trim();
				if (last) args.push(last);
				return { args, end: i + 1 };
			}
		} else if (ch === "," && depth === 1) {
			args.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	return null;
}

const notFoundMessage = (arg: string) => {
	// already a message: running twice must change nothing
	if (/not found\W?$/i.test(arg)) return arg;
	const literal = /^(["'])(.*)\1$/s.exec(arg);
	if (literal) return `${literal[1]}${literal[2]} not found${literal[1]}`;
	if (arg.startsWith("`") && arg.endsWith("`")) return `${arg.slice(0, -1)} not found\``;
	return `\`\${${arg}} not found\``;
};

/** Rewrites the calls of one error class in `text`. */
export function rewriteErrors(text: string): string {
	let out = text;
	for (const [name, rewrite] of [
		["NotFoundError", (a: string[]) => (a.length === 1 ? [notFoundMessage(a[0] as string)] : null)],
		[
			"ConflictError",
			(a: string[]) =>
				a.length === 2 && !/^\{\s*details:/.test(a[1] as string)
					? [a[0], `{ details: ${a[1]} }`]
					: null,
		],
		[
			"ServiceUnavailableError",
			(a: string[]) =>
				a.length === 2 && !(a[1] as string).startsWith("{") ? [a[0], `{ code: ${a[1]} }`] : null,
		],
	] as const) {
		const pattern = new RegExp(`new\\s+${name}\\s*\\(`, "g");
		let next = "";
		let last = 0;
		for (const match of out.matchAll(pattern)) {
			const open = (match.index as number) + match[0].length - 1;
			const call = callArgs(out, open);
			if (!call) continue;
			const args = rewrite(call.args);
			if (!args) continue;
			next += `${out.slice(last, match.index)}new ${name}(${args.join(", ")})`;
			last = call.end;
		}
		out = next + out.slice(last);
	}
	return out;
}

/** 4xx errors take `(message?, { code?, details? })`; NotFoundError's argument is the message. */
export const errorOptions: Codemod = {
	version: "0.21.0",
	id: "error-options",
	description:
		"NotFoundError, ConflictError and ServiceUnavailableError take (message?, { code?, details? })",
	async run(ctx) {
		const files = await glob(["src/**/*.ts", "tests/**/*.ts"], {
			cwd: ctx.project.root,
			ignore: ["src/generated/**"],
		});
		let changed = 0;
		for (const path of files) {
			const text = await ctx.read(path);
			if (!/NotFoundError|ConflictError|ServiceUnavailableError/.test(text)) continue;
			const next = rewriteErrors(text);
			if (next !== text) {
				await ctx.write(path, next);
				changed++;
			}
		}
		if (changed > 0)
			ctx.report.notes.push(
				`4xx errors take (message?, { code?, details? }) now: NotFoundError("Job") became NotFoundError("Job not found") in ${changed} file(s). A code of your own (e.g. { code: "JOB_NOT_FOUND" }) is translated as errors.<code>.`,
			);
	},
};
