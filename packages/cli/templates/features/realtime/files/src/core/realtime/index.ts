import { corsOrigin } from "@tatara/http";
import { createRealtime } from "@tatara/realtime";
import { Redis } from "ioredis";
import { cache } from "#core/cache/index";
import { env } from "#core/config/env";
import { logger } from "#core/logging/logger";

/**
 * The app's websockets: the api attaches them, every process can publish (through Redis). A client
 * gets a ticket from POST /api/realtime/ticket and connects with `auth: { ticket }`.
 */
export const realtime = createRealtime({
	driver: env.REALTIME_DRIVER,
	adapter:
		env.REALTIME_ADAPTER === "redis"
			? { kind: "redis", redis: () => new Redis(env.REDIS_URL) }
			: { kind: "memory" },
	// single-use tickets, kept in the cache
	tickets: cache,
	ticketTtlMs: env.REALTIME_TICKET_TTL_SECONDS * 1000,
	path: env.REALTIME_PATH,
	allowOrigin: (() => {
		const allow = corsOrigin(env.CORS_ORIGINS);
		return (origin: string) => allow(origin) !== null;
	})(),
	logger,
});

export const { publishToUser, publishToOrg, publishTo, unsubscribeUser, disconnectUser, disconnectOrg } = realtime;
