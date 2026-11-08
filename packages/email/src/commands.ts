import { type CommandDefinition, defineCommand } from "@tatara/core";
import { z } from "zod";
import type { EmailMessage } from "./index.ts";

/** email:send-test; wired into the app by `tatara sync`. */
export function emailCommands({
	sendEmail,
}: {
	sendEmail(message: EmailMessage): Promise<unknown>;
}): CommandDefinition[] {
	return [
		defineCommand({
			name: "email:send-test",
			description: "Send a test email (see it in Mailpit locally)",
			args: z.object({ to: z.email().default("dev@example.com") }),
			async run({ to }, { logger }) {
				await sendEmail({ to, subject: "Test email", text: "It works." });
				logger.info({ to }, "test email sent");
			},
		}),
	] as CommandDefinition[];
}
