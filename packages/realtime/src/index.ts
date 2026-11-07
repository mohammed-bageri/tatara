/** @tatara/realtime: socket.io with ticket auth, user and org rooms, module channels, publish from anywhere. */
export {
	type ChannelDefinition,
	type ChannelParams,
	channelName,
	createEnvelope,
	type DenyCode,
	type DisconnectReason,
	defineChannel,
	ENVELOPE_VERSION,
	matchChannel,
	ORG_CHANNEL,
	type RealtimeEnvelope,
	type SocketIdentity,
	type SubscribeAck,
	USER_CHANNEL,
	userChannel,
	validateChannels,
	WIRE_CLOSED_EVENT,
	WIRE_EVENT,
} from "./channels.ts";
export type { RealtimeMeter, RealtimeMetricsSnapshot, RejectReason } from "./metrics.ts";
export {
	createRealtime,
	type Realtime,
	type RealtimeHealth,
	type RealtimeOptions,
	type TicketStore,
} from "./realtime.ts";
