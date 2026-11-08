/** @tatara/email: SMTP, Mailgun or console transport; templates, layout, a durable queue, suppressions. */
export { createLanguageResolver, type LanguageResolver } from "./language.ts";
export {
	createDetailRow,
	createDetailsCard,
	createEmailButton,
	createEmailButtonOutline,
	createStatusBadge,
	type EmailBranding,
	type LayoutLabels,
	type LayoutOptions,
	layoutLabels,
	textDirection,
	wrapEmailContent,
} from "./layout.ts";
export {
	createMailer,
	type EmailAttachment,
	type EmailMessage,
	type Mailer,
	type MailerOptions,
	type SentEmail,
} from "./mailer.ts";
export {
	createMailgunWebhook,
	MAILGUN_SIGNATURE_TOLERANCE_SECONDS,
	type MailgunEventData,
	type MailgunWebhookBody,
	type MailgunWebhookOptions,
	type MailgunWebhookResult,
	mailgunSuppressionReason,
	mailgunWebhookBody,
	type ReplayGuard,
	verifyMailgunSignature,
} from "./mailgun-webhook.ts";
export { memoryEmailQueueStore, memorySuppressionStore } from "./memory.ts";
export {
	escapeHtml,
	hashVariables,
	missingVariables,
	type PlaceholderOptions,
	substitutePlaceholders,
} from "./placeholders.ts";
export {
	createEmailQueue,
	DEFAULT_JOB_ID_VARIABLE,
	definitionRenderer,
	type EmailJob,
	type EmailJobFilter,
	type EmailJobPatch,
	type EmailJobStatus,
	type EmailLogEntry,
	type EmailQueue,
	type EmailQueueOptions,
	type EmailQueueStore,
	type NewEmailJob,
	type ProcessResult,
	type QueuedContent,
	type QueueEmailInput,
	type QueueEmailResult,
	type SentMessageRef,
} from "./queue.ts";
export {
	createSuppressionList,
	emailHash,
	SUPPRESSION_REASONS,
	type SuppressedSend,
	type SuppressionList,
	type SuppressionReason,
	type SuppressionStore,
} from "./suppression.ts";
export { defineEmail, type EmailDefinition, type RenderedEmail, renderEmail } from "./templates.ts";
export {
	createUnsubscribePage,
	createUnsubscribeTokens,
	type UnsubscribeTokenOptions,
	type UnsubscribeTokens,
	unsubscribeHeaders,
} from "./unsubscribe.ts";
