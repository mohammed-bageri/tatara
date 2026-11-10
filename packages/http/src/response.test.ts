import { z } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createPagination } from "./response.ts";

describe("createPagination: navigation types", () => {
	it("requires hasNext and hasPrev in both schema and types when navigation is true", () => {
		const pagination = createPagination({ navigation: true });

		// runtime test: the schema requires hasNext and hasPrev
		const validMeta = {
			page: 1,
			pageSize: 20,
			total: 100,
			totalPages: 5,
			hasNext: true,
			hasPrev: false,
		};
		expect(() => pagination.metaSchema.parse(validMeta)).not.toThrow();

		const missingHasNext = {
			page: 1,
			pageSize: 20,
			total: 100,
			totalPages: 5,
			hasPrev: false,
		};
		expect(() => pagination.metaSchema.parse(missingHasNext)).toThrow();

		// type test: meta() return type includes required hasNext and hasPrev
		const meta = pagination.meta(1, 20, 100);
		// These should not be optional - accessing them should not require optional chaining
		const hasNext: boolean = meta.hasNext;
		const hasPrev: boolean = meta.hasPrev;
		expect(typeof hasNext).toBe("boolean");
		expect(typeof hasPrev).toBe("boolean");

		// type test: paginated() return type includes required hasNext and hasPrev
		const result = pagination.paginated([1, 2, 3], { page: 1, pageSize: 20, total: 100 });
		const resultHasNext: boolean = result.meta.hasNext;
		const resultHasPrev: boolean = result.meta.hasPrev;
		expect(typeof resultHasNext).toBe("boolean");
		expect(typeof resultHasPrev).toBe("boolean");
	});

	it("excludes hasNext and hasPrev when navigation is false or omitted", () => {
		const pagination = createPagination();

		// runtime test: the schema does not include hasNext or hasPrev
		const validMeta = {
			page: 1,
			pageSize: 20,
			total: 100,
			totalPages: 5,
		};
		expect(() => pagination.metaSchema.parse(validMeta)).not.toThrow();

		const withNavigation = {
			page: 1,
			pageSize: 20,
			total: 100,
			totalPages: 5,
			hasNext: true,
			hasPrev: false,
		};
		// The schema should not accept hasNext/hasPrev when navigation is false
		const parsed = pagination.metaSchema.parse(withNavigation);
		// zod strips unknown keys by default, so the parsed result won't have hasNext/hasPrev
		expect("hasNext" in parsed).toBe(false);
		expect("hasPrev" in parsed).toBe(false);

		// type test: meta() return type does not include hasNext and hasPrev as properties
		const meta = pagination.meta(1, 20, 100);
		expect("hasNext" in meta).toBe(false);
		expect("hasPrev" in meta).toBe(false);
	});

	it("computes hasNext and hasPrev correctly", () => {
		const pagination = createPagination({ navigation: true });

		// first page
		const first = pagination.meta(1, 20, 100);
		expect(first.hasNext).toBe(true);
		expect(first.hasPrev).toBe(false);

		// middle page
		const middle = pagination.meta(3, 20, 100);
		expect(middle.hasNext).toBe(true);
		expect(middle.hasPrev).toBe(true);

		// last page
		const last = pagination.meta(5, 20, 100);
		expect(last.hasNext).toBe(false);
		expect(last.hasPrev).toBe(true);

		// single page
		const single = pagination.meta(1, 20, 10);
		expect(single.hasNext).toBe(false);
		expect(single.hasPrev).toBe(false);
	});

	it("works with custom sizeKey and navigation", () => {
		const pagination = createPagination({ sizeKey: "limit", navigation: true });

		const meta = pagination.meta(2, 50, 200);
		expect(meta.page).toBe(2);
		expect(meta.limit).toBe(50);
		expect(meta.total).toBe(200);
		expect(meta.totalPages).toBe(4);
		expect(meta.hasNext).toBe(true);
		expect(meta.hasPrev).toBe(true);

		const result = pagination.paginated([1, 2, 3], { page: 2, limit: 50, total: 200 });
		expect(result.meta.limit).toBe(50);
		expect(result.meta.hasNext).toBe(true);
		expect(result.meta.hasPrev).toBe(true);
	});
});
