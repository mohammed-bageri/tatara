import type {
	Storage as GcsClient,
	StorageOptions as GcsClientOptions,
} from "@google-cloud/storage";
import {
	assertKey,
	type BucketStorage,
	DEFAULT_URL_EXPIRY_SECONDS,
	downloadOptions,
} from "./storage.ts";

export type { BucketStorage } from "./storage.ts";

export interface GcsStorageOptions {
	/** the app's own `new Storage(...)` from @google-cloud/storage */
	client: GcsClient;
	bucket: string;
	/** create the bucket on first write (local development) */
	createBucket?: boolean;
}

const notFound = (error: unknown) => (error as { code?: number }).code === 404;

/** Google Cloud Storage through its native SDK (service-account credentials, v4 signing). */
export function gcsStorage({
	client,
	bucket,
	createBucket = false,
}: GcsStorageOptions): BucketStorage {
	const files = client.bucket(bucket);
	const file = (key: string) => files.file(assertKey(key));
	const ensure = async () => {
		const [exists] = await files.exists();
		if (exists) return false;
		await files.create();
		return true;
	};
	let bucketReady: Promise<boolean> | undefined;
	return {
		bucket,
		ensureBucket: ensure,
		async put(key, body, contentType) {
			if (createBucket) {
				bucketReady ??= ensure();
				await bucketReady;
			}
			await file(key).save(typeof body === "string" ? body : Buffer.from(body), {
				...(contentType ? { contentType } : {}),
				resumable: false,
			});
		},
		async get(key) {
			try {
				const [contents] = await file(key).download();
				return new Uint8Array(contents);
			} catch (error) {
				if (notFound(error)) return null;
				throw error;
			}
		},
		async delete(key) {
			await file(key).delete({ ignoreNotFound: true });
		},
		async url(key, options) {
			const {
				expiresInSeconds = DEFAULT_URL_EXPIRY_SECONDS,
				responseContentType,
				responseContentDisposition,
			} = downloadOptions(options);
			const [url] = await file(key).getSignedUrl({
				version: "v4",
				action: "read",
				expires: Date.now() + expiresInSeconds * 1000,
				...(responseContentType ? { responseType: responseContentType } : {}),
				...(responseContentDisposition ? { responseDisposition: responseContentDisposition } : {}),
			});
			return url;
		},
		async uploadUrl(
			key,
			{ expiresInSeconds = DEFAULT_URL_EXPIRY_SECONDS, contentType, contentLength } = {},
		) {
			const [url] = await file(key).getSignedUrl({
				version: "v4",
				action: "write",
				expires: Date.now() + expiresInSeconds * 1000,
				...(contentType ? { contentType } : {}),
				// v4 signs extension headers canonically, so GCS refuses a PUT of any other length
				...(contentLength !== undefined
					? { extensionHeaders: { "content-length": contentLength } }
					: {}),
			});
			return url;
		},
		async list(prefix) {
			const [found] = await files.getFiles(prefix ? { prefix } : {});
			return found.map((f) => {
				const { updated, size } = f.metadata;
				return {
					key: f.name,
					...(updated ? { lastModified: new Date(updated) } : {}),
					...(size !== undefined ? { size: Number(size) } : {}),
				};
			});
		},
		async copy(fromKey, toKey) {
			await file(fromKey).copy(file(toKey));
		},
	};
}

export interface GcsCredentialsOptions {
	projectId?: string;
	/** path to a service-account JSON file */
	keyFile?: string;
	/** a service-account JSON string (wins over nothing, loses to keyFile) */
	credentials?: string;
}

/** Options for `new Storage(...)`; without a key file or credentials ADC applies. */
export function gcsClientOptions({
	projectId,
	keyFile,
	credentials,
}: GcsCredentialsOptions): GcsClientOptions {
	const options: GcsClientOptions = projectId ? { projectId } : {};
	if (keyFile) return { ...options, keyFilename: keyFile };
	if (credentials) {
		try {
			return { ...options, credentials: JSON.parse(credentials) };
		} catch {
			throw new Error("GCS credentials are not valid JSON");
		}
	}
	return options;
}
