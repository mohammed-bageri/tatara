/** Object keys: file-name sanitising, per-context upload keys, public URLs and key owners. */

const MAX_FILE_NAME = 200;

/** A file name safe to put in a key: no separators, NUL bytes, runs of spaces or edge dots. */
export function sanitizeFileName(fileName: string): string {
	// decode first so %2F and the like cannot smuggle a separator past the strip
	let safe: string;
	try {
		safe = decodeURIComponent(fileName);
	} catch {
		safe = fileName;
	}
	safe = safe
		// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL bytes must be stripped
		.replace(/[/\\:\x00]/g, "_")
		.replace(/[\s_]+/g, "_")
		.replace(/^[.\s]+|[.\s]+$/g, "");
	if (safe.length > MAX_FILE_NAME) {
		const dot = safe.lastIndexOf(".");
		const ext = dot > 0 ? safe.slice(dot + 1) : "";
		const name = ext ? safe.slice(0, dot) : safe;
		safe = ext
			? `${name.slice(0, MAX_FILE_NAME - ext.length - 1)}.${ext}`
			: name.slice(0, MAX_FILE_NAME);
	}
	return safe || "unnamed_file";
}

/** What every upload-context handler receives. */
export interface UploadKeyArgs {
	/** the organization passed to `generate` */
	organizationId: string;
	/** `now()` for this call (default `Date.now()`) */
	timestamp: number;
	safeFileName: string;
	/** the public key prefix (default "public"); private keys use "private" */
	pub: string;
}

/** An app's upload contexts: a discriminated union on `type`. */
export interface UploadContextBase {
	type: string;
}

/** Builds the key for one context type, from the narrowed context. */
export type UploadContextHandler<C extends UploadContextBase, T extends C["type"] = C["type"]> = (
	context: Extract<C, { type: T }>,
	args: UploadKeyArgs,
) => string;

/** Handlers for some of an app's context types; modules each declare the ones they own. */
export type UploadContextHandlers<C extends UploadContextBase> = {
	[T in C["type"]]?: UploadContextHandler<C, T>;
};

type HandlerMaps<C extends UploadContextBase> =
	| UploadContextHandlers<C>
	| UploadContextHandlers<C>[];

export interface UploadKeysOptions<C extends UploadContextBase> {
	/** handler maps, merged in order (later wins), or a loader for them that runs once */
	contexts: HandlerMaps<C> | (() => Promise<HandlerMaps<C>>);
	/** default "public" */
	publicPrefix?: string;
	now?: () => number;
}

export interface UploadKeys<C extends UploadContextBase> {
	readonly publicPrefix: string;
	/** the key for a new upload; throws for a context type no handler covers */
	generate(organizationId: string, context: C, fileName: string): Promise<string>;
}

type AnyHandler = (context: UploadContextBase, args: UploadKeyArgs) => string;

/** Upload-key generation over app-declared contexts. */
export function uploadKeys<C extends UploadContextBase>({
	contexts,
	publicPrefix = "public",
	now = Date.now,
}: UploadKeysOptions<C>): UploadKeys<C> {
	let merged: Promise<Record<string, AnyHandler>> | undefined;
	const load = async () => {
		const maps = typeof contexts === "function" ? await contexts() : contexts;
		return Object.assign({}, ...(Array.isArray(maps) ? maps : [maps])) as Record<
			string,
			AnyHandler
		>;
	};
	return {
		publicPrefix,
		async generate(organizationId, context, fileName) {
			merged ??= load();
			const handler = (await merged)[context.type];
			if (!handler) throw new Error(`Unknown upload context type: ${JSON.stringify(context)}`);
			return handler(context, {
				organizationId,
				timestamp: now(),
				safeFileName: sanitizeFileName(fileName),
				pub: publicPrefix,
			});
		},
	};
}

/**
 * The public URL of a key in a publicly readable prefix, or null when no base URL is configured
 * (the caller then falls back to a signed URL).
 */
export function publicUrl(baseUrl: string | undefined | null, key: string): string | null {
	if (!baseUrl) return null;
	return `${baseUrl.replace(/\/+$/, "")}/${key}`;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The organization a key belongs to: `orgs/{id}/...`, optionally under one of `prefixes`
 * (default "private" and "public"). Null for keys outside an organization.
 */
export function organizationIdFromKey(
	key: string,
	prefixes: readonly string[] = ["private", "public"],
): string | null {
	const alt = prefixes.length ? `(?:(?:${prefixes.map(escapeRegExp).join("|")})/)?` : "";
	const pattern = new RegExp(`^${alt}orgs/([^/]+)/`);
	return key.match(pattern)?.[1] ?? null;
}
