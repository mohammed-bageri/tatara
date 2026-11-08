import { describe, expect, it } from "vitest";
import { sendEmail } from "#core/email/send";

describe("email", () => {
	it("accepts a message with the test (console) driver", async () => {
		await expect(sendEmail({ to: "a@example.com", subject: "Hi", text: "Hello" })).resolves.toEqual({ id: null });
	});
});
