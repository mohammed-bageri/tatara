import type { Channel, InAppContent, NotificationParams } from "./define.ts";

export interface NotificationRow {
	id: string;
	orgId: string;
	userId: string;
	name: string;
	/** the rendered title, or "" for a key-only notification (see `localizeNotification`) */
	title: string;
	body: string | null;
	url: string | null;
	/** keys and params, translated when read; absent on stores and tables without them */
	titleKey?: string | null;
	bodyKey?: string | null;
	params?: NotificationParams | null;
	readAt: Date | null;
	createdAt: Date;
}

export interface NewNotification {
	id: string;
	orgId: string;
	userId: string;
	name: string;
	/** null when the notification doesn't go in the inbox (email or push only) */
	inApp: InAppContent | null;
	idempotencyKey: string;
}

/** What the notifications table and push tokens need; Drizzle and Prisma stores ship with the package. */
export interface NotificationStore {
	/** The record for this delivery, created on first call and found on every later one. */
	claim(row: NewNotification): Promise<{ id: string }>;
	/** Takes `channel` for sending, atomically: true for exactly one caller until it's released. */
	claimChannel(id: string, channel: Channel): Promise<boolean>;
	/** Gives a channel back after its send failed, so a retry can take it. */
	releaseChannel(id: string, channel: Channel): Promise<void>;
	/**
	 * At-least-once channels: marks `channel` pending unless it was already sent, and says whether
	 * it still has to go out. A pending channel goes out again on the next delivery of the job.
	 */
	claimPending?(id: string, channel: Channel): Promise<boolean>;
	/** At-least-once channels: the channel went out, so no retry sends it again. */
	markSent?(id: string, channel: Channel): Promise<void>;
	/** the user's inbox, newest first; `before` is the last row of the previous page */
	list(
		orgId: string,
		userId: string,
		options: { limit: number; before?: { createdAt: Date; id: string }; unreadOnly?: boolean },
	): Promise<NotificationRow[]>;
	unreadCount(orgId: string, userId: string): Promise<number>;
	/** marks the user's own notifications read: the ids given, or all of them */
	markRead(orgId: string, userId: string, ids: readonly string[] | "all"): Promise<number>;
	pushTokens(userId: string): Promise<string[]>;
	addPushToken(userId: string, token: string, device: string | null): Promise<void>;
	removePushTokens(tokens: readonly string[]): Promise<void>;
}
