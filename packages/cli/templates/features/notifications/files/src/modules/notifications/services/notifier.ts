import {
	consolePush,
	consoleSms,
	createNotifier,
	fcmPush,
	type NotificationsOf,
	type PushSender,
	type SmsSender,
	twilioSms,
} from "@tatara/notifications";
import { env } from "#core/config/env";
import { enqueue } from "#core/jobs/index";
import { logger } from "#core/logging/logger";
import { notifications } from "#generated/notifications";
import { notificationStore } from "#modules/notifications/services/store";
import { translate } from "#modules/notifications/services/translate";
import { auth } from "#modules/users/services/auth";
// tatara:slot imports

function sms(): SmsSender {
	if (env.SMS_DRIVER !== "twilio") return consoleSms(logger);
	if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM)
		throw new Error("SMS_DRIVER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM");
	return twilioSms({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM });
}

function push(): PushSender {
	if (env.PUSH_DRIVER !== "fcm") return consolePush(logger);
	if (!env.FCM_PROJECT_ID || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY)
		throw new Error("PUSH_DRIVER=fcm needs FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY");
	return fcmPush({ projectId: env.FCM_PROJECT_ID, clientEmail: env.FCM_CLIENT_EMAIL, privateKey: env.FCM_PRIVATE_KEY });
}

// tatara:slot helpers

/**
 * `notify({ orgId, to, notification, data })`: stores the inbox entry and sends each channel through
 * jobs. Notifications are `notifications/*.ts` in any module (`defineNotification`).
 */
export const { notify, consumers } = createNotifier<NotificationsOf<typeof notifications>>({
	notifications,
	store: notificationStore,
	enqueue: enqueue as never,
	// tatara:slot recipients
	async contact(userId) {
		const { adapter } = await auth.$context;
		const user = await adapter.findOne<{ email?: string; phoneNumber?: string | null; language?: string | null }>({
			model: "user",
			where: [{ field: "id", value: userId }],
		});
		// language: add it as a user field (better-auth additionalFields) to notify in each user's own
		return user
			? { email: user.email ?? null, phone: user.phoneNumber ?? null, language: user.language ?? null }
			: null;
	},
	// who gets what is yours to decide: preferences, quiet hours… ({ userId, notification, channel,
	// data }); false skips that channel for that user
	allow: () => true,
	// a channel is at most once unless listed here: "at-least-once" resends after a crash, with the
	// same idempotency key (passed to each sender), e.g. { email: "at-least-once" }
	delivery: {},
	translate,
	sms: sms(),
	push: push(),
	// tatara:slot senders
	logger,
});
