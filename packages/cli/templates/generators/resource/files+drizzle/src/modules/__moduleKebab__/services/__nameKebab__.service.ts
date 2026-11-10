import { count, desc, eq } from "drizzle-orm";
import { db, type Executor } from "#core/db/client";
import { newId } from "@tatara/db";
import { NotFoundError } from "@tatara/http";
import type { PaginationQuery } from "@tatara/http";
import { __namePluralCamel__ } from "#modules/__moduleKebab__/db/__nameKebab__.schema";
import type {
	Create__namePascal__Input,
	__namePascal__,
	Update__namePascal__Input,
} from "#modules/__moduleKebab__/validators/__nameKebab__.validators";

type Row = typeof __namePluralCamel__.$inferSelect;

function to__namePascal__(row: Row): __namePascal__ {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export async function list__namePluralPascal__(
	{ page, pageSize }: PaginationQuery,
	executor: Executor = db,
) {
	const [rows, totals] = await Promise.all([
		executor
			.select()
			.from(__namePluralCamel__)
			.orderBy(desc(__namePluralCamel__.id))
			.limit(pageSize)
			.offset((page - 1) * pageSize),
		executor.select({ total: count() }).from(__namePluralCamel__),
	]);
	return { items: rows.map(to__namePascal__), total: totals[0]?.total ?? 0 };
}

export async function get__namePascal__(id: string, executor: Executor = db): Promise<__namePascal__> {
	const [row] = await executor
		.select()
		.from(__namePluralCamel__)
		.where(eq(__namePluralCamel__.id, id))
		.limit(1);
	if (!row) throw new NotFoundError("__nameTitle__ not found");
	return to__namePascal__(row);
}

export async function create__namePascal__(
	input: Create__namePascal__Input,
	executor: Executor = db,
): Promise<__namePascal__> {
	const id = newId();
	await executor
		.insert(__namePluralCamel__)
		.values({ id, name: input.name, description: input.description ?? null });
	return get__namePascal__(id, executor);
}

export async function update__namePascal__(
	id: string,
	input: Update__namePascal__Input,
	executor: Executor = db,
): Promise<__namePascal__> {
	await get__namePascal__(id, executor);
	await executor
		.update(__namePluralCamel__)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(__namePluralCamel__.id, id));
	return get__namePascal__(id, executor);
}

export async function remove__namePascal__(id: string, executor: Executor = db): Promise<void> {
	await get__namePascal__(id, executor);
	await executor.delete(__namePluralCamel__).where(eq(__namePluralCamel__.id, id));
}
