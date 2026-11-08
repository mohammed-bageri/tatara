/** Options for a signed download (GET) URL. */
export interface DownloadUrlOptions {
	/** default 900 */
	expiresInSeconds?: number;
	/** the `Content-Type` storage answers with */
	responseContentType?: string;
	/** the `Content-Disposition` storage answers with (see `contentDispositionFor`) */
	responseContentDisposition?: string;
}

/** Options for a signed upload (PUT) URL. */
export interface UploadUrlOptions {
	/** default 900 */
	expiresInSeconds?: number;
	/** signed into the URL: storage refuses an upload sent with any other `Content-Type` */
	contentType?: string;
	/** signed into the URL: storage refuses an upload of any other byte length */
	contentLength?: number;
}

export interface StoredObject {
	key: string;
	lastModified?: Date;
	size?: number;
}

/** Object storage used by modules: one bucket per instance, keys are relative paths. */
export interface Storage {
	put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
	/** null when the object does not exist */
	get(key: string): Promise<Uint8Array | null>;
	/** deleting a missing object succeeds */
	delete(key: string): Promise<void>;
	/** a URL clients can fetch the object from (signed for S3 and GCS); a number is the expiry */
	url(key: string, options?: number | DownloadUrlOptions): Promise<string>;
	/** a signed URL a client can PUT the object to */
	uploadUrl(key: string, options?: UploadUrlOptions): Promise<string>;
	/** every object under `prefix`, or in the whole bucket */
	list(prefix?: string): Promise<StoredObject[]>;
	copy(fromKey: string, toKey: string): Promise<void>;
	/** bucket drivers only: create the bucket when missing; true when it was created */
	ensureBucket?(): Promise<boolean>;
}

/** A driver bound to one bucket (S3, GCS). */
export interface BucketStorage extends Storage {
	readonly bucket: string;
	ensureBucket(): Promise<boolean>;
}

/** Keys are relative, forward-slash paths without "..", backslashes, NUL bytes or drive prefixes. */
export function assertKey(key: string): string {
	const invalid =
		!key ||
		key.startsWith("/") ||
		key.includes("\\") ||
		key.includes("\0") ||
		/^[A-Za-z]:/.test(key) ||
		key.split("/").some((segment) => segment === ".." || segment === ".");
	if (invalid) throw new Error(`Invalid storage key "${key}"`);
	return key;
}

export const DEFAULT_URL_EXPIRY_SECONDS = 900;

export function downloadOptions(options?: number | DownloadUrlOptions): DownloadUrlOptions {
	return typeof options === "number" ? { expiresInSeconds: options } : (options ?? {});
}
