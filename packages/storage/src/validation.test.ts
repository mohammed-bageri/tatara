import { describe, expect, it } from "vitest";
import {
	buildConstraintsFromRequirement,
	contentDispositionFor,
	formatBytes,
	getExpectedMimeTypes,
	getFileExtension,
	mimeTypeMatchesExtension,
	validateFileUpload,
} from "./validation.ts";

const pdf = { allowedExtensions: ["pdf"], allowedMimeTypes: ["application/pdf"], maxSizeMb: 1 };

describe("validateFileUpload", () => {
	it("accepts a matching file", () => {
		expect(validateFileUpload("CV.PDF", "application/pdf", 1000, pdf)).toEqual({ valid: true });
		expect(validateFileUpload("a.txt", "text/plain; charset=utf-8", 5, {})).toEqual({
			valid: true,
		});
	});

	it("checks the extension, then the MIME type, then their agreement", () => {
		expect(validateFileUpload("a.exe", "application/pdf", 10, pdf).errorCode).toBe(
			"INVALID_EXTENSION",
		);
		expect(validateFileUpload("a.pdf", "text/html", 10, pdf).errorCode).toBe("INVALID_MIME_TYPE");
		const spoof = validateFileUpload("a.png", "text/html", 10, {});
		expect(spoof).toMatchObject({ valid: false, errorCode: "INVALID_MIME_TYPE" });
		expect(spoof.error).toContain("Expected: image/png");
		expect(validateFileUpload("a.unknown", "text/html", 10, {}).valid).toBe(true);
	});

	it("checks the size bounds", () => {
		expect(validateFileUpload("a.pdf", "application/pdf", 1024 * 1024 + 1, pdf)).toMatchObject({
			errorCode: "FILE_TOO_LARGE",
			error: "File size (1 MB) exceeds maximum allowed size (1MB)",
		});
		expect(validateFileUpload("a.pdf", "application/pdf", 0, pdf).errorCode).toBe("FILE_TOO_SMALL");
		expect(validateFileUpload("a.pdf", "application/pdf", 5, { minSizeBytes: 10 }).errorCode).toBe(
			"FILE_TOO_SMALL",
		);
	});
});

describe("MIME helpers", () => {
	it("reads extensions and the MIME types they may declare", () => {
		expect(getFileExtension("a.tar.GZ")).toBe("gz");
		expect(getFileExtension("README")).toBe("");
		expect(getExpectedMimeTypes("WEBM")).toEqual(["video/webm", "audio/webm"]);
		expect(getExpectedMimeTypes("nope")).toEqual([]);
		expect(mimeTypeMatchesExtension("audio/webm", "webm")).toBe(true);
		expect(mimeTypeMatchesExtension("image/png", "jpg")).toBe(false);
	});

	it("builds constraints from allowed extensions", () => {
		expect(
			buildConstraintsFromRequirement({
				allowedFileTypes: ["pdf", "jpg", "zzz"],
				maxFileSizeMb: 5,
			}),
		).toEqual({
			allowedExtensions: ["pdf", "jpg", "zzz"],
			allowedMimeTypes: ["application/pdf", "image/jpeg"],
			maxSizeMb: 5,
		});
		expect(
			buildConstraintsFromRequirement({ allowedFileTypes: null, maxFileSizeMb: null }),
		).toEqual({});
	});

	it("formats bytes", () => {
		expect(formatBytes(0)).toBe("0 Bytes");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(5 * 1024 ** 4)).toBe("5120 GB");
	});
});

describe("contentDispositionFor", () => {
	it("shows safe images and audio inline and downloads the rest", () => {
		expect(contentDispositionFor("a.png", "image/png")).toBe(
			`inline; filename="a.png"; filename*=UTF-8''a.png`,
		);
		expect(contentDispositionFor("v.webm", "audio/webm").startsWith("inline")).toBe(true);
		expect(contentDispositionFor("x.svg", "image/svg+xml").startsWith("attachment")).toBe(true);
	});

	it("keeps a non-ASCII name in filename* and an ASCII fallback", () => {
		expect(contentDispositionFor('عقد "1".pdf', "application/pdf")).toBe(
			`attachment; filename="___ _1_.pdf"; filename*=UTF-8''%D8%B9%D9%82%D8%AF%20%221%22.pdf`,
		);
	});
});
