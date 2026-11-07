/** Realtime counters: a per-process snapshot, and the same counts on an OpenTelemetry meter if given. */
import type { DenyCode, DisconnectReason } from "./channels.ts";

type Attributes = Record<string, string>;
interface Instrument {
	add(value: number, attributes?: Attributes): void;
}

/** The part of an OpenTelemetry `Meter` realtime uses; `@opentelemetry/api`'s satisfies it. */
export interface RealtimeMeter {
	createCounter(name: string, options?: { description?: string }): Instrument;
	createUpDownCounter(name: string, options?: { description?: string }): Instrument;
}

/** Why a handshake or a new socket was refused. */
export type RejectReason = "origin" | "no_ticket" | "bad_ticket" | "too_many_connections";

export interface RealtimeMetricsSnapshot {
	/** sockets open on this process now */
	connectionsOpen: number;
	connectionsOpened: number;
	connectionsRejected: Partial<Record<RejectReason, number>>;
	subscribesAllowed: number;
	subscribesDenied: Partial<Record<DenyCode, number>>;
	eventsPublished: number;
	/** publishes that failed or were dropped as invalid: publishing never throws, so only this shows it */
	publishFailures: number;
	/** server-initiated closes, by reason */
	disconnects: Record<string, number>;
}

const NO_INSTRUMENT: Instrument = { add() {} };

export function createMetrics(meter?: RealtimeMeter) {
	const counter = (name: string, description: string) =>
		meter ? meter.createCounter(name, { description }) : NO_INSTRUMENT;
	const opened = counter("realtime.connections.opened", "Sockets authenticated and accepted.");
	const rejected = counter("realtime.connections.rejected", "Handshakes refused, by reason.");
	const current = meter
		? meter.createUpDownCounter("realtime.connections.current", {
				description: "Sockets held by this process.",
			})
		: NO_INSTRUMENT;
	const subscribes = counter("realtime.subscribes", "Subscribe attempts, by outcome.");
	const published = counter(
		"realtime.events.published",
		"Events handed to the transport, by outcome.",
	);
	const disconnects = counter("realtime.disconnects", "Server-initiated disconnects, by reason.");

	const counts: RealtimeMetricsSnapshot = {
		connectionsOpen: 0,
		connectionsOpened: 0,
		connectionsRejected: {},
		subscribesAllowed: 0,
		subscribesDenied: {},
		eventsPublished: 0,
		publishFailures: 0,
		disconnects: {},
	};
	const bump = <K extends string>(bucket: Partial<Record<K, number>>, key: K) => {
		bucket[key] = (bucket[key] ?? 0) + 1;
	};

	return {
		opened() {
			opened.add(1);
			current.add(1);
			counts.connectionsOpened++;
			counts.connectionsOpen++;
		},
		closed() {
			current.add(-1);
			counts.connectionsOpen = Math.max(0, counts.connectionsOpen - 1);
		},
		rejected(reason: RejectReason) {
			rejected.add(1, { reason });
			bump(counts.connectionsRejected, reason);
		},
		subscribed(outcome: "allowed" | DenyCode) {
			subscribes.add(1, { outcome });
			if (outcome === "allowed") counts.subscribesAllowed++;
			else bump(counts.subscribesDenied, outcome);
		},
		published(ok: boolean) {
			published.add(1, { outcome: ok ? "ok" : "failed" });
			if (ok) counts.eventsPublished++;
			else counts.publishFailures++;
		},
		disconnected(reason: DisconnectReason) {
			disconnects.add(1, { reason });
			bump(counts.disconnects, reason);
		},
		/** a copy */
		snapshot(): RealtimeMetricsSnapshot {
			return {
				...counts,
				connectionsRejected: { ...counts.connectionsRejected },
				subscribesDenied: { ...counts.subscribesDenied },
				disconnects: { ...counts.disconnects },
			};
		},
	};
}
