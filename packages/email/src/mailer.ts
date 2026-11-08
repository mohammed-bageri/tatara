/** The transport: SMTP, Mailgun, or the console driver that only logs. */
import type { CoreLogger } from "@tatara/core";
import { createTransport, type Transporter } from "nodemailer";

export interface EmailAttachment {
	filename: string;
	content: Uint8Array | Blob;
	contentType?: string;
}

export interface EmailMessage {
	to: string | string[];
	subject: string;
	text?: string;
	html?: string;
	replyTo?: string;
	cc?: string | string[];
	bcc?: string | string[];
	/** extra MIME headers, e.g. List-Unsubscribe */
	headers?: Record<string, string>;
	/** Mailgun `v:` variables, echoed back on its webhooks; other drivers ignore them */
	variables?: Record<string, string>;
	/** Mailgun `o:tag`; other drivers ignore them */
	tags?: string[];
	/** a link that must reach the reader untouched (sign-in): no click/open tracking, high priority */
	priority?: boolean;
	attachments?: EmailAttachment[];
}

export interface SentEmail {
	/** the provider's message id (`<…>`), what its webhooks refer to; null for the console driver */
	id: string | null;
}

export interface MailerOptions {
	driver: "smtp" | "mailgun" | "console";
	/** e.g. smtp://localhost:1025 (Mailpit); for the smtp driver */
	smtpUrl?: string;
	/** for the mailgun driver; `apiUrl` is https://api.eu.mailgun.net for EU domains */
	mailgun?: { apiKey: string; domain: string; apiUrl?: string };
	from: string;
	logger: CoreLogger;
	/** for tests: the HTTP client the mailgun driver uses */
	fetch?: typeof fetch;
}

export interface Mailer {
	send(message: EmailMessage): Promise<SentEmail>;
}

const list = (to: string | string[]) => (Array.isArray(to) ? to : [to]);

const blobOf = (a: EmailAttachment) =>
	a.content instanceof Blob
		? a.content
		: new Blob([new Uint8Array(a.content)], a.contentType ? { type: a.contentType } : {});

function mailgunForm(from: string, message: EmailMessage): FormData {
	const form = new FormData();
	form.set("from", from);
	for (const to of list(message.to)) form.append("to", to);
	for (const cc of message.cc ? list(message.cc) : []) form.append("cc", cc);
	for (const bcc of message.bcc ? list(message.bcc) : []) form.append("bcc", bcc);
	form.set("subject", message.subject);
	if (message.text) form.set("text", message.text);
	if (message.html) form.set("html", message.html);
	if (message.replyTo) form.set("h:Reply-To", message.replyTo);
	for (const [name, value] of Object.entries(message.headers ?? {}))
		form.append(`h:${name}`, value);
	for (const [name, value] of Object.entries(message.variables ?? {}))
		form.append(`v:${name}`, value);
	for (const tag of message.tags ?? []) form.append("o:tag", tag);
	if (message.priority) {
		// tracking rewrites links; a sign-in link must arrive as sent
		form.set("o:tracking", "no");
		form.set("o:tracking-clicks", "no");
		form.set("o:tracking-opens", "no");
		form.set("h:X-Priority", "1");
		form.set("h:Importance", "high");
	}
	for (const a of message.attachments ?? []) form.append("attachment", blobOf(a), a.filename);
	return form;
}

async function smtpMessage(from: string, message: EmailMessage) {
	const { variables: _v, tags: _t, priority, attachments, ...rest } = message;
	return {
		from,
		...rest,
		...(priority ? { priority: "high" as const } : {}),
		...(attachments
			? {
					attachments: await Promise.all(
						attachments.map(async (a) => ({
							filename: a.filename,
							content:
								a.content instanceof Blob
									? Buffer.from(await a.content.arrayBuffer())
									: Buffer.from(a.content),
							...(a.contentType ? { contentType: a.contentType } : {}),
						})),
					),
				}
			: {}),
	};
}

export function createMailer(options: MailerOptions): Mailer {
	// created on first send, so building the mailer does no work
	let transport: Transporter | undefined;
	return {
		async send(message) {
			if (options.driver === "console") {
				options.logger.info({ to: message.to, subject: message.subject }, "email (console driver)");
				return { id: null };
			}
			if (options.driver === "mailgun") {
				const mg = options.mailgun;
				if (!mg) throw new Error("The mailgun driver needs mailgun: { apiKey, domain }");
				const res = await (options.fetch ?? fetch)(
					`${mg.apiUrl ?? "https://api.mailgun.net"}/v3/${encodeURIComponent(mg.domain)}/messages`,
					{
						method: "POST",
						headers: {
							authorization: `Basic ${Buffer.from(`api:${mg.apiKey}`).toString("base64")}`,
						},
						body: mailgunForm(options.from, message),
					},
				);
				if (!res.ok) throw new Error(`Mailgun answered ${res.status}: ${await res.text()}`);
				const body = (await res.json().catch(() => ({}))) as { id?: unknown };
				return { id: typeof body.id === "string" ? body.id : null };
			}
			if (!options.smtpUrl) throw new Error("The smtp driver needs smtpUrl");
			transport ??= createTransport(options.smtpUrl);
			const info = (await transport.sendMail(await smtpMessage(options.from, message))) as
				| { messageId?: string }
				| undefined;
			return { id: info?.messageId ?? null };
		},
	};
}
