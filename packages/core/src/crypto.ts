import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	randomInt,
	timingSafeEqual,
} from "node:crypto";

/** Ambiguous-free uppercase letters and digits (no 0/O, 1/I/L), for codes people type. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** `length` characters from `alphabet`, each uniformly random (no modulo bias). */
export function randomCode(length: number, alphabet = CODE_ALPHABET): string {
	if (!(Number.isInteger(length) && length > 0)) throw new Error("A code needs a positive length");
	if (alphabet.length < 2) throw new Error("A code alphabet needs at least two characters");
	let out = "";
	for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
	return out;
}

/** A one-time numeric code, e.g. for SMS sign-in. */
export const numericCode = (length = 6) => randomCode(length, "0123456789");

/** An unguessable token for links and API keys (base64url, `bytes` of randomness). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** What to store to look a token up later without storing the token itself. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");

/** Compares secrets without leaking, through timing, how much of them matched. */
export function safeEqual(a: string, b: string): boolean {
	const x = createHash("sha256").update(a).digest();
	const y = createHash("sha256").update(b).digest();
	return timingSafeEqual(x, y);
}

const KEY_ID = /^[A-Za-z0-9_-]+$/;

export interface KeyRingOptions {
	/** what a key id must look like (default letters, digits, `_` and `-`) */
	idPattern?: RegExp;
}

/**
 * "id:base64key,…" as a map of id → 32-byte key, in the order given. Throws on a malformed entry,
 * a key that isn't 32 bytes or an id listed twice; the messages never include key material.
 */
export function parseKeyRing(
	keys: string | undefined,
	options: KeyRingOptions = {},
): Map<string, Buffer> {
	const idPattern = options.idPattern ?? KEY_ID;
	const ring = new Map<string, Buffer>();
	for (const entry of (keys ?? "").split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const at = trimmed.indexOf(":");
		const id = trimmed.slice(0, at);
		const key = Buffer.from(trimmed.slice(at + 1), "base64");
		if (at < 1 || !idPattern.test(id) || key.length !== 32)
			throw new Error("Encryption keys are id:base64, each key 32 bytes");
		if (ring.has(id)) throw new Error("An encryption key id is listed twice");
		ring.set(id, key);
	}
	return ring;
}

export interface KeyRingCheckOptions extends KeyRingOptions {
	/** how the problems name the keys setting (default "ENCRYPTION_KEYS") */
	keysName?: string;
	/** how the problems name the active-key setting (default "ENCRYPTION_ACTIVE_KEY") */
	activeName?: string;
}

/**
 * Every problem with a key ring setting and the id of its active key, for env validation at boot
 * (empty = fine; no ring at all is fine too). Ids are only echoed when they look like ids, so a
 * key pasted in the wrong place never ends up in a log.
 */
export function validateKeyRing(
	keys: string | undefined,
	active: string | undefined,
	options: KeyRingCheckOptions = {},
): string[] {
	const idPattern = options.idPattern ?? KEY_ID;
	const keysName = options.keysName ?? "ENCRYPTION_KEYS";
	const activeName = options.activeName ?? "ENCRYPTION_ACTIVE_KEY";
	const entries = (keys ?? "")
		.split(",")
		.map((e) => e.trim())
		.filter(Boolean);
	if (entries.length === 0) return [];
	const problems: string[] = [];
	const ids = new Set<string>();
	const shown = (id: string) => (idPattern.test(id) ? ` "${id}"` : "");
	entries.forEach((entry, i) => {
		const n = i + 1;
		const sep = entry.indexOf(":");
		if (sep <= 0) {
			problems.push(`${keysName} entry ${n} is malformed: must be 'kid:base64key'`);
			return;
		}
		const id = entry.slice(0, sep);
		const key = entry.slice(sep + 1);
		if (!idPattern.test(id))
			problems.push(`${keysName} entry ${n}: Key ID must match ${idPattern}`);
		if (!key) {
			problems.push(`${keysName} entry ${n} is malformed: must have a base64 key after the colon`);
			return;
		}
		const bytes = Buffer.from(key, "base64").length;
		if (bytes !== 32)
			problems.push(
				`${keysName} entry ${n}${shown(id)}: key must be 32 bytes (base64), got ${bytes}`,
			);
		if (ids.has(id)) problems.push(`${keysName}${shown(id) || " entry"}: duplicate key ID`);
		ids.add(id);
	});
	if (!active) problems.push(`${activeName} is required when ${keysName} is set`);
	else if (!ids.has(active))
		problems.push(
			idPattern.test(active)
				? `${activeName} "${active}" not found in ${keysName}`
				: `${activeName} is not a valid key ID`,
		);
	return problems;
}

/**
 * How sealed values look. "enc1" (the default): `enc1.<keyId>.<iv>.<ciphertext+tag>` in base64url,
 * the key id authenticated. "colon": `k<keyId>:<iv>:<ciphertext+tag>` in base64, no associated
 * data — what WebCrypto AES-GCM code commonly stores — plus unlabelled `<iv>:<ciphertext+tag>`
 * values sealed with a `legacyKey`.
 */
export type SealFormat = "enc1" | "colon";

export interface EncryptionOptions extends KeyRingOptions {
	/** id of the key new values are sealed with (default the first in the ring) */
	active?: string;
	format?: SealFormat;
	/**
	 * "colon" only: a single base64 32-byte key for unlabelled values. Always readable; new values
	 * are sealed with it only when the ring is empty.
	 */
	legacyKey?: string;
}

export interface Encryption {
	/** AES-256-GCM with the active key, in the configured format */
	encrypt(plaintext: string): string;
	/** decrypts with whichever key it was encrypted with; throws when it was tampered with */
	decrypt(sealed: string): string;
}

const B64 = "[A-Za-z0-9+/]+={0,2}";
const B64URL = "[A-Za-z0-9_-]+";
const SEALED: Record<SealFormat, RegExp> = {
	enc1: new RegExp(`^enc1\\.${B64URL}\\.${B64URL}\\.${B64URL}$`),
	colon: new RegExp(`^(k${B64URL}:)?${B64}:${B64}$`),
};

/** Whether `value` has the shape `encrypt` produces in `format` (it doesn't check any key). */
export function isSealed(value: string, format: SealFormat = "enc1"): boolean {
	return SEALED[format].test(value);
}

function seal(key: Buffer, plaintext: string, aad?: string) {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
	const body = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	return { iv, body };
}

function open(key: Buffer, iv: Buffer, data: Buffer, aad?: string): string {
	if (iv.length === 0 || data.length < 16) throw new Error("Can't decrypt: too short");
	const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
	if (aad !== undefined) decipher.setAAD(Buffer.from(aad));
	decipher.setAuthTag(data.subarray(data.length - 16));
	return Buffer.concat([
		decipher.update(data.subarray(0, data.length - 16)),
		decipher.final(),
	]).toString("utf8");
}

/**
 * Secrets at rest (OAuth tokens, API keys of other services). `keys` is "id:base64key,…", 32-byte
 * keys; the active one (default the first) seals: add a new key and make it active to rotate,
 * keep the old ones to read.
 */
export function createEncryption(keys: string, options: EncryptionOptions = {}): Encryption {
	const format = options.format ?? "enc1";
	const ring = parseKeyRing(keys, options);
	let legacy: Buffer | undefined;
	if (options.legacyKey) {
		if (format !== "colon") throw new Error("A legacy key needs the colon format");
		legacy = Buffer.from(options.legacyKey, "base64");
		if (legacy.length !== 32)
			throw new Error("The legacy encryption key must be 32 bytes (base64)");
	}
	const activeId = options.active ?? ring.keys().next().value;
	const activeKey = activeId === undefined ? undefined : ring.get(activeId);
	if (options.active !== undefined && !activeKey)
		throw new Error("The active encryption key isn't in the key ring");
	if (!activeKey && !legacy) throw new Error("No encryption key");

	if (format === "enc1") {
		return {
			encrypt(plaintext) {
				const id = activeId as string;
				const { iv, body } = seal(activeKey as Buffer, plaintext, id);
				return `enc1.${id}.${iv.toString("base64url")}.${body.toString("base64url")}`;
			},
			decrypt(sealed) {
				const [version, id = "", iv = "", body = ""] = sealed.split(".");
				const key = ring.get(id);
				if (version !== "enc1" || !key) throw new Error("Can't decrypt: unknown format or key");
				return open(key, Buffer.from(iv, "base64url"), Buffer.from(body, "base64url"), id);
			},
		};
	}
	return {
		encrypt(plaintext) {
			const { iv, body } = seal((activeKey ?? legacy) as Buffer, plaintext);
			const prefix = activeKey ? `k${activeId}:` : "";
			return `${prefix}${iv.toString("base64")}:${body.toString("base64")}`;
		},
		decrypt(sealed) {
			const parts = sealed.split(":");
			const labelled = parts.length === 3 && parts[0]?.startsWith("k");
			if (!labelled && parts.length !== 2) throw new Error("Can't decrypt: unknown format or key");
			const key = labelled ? ring.get((parts[0] as string).slice(1)) : legacy;
			if (!key) throw new Error("Can't decrypt: unknown format or key");
			const [iv = "", body = ""] = parts.slice(labelled ? 1 : 0);
			return open(key, Buffer.from(iv, "base64"), Buffer.from(body, "base64"));
		},
	};
}
