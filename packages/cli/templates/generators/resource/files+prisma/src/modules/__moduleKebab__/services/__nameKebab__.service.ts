import { db, type Executor } from "#core/db/client";
import { newId } from "@tatara/db";
import { NotFoundError } from "@tatara/http";
import type { PaginationQuery } from "@tatara/http";
import type {
	Create__namePascal__Input,
	__namePascal__,
	Update__namePascal__Input,
} from "#modules/__moduleKebab__/validators/__nameKebab__.validators";

interface Row {
	id: string;
	name: string;
	description: string | null;
	createdAt: Date;
	updatedAt: Date;
}

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
	const [rows, total] = await Promise.all([
		executor.__nameCamel__.findMany({
			orderBy: { id: "desc" },
			skip: (page - 1) * pageSize,
			take: pageSize,
		}),
		executor.__nameCamel__.count(),
	]);
	return { items: rows.map(to__namePascal__), total };
}

export async function get__namePascal__(id: string, executor: Executor = db): Promise<__namePascal__> {
	const row = await executor.__nameCamel__.findUnique({ where: { id } });
	if (!row) throw new NotFoundError("__nameTitle__ not found");
	return to__namePascal__(row);
}

export async function create__namePascal__(
	input: Create__namePascal__Input,
	executor: Executor = db,
): Promise<__namePascal__> {
	const row = await executor.__nameCamel__.create({
		data: { id: newId(), name: input.name, description: input.description ?? null },
	});
	return to__namePascal__(row);
}

export async function update__namePascal__(
	id: string,
	input: Update__namePascal__Input,
	executor: Executor = db,
): Promise<__namePascal__> {
	await get__namePascal__(id, executor);
	const row = await executor.__nameCamel__.update({ where: { id }, data: input });
	return to__namePascal__(row);
}

export async function remove__namePascal__(id: string, executor: Executor = db): Promise<void> {
	await get__namePascal__(id, executor);
	await executor.__nameCamel__.delete({ where: { id } });
}
