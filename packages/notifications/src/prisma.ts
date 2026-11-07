import type { Channel } from "./define.ts";
import type { NotificationRow, NotificationStore } from "./store.ts";

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

type NotificationRecord = NotificationRow & Partial<Record<(typeof DELIVERED)[Channel], boolean>>;

/** The two delegates the store uses, as Prisma generates them from the app's models. */
export interface PrismaNotificationClient {
	notification: {
		findUnique(args: unknown): Promise<NotificationRecord | null>;
		findMany(args: unknown): Promise<NotificationRecord[]>;
		create(args: unknown): Promise<unknown>;
		update(args: unknown): Promise<unknown>;
		updateMany(args: unknown): Promise<{ count: number }>;
		count(args: unknown): Promise<number>;
	};
	pushToken: {
		findMany(args: unknown): Promise<{ token: string }[]>;
		upsert(args: unknown): Promise<unknown>;
		deleteMany(args: unknown): Promise<unknown>;
	};
}

const KNOWN = ["P2002"];

/** The NotificationStore for Prisma (models Notification and PushToken in prisma/models/notifications.prisma). */
export function prismaNotificationStore(client: unknown): NotificationStore {
	const db = client as PrismaNotificationClient;
	const inbox = (orgId: string, userId: string) => ({ orgId, userId, inApp: true });
	return {
		async claim(row) {
			const find = () =>
				db.notification.findUnique({ where: { idempotencyKey: row.idempotencyKey } });
			const found = await find();
			if (found) return { id: found.id };
			try {
				await db.notification.create({
					data: {
						id: row.id,
						orgId: row.orgId,
						userId: row.userId,
						name: row.name,
						title: row.inApp?.title ?? "",
						body: row.inApp?.body ?? null,
						url: row.inApp?.url ?? null,
						// only when given, so a model from before keys still takes text notifications
						...(row.inApp?.titleKey ? { titleKey: row.inApp.titleKey } : {}),
						...(row.inApp?.bodyKey ? { bodyKey: row.inApp.bodyKey } : {}),
						...(row.inApp?.params ? { params: row.inApp.params } : {}),
						inApp: row.inApp !== null,
						idempotencyKey: row.idempotencyKey,
					},
				});
				return { id: row.id };
			} catch (error) {
				// a concurrent delivery of the same job inserted it first
				if (!KNOWN.includes((error as { code?: string }).code ?? "")) throw error;
				const raced = await find();
				if (!raced) throw error;
				return { id: raced.id };
			}
		},
		// a conditional update on the channel's column: the database decides who took it
		async claimChannel(id, channel) {
			const column = COLUMN[channel];
			const { count } = await db.notification.updateMany({
				where: { id, [column]: false },
				data: { [column]: true },
			});
			return count === 1;
		},
		async releaseChannel(id, channel) {
			await db.notification.updateMany({ where: { id }, data: { [COLUMN[channel]]: false } });
		},
		async claimPending(id, channel) {
			await db.notification.updateMany({ where: { id }, data: { [COLUMN[channel]]: true } });
			const row = await db.notification.findUnique({
				where: { id },
				select: { [DELIVERED[channel]]: true },
			});
			return row !== null && !row[DELIVERED[channel]];
		},
		async markSent(id, channel) {
			await db.notification.updateMany({ where: { id }, data: { [DELIVERED[channel]]: true } });
		},
		async list(orgId, userId, { limit, before, unreadOnly }) {
			const rows = await db.notification.findMany({
				where: {
					...inbox(orgId, userId),
					...(unreadOnly ? { readAt: null } : {}),
					...(before
						? {
								OR: [
									{ createdAt: { lt: before.createdAt } },
									{ createdAt: before.createdAt, id: { lt: before.id } },
								],
							}
						: {}),
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: limit,
			});
			return rows.map((r) => ({
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
			}));
		},
		unreadCount(orgId, userId) {
			return db.notification.count({ where: { ...inbox(orgId, userId), readAt: null } });
		},
		async markRead(orgId, userId, ids) {
			if (ids !== "all" && ids.length === 0) return 0;
			const { count } = await db.notification.updateMany({
				where: {
					...inbox(orgId, userId),
					readAt: null,
					...(ids === "all" ? {} : { id: { in: [...ids] } }),
				},
				data: { readAt: new Date() },
			});
			return count;
		},
		async pushTokens(userId) {
			return (await db.pushToken.findMany({ where: { userId }, select: { token: true } })).map(
				(r) => r.token,
			);
		},
		async addPushToken(userId, token, device) {
			// a token moves to whoever signed in on the device last
			await db.pushToken.upsert({
				where: { token },
				create: { token, userId, device, lastSeenAt: new Date() },
				update: { userId, device, lastSeenAt: new Date() },
			});
		},
		async removePushTokens(tokens) {
			if (tokens.length) await db.pushToken.deleteMany({ where: { token: { in: [...tokens] } } });
		},
	};
}
