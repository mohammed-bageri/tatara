import { z } from "@hono/zod-openapi";

export const uuidSchema = z.uuid();

export function isUuid(value: unknown): value is string {
	return uuidSchema.safeParse(value).success;
}

/** Path params that are all UUIDs: `uuidParams("orgId", "id")` → `{ orgId, id }`. */
export function uuidParams<const K extends string>(...names: K[]) {
	return z.object(Object.fromEntries(names.map((n) => [n, z.uuid()])) as { [P in K]: z.ZodUUID });
}

/** `{ id: uuid }` path params. */
export const idParamSchema = uuidParams("id");
