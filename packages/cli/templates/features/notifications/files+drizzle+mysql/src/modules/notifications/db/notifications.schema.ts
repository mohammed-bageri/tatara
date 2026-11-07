import { boolean, index, json, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

const ts = () => timestamp({ mode: "date", fsp: 3 });

/** One row per user per notification; `in_app` false rows only record what was sent. */
export const notifications = mysqlTable(
	"notifications",
	{
		id: varchar({ length: 36 }).primaryKey(),
		orgId: varchar({ length: 255 }).notNull(),
		userId: varchar({ length: 255 }).notNull(),
		name: varchar({ length: 255 }).notNull(),
		title: text().notNull(),
		body: text(),
		url: text(),
		// keys and params, translated when the inbox is read (title is "" when only keys are given)
		titleKey: varchar({ length: 255 }),
		bodyKey: varchar({ length: 255 }),
		params: json().$type<Record<string, string>>(),
		inApp: boolean().notNull().default(true),
		idempotencyKey: varchar({ length: 255 }).notNull().unique(),
		// each channel is taken once, by a conditional update on its column
		sentInApp: boolean().notNull().default(false),
		sentEmail: boolean().notNull().default(false),
		sentSms: boolean().notNull().default(false),
		sentPush: boolean().notNull().default(false),
		// at-least-once channels: sent* marks them pending, delivered* once they went out
		deliveredInApp: boolean().notNull().default(false),
		deliveredEmail: boolean().notNull().default(false),
		deliveredSms: boolean().notNull().default(false),
		deliveredPush: boolean().notNull().default(false),
		readAt: ts(),
		createdAt: ts().notNull().defaultNow(),
	},
	(t) => [index("notifications_inbox").on(t.orgId, t.userId, t.createdAt)],
);

/** Devices that receive push, by FCM token. */
export const pushTokens = mysqlTable(
	"push_tokens",
	{
		token: varchar({ length: 512 }).primaryKey(),
		userId: varchar({ length: 255 }).notNull(),
		device: varchar({ length: 255 }),
		createdAt: ts().notNull().defaultNow(),
		lastSeenAt: ts().notNull().defaultNow(),
	},
	(t) => [index("push_tokens_user").on(t.userId)],
);
