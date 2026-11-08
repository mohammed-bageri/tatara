import { defineEvent } from "@tatara/events";
import { z } from "zod";

export default defineEvent({
	name: "example.greeting.sent",
	description: "Example event: someone was greeted",
	schema: z.object({ name: z.string().min(1) }),
});
