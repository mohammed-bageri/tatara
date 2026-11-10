import { describe, expect, it } from "vitest";
import { sanitizeHtml, stripHtml } from "./html.ts";

describe("sanitizeHtml", () => {
	it("keeps formatting and drops anything that runs or loads", () => {
		const dirty =
			'<p onclick="x()">Hi <b>there</b><script>alert(1)</script><iframe src="https://x"></iframe>' +
			'<a href="javascript:alert(1)">bad</a> <a href="https://ok.dev" target="_blank">ok</a></p>' +
			'<img src="https://x/y.png" onerror="z()">';
		const clean = sanitizeHtml(dirty);
		expect(clean).toBe(
			'<p>Hi <b>there</b><a rel="noopener noreferrer">bad</a> <a href="https://ok.dev" target="_blank" rel="noopener noreferrer">ok</a></p>',
		);
	});

	it("keeps images, tables and safe inline styles for email", () => {
		const clean = sanitizeHtml(
			'<table><tr><td style="color: #333; position: fixed; background-image: url(x)">A</td></tr></table>' +
				'<img src="https://cdn.x/logo.png" alt="logo"><img src="http://insecure/x.png">',
			"email",
		);
		expect(clean).toContain('<td style="color:#333">A</td>');
		expect(clean).toContain('<img src="https://cdn.x/logo.png" alt="logo" />');
		expect(clean).not.toContain("insecure");
	});
});

describe("sanitizeHtml options", () => {
	it("returns an empty string for null and undefined", () => {
		expect(sanitizeHtml(null)).toBe("");
		expect(sanitizeHtml(undefined, "email")).toBe("");
	});

	it("adds tags, attributes, styles and schemes to a profile without dropping its guards", () => {
		const options = {
			profile: "email" as const,
			tags: ["font", "sub"],
			attributes: { "*": ["class", "bgcolor"], font: ["color", "face"] },
			styles: { "font-family": [/^[\w\s,"'-]+$/] },
			imageSchemes: ["http", "https"],
		};
		const clean = sanitizeHtml(
			'<font color="red" face="Arial" onclick="x()">Hi</font><sub class="n">2</sub>' +
				'<td bgcolor="#fff" style="font-family: Arial; position: fixed" align="center">A</td>' +
				'<img src="http://cdn/x.png"><script>alert(1)</script><iframe src="https://x"></iframe>',
			options,
		);
		expect(clean).toContain('<font color="red" face="Arial">Hi</font>');
		expect(clean).toContain('<sub class="n">2</sub>');
		expect(clean).toContain('style="font-family:Arial"');
		expect(clean).toContain('bgcolor="#fff"');
		expect(clean).toContain('<img src="http://cdn/x.png" />');
		expect(clean).not.toMatch(/script|iframe|onclick|position/);
	});

	it("keeps the email profile's center and hr, and only formatting in text", () => {
		expect(sanitizeHtml("<center>Hello</center><hr>", "email")).toBe(
			"<center>Hello</center><hr />",
		);
		expect(sanitizeHtml('<div onclick="evil()">text</div>')).toBe("text");
		expect(sanitizeHtml('<img src="x" onerror="alert(1)">')).toBe("");
	});
});

describe("stripHtml", () => {
	it("leaves the text, without tags, script contents or extra whitespace", () => {
		expect(stripHtml("<p>Hello <b>World</b></p>")).toBe("Hello World");
		expect(stripHtml("<script>alert(1)</script>safe text")).toBe("safe text");
		expect(stripHtml("  hello \n\t  world\u200B ")).toBe("hello world");
		expect(stripHtml(null)).toBe("");
		expect(stripHtml(undefined)).toBe("");
	});

	it("decodes entities into plain text", () => {
		expect(stripHtml("Tom &amp; Jerry&nbsp;&quot;&lt;3&quot;")).toBe('Tom & Jerry "<3"');
		expect(stripHtml("&lt;b&gt;not bold&lt;/b&gt;")).toBe("<b>not bold</b>");
		expect(stripHtml("&amp;lt;")).toBe("&lt;");
	});
});
