import type { Channel } from "./define.ts";
import type { NotificationRow, NotificationStore } from "./store.ts";

/** `sent`: channels taken (or pending, at-least-once); `delivered`: at-least-once channels that went out */
type Row = NotificationRow & { key: string; inApp: boolean; sent: Channel[]; delivered: Channel[] };

/** An in-process store for tests. */
export function memoryNotificationStore(): NotificationStore & {
	rows: Row[];
} {
	const rows: Row[] = [];
	const tokens = new Map<string, { userId: string; device: string | null }>();
	const mine = (orgId: string, userId: string) =>
		rows.filter((r) => r.orgId === orgId && r.userId === userId && r.inApp);
	return {
		rows,
		async claim(row) {
			const found = rows.find((r) => r.key === row.idempotencyKey);
			if (found) return { id: found.id };
			rows.push({
				id: row.id,
				orgId: row.orgId,
				userId: row.userId,
				name: row.name,
				title: row.inApp?.title ?? "",
				body: row.inApp?.body ?? null,
				url: row.inApp?.url ?? null,
				titleKey: row.inApp?.titleKey ?? null,
				bodyKey: row.inApp?.bodyKey ?? null,
				params: row.inApp?.params ?? null,
				readAt: null,
				createdAt: new Date(),
				key: row.idempotencyKey,
				inApp: row.inApp !== null,
				sent: [],
				delivered: [],
			});
			return { id: row.id };
		},
		async claimChannel(id, channel) {
			const row = rows.find((r) => r.id === id);
			if (!row || row.sent.includes(channel)) return false;
			row.sent.push(channel);
			return true;
		},
		async releaseChannel(id, channel) {
			const row = rows.find((r) => r.id === id);
			if (row) row.sent = row.sent.filter((c) => c !== channel);
		},
		async claimPending(id, channel) {
			const row = rows.find((r) => r.id === id);
			if (!row || row.delivered.includes(channel)) return false;
			if (!row.sent.includes(channel)) row.sent.push(channel);
			return true;
		},
		async markSent(id, channel) {
			const row = rows.find((r) => r.id === id);
			if (row && !row.delivered.includes(channel)) row.delivered.push(channel);
		},
		async list(orgId, userId, { limit, before, unreadOnly }) {
			return mine(orgId, userId)
				.filter((r) => !unreadOnly || r.readAt === null)
				.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
				.filter(
					(r) =>
						!before ||
						r.createdAt < before.createdAt ||
						(r.createdAt.getTime() === before.createdAt.getTime() && r.id < before.id),
				)
				.slice(0, limit);
		},
		async unreadCount(orgId, userId) {
			return mine(orgId, userId).filter((r) => r.readAt === null).length;
		},
		async markRead(orgId, userId, ids) {
			let count = 0;
			for (const row of mine(orgId, userId))
				if (row.readAt === null && (ids === "all" || ids.includes(row.id))) {
					row.readAt = new Date();
					count++;
				}
			return count;
		},
		async pushTokens(userId) {
			return [...tokens].filter(([, t]) => t.userId === userId).map(([token]) => token);
		},
		async addPushToken(userId, token, device) {
			tokens.set(token, { userId, device });
		},
		async removePushTokens(list) {
			for (const token of list) tokens.delete(token);
		},
	};
}
