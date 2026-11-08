/** `{{name}}` substitution for stored (tenant-edited) templates, HTML escaping, and variable hashing. */
import { createHash } from "node:crypto";

const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export function escapeHtml(value: string | null | undefined): string {
	if (value == null) return "";
	return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export interface PlaceholderOptions {
	language?: string;
	/** how a Date variable reads; default: the long date in `language` */
	formatDate?(date: Date, language: string): string;
}

const longDate = (date: Date, language: string) =>
	date.toLocaleDateString(language, { year: "numeric", month: "long", day: "numeric" });

/**
 * Replaces `{{key}}` with `variables[key]`: strings as they are, numbers and booleans as text,
 * dates formatted, anything else as JSON, missing values as "". Values are not escaped.
 */
export function substitutePlaceholders(
	template: string | null | undefined,
	variables: Record<string, unknown>,
	options: PlaceholderOptions = {},
): string {
	if (template == null) return "";
	const language = options.language ?? "en";
	const formatDate = options.formatDate ?? longDate;
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
		const value = variables[key];
		if (value === undefined || value === null) return "";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		if (value instanceof Date) return formatDate(value, language);
		return JSON.stringify(value);
	});
}

/** The names in `required` that `variables` lacks (undefined or null). */
export function missingVariables(
	variables: Record<string, unknown>,
	required: readonly string[],
): string[] {
	return required.filter((key) => variables[key] === undefined || variables[key] === null);
}

/** A stable SHA-256 of the variables' top-level keys and values, for the send log. */
export function hashVariables(variables: Record<string, unknown>): string {
	const sorted = JSON.stringify(variables, Object.keys(variables).sort());
	return createHash("sha256").update(sorted).digest("hex");
}
