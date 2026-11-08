import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMailer, defineEmail, renderEmail } from "./index.ts";

const sendMail = vi.fn(async () => ({}));
vi.mock("nodemailer", () => ({ createTransport: vi.fn(() => ({ sendMail })) }));

describe("createMailer", () => {
	it("logs recipient and subject, never the body, with the console driver", async () => {
		const lines: string[] = [];
		const logger = pino({}, { write: (line: string) => lines.push(line) });
		const mailer = createMailer({ driver: "console", smtpUrl: "smtp://x", from: "a@x", logger });
		await mailer.send({ to: "b@x", subject: "Hi", text: "secret code 123456" });
		expect(lines.join("")).toContain("b@x");
		expect(lines.join("")).not.toContain("123456");
		expect(sendMail).not.toHaveBeenCalled();
	});

	it("sends through one SMTP transport with the configured sender", async () => {
		const { createTransport } = await import("nodemailer");
		const mailer = createMailer({
			driver: "smtp",
			smtpUrl: "smtp://localhost:1025",
			from: "noreply@x",
			logger: pino({ level: "silent" }),
		});
		await mailer.send({ to: "b@x", subject: "Hi", text: "Hello" });
		await mailer.send({ to: "c@x", subject: "Hi", text: "Hello" });
		expect(createTransport).toHaveBeenCalledTimes(1);
		expect(createTransport).toHaveBeenCalledWith("smtp://localhost:1025");
		expect(sendMail).toHaveBeenLastCalledWith({
			from: "noreply@x",
			to: "c@x",
			subject: "Hi",
			text: "Hello",
		});
	});
});

describe("the smtp driver's extras", () => {
	it("passes headers, cc and attachments to nodemailer and drops Mailgun-only fields", async () => {
		sendMail.mockResolvedValueOnce({ messageId: "<s1@host>" } as never);
		const mailer = createMailer({
			driver: "smtp",
			smtpUrl: "smtp://localhost:1025",
			from: "noreply@x",
			logger: pino({ level: "silent" }),
		});
		const sent = await mailer.send({
			to: "b@x",
			cc: "c@x",
			subject: "Hi",
			text: "Hello",
			headers: { "X-A": "1" },
			variables: { v: "1" },
			tags: ["t"],
			priority: true,
			attachments: [{ filename: "f.txt", content: new Blob(["yo"]) }],
		});
		expect(sent).toEqual({ id: "<s1@host>" });
		expect(sendMail).toHaveBeenLastCalledWith({
			from: "noreply@x",
			to: "b@x",
			cc: "c@x",
			subject: "Hi",
			text: "Hello",
			headers: { "X-A": "1" },
			priority: "high",
			attachments: [{ filename: "f.txt", content: Buffer.from("yo") }],
		});
	});
});

describe("the mailgun driver", () => {
	it("posts the message to the domain's endpoint with the API key", async () => {
		const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
		const mailer = createMailer({
			driver: "mailgun",
			mailgun: { apiKey: "key-1", domain: "mg.example.com", apiUrl: "https://api.eu.mailgun.net" },
			from: "noreply@example.com",
			logger: pino({ level: "silent" }),
			fetch: fetch as unknown as typeof globalThis.fetch,
		});
		await mailer.send({ to: ["a@x", "b@x"], subject: "Hi", text: "Hello", html: "<p>Hello</p>" });
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.eu.mailgun.net/v3/mg.example.com/messages");
		expect((init.headers as Record<string, string>).authorization).toBe(
			`Basic ${Buffer.from("api:key-1").toString("base64")}`,
		);
		const form = init.body as FormData;
		expect(form.getAll("to")).toEqual(["a@x", "b@x"]);
		expect(form.get("html")).toBe("<p>Hello</p>");
	});

	it("sends headers, variables, tags, cc/bcc, attachments and priority; returns the message id", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "<abc@mg>", message: "Queued" }), { status: 200 }),
		);
		const mailer = createMailer({
			driver: "mailgun",
			mailgun: { apiKey: "k", domain: "d" },
			from: "f@x",
			logger: pino({ level: "silent" }),
			fetch: fetch as unknown as typeof globalThis.fetch,
		});
		const sent = await mailer.send({
			to: "a@x",
			cc: "c@x",
			bcc: ["d@x", "e@x"],
			subject: "s",
			html: "<p>h</p>",
			replyTo: "r@x",
			headers: { "List-Unsubscribe": "<https://u>" },
			variables: { job_id: "j1" },
			tags: ["login"],
			priority: true,
			attachments: [
				{ filename: "a.txt", content: new TextEncoder().encode("hi"), contentType: "text/plain" },
			],
		});
		expect(sent).toEqual({ id: "<abc@mg>" });
		const form = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
		expect(form.get("cc")).toBe("c@x");
		expect(form.getAll("bcc")).toEqual(["d@x", "e@x"]);
		expect(form.get("text")).toBeNull();
		expect(form.get("h:Reply-To")).toBe("r@x");
		expect(form.get("h:List-Unsubscribe")).toBe("<https://u>");
		expect(form.get("v:job_id")).toBe("j1");
		expect(form.getAll("o:tag")).toEqual(["login"]);
		expect(form.get("o:tracking")).toBe("no");
		expect(form.get("h:X-Priority")).toBe("1");
		const file = form.get("attachment") as File;
		expect(file.name).toBe("a.txt");
		expect(await file.text()).toBe("hi");
	});

	it("throws when Mailgun refuses, so a job retries", async () => {
		const mailer = createMailer({
			driver: "mailgun",
			mailgun: { apiKey: "k", domain: "d" },
			from: "f",
			logger: pino({ level: "silent" }),
			fetch: (async () => new Response("forbidden", { status: 401 })) as unknown as typeof fetch,
		});
		await expect(mailer.send({ to: "a@x", subject: "s", text: "t" })).rejects.toThrow(/401/);
	});
});

describe("email templates", () => {
	const welcome = defineEmail({
		name: "users.welcome",
		schema: z.object({ name: z.string().min(1) }),
		render: ({ name }, language) =>
			language === "ar"
				? { subject: "أهلاً", text: `أهلاً ${name}` }
				: { subject: "Welcome", text: `Hello ${name}` },
	});

	it("renders in the recipient's language", () => {
		expect(renderEmail(welcome, { name: "Ada" }, "ar")).toEqual({
			subject: "أهلاً",
			text: "أهلاً Ada",
		});
		expect(renderEmail(welcome, { name: "Ada" }, "en").subject).toBe("Welcome");
	});

	it("refuses data the template's schema rejects", () => {
		expect(() => renderEmail(welcome, { name: "" }, "en")).toThrow(
			/Invalid data for email users.welcome/,
		);
	});
});
