/** Upload validation from the client's declared name, MIME type and size, before presigning. */

export interface FileConstraints {
	/** extensions without the dot, e.g. ["pdf", "png"] */
	allowedExtensions?: string[];
	/** exact MIME types (parameters such as "; charset=" are allowed) */
	allowedMimeTypes?: string[];
	maxSizeMb?: number;
	/** default 1 */
	minSizeBytes?: number;
}

export type FileValidationErrorCode =
	| "INVALID_EXTENSION"
	| "INVALID_MIME_TYPE"
	| "FILE_TOO_LARGE"
	| "FILE_TOO_SMALL";

export interface ValidationResult {
	valid: boolean;
	error?: string;
	errorCode?: FileValidationErrorCode;
}

/** The MIME types each common extension may declare. */
export const MIME_TYPE_MAP: Readonly<Record<string, readonly string[]>> = {
	pdf: ["application/pdf"],
	doc: ["application/msword"],
	docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	xls: ["application/vnd.ms-excel"],
	xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
	ppt: ["application/vnd.ms-powerpoint"],
	pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
	txt: ["text/plain"],
	csv: ["text/csv", "application/csv"],
	rtf: ["application/rtf", "text/rtf"],
	jpg: ["image/jpeg"],
	jpeg: ["image/jpeg"],
	png: ["image/png"],
	gif: ["image/gif"],
	webp: ["image/webp"],
	svg: ["image/svg+xml"],
	bmp: ["image/bmp"],
	tiff: ["image/tiff"],
	tif: ["image/tiff"],
	zip: ["application/zip", "application/x-zip-compressed"],
	rar: ["application/x-rar-compressed", "application/vnd.rar"],
	"7z": ["application/x-7z-compressed"],
	mp4: ["video/mp4"],
	// a browser's voice recorder produces audio/webm under the same extension
	webm: ["video/webm", "audio/webm"],
	mov: ["video/quicktime"],
	avi: ["video/x-msvideo", "video/avi"],
	mkv: ["video/x-matroska"],
	m4v: ["video/x-m4v"],
	json: ["application/json"],
	xml: ["application/xml", "text/xml"],
};

/** Lower-case extension without the dot; "" when there is none. */
export function getFileExtension(fileName: string): string {
	const parts = fileName.toLowerCase().split(".");
	return parts.length > 1 ? (parts.at(-1) ?? "") : "";
}

const mimeIs = (mimeType: string, expected: string) => {
	const m = mimeType.toLowerCase();
	const e = expected.toLowerCase();
	return m === e || m.startsWith(`${e};`);
};

/** True when the extension is unknown or the MIME type is one it may declare. */
export function mimeTypeMatchesExtension(mimeType: string, extension: string): boolean {
	const expected = MIME_TYPE_MAP[extension.toLowerCase()];
	return !expected || expected.some((m) => mimeIs(mimeType, m));
}

export function getExpectedMimeTypes(extension: string): string[] {
	return [...(MIME_TYPE_MAP[extension.toLowerCase()] ?? [])];
}

export function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 Bytes";
	const sizes = ["Bytes", "KB", "MB", "GB"];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
	return `${Number.parseFloat((bytes / 1024 ** i).toFixed(2))} ${sizes[i]}`;
}

/**
 * Checks extension, MIME type, extension/MIME agreement (against spoofing) and size, in that
 * order; the first failure wins.
 */
export function validateFileUpload(
	fileName: string,
	mimeType: string,
	sizeBytes: number,
	constraints: FileConstraints,
): ValidationResult {
	const extension = getFileExtension(fileName);
	const { allowedExtensions, allowedMimeTypes, maxSizeMb } = constraints;

	if (allowedExtensions?.length && !allowedExtensions.some((e) => e.toLowerCase() === extension))
		return {
			valid: false,
			error: `File type "${extension}" is not allowed. Allowed types: ${allowedExtensions.join(", ")}`,
			errorCode: "INVALID_EXTENSION",
		};

	if (allowedMimeTypes?.length && !allowedMimeTypes.some((m) => mimeIs(mimeType, m)))
		return {
			valid: false,
			error: `MIME type "${mimeType}" is not allowed. Allowed types: ${allowedMimeTypes.join(", ")}`,
			errorCode: "INVALID_MIME_TYPE",
		};

	if (extension && !mimeTypeMatchesExtension(mimeType, extension))
		return {
			valid: false,
			error: `MIME type "${mimeType}" does not match file extension ".${extension}". Expected: ${getExpectedMimeTypes(extension).join(" or ")}`,
			errorCode: "INVALID_MIME_TYPE",
		};

	if (maxSizeMb !== undefined && sizeBytes > maxSizeMb * 1024 * 1024)
		return {
			valid: false,
			error: `File size (${formatBytes(sizeBytes)}) exceeds maximum allowed size (${maxSizeMb}MB)`,
			errorCode: "FILE_TOO_LARGE",
		};

	const minSize = constraints.minSizeBytes ?? 1;
	if (sizeBytes < minSize)
		return {
			valid: false,
			error: `File is too small (${formatBytes(sizeBytes)}). Minimum size: ${formatBytes(minSize)}`,
			errorCode: "FILE_TOO_SMALL",
		};

	return { valid: true };
}

/** Constraints from a list of allowed extensions (their MIME types are derived) and a size cap. */
export function buildConstraintsFromRequirement(requirement: {
	allowedFileTypes?: string[] | null;
	maxFileSizeMb?: number | null;
}): FileConstraints {
	const constraints: FileConstraints = {};
	const types = requirement.allowedFileTypes;
	if (types?.length) {
		constraints.allowedExtensions = types;
		const mimes = types.flatMap((ext) => getExpectedMimeTypes(ext));
		if (mimes.length) constraints.allowedMimeTypes = mimes;
	}
	if (requirement.maxFileSizeMb) constraints.maxSizeMb = requirement.maxFileSizeMb;
	return constraints;
}

/** Pictures a browser can show inline and can never run. No SVG: it can carry script. */
export const INLINE_IMAGE_MIME_TYPES: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
];

/**
 * A `Content-Disposition` for a file served through a signed link: safe images and audio open
 * in place, anything else downloads, so a document never renders as a page on the storage
 * domain. The name is given as an ASCII fallback and as UTF-8 (`filename*`).
 */
export function contentDispositionFor(fileName: string, mimeType: string): string {
	const inline = INLINE_IMAGE_MIME_TYPES.includes(mimeType) || mimeType.startsWith("audio/");
	const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
	const encoded = encodeURIComponent(fileName).replace(
		/['()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
