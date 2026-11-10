import { and, count, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Channel } from "./define.ts";
import type { NotificationRow, NotificationStore } from "./store.ts";

/** The app's tables (src/modules/notifications/db/notifications.schema.ts), Postgres or MySQL. */
export interface DrizzleNotificationTables {
	// biome-ignore lint/suspicious/noExplicitAny: the same queries run on pg and mysql tables
	notifications: any;
	// biome-ignore lint/suspicious/noExplicitAny: as above
	pushTokens: any;
}

const COLUMN = {
	"in-app": "sentInApp",
	email: "sentEmail",
	sms: "sentSms",
	push: "sentPush",
} as const satisfies Record<Channel, string>;

/** at-least-once channels that went out; `sent*` then means taken or pending */
const DELIVERED = {
	"in-app": "deliveredInApp",
	email: "deliveredEmail",
	sms: "deliveredSms",
	push: "deliveredPush",
} as const satisfies Record<Channel, string>;

/** Rows an update changed: node-postgres says rowCount, mysql2 affectedRows. */
const changed = (result: unknown): number => {
	const r = result as { rowCount?: number; affectedRows?: number } & {
		0?: { affectedRows?: number };
	};
	return r.rowCount ?? r.affectedRows ?? r[0]?.affectedRows ?? 0;
};

/** The NotificationStore for Drizzle, over the app's database and its notification tables. */
export function drizzleNotificationStore(
	// biome-ignore lint/suspicious/noExplicitAny: a pg or mysql drizzle database
	db: any,
	tables: DrizzleNotificationTables,
): NotificationStore {
	const { notifications: n, pushTokens: p } = tables;
	// tables from before keys and at-least-once lack these columns; they're needed only when used
	const missing = (column: string, use: string) =>
		new Error(`The notifications table has no ${column} column, which ${use} needs`);
	const delivered = (channel: Channel) => {
		const column = DELIVERED[channel];
		if (!n[column]) throw missing(column, "at-least-once delivery");
		return column;
	};
	const inbox = (orgId: string, userId: string) =>
		and(eq(n.orgId, orgId), eq(n.userId, userId), eq(n.inApp, true));
	return {
		async claim(row) {
			const find = async () =>
				(await db.select({ id: n.id }).from(n).where(eq(n.idempotencyKey, row.idempotencyKey)))[0];
			const found = await find();
			if (found) return { id: found.id };
			const keys = row.inApp
				? {
						titleKey: row.inApp.titleKey ?? null,
						bodyKey: row.inApp.bodyKey ?? null,
						params: row.inApp.params ?? null,
					}
				: null;
			if (keys && !n.titleKey && (keys.titleKey || keys.bodyKey || keys.params))
				throw missing("titleKey", "a notification with keys");
			try {
				await db.insert(n).values({
					id: row.id,
					orgId: row.orgId,
					userId: row.userId,
					name: row.name,
					title: row.inApp?.title ?? "",
					body: row.inApp?.body ?? null,
					url: row.inApp?.url ?? null,
					...(keys && n.titleKey ? keys : {}),
					inApp: row.inApp !== null,
					idempotencyKey: row.idempotencyKey,
				});
				return { id: row.id };
			} catch (error) {
				// a concurrent delivery of the same job inserted it first
				const raced = await find();
				if (raced) return { id: raced.id };
				throw error;
			}
		},
		// a conditional update on the channel's column: the database decides who took it
		async claimChannel(id, channel) {
			const column = COLUMN[channel];
			const result = await db
				.update(n)
				.set({ [column]: true })
				.where(and(eq(n.id, id), eq(n[column], false)));
			return changed(result) === 1;
		},
		async releaseChannel(id, channel) {
			await db
				.update(n)
				.set({ [COLUMN[channel]]: false })
				.where(eq(n.id, id));
		},
		async claimPending(id, channel) {
			const column = delivered(channel);
			await db
				.update(n)
				.set({ [COLUMN[channel]]: true })
				.where(eq(n.id, id));
			const [row] = await db.select({ done: n[column] }).from(n).where(eq(n.id, id));
			return row !== undefined && !row.done;
		},
		async markSent(id, channel) {
			await db
				.update(n)
				.set({ [delivered(channel)]: true })
				.where(eq(n.id, id));
		},
		async list(orgId, userId, { limit, before, unreadOnly }) {
			const rows = await db
				.select()
				.from(n)
				.where(
					and(
						inbox(orgId, userId),
						unreadOnly ? isNull(n.readAt) : undefined,
						before
							? or(
									lt(n.createdAt, before.createdAt),
									and(eq(n.createdAt, before.createdAt), lt(n.id, before.id)),
								)
							: undefined,
					),
				)
				.orderBy(desc(n.createdAt), desc(n.id))
				.limit(limit);
			return rows.map(
				(r: NotificationRow): NotificationRow => ({
					id: r.id,
					orgId: r.orgId,
					userId: r.userId,
					name: r.name,
					title: r.title,
					body: r.body,
					url: r.url,
					titleKey: r.titleKey ?? null,
					bodyKey: r.bodyKey ?? null,
					params: r.params ?? null,
					readAt: r.readAt,
					createdAt: r.createdAt,
				}),
			);
		},
		async unreadCount(orgId, userId) {
			const [row] = await db
				.select({ total: count() })
				.from(n)
				.where(and(inbox(orgId, userId), isNull(n.readAt)));
			return Number(row?.total ?? 0);
		},
		async markRead(orgId, userId, ids) {
			if (ids !== "all" && ids.length === 0) return 0;
			const where = and(
				inbox(orgId, userId),
				isNull(n.readAt),
				ids === "all" ? undefined : inArray(n.id, [...ids]),
			);
			const [row] = await db.select({ total: count() }).from(n).where(where);
			await db.update(n).set({ readAt: new Date() }).where(where);
			return Number(row?.total ?? 0);
		},
		async pushTokens(userId) {
			return (await db.select({ token: p.token }).from(p).where(eq(p.userId, userId))).map(
				(r: { token: string }) => r.token,
			);
		},
		async addPushToken(userId, token, device) {
			// a token moves to whoever signed in on the device last
			const update = () =>
				db.update(p).set({ userId, device, lastSeenAt: new Date() }).where(eq(p.token, token));
			if (changed(await update()) === 1) return;
			try {
				await db.insert(p).values({ token, userId, device, lastSeenAt: new Date() });
			} catch (error) {
				// registered at the same moment by another request
				if (changed(await update()) !== 1) throw error;
			}
		},
		async removePushTokens(tokens) {
			if (tokens.length) await db.delete(p).where(inArray(p.token, [...tokens]));
		},
	};
}
