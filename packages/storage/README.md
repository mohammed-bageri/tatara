# @tatara/storage

Part of [tatara](https://github.com/mohammed-bageri/tatara).

Object storage for tatara apps: one `Storage` contract with local, S3-compatible and GCS drivers,
upload keys, upload validation, and orphan reconciliation. The SDKs are optional peers:
`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` for `@tatara/storage/s3`,
`@google-cloud/storage` for `@tatara/storage/gcs`.

## The contract

```ts
interface Storage {
	put(key, body: Uint8Array | string, contentType?): Promise<void>;
	get(key): Promise<Uint8Array | null>; // null when missing
	delete(key): Promise<void>; // a missing object is success
	url(key, options?: number | { expiresInSeconds?, responseContentType?, responseContentDisposition? }): Promise<string>;
	uploadUrl(key, options?: { expiresInSeconds?, contentType?, contentLength? }): Promise<string>;
	list(prefix?): Promise<{ key; lastModified?; size? }[]>;
	copy(fromKey, toKey): Promise<void>;
	ensureBucket?(): Promise<boolean>; // S3 and GCS drivers
}
```

One instance is one bucket. Keys are relative paths (`assertKey` rejects `..`, backslashes, NUL
and absolute paths). Public and private objects share the bucket and differ by key prefix
(`public/…`, `private/…`); the bucket policy makes the public prefix readable.

`uploadUrl` signs `contentType` and `contentLength` into the URL, so storage refuses a PUT whose
type or size differs from what the server validated. Expiries default to 900 seconds.

## Drivers

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { s3ClientConfig, s3Storage } from "@tatara/storage/s3";

const config = { provider: env.STORAGE_PROVIDER, region: env.STORAGE_REGION,
	accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY };
export const storage = s3Storage({
	client: new S3Client(s3ClientConfig({ ...config, endpoint: env.STORAGE_ENDPOINT })),
	// behind a proxy: sign browser URLs against the public host
	presignClient: new S3Client(s3ClientConfig({ ...config, endpoint: env.STORAGE_PUBLIC_ENDPOINT ?? env.STORAGE_ENDPOINT })),
	bucket: env.STORAGE_BUCKET,
});
```

`s3ClientConfig` presets: `s3` (AWS; default credential chain without keys), `minio` and `oci`
(endpoint required, path-style forced), `gcs` (the GCS XML API with HMAC keys). Checksums are
sent only when required, since MinIO rejects presigned PUTs carrying the SDK's default CRC32.

```ts
import { Storage as Gcs } from "@google-cloud/storage";
import { gcsClientOptions, gcsStorage } from "@tatara/storage/gcs";

export const storage = gcsStorage({
	client: new Gcs(gcsClientOptions({ projectId: env.GCS_PROJECT_ID, keyFile: env.GCS_KEY_FILE, credentials: env.GCS_CREDENTIALS })),
	bucket: env.STORAGE_BUCKET,
});
```

The GCS driver signs v4 URLs; an upload's length is bound as a `content-length` extension header.
`localStorage(dir)` writes files under `dir` and returns `file://` URLs, for development and tests.

## Upload keys

The app declares its upload contexts as a discriminated union and the key rule for each; modules
can each contribute a handler map.

```ts
import { type UploadContextHandlers, uploadKeys } from "@tatara/storage";

type UploadContext =
	| { type: "user-avatar"; userId: string }
	| { type: "general"; category: string };

const general: UploadContextHandlers<UploadContext> = {
	general: (c, { organizationId, timestamp, safeFileName }) =>
		`private/orgs/${organizationId}/uploads/${c.category}/${timestamp}_${safeFileName}`,
};

export const keys = uploadKeys<UploadContext>({
	contexts: [general, userContexts], // or an async loader, called once
	publicPrefix: env.STORAGE_PUBLIC_PREFIX, // handlers get it as `pub`; default "public"
});
await keys.generate(orgId, { type: "general", category: "docs" }, "My CV.pdf");
```

`sanitizeFileName` (used by `generate`) strips separators, NUL bytes and percent-encoded
separators, collapses whitespace and caps the name at 200 characters, keeping the extension.
`publicUrl(env.STORAGE_PUBLIC_BASE_URL, key)` gives the public URL, or null without a base URL
(fall back to `url()`). `organizationIdFromKey(key, prefixes?)` reads `orgs/{id}/` under an
optional `private/` or `public/` prefix.

## Upload validation

`validateFileUpload(fileName, mimeType, sizeBytes, constraints)` checks the extension, the MIME
type, that the two agree (`MIME_TYPE_MAP`, against an `x.png` declared as `text/html`), and size;
it returns `{ valid, error?, errorCode? }`. `buildConstraintsFromRequirement({ allowedFileTypes,
maxFileSizeMb })` derives MIME types from extensions. `contentDispositionFor(fileName, mimeType)`
gives `inline` for safe images and audio and `attachment` for everything else (SVG included),
with an ASCII fallback and the UTF-8 name.

These check what the client declares before presigning; the signed type and length make storage
hold it to that.

## Commands

`storage:check` is wired in by `tatara sync` (it needs `storage` from `#core/storage/index`): it
creates the bucket when the driver can, then puts, reads back, signs a URL for and deletes a
`_healthcheck/` object.

`storage:reconcile-orphan-objects` needs the app's object metadata, so the app adds it as its own
command file:

```ts
import { reconcileOrphanObjectsCommand } from "@tatara/storage/commands";

export default reconcileOrphanObjectsCommand({
	storage,
	objects: {
		async referencedKeys(keys) {
			const rows = await db.select({ key: fileObjects.objectKey }).from(fileObjects)
				.where(inArray(fileObjects.objectKey, [...keys]));
			return new Set(rows.map((r) => r.key));
		},
		async existingOwners(ids) {
			const rows = await db.select({ id: organization.id }).from(organization)
				.where(inArray(organization.id, [...ids]));
			return new Set(rows.map((r) => r.id));
		},
	},
	// ownerOf: (key) => organizationIdFromKey(key, ["private", env.STORAGE_PUBLIC_PREFIX]),
});
```

It lists the bucket, skips keys without an owner, and reports objects with no metadata row whose
owner is gone or that are older than `minAgeMs` (24h). `--apply` deletes only those of deleted
owners: an old object with no row under a live owner is reported, never deleted, since not every
upload path has to record a row. `findOrphanObjects` and `reconcileOrphanObjects` are the same
logic as functions.
