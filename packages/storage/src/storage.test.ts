import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { localStorage } from "./index.ts";
import { ensureBucket, s3ClientConfig, s3Storage } from "./s3.ts";

describe("localStorage", () => {
	it("round-trips an object", async () => {
		const store = localStorage(await mkdtemp(join(tmpdir(), "storage-")));
		await store.put("a/b.txt", "hello");
		expect(new TextDecoder().decode((await store.get("a/b.txt")) ?? new Uint8Array())).toBe(
			"hello",
		);
		await store.delete("a/b.txt");
		expect(await store.get("a/b.txt")).toBeNull();
	});

	it("rejects keys that escape the root", async () => {
		const store = localStorage(await mkdtemp(join(tmpdir(), "storage-")));
		for (const key of [
			"../x",
			"a/../../x",
			"a\\..\\x",
			"/etc/passwd",
			"C:/x",
			"a/\0b",
			"",
			"./x",
		]) {
			await expect(store.put(key, "no")).rejects.toThrow(/Invalid storage key/);
		}
	});

	it("lists by prefix and copies objects", async () => {
		const store = localStorage(await mkdtemp(join(tmpdir(), "storage-")));
		expect(await store.list()).toEqual([]);
		await store.put("orgs/a/x.txt", "1");
		await store.put("orgs/b/y.txt", "22");
		await store.copy("orgs/a/x.txt", "orgs/a/copy/x.txt");
		const listed = await store.list("orgs/a/");
		expect(listed.map((o) => o.key)).toEqual(["orgs/a/copy/x.txt", "orgs/a/x.txt"]);
		expect(listed[0]?.size).toBe(1);
		expect(listed[0]?.lastModified).toBeInstanceOf(Date);
		expect((await store.list()).length).toBe(3);
	});

	it("deletes missing objects without error", async () => {
		const store = localStorage(await mkdtemp(join(tmpdir(), "storage-")));
		await expect(store.delete("nope.txt")).resolves.toBeUndefined();
	});
});

describe("s3Storage", () => {
	const client = () => {
		const c = new S3Client({
			region: "us-east-1",
			credentials: { accessKeyId: "a", secretAccessKey: "b" },
		});
		return c;
	};

	it("creates the bucket once before the first write when asked", async () => {
		const c = client();
		const sent: string[] = [];
		vi.spyOn(c, "send").mockImplementation(async (command: { constructor: { name: string } }) => {
			sent.push(command.constructor.name);
			if (command.constructor.name === "HeadBucketCommand") throw new Error("missing");
			return {};
		});
		const store = s3Storage({ client: c, bucket: "b", createBucket: true });
		await store.put("x", "1");
		await store.put("y", "2");
		expect(sent).toEqual([
			"HeadBucketCommand",
			"CreateBucketCommand",
			"PutObjectCommand",
			"PutObjectCommand",
		]);
	});

	it("never touches the bucket by default, and validates keys", async () => {
		const c = client();
		const send = vi.spyOn(c, "send").mockResolvedValue({} as never);
		const store = s3Storage({ client: c, bucket: "b" });
		await store.put("x", "1");
		expect(send).toHaveBeenCalledTimes(1);
		await expect(store.get("../x")).rejects.toThrow(/Invalid storage key/);
	});

	it("reports whether ensureBucket created the bucket", async () => {
		const c = client();
		vi.spyOn(c, "send").mockResolvedValue({} as never);
		expect(await ensureBucket(c, "b")).toBe(false);
	});

	it("treats a missing object as null and nothing else", async () => {
		const c = client();
		const send = vi.spyOn(c, "send");
		send.mockRejectedValueOnce(new NoSuchKey({ message: "missing", $metadata: {} }));
		const store = s3Storage({ client: c, bucket: "b" });
		expect(await store.get("x")).toBeNull();
		send.mockRejectedValueOnce(new Error("AccessDenied"));
		await expect(store.get("x")).rejects.toThrow("AccessDenied");
	});

	it("lists every page", async () => {
		const c = client();
		const pages = [
			{ Contents: [{ Key: "a", Size: 1 }], IsTruncated: true, NextContinuationToken: "t" },
			{ Contents: [{ Key: "b", Size: 2 }, {}], IsTruncated: false },
		];
		const tokens: unknown[] = [];
		vi.spyOn(c, "send").mockImplementation((async (command: {
			input: { ContinuationToken?: string };
		}) => {
			tokens.push(command.input.ContinuationToken);
			return pages.shift();
		}) as never);
		const listed = await s3Storage({ client: c, bucket: "b" }).list("p/");
		expect(listed.map((o) => o.key)).toEqual(["a", "b"]);
		expect(tokens).toEqual([undefined, "t"]);
	});

	it("copies within the bucket with an encoded source", async () => {
		const c = client();
		const send = vi.spyOn(c, "send").mockResolvedValue({} as never);
		await s3Storage({ client: c, bucket: "b" }).copy("a/x y.txt", "a/z.txt");
		expect(send.mock.calls[0]?.[0].input).toMatchObject({
			Bucket: "b",
			CopySource: "b/a/x%20y.txt",
			Key: "a/z.txt",
		});
	});

	it("exposes its bucket and ensureBucket", async () => {
		const c = client();
		vi.spyOn(c, "send").mockResolvedValue({} as never);
		const store = s3Storage({ client: c, bucket: "files" });
		expect(store.bucket).toBe("files");
		expect(await store.ensureBucket()).toBe(false);
	});

	it("signs upload URLs bound to the declared type and length", async () => {
		const url = new URL(
			await s3Storage({ client: client(), bucket: "b" }).uploadUrl("a/b.pdf", {
				expiresInSeconds: 120,
				contentType: "application/pdf",
				contentLength: 1234,
			}),
		);
		expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
		expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
		const bare = new URL(await s3Storage({ client: client(), bucket: "b" }).uploadUrl("a/b.pdf"));
		expect(bare.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
		expect(bare.searchParams.get("X-Amz-Expires")).toBe("900");
	});

	it("signs download URLs with response headers", async () => {
		const url = new URL(
			await s3Storage({ client: client(), bucket: "b" }).url("a/b.pdf", {
				expiresInSeconds: 30,
				responseContentType: "application/pdf",
				responseContentDisposition: 'attachment; filename="b.pdf"',
			}),
		);
		expect(url.searchParams.get("X-Amz-Expires")).toBe("30");
		expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
		expect(url.searchParams.get("response-content-disposition")).toBe(
			'attachment; filename="b.pdf"',
		);
	});

	it("signs browser URLs with the presign client", async () => {
		const internal = new S3Client(
			s3ClientConfig({
				provider: "minio",
				endpoint: "http://minio:9000",
				accessKeyId: "a",
				secretAccessKey: "b",
			}),
		);
		const presign = new S3Client(
			s3ClientConfig({
				provider: "minio",
				endpoint: "https://files.example.com",
				accessKeyId: "a",
				secretAccessKey: "b",
			}),
		);
		const store = s3Storage({ client: internal, presignClient: presign, bucket: "b" });
		expect(await store.url("k")).toMatch(/^https:\/\/files\.example\.com\/b\/k\?/);
		expect(await store.uploadUrl("k")).toMatch(/^https:\/\/files\.example\.com\/b\/k\?/);
		expect(await store.uploadUrl("k")).not.toContain("x-amz-checksum");
	});

	it("signs URLs without a network call", async () => {
		const url = await s3Storage({ client: client(), bucket: "b" }).url("a/b.txt", 60);
		expect(url).toMatch(/\/a\/b\.txt\?/);
		expect(url).toContain("X-Amz-Expires=60");
	});
});

describe("s3ClientConfig", () => {
	it("forces path-style and needs an endpoint for minio and oci", () => {
		for (const provider of ["minio", "oci"] as const) {
			expect(() => s3ClientConfig({ provider })).toThrow(/needs an endpoint/);
			expect(s3ClientConfig({ provider, endpoint: "http://x:9000" })).toMatchObject({
				endpoint: "http://x:9000",
				forcePathStyle: true,
			});
		}
	});

	it("leaves AWS S3 virtual-hosted with the default credential chain", () => {
		const config = s3ClientConfig();
		expect(config).toEqual({
			region: "us-east-1",
			requestChecksumCalculation: "WHEN_REQUIRED",
			responseChecksumValidation: "WHEN_REQUIRED",
		});
		expect(s3ClientConfig({ forcePathStyle: true, region: "eu-west-1" })).toMatchObject({
			forcePathStyle: true,
			region: "eu-west-1",
		});
	});

	it("targets the GCS XML API for gcs", () => {
		expect(
			s3ClientConfig({ provider: "gcs", accessKeyId: "a", secretAccessKey: "b" }),
		).toMatchObject({
			endpoint: "https://storage.googleapis.com",
			region: "auto",
			credentials: { accessKeyId: "a", secretAccessKey: "b" },
		});
	});

	it("rejects half a key pair", () => {
		expect(() => s3ClientConfig({ accessKeyId: "a" })).toThrow(/both/);
	});
});
