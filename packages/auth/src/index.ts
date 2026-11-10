/** @tatara/auth: the principal contract, guards and better-auth helpers. */
export {
	consoleSmsSender,
	createOutbox,
	type Outbox,
	type OutboxMessage,
	type SmsSender,
} from "./delivery.ts";
export {
	type AuthInstanceOptions,
	type ClientIpOptions,
	createAuthInstance,
	OrgRequiredError,
	type SessionEnv,
	withClientIpHeader,
} from "./instance.ts";
export { mergeAuthOpenApi, type OpenApiAuth } from "./openapi.ts";
export {
	type AuthEnv,
	currentPrincipal,
	type Principal,
	type PrincipalResolver,
	principalMiddleware,
	requireAuth,
	requireRole,
} from "./principal.ts";
export { isBannedNow, type SessionAuth, sessionPrincipal } from "./session.ts";
