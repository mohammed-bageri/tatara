import { describe, expect, it } from "vitest";
import { createEncryption, isSealed, parseKeyRing, validateKeyRing } from "./crypto.ts";

const LEGACY = Buffer.alloc(32, 1).toString("base64");
const K1 = Buffer.alloc(32, 2).toString("base64");
const K2 = Buffer.alloc(32, 3).toString("base64");
const WRONG_LEN = Buffer.alloc(16).toString("base64"); // 16 bytes instead of 32

// the strict ids and setting names an app's env validation may use
const check = (keys: string | undefined, active: string | undefined) =>
	validateKeyRing(keys, active, {
		idPattern: /^[a-z0-9]{1,16}$/,
		keysName: "APP_ENCRYPTION_KEYS",
		activeName: "APP_ENCRYPTION_ACTIVE_KEY",
	});

/** What WebCrypto AES-GCM code stores: `<base64 iv>:<base64 ciphertext+tag>`. */
async function webCryptoSeal(base64Key: string, plaintext: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		Buffer.from(base64Key, "base64"),
		{ name: "AES-GCM" },
		false,
		["encrypt"],
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const body = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(plaintext),
	);
	return `${Buffer.from(iv).toString("base64")}:${Buffer.from(body).toString("base64")}`;
}

describe("colon format", () => {
	it("seals with the legacy key, unlabelled, when there is no ring", () => {
		const e = createEncryption("", { format: "colon", legacyKey: LEGACY });
		const sealed = e.encrypt("secret");
		expect(sealed.split(":")).toHaveLength(2);
		expect(e.decrypt(sealed)).toBe("secret");
	});

	it("seals with the active ring key and labels it with the key id", () => {
		const e = createEncryption(`a1:${K1},b2:${K2}`, { format: "colon", active: "b2" });
		const sealed = e.encrypt("secret");
		expect(sealed.startsWith("kb2:")).toBe(true);
		expect(sealed.split(":")).toHaveLength(3);
		expect(e.decrypt(sealed)).toBe("secret");
	});

	it("still decrypts legacy values and older ring keys after rotation", () => {
		const legacy = createEncryption("", { format: "colon", legacyKey: LEGACY }).encrypt("old");
		const byA1 = createEncryption(`a1:${K1}`, { format: "colon", active: "a1" }).encrypt("mid");
		const rotated = createEncryption(`a1:${K1},b2:${K2}`, {
			format: "colon",
			active: "b2",
			legacyKey: LEGACY,
		});
		expect(rotated.decrypt(legacy)).toBe("old");
		expect(rotated.decrypt(byA1)).toBe("mid");
	});

	it("reads values WebCrypto sealed, with or without a key label", async () => {
		const e = createEncryption(`a1:${K1}`, { format: "colon", legacyKey: LEGACY });
		expect(e.decrypt(await webCryptoSeal(LEGACY, "from webcrypto"))).toBe("from webcrypto");
		expect(e.decrypt(`ka1:${await webCryptoSeal(K1, "labelled")}`)).toBe("labelled");
	});

	it("rejects unknown key ids, malformed and tampered values and a misconfigured ring", () => {
		const sealed = createEncryption(`zz:${K1}`, { format: "colon" }).encrypt("x");
		const other = createEncryption(`a1:${K2}`, { format: "colon" });
		expect(() => other.decrypt(sealed)).toThrow(/unknown format or key/);
		expect(() => other.decrypt("nope")).toThrow(/unknown format or key/);
		// no legacy key configured: unlabelled values can't be read
		expect(() => other.decrypt(other.encrypt("x").slice(4))).toThrow(/unknown format or key/);
		const [label, iv, body] = sealed.split(":") as [string, string, string];
		const flipped = Buffer.from(body, "base64");
		flipped[0] = (flipped[0] as number) ^ 1;
		const zz = createEncryption(`zz:${K1}`, { format: "colon" });
		expect(() => zz.decrypt(`${label}:${iv}:${flipped.toString("base64")}`)).toThrow();
		expect(() => createEncryption(`a1:${K1}`, { format: "colon", active: "b2" })).toThrow(
			/active encryption key/,
		);
		expect(() => createEncryption("", { format: "colon" })).toThrow(/No encryption key/);
		expect(() => createEncryption(`a1:${K1}`, { legacyKey: LEGACY })).toThrow(/colon format/);
		expect(() => createEncryption("", { format: "colon", legacyKey: WRONG_LEN })).toThrow(
			/32 bytes/,
		);
	});
});

describe("enc1 format", () => {
	it("seals with a chosen active key, not only the first", () => {
		const e = createEncryption(`a1:${K1},b2:${K2}`, { active: "b2" });
		const sealed = e.encrypt("secret");
		expect(sealed).toMatch(/^enc1\.b2\./);
		expect(createEncryption(`b2:${K2}`).decrypt(sealed)).toBe("secret");
	});
});

describe("isSealed", () => {
	it("recognises both sealed shapes and refuses plain tokens", () => {
		const colon = createEncryption(`a1:${K1}`, { format: "colon", legacyKey: LEGACY });
		expect(isSealed(colon.encrypt("abc"), "colon")).toBe(true);
		expect(
			isSealed(
				createEncryption("", { format: "colon", legacyKey: LEGACY }).encrypt("abc"),
				"colon",
			),
		).toBe(true);
		expect(isSealed(createEncryption(`a1:${K1}`).encrypt("abc"))).toBe(true);
		expect(isSealed(crypto.randomUUID().replace(/-/g, ""), "colon")).toBe(false);
		expect(isSealed("", "colon")).toBe(false);
		expect(isSealed("a:b:c", "colon")).toBe(false);
		expect(isSealed("plain")).toBe(false);
	});
});

describe("parseKeyRing", () => {
	it("maps ids to 32-byte keys in order, and refuses bad entries without echoing keys", () => {
		const ring = parseKeyRing(` a1:${K1} , b2:${K2},`);
		expect([...ring.keys()]).toEqual(["a1", "b2"]);
		expect(ring.get("a1")?.length).toBe(32);
		expect(parseKeyRing(undefined).size).toBe(0);
		expect(() => parseKeyRing(`A1:${K1}`, { idPattern: /^[a-z0-9]{1,16}$/ })).toThrow(/id:base64/);
		expect(() => parseKeyRing(`a1:${WRONG_LEN}`)).toThrow(/32 bytes/);
		expect(() => parseKeyRing(`a1:${K1},a1:${K2}`)).toThrow(/twice/);
		try {
			parseKeyRing(`a1:${WRONG_LEN}`);
		} catch (error) {
			expect(String(error)).not.toContain(WRONG_LEN);
		}
	});
});

describe("validateKeyRing", () => {
	it("accepts a valid ring", () => {
		const problems = check(`a1:${K1},b2:${K2}`, "b2");
		expect(problems).toEqual([]);
	});

	it("accepts undefined/empty ring", () => {
		expect(check(undefined, undefined)).toEqual([]);
		expect(check("", undefined)).toEqual([]);
	});

	it("rejects bad key ID format without echoing invalid kid", () => {
		const problems = check(`Bad_ID:${K1}`, "Bad_ID");
		const joined = problems.join();
		// Kid doesn't match regex, so it's not echoed (security: might be swapped key)
		expect(joined).toContain("must match /^[a-z0-9]{1,16}$/");
		expect(joined).toContain("entry 1");
		// Verify the bad kid is NOT echoed (security)
		expect(joined).not.toContain("Bad_ID");
	});

	it("rejects wrong key length", () => {
		const problems = check(`a1:${WRONG_LEN}`, "a1");
		const joined = problems.join();
		// Valid kid format, so we echo it
		expect(joined).toContain("a1");
		expect(joined).toContain("32 bytes");
		expect(joined).toContain("16");
	});

	it("rejects duplicate key IDs", () => {
		const problems = check(`a1:${K1},a1:${K2}`, "a1");
		const joined = problems.join();
		// Valid kid format in duplicate, so we echo it
		expect(joined).toContain("a1");
		expect(joined).toContain("duplicate");
	});

	it("rejects when active key ID is not in the ring (valid format)", () => {
		const problems = check(`a1:${K1}`, "unknown");
		const joined = problems.join();
		// Valid kid format, so we echo it
		expect(joined).toContain("unknown");
		expect(joined).toContain("not found");
	});

	it("rejects when active key ID is a base64 value without echoing it", () => {
		// Simulate mistake: pasted a 32-byte base64 key as activeKid
		const problems = check(`a1:${K1}`, K1);
		const allProblems = problems.join(" ");
		// Must not leak the base64 key value
		expect(allProblems).not.toContain(K1);
		// Should mention it's not a valid key ID
		expect(allProblems).toContain("is not a valid key ID");
	});

	it("rejects malformed entries", () => {
		const problems = check(`no-colon-here`, undefined);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toContain("kid:base64key");
	});

	it("never includes actual key values in error messages", () => {
		const secretKey = "very-secret-base64-key-here";
		const problems = check(`bad_id:${secretKey},a1:${WRONG_LEN}`, "unknown");
		const allProblems = problems.join(" ");
		expect(allProblems).not.toContain(secretKey);
		expect(allProblems).not.toContain(WRONG_LEN);
	});

	it("requires APP_ENCRYPTION_ACTIVE_KEY when ring is set", () => {
		const problems = check(`a1:${K1}`, undefined);
		const joined = problems.join();
		expect(joined).toContain("APP_ENCRYPTION_ACTIVE_KEY is required");
	});

	it("rejects with wrong entry order (key:kid) without leaking the key", () => {
		// Simulate accidentally swapping: put base64 key where kid should go
		const wrongOrder = `${K1}:b2`;
		const problems = check(wrongOrder, "b2");
		const allProblems = problems.join(" ");
		// Must not leak the base64 key
		expect(allProblems).not.toContain(K1);
		// Should mention the problem
		expect(allProblems.length).toBeGreaterThan(0);
	});
});
