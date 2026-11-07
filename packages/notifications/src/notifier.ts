import { randomUUID } from "node:crypto";
import type { CoreLogger } from "@tatara/core";
import { z } from "zod";
import {
	CHANNELS,
	type Channel,
	type EmailContent,
	type InAppContent,
	type NotificationDefinition,
	type NotificationParams,
	type PushContent,
	type Recipients,
	renderChannel,
	type Translate,
} from "./define.ts";
import { renderInApp } from "./localize.ts";
import type { NotificationStore } from "./store.ts";

/**
 * Passed with every send. `idempotencyKey` is `<notification id>:<channel>:<user id>`, the same on
 * every retry: hand it to a provider that dedupes on one, so an at-least-once resend isn't sent twice.
 */
export interface SendOptions {
	idempotencyKey: string;
}

export interface SmsSender {
	send(to: string, text: string, options?: SendOptions): Promise<void>;
}

export interface PushSender {
	/** sends to each token; returns the tokens the provider says are gone, to forget them */
	send(
		tokens: readonly string[],
		content: PushContent,
		options?: SendOptions,
	): Promise<{ invalidTokens: string[] }>;
}

/**
 * How a channel survives a crash. `at-most-once` (the default) takes the channel before sending:
 * a crash after that never sends it. `at-least-once` records it pending, sends, then marks it sent:
 * a crash in between leaves it pending and the job's next delivery sends it again, with the same
 * idempotency key. The store needs `claimPending` and `markSent` for it.
 */
export type DeliveryMode = "at-most-once" | "at-least-once";

export interface Contact {
	email?: string | null;
	phone?: string | null;
	language?: string | null;
}

/** The job producer the notifier sends through; `jobs.enqueue` from `@tatara/jobs` is one. */
export type Enqueue = (
	topic: string,
	data: unknown,
	options?: { orgId?: string | null; executor?: unknown },
) => Promise<string>;

export interface NotifierOptions {
	// biome-ignore lint/suspicious/noExplicitAny: every notification, whatever its data
	notifications: readonly NotificationDefinition<string, any>[];
	store: NotificationStore;
	enqueue: Enqueue;
	/** user ids in the org with a role or permission (the app resolves these with its auth and authz) */
	recipients: {
		role(orgId: string, role: string): AsyncIterable<string> | Promise<Iterable<string>>;
		permission(
			orgId: string,
			permission: string,
		): AsyncIterable<string> | Promise<Iterable<string>>;
	};
	/** where to reach a user, and in which language */
	contact(userId: string): Promise<Contact | null>;
	email?: { send(message: { to: string } & EmailContent, options?: SendOptions): Promise<void> };
	sms?: SmsSender;
	push?: PushSender;
	/**
	 * After an in-app notification is stored, e.g. to push it to the user's open tabs. `title` and
	 * `body` are in the user's language (keys go through `translate`).
	 */
	onInApp?(row: {
		id: string;
		orgId: string;
		userId: string;
		name: string;
		title: string;
		body?: string;
		url?: string;
		titleKey?: string;
		bodyKey?: string;
		params?: NotificationParams;
		idempotencyKey: string;
	}): Promise<void>;
	/** how stored keys become text, for `onInApp`; the inbox uses `localizeNotification` */
	translate?: Translate;
	/** per channel; every channel is at-most-once unless listed here */
	delivery?: Partial<Record<Channel, DeliveryMode>>;
	/**
	 * The app's say over delivery: return false and this user doesn't get this channel (their
	 * preferences, quiet hours, an unverified address…). Asked once per user and channel.
	 */
	allow?(input: {
		orgId: string;
		userId: string;
		notification: string;
		channel: Channel;
		data: unknown;
	}): boolean | Promise<boolean>;
	defaultLanguage?: string;
	logger: CoreLogger;
}

export const FANOUT_TOPIC = "notifications.fanout" as const;
export const DELIVER_TOPIC = "notifications.deliver" as const;

const recipientsSchema = z.union([
	z.object({ user: z.string().min(1) }),
	z.object({ users: z.array(z.string().min(1)) }),
	z.object({ role: z.string().min(1) }),
	z.object({ permission: z.string().min(1) }),
]);
const channelsSchema = z.array(z.enum(CHANNELS)).min(1);

const fanoutSchema = z.object({
	orgId: z.string().min(1),
	to: recipientsSchema,
	notification: z.string().min(1),
	data: z.unknown(),
	channels: channelsSchema.optional(),
	key: z.string().min(1),
});

const deliverSchema = z.object({
	orgId: z.string().min(1),
	userId: z.string().min(1),
	notification: z.string().min(1),
	data: z.unknown(),
	channels: channelsSchema.optional(),
	key: z.string().min(1),
});

/** A notifications consumer, typed up front so an app's consumer files need no inference. */
export interface NotificationConsumer<T extends string, S extends z.ZodType> {
	topic: T;
	description: string;
	schema: S;
	handle(job: z.infer<S>, ctx: { logger: CoreLogger }): Promise<void>;
}
export type FanoutConsumer = NotificationConsumer<typeof FANOUT_TOPIC, typeof fanoutSchema>;
export type DeliverConsumer = NotificationConsumer<typeof DELIVER_TOPIC, typeof deliverSchema>;

export interface NotifyInput<N extends string = string, D = unknown> {
	orgId: string;
	to: Recipients;
	notification: N;
	data: D;
	/** override the notification's own channels */
	channels?: readonly Channel[];
	/** the same key notifies each recipient once, however often `notify` runs (e.g. `invoice:${id}:paid`) */
	idempotencyKey?: string;
	/** the caller's transaction, so the notification goes out only if it commits (Postgres jobs) */
	executor?: unknown;
}

/** `notify` and the two consumers that deliver it: fan out to users, then one job per user. */
export function createNotifier<Names extends object = Record<string, unknown>>(
	options: NotifierOptions,
) {
	const byName = new Map(options.notifications.map((n) => [n.name, n]));
	const { store } = options;
	const atLeastOnce = (channel: Channel) => options.delivery?.[channel] === "at-least-once";
	if (CHANNELS.some(atLeastOnce) && (!store.claimPending || !store.markSent))
		throw new Error("At-least-once delivery needs a store with claimPending() and markSent()");
	const definition = (name: string) => {
		const found = byName.get(name);
		if (!found) throw new Error(`No notification named "${name}"`);
		return found;
	};

	async function notify<N extends keyof Names & string>(
		input: NotifyInput<N, Names[N]>,
	): Promise<void> {
		const def = definition(input.notification);
		const parsed = def.schema.safeParse(input.data);
		if (!parsed.success)
			throw new Error(`Invalid data for notification ${def.name}: ${parsed.error.message}`);
		await options.enqueue(
			FANOUT_TOPIC,
			{
				orgId: input.orgId,
				to: input.to,
				notification: def.name,
				data: input.data,
				...(input.channels ? { channels: [...input.channels] } : {}),
				key: input.idempotencyKey ?? randomUUID(),
			},
			{ orgId: input.orgId, executor: input.executor },
		);
	}

	async function* users(orgId: string, to: Recipients): AsyncIterable<string> {
		if ("user" in to) yield to.user;
		else if ("users" in to) yield* to.users;
		else if ("role" in to) yield* await options.recipients.role(orgId, to.role);
		else yield* await options.recipients.permission(orgId, to.permission);
	}

	const fanout: FanoutConsumer = {
		topic: FANOUT_TOPIC,
		description: "Resolves a notification's recipients and queues one delivery per user",
		schema: fanoutSchema,
		async handle(job) {
			const seen = new Set<string>();
			for await (const userId of users(job.orgId, job.to)) {
				if (seen.has(userId)) continue;
				seen.add(userId);
				// the key makes a retried fan-out queue the same deliveries, which then dedupe; keys are
				// the caller's, so the org keeps one org's key from shadowing another's
				await options.enqueue(
					DELIVER_TOPIC,
					{ ...job, to: undefined, userId, key: `${job.orgId}:${job.key}:${userId}` },
					{ orgId: job.orgId },
				);
			}
		},
	};

	const deliver: DeliverConsumer = {
		topic: DELIVER_TOPIC,
		description: "Stores one user's notification and sends it on each channel",
		schema: deliverSchema,
		async handle(job, ctx) {
			const def = definition(job.notification);
			const data = def.schema.parse(job.data);
			const wanted = job.channels ?? [...def.channels];
			const channels: Channel[] = [];
			for (const channel of wanted)
				if (
					!options.allow ||
					(await options.allow({
						orgId: job.orgId,
						userId: job.userId,
						notification: def.name,
						channel,
						data,
					}))
				)
					channels.push(channel);
			if (channels.length === 0) return;
			const contact = (await options.contact(job.userId)) ?? {};
			const language = contact.language ?? options.defaultLanguage ?? "en";
			const inApp = channels.includes("in-app")
				? (renderChannel(def, "in-app", data, language) as InAppContent)
				: null;
			const record = await options.store.claim({
				id: randomUUID(),
				orgId: job.orgId,
				userId: job.userId,
				name: def.name,
				inApp,
				idempotencyKey: job.key,
			});
			for (const channel of channels) {
				const sendIt = () =>
					send(channel, def, data, language, contact, job, record.id, inApp, ctx.logger);
				if (atLeastOnce(channel)) {
					// pending until the send returns: a crash or a failure leaves it for the next delivery
					if (!(await store.claimPending?.(record.id, channel))) continue;
					await sendIt();
					await store.markSent?.(record.id, channel);
					continue;
				}
				// taken before sending: two deliveries of one key can't both send it. A crash after
				// this sends nothing for the channel: at most once, never twice
				if (!(await options.store.claimChannel(record.id, channel))) continue;
				try {
					await sendIt();
				} catch (error) {
					// hand it back so the job's retry sends it
					await options.store.releaseChannel(record.id, channel);
					throw error;
				}
			}
		},
	};

	async function send(
		channel: Channel,
		// biome-ignore lint/suspicious/noExplicitAny: any notification
		def: NotificationDefinition<string, any>,
		data: unknown,
		language: string,
		contact: Contact,
		job: { orgId: string; userId: string },
		id: string,
		inApp: InAppContent | null,
		logger: CoreLogger,
	): Promise<"sent" | "skipped"> {
		const sendOptions: SendOptions = { idempotencyKey: `${id}:${channel}:${job.userId}` };
		const skip = (why: string) => {
			logger.debug({ channel, userId: job.userId, why }, "notification channel skipped");
			return "skipped" as const;
		};
		switch (channel) {
			case "in-app":
				if (inApp)
					await options.onInApp?.({
						id,
						orgId: job.orgId,
						userId: job.userId,
						name: def.name,
						...inApp,
						...renderInApp(inApp, language, options.translate),
						...sendOptions,
					});
				return "sent";
			case "email": {
				if (!options.email) return skip("no email sender");
				if (!contact.email) return skip("no email address");
				const content = renderChannel(def, "email", data, language) as EmailContent;
				await options.email.send({ to: contact.email, ...content }, sendOptions);
				return "sent";
			}
			case "sms": {
				if (!options.sms) return skip("no SMS sender");
				if (!contact.phone) return skip("no phone number");
				await options.sms.send(
					contact.phone,
					renderChannel(def, "sms", data, language) as string,
					sendOptions,
				);
				return "sent";
			}
			case "push": {
				if (!options.push) return skip("no push sender");
				const tokens = await options.store.pushTokens(job.userId);
				if (tokens.length === 0) return skip("no devices");
				let result: { invalidTokens: string[] };
				try {
					result = await options.push.send(
						tokens,
						renderChannel(def, "push", data, language) as PushContent,
						sendOptions,
					);
				} catch (error) {
					const gone = (error as { invalidTokens?: string[] }).invalidTokens;
					if (gone?.length) await options.store.removePushTokens(gone);
					throw error;
				}
				if (result.invalidTokens.length) await options.store.removePushTokens(result.invalidTokens);
				return "sent";
			}
		}
	}

	const consumers: readonly [FanoutConsumer, DeliverConsumer] = [fanout, deliver];
	return { notify, consumers };
}
