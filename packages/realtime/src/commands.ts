import { type CommandDefinition, defineCommand, flag } from "@tatara/core";
import { z } from "zod";
import type { ChannelDefinition } from "./channels.ts";

export interface ChannelSummary {
	/** the pattern clients subscribe to, e.g. "survey.{surveyId}" */
	channel: string;
	description: string;
	permission?: string;
	feature?: string;
	/** the channel adds its own authorize() check */
	rowLevel: boolean;
	events: string[];
}

// biome-ignore lint/suspicious/noExplicitAny: channels with any params and events
type AnyChannel = ChannelDefinition<string, any>;

export function summarizeChannels(channels: readonly AnyChannel[]): ChannelSummary[] {
	return channels
		.map(
			(c): ChannelSummary => ({
				channel: c.name,
				description: c.description,
				...(c.permission !== undefined ? { permission: c.permission } : {}),
				...(c.feature !== undefined ? { feature: c.feature } : {}),
				rowLevel: typeof c.authorize === "function",
				events: Object.keys(c.events).sort(),
			}),
		)
		.sort((a, b) => a.channel.localeCompare(b.channel));
}

/** realtime:publish and realtime:channels; wired into the app by `tatara sync`. */
export function realtimeCommands({
	realtime,
	channels = [],
}: {
	realtime: {
		publishToUser(orgId: string, userId: string, event: string, payload: unknown): Promise<void>;
	};
	/** `src/generated/channels.ts`; absent in apps ejected before it was passed */
	channels?: readonly AnyChannel[];
}): CommandDefinition[] {
	return [
		defineCommand({
			name: "realtime:publish",
			description: "Send an event to a user's open sockets, from outside the api (debugging)",
			args: z.object({
				org: z.string().default("default"),
				user: z.string().min(1),
				event: z.string().min(1),
				data: z.string().default("{}"),
			}),
			async run({ org, user, event, data }, { logger }) {
				await realtime.publishToUser(org, user, event, JSON.parse(data) as unknown);
				logger.info({ org, user, event }, "published");
			},
		}),
		defineCommand({
			name: "realtime:channels",
			description: "List the app's realtime channels with their checks and events",
			args: z.object({ json: flag() }),
			async run({ json }, { logger }) {
				const summaries = summarizeChannels(channels);
				if (json) {
					process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
					return;
				}
				for (const { channel, ...rest } of summaries) logger.info(rest, channel);
				logger.info(
					{ count: summaries.length },
					summaries.length
						? "realtime channels"
						: "no realtime channels: add one at src/modules/<module>/channels/<name>.ts",
				);
			},
		}),
	] as CommandDefinition[];
}
