import { describe, expect, it } from "vitest";
import { escapeCsvCell, toCsv } from "./csv.ts";

describe("CSV helpers", () => {
	describe("escapeCsvCell", () => {
		it("returns empty string for null/undefined", () => {
			expect(escapeCsvCell(null)).toBe("");
			expect(escapeCsvCell(undefined)).toBe("");
		});

		it("passes through simple strings unchanged", () => {
			expect(escapeCsvCell("hello")).toBe("hello");
			expect(escapeCsvCell("123")).toBe("123");
		});

		it("quotes strings with comma, quote, CR, or LF", () => {
			expect(escapeCsvCell("hello, world")).toBe('"hello, world"');
			expect(escapeCsvCell('Say "hello"')).toBe('"Say ""hello"""');
			expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
			expect(escapeCsvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
		});

		it("handles Arabic text", () => {
			expect(escapeCsvCell("محمد")).toBe("محمد");
			expect(escapeCsvCell("محمد, علي")).toBe('"محمد, علي"');
		});

		it("escapes embedded quotes with double-quotes", () => {
			expect(escapeCsvCell('Ali "Al" Rashid, Jr')).toBe('"Ali ""Al"" Rashid, Jr"');
		});
	});

	describe("toCsv", () => {
		it("produces UTF-8 BOM + header + rows with CRLF", () => {
			const csv = toCsv(
				["id", "name"],
				[
					["1", "Alice"],
					["2", "Bob"],
				],
			);
			expect(csv.startsWith("\uFEFF")).toBe(true);
			expect(csv).toBe("\uFEFFid,name\r\n1,Alice\r\n2,Bob");
		});

		it("handles nulls and empty values", () => {
			const csv = toCsv(
				["a", "b"],
				[
					["x", null],
					[undefined, "y"],
				],
			);
			expect(csv).toBe("\uFEFFa,b\r\nx,\r\n,y");
		});

		it("escapes cells with special characters", () => {
			const csv = toCsv(["name"], [['Ali "Al" Rashid, Jr'], ["محمد"]]);
			expect(csv).toContain('"Ali ""Al"" Rashid, Jr"');
			expect(csv).toContain("محمد");
		});
	});
	describe("options", () => {
		it("leaves out the BOM, and uses another separator and delimiter", () => {
			expect(toCsv(["a", "b"], [["x;y", 1]], { bom: false, eol: "\n", delimiter: ";" })).toBe(
				'a;b\n"x;y";1',
			);
			expect(escapeCsvCell("a;b")).toBe("a;b");
			expect(escapeCsvCell("a;b", ";")).toBe('"a;b"');
		});
	});
});
