import {
	CopyObjectCommand,
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	ListObjectsV2Command,
	NoSuchKey,
	PutObjectCommand,
	type S3Client,
	type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
	assertKey,
	type BucketStorage,
	DEFAULT_URL_EXPIRY_SECONDS,
	downloadOptions,
	type StoredObject,
} from "./storage.ts";

export type { BucketStorage } from "./storage.ts";

export interface S3StorageOptions {
	/** the app's own S3Client, so it picks region, endpoint and credentials */
	client: S3Client;
	/**
	 * signs the URLs handed to browsers; give it a client on the public endpoint when the bucket
	 * sits behind a proxy and `client` targets an internal host (default: `client`)
	 */
	presignClient?: S3Client;
	bucket: string;
	/** create the bucket on first write (local development) */
	createBucket?: boolean;
}

/** Any S3-compatible store (AWS S3, MinIO, OCI, GCS interop, R2, RustFS locally). */
export function s3Storage({
	client,
	presignClient = client,
	bucket,
	createBucket = false,
}: S3StorageOptions): BucketStorage {
	let bucketReady: Promise<boolean> | undefined;
	return {
		bucket,
		ensureBucket: () => ensureBucket(client, bucket),
		async put(key, body, contentType) {
			if (createBucket) {
				bucketReady ??= ensureBucket(client, bucket);
				await bucketReady;
			}
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: assertKey(key),
					Body: body,
					ContentType: contentType,
				}),
			);
		},
		async get(key) {
			try {
				const res = await client.send(
					new GetObjectCommand({ Bucket: bucket, Key: assertKey(key) }),
				);
				return res.Body ? await res.Body.transformToByteArray() : null;
			} catch (error) {
				if (error instanceof NoSuchKey || (error as { name?: string }).name === "NoSuchKey")
					return null;
				throw error;
			}
		},
		async delete(key) {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: assertKey(key) }));
		},
		async url(key, options) {
			const {
				expiresInSeconds = DEFAULT_URL_EXPIRY_SECONDS,
				responseContentType,
				responseContentDisposition,
			} = downloadOptions(options);
			const command = new GetObjectCommand({
				Bucket: bucket,
				Key: assertKey(key),
				...(responseContentType ? { ResponseContentType: responseContentType } : {}),
				...(responseContentDisposition
					? { ResponseContentDisposition: responseContentDisposition }
					: {}),
			});
			return getSignedUrl(presignClient, command, { expiresIn: expiresInSeconds });
		},
		async uploadUrl(
			key,
			{ expiresInSeconds = DEFAULT_URL_EXPIRY_SECONDS, contentType, contentLength } = {},
		) {
			const command = new PutObjectCommand({
				Bucket: bucket,
				Key: assertKey(key),
				...(contentType ? { ContentType: contentType } : {}),
				...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
			});
			// the presigner leaves these headers unsigned unless named, and then storage accepts any
			const signableHeaders = new Set<string>();
			if (contentType) signableHeaders.add("content-type");
			if (contentLength !== undefined) signableHeaders.add("content-length");
			return getSignedUrl(presignClient, command, {
				expiresIn: expiresInSeconds,
				...(signableHeaders.size > 0 ? { signableHeaders } : {}),
			});
		},
		async list(prefix) {
			const out: StoredObject[] = [];
			let token: string | undefined;
			do {
				const res = await client.send(
					new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
				);
				for (const obj of res.Contents ?? [])
					if (obj.Key) out.push({ key: obj.Key, lastModified: obj.LastModified, size: obj.Size });
				token = res.IsTruncated ? res.NextContinuationToken : undefined;
			} while (token);
			return out;
		},
		async copy(fromKey, toKey) {
			const source = assertKey(fromKey).split("/").map(encodeURIComponent).join("/");
			await client.send(
				new CopyObjectCommand({
					Bucket: bucket,
					CopySource: `${bucket}/${source}`,
					Key: assertKey(toKey),
				}),
			);
		},
	};
}

/** Creates the bucket when it does not exist; true when it was created. */
export async function ensureBucket(client: S3Client, bucket: string): Promise<boolean> {
	try {
		await client.send(new HeadBucketCommand({ Bucket: bucket }));
		return false;
	} catch {
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
		return true;
	}
}

/** `s3`: AWS S3; `minio`, `oci`: need an endpoint and path-style; `gcs`: GCS XML API with HMAC keys. */
export type S3Provider = "s3" | "minio" | "oci" | "gcs";

export interface S3ConfigOptions {
	provider?: S3Provider;
	endpoint?: string;
	/** default "us-east-1" ("auto" for gcs) */
	region?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	/** forced on for minio and oci */
	forcePathStyle?: boolean;
}

const PATH_STYLE: ReadonlySet<S3Provider> = new Set(["minio", "oci"]);

/**
 * An S3ClientConfig for a provider. Without keys the SDK's default credential chain applies.
 * Checksums are only sent when required: SDK >= 3.750 adds CRC32 params to presigned URLs by
 * default, and MinIO answers those PUTs with 404.
 */
export function s3ClientConfig({
	provider = "s3",
	endpoint,
	region,
	accessKeyId,
	secretAccessKey,
	forcePathStyle = false,
}: S3ConfigOptions = {}): S3ClientConfig {
	if (PATH_STYLE.has(provider) && !endpoint)
		throw new Error(`${provider} storage needs an endpoint (e.g. http://localhost:9000)`);
	if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
		throw new Error("Set both the storage access key id and secret access key, or neither");
	const resolvedEndpoint =
		endpoint ?? (provider === "gcs" ? "https://storage.googleapis.com" : undefined);
	return {
		region: region ?? (provider === "gcs" ? "auto" : "us-east-1"),
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
		...(resolvedEndpoint ? { endpoint: resolvedEndpoint } : {}),
		...(PATH_STYLE.has(provider) || forcePathStyle ? { forcePathStyle: true } : {}),
		...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
	};
}
