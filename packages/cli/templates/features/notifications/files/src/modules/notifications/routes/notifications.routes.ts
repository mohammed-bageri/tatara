import { createRoute, z } from "@hono/zod-openapi";
import { currentPrincipal, requireAuth } from "@tatara/auth";
import {
	cursorPage,
	cursorPageSchema,
	cursorQuerySchema,
	decodeCursor,
	errorResponses,
	jsonBody,
	jsonContent,
	success,
	successSchema,
} from "@tatara/http";
import { localizeNotification } from "@tatara/notifications";
import type { Context } from "hono";
import { createRouter, defineRoutes } from "#core/http/routes";
import { notificationStore as store } from "#modules/notifications/services/store";
import { readerLanguage, translate } from "#modules/notifications/services/translate";
// tatara:slot imports

const guard = [
	requireAuth(),
	// tatara:slot guard
];

/** The org the inbox belongs to; apps without organizations have one, "default". */
function inbox(c: Context) {
	const principal = currentPrincipal(c);
	return { orgId: principal.orgId ?? "default", userId: principal.userId };
}

const notificationSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		title: z.string(),
		body: z.string().nullable(),
		url: z.string().nullable(),
		readAt: z.string().nullable(),
		createdAt: z.string(),
	})
	.openapi("Notification");

const position = z.object({ createdAt: z.iso.datetime(), id: z.string() });
const security = [{ bearerAuth: [] }];
const router = createRouter();

router.openapi(
	createRoute({
		method: "get",
		path: "/",
		tags: ["Notifications"],
		summary: "The caller's notifications, newest first",
		middleware: guard,
		security,
		request: { query: cursorQuerySchema.extend({ unread: z.stringbool().optional() }) },
		responses: {
			200: jsonContent(cursorPageSchema(notificationSchema), "A page of notifications"),
			...errorResponses(400, 401),
		},
	}),
	async (c) => {
		const { cursor, limit, unread } = c.req.valid("query");
		const before = cursor ? decodeCursor(position, cursor) : undefined;
		const rows = await store.list(inbox(c).orgId, inbox(c).userId, {
			limit: limit + 1,
			unreadOnly: unread,
			...(before ? { before: { createdAt: new Date(before.createdAt), id: before.id } } : {}),
		});
		const page = cursorPage(rows, limit, (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }));
		// keys are translated now, in the reader's language, not the one it was sent in
		const language = readerLanguage(c);
		return c.json(
			{
				...page,
				data: page.data.map((row) => {
					const r = localizeNotification(row, language, translate);
					return {
						id: r.id,
						name: r.name,
						title: r.title,
						body: r.body,
						url: r.url,
						readAt: r.readAt?.toISOString() ?? null,
						createdAt: r.createdAt.toISOString(),
					};
				}),
			},
			200,
		);
	},
);

router.openapi(
	createRoute({
		method: "get",
		path: "/unread-count",
		tags: ["Notifications"],
		summary: "How many of the caller's notifications are unread",
		middleware: guard,
		security,
		responses: {
			200: jsonContent(successSchema(z.object({ count: z.number().int() })), "The unread count"),
			...errorResponses(401),
		},
	}),
	async (c) => {
		const { orgId, userId } = inbox(c);
		return c.json(success({ count: await store.unreadCount(orgId, userId) }), 200);
	},
);

router.openapi(
	createRoute({
		method: "post",
		path: "/read",
		tags: ["Notifications"],
		summary: "Mark the caller's notifications read: some, or all",
		middleware: guard,
		security,
		request: {
			body: jsonBody(
				z.union([z.object({ ids: z.array(z.string()).min(1).max(100) }), z.object({ all: z.literal(true) })]),
				"Which to mark read",
			),
		},
		responses: {
			200: jsonContent(successSchema(z.object({ updated: z.number().int() })), "How many changed"),
			...errorResponses(400, 401),
		},
	}),
	async (c) => {
		const body = c.req.valid("json");
		const { orgId, userId } = inbox(c);
		const updated = await store.markRead(orgId, userId, "all" in body ? "all" : body.ids);
		return c.json(success({ updated }), 200);
	},
);

const tokenSchema = z.object({ token: z.string().min(1).max(512), device: z.string().max(255).optional() });

router.openapi(
	createRoute({
		method: "post",
		path: "/push-tokens",
		tags: ["Notifications"],
		summary: "Register this device for push",
		middleware: guard,
		security,
		request: { body: jsonBody(tokenSchema, "The device's FCM token") },
		responses: { 204: { description: "Registered" }, ...errorResponses(400, 401) },
	}),
	async (c) => {
		const { token, device } = c.req.valid("json");
		await store.addPushToken(inbox(c).userId, token, device ?? null);
		return c.body(null, 204);
	},
);

router.openapi(
	createRoute({
		method: "delete",
		path: "/push-tokens",
		tags: ["Notifications"],
		summary: "Stop push to this device (e.g. on sign-out)",
		middleware: guard,
		security,
		request: { body: jsonBody(tokenSchema.pick({ token: true }), "The device's FCM token") },
		responses: { 204: { description: "Removed" }, ...errorResponses(400, 401) },
	}),
	async (c) => {
		const { token } = c.req.valid("json");
		// only the caller's own device
		if ((await store.pushTokens(inbox(c).userId)).includes(token)) await store.removePushTokens([token]);
		return c.body(null, 204);
	},
);

export default defineRoutes({ app: "api", basePath: "/notifications", router });
