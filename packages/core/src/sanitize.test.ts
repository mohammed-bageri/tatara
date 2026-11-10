import { describe, expect, it } from "vitest";
import { z } from "zod";
import { safeUrl, url } from "./sanitize.ts";

describe("safeUrl options", () => {
	it("takes other schemes, and nothing for null or blank", () => {
		const protocols = ["http:", "https:", "mailto:", "tel:"];
		expect(safeUrl("mailto:user@example.com", { protocols })).toBe("mailto:user@example.com");
		expect(safeUrl("tel:+966500000000", { protocols })).toBe("tel:+966500000000");
		expect(safeUrl("mailto:user@example.com")).toBeNull();
		expect(safeUrl(null)).toBeNull();
		expect(safeUrl(undefined)).toBeNull();
		expect(safeUrl("   ")).toBeNull();
	});

	it("puts the default scheme in front of a bare host, never in front of another scheme", () => {
		const options = { defaultProtocol: "https:" };
		expect(safeUrl("example.com", options)).toBe("https://example.com/");
		expect(safeUrl(" maps.app.goo.gl/abc ", options)).toBe("https://maps.app.goo.gl/abc");
		expect(safeUrl("https://example.com/path", options)).toBe("https://example.com/path");
		expect(safeUrl("javascript:alert(1)", options)).toBeNull();
		expect(safeUrl("javascript:alert(document.cookie)", options)).toBeNull();
		expect(safeUrl("data:text/html,<h1>hi</h1>", options)).toBeNull();
		expect(safeUrl("ftp://files.example.com", options)).toBeNull();
		expect(safeUrl("not a url.com", options)).toBeNull();
		expect(safeUrl("localhost", options)).toBeNull();
		expect(safeUrl("example.com")).toBeNull();
	});

	it("passes the options through the zod field", () => {
		expect(url({ defaultProtocol: "https:" }).parse("example.com")).toBe("https://example.com/");
		expect(z.object({ site: url(["https:"]) }).safeParse({ site: "http://x.dev" }).success).toBe(
			false,
		);
	});
});
