import { describe, expect, it } from "vitest";
import {
	organizationIdFromKey,
	publicUrl,
	sanitizeFileName,
	type UploadContextHandlers,
	uploadKeys,
} from "./keys.ts";

describe("sanitizeFileName", () => {
	it("strips separators, NUL bytes and encoded separators", () => {
		expect(sanitizeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
		expect(sanitizeFileName("a%2Fb.pdf")).toBe("a_b.pdf");
		expect(sanitizeFileName("C:\\x\0y.txt")).toBe("C_x_y.txt");
		expect(sanitizeFileName("bad%zz name.pdf")).toBe("bad%zz_name.pdf");
	});

	it("collapses whitespace, trims dots and never returns empty", () => {
		expect(sanitizeFileName("my   cv .pdf.")).toBe("my_cv_.pdf");
		expect(sanitizeFileName(".hidden")).toBe("hidden");
		expect(sanitizeFileName("...")).toBe("unnamed_file");
		expect(sanitizeFileName("سيرة ذاتية.pdf")).toBe("سيرة_ذاتية.pdf");
	});

	it("truncates to 200 characters and keeps the extension", () => {
		const long = sanitizeFileName(`${"a".repeat(300)}.pdf`);
		expect(long).toHaveLength(200);
		expect(long.endsWith(".pdf")).toBe(true);
		expect(sanitizeFileName("b".repeat(300))).toHaveLength(200);
	});
});

type Ctx =
	| { type: "avatar"; userId: string }
	| { type: "general"; category: string }
	| { type: "unhandled" };

describe("uploadKeys", () => {
	const core: UploadContextHandlers<Ctx> = {
		general: (c, { organizationId, timestamp, safeFileName }) =>
			`private/orgs/${organizationId}/uploads/${c.category}/${timestamp}_${safeFileName}`,
	};
	const user: UploadContextHandlers<Ctx> = {
		avatar: (c, { pub, timestamp, safeFileName }) =>
			`${pub}/users/${c.userId}/${timestamp}_${safeFileName}`,
	};

	it("applies the handler for the context type with sanitised name, time and prefix", async () => {
		const keys = uploadKeys<Ctx>({ contexts: [core, user], publicPrefix: "pub", now: () => 7 });
		expect(await keys.generate("o1", { type: "general", category: "docs" }, "my file.pdf")).toBe(
			"private/orgs/o1/uploads/docs/7_my_file.pdf",
		);
		expect(await keys.generate("o1", { type: "avatar", userId: "u1" }, "me.png")).toBe(
			"pub/users/u1/7_me.png",
		);
		expect(keys.publicPrefix).toBe("pub");
	});

	it("loads lazy handler maps once, later maps winning", async () => {
		let loads = 0;
		const keys = uploadKeys<Ctx>({
			contexts: async () => {
				loads += 1;
				return [core, { general: () => "override" }];
			},
		});
		expect(await keys.generate("o", { type: "general", category: "x" }, "f")).toBe("override");
		await keys.generate("o", { type: "general", category: "x" }, "f");
		expect(loads).toBe(1);
	});

	it("throws for a context nobody handles", async () => {
		await expect(
			uploadKeys<Ctx>({ contexts: core }).generate("o", { type: "unhandled" }, "f"),
		).rejects.toThrow(/Unknown upload context type/);
	});
});

describe("publicUrl", () => {
	it("joins the base and key, or gives null without a base", () => {
		expect(publicUrl("http://localhost:9000/bucket/", "public/a.png")).toBe(
			"http://localhost:9000/bucket/public/a.png",
		);
		expect(publicUrl(undefined, "public/a.png")).toBeNull();
		expect(publicUrl("", "public/a.png")).toBeNull();
	});
});

describe("organizationIdFromKey", () => {
	it("reads the org under the private, public or no prefix", () => {
		expect(organizationIdFromKey("private/orgs/o1/a/b")).toBe("o1");
		expect(organizationIdFromKey("public/orgs/o2/a")).toBe("o2");
		expect(organizationIdFromKey("orgs/o3/a")).toBe("o3");
		expect(organizationIdFromKey("cdn/orgs/o4/a", ["private", "cdn"])).toBe("o4");
		expect(organizationIdFromKey("users/u1/a")).toBeNull();
		expect(organizationIdFromKey("other/orgs/o5/a")).toBeNull();
		expect(organizationIdFromKey("/orgs/o6/a", [])).toBeNull();
	});
});
