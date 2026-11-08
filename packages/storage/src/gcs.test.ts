import { generateKeyPairSync } from "node:crypto";
import { Storage as GcsClient } from "@google-cloud/storage";
import { describe, expect, it, vi } from "vitest";
import { gcsClientOptions, gcsStorage } from "./gcs.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// a real client: v4 signing with a service-account key needs no network
const signer = new GcsClient({
	projectId: "p",
	credentials: {
		client_email: "sa@p.iam.gserviceaccount.com",
		private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	},
});

/** A fake client for the operations that would hit the network. */
function fakeClient(file: Record<string, unknown>, bucket: Record<string, unknown> = {}) {
	const files = new Map<string, Record<string, unknown>>();
	const handle = {
		...bucket,
		file: (name: string) => {
			if (!files.has(name)) files.set(name, { name, ...file });
			return files.get(name);
		},
	};
	return { client: { bucket: () => handle } as unknown as GcsClient, files };
}

describe("gcsStorage", () => {
	it("signs uploads bound to the declared type and length with v4", async () => {
		const url = new URL(
			await gcsStorage({ client: signer, bucket: "b" }).uploadUrl("private/a.pdf", {
				expiresInSeconds: 300,
				contentType: "application/pdf",
				contentLength: 1234,
			}),
		);
		expect(url.pathname).toBe("/b/private/a.pdf");
		expect(url.searchParams.get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
		expect(url.searchParams.get("X-Goog-Expires")).toBe("300");
		expect(url.searchParams.get("X-Goog-SignedHeaders")).toBe("content-length;content-type;host");
	});

	it("signs downloads with response headers", async () => {
		const url = new URL(
			await gcsStorage({ client: signer, bucket: "b" }).url("k.pdf", {
				responseContentType: "application/pdf",
				responseContentDisposition: "attachment",
			}),
		);
		expect(url.searchParams.get("X-Goog-Expires")).toBe("900");
		expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
		expect(url.searchParams.get("response-content-disposition")).toBe("attachment");
		expect(
			new URL(await gcsStorage({ client: signer, bucket: "b" }).url("k", 60)).searchParams.get(
				"X-Goog-Expires",
			),
		).toBe("60");
	});

	it("reads, writes, deletes idempotently and copies", async () => {
		const save = vi.fn(async () => {});
		const del = vi.fn(async () => {});
		const copy = vi.fn(async () => {});
		const download = vi
			.fn()
			.mockResolvedValueOnce([Buffer.from("hi")])
			.mockRejectedValueOnce(Object.assign(new Error("No such object"), { code: 404 }))
			.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { code: 403 }));
		const { client, files } = fakeClient({ save, delete: del, copy, download });
		const store = gcsStorage({ client, bucket: "b" });
		await store.put("a.txt", new Uint8Array([1]), "text/plain");
		expect(save).toHaveBeenCalledWith(Buffer.from([1]), {
			contentType: "text/plain",
			resumable: false,
		});
		expect(new TextDecoder().decode((await store.get("a.txt")) ?? undefined)).toBe("hi");
		expect(await store.get("a.txt")).toBeNull();
		await expect(store.get("a.txt")).rejects.toThrow("Forbidden");
		await store.delete("a.txt");
		expect(del).toHaveBeenCalledWith({ ignoreNotFound: true });
		await store.copy("a.txt", "b.txt");
		expect(copy).toHaveBeenCalledWith(files.get("b.txt"));
		await expect(store.get("../x")).rejects.toThrow(/Invalid storage key/);
	});

	it("lists with metadata and creates a missing bucket once", async () => {
		const exists = vi.fn(async () => [false]);
		const create = vi.fn(async () => {});
		const getFiles = vi.fn(async () => [
			[
				{ name: "p/a", metadata: { updated: "2026-01-01T00:00:00Z", size: "12" } },
				{ name: "p/b", metadata: {} },
			],
		]);
		const save = vi.fn(async () => {});
		const { client } = fakeClient({ save }, { exists, create, getFiles });
		const store = gcsStorage({ client, bucket: "b", createBucket: true });
		expect(await store.list("p/")).toEqual([
			{ key: "p/a", lastModified: new Date("2026-01-01T00:00:00Z"), size: 12 },
			{ key: "p/b" },
		]);
		expect(getFiles).toHaveBeenCalledWith({ prefix: "p/" });
		await store.put("x", "1");
		await store.put("y", "2");
		expect(create).toHaveBeenCalledTimes(1);
		expect(store.bucket).toBe("b");
	});
});

describe("gcsClientOptions", () => {
	it("prefers a key file, then JSON credentials, else ADC", () => {
		expect(gcsClientOptions({ projectId: "p", keyFile: "/k.json", credentials: "{}" })).toEqual({
			projectId: "p",
			keyFilename: "/k.json",
		});
		expect(gcsClientOptions({ credentials: '{"client_email":"e"}' })).toEqual({
			credentials: { client_email: "e" },
		});
		expect(gcsClientOptions({})).toEqual({});
		expect(() => gcsClientOptions({ credentials: "nope" })).toThrow(/not valid JSON/);
	});
});
