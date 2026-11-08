import type { Feature } from "./types.ts";

const AUTHZ_AGENTS = `## Permissions (authz)

- Permissions are \`resource:action\` (optionally scoped \`own | team | org\`, where a wider scope
  satisfies a narrower one). Each module declares its resources and the grants built-in roles get
  in \`permissions/<name>.permissions.ts\` (\`definePermissions\` from \`@tatara/authz\`); \`tatara sync\` merges them into a
  typed catalog.
- Guard routes with \`middleware: [requirePermission("project:read")]\` from \`#core/authz/index\`
  and declare \`security: [{ bearerAuth: ["project:read"] }]\`. For scoped actions, call
  \`resolveScope(principal, "doc:read")\` in the service and filter rows by the returned scope.
- Effective permissions = grants of the caller's roles + grant overlays − deny overlays. Deny
  always wins. Roles are assigned in authz (the org's creator gets \`admin\`); a built-in role with
  \`heldBy: "members"\` goes to every member, \`heldBy: "identity"\` to holders of that identity role.
- better-auth's member role is membership only (\`owner\` or \`member\`): \`authzPlugin\` in
  \`src/modules/users/services/auth.ts\` refuses others and gives the creator \`admin\`.
- Custom roles and grant overlays can never grant \`role\`, \`member\` or \`audit_log\`.
- Built-in roles live in \`src/core/authz/system-roles.ts\`. \`authz:sync-permissions\` brings the database
  in line with them; \`deploy\` runs it every deploy, \`db:seed\` locally.
- In tests: \`asUser({ permissions: ["project:read"] })\` or \`asUser({ systemRoles: ["admin"] })\`.
`;

export const authz: Feature = {
	id: "authz",
	kind: "addon",
	label: "Permission system",
	dependencies: ["@tatara/authz"],
	slots: [
		{
			file: "src/core/authz/system-roles.ts",
			slot: "admin",
			unless: ["auth-keycloak"],
			content:
				'{ key: "admin", name: "Admin", description: "Full access, including roles and members." },',
		},
		{
			// Keycloak's realm roles are the app's roles: a token with "admin" is the admin
			file: "src/core/authz/system-roles.ts",
			slot: "admin",
			when: ["auth-keycloak"],
			content:
				'{ key: "admin", name: "Admin", description: "Full access, including roles and members.", heldBy: "identity" },',
		},
		{
			// without organizations the app has one tenant; say so instead of falling back silently
			file: "src/core/authz/index.ts",
			slot: "options",
			unless: ["auth-orgs"],
			content: 'singleTenant: "default",',
		},
		{
			// each request names the org it acts in
			file: "src/modules/users/routes/authorization.routes.ts",
			slot: "route-options",
			when: ["auth-orgs"],
			content: "use: [requireOrg()],",
		},
		{
			file: "src/modules/users/routes/authorization.routes.ts",
			slot: "imports",
			when: ["auth-orgs"],
			content: 'import { requireOrg } from "#modules/users/services/auth";',
		},
		{
			file: "tests/helpers/auth.ts",
			slot: "imports",
			content: 'import { applyTestAccess, type TestAccess } from "#tests/helpers/authz";',
		},
		{
			file: "tests/helpers/auth.ts",
			slot: "options",
			content: 'permissions?: TestAccess["permissions"];\nsystemRoles?: TestAccess["systemRoles"];',
		},

		{
			file: "tests/helpers/auth.ts",
			slot: "as-user",
			unless: ["auth-orgs"],
			content: "await applyTestAccess(user.userId, options);",
		},
		{
			// roles and grants go in the org the user acts in
			file: "tests/helpers/auth.ts",
			slot: "as-user",
			when: ["auth-orgs"],
			content: "await applyTestAccess(user.userId, { ...options, orgId: user.orgId });",
		},
		{ file: "AGENTS.md", slot: "sections", content: AUTHZ_AGENTS },
	],
};

const REDIS_SERVICE = {
	image: "redis:8-alpine",
	ports: ["${REDIS_PORT:-6379}:6379"],
	healthcheck: {
		test: ["CMD", "redis-cli", "ping"],
		interval: "2s",
		timeout: "3s",
		retries: 30,
	},
};

const jobsDriver = (drivers: string[]) => ({
	key: "JOBS_DRIVER",
	schema: `localDefault(z.enum(${JSON.stringify(drivers)}), "bullmq")`,
	example: "bullmq",
	test: "inline",
	comment: `Where jobs wait: ${drivers.join(", ")} (inline runs them where they're sent, no worker)`,
});

export const jobs: Feature = {
	id: "jobs",
	kind: "addon",
	label: "Jobs + cron (BullMQ, Postgres or Kafka)",
	dependencies: ["@tatara/jobs", "bullmq", "ioredis", "croner", "kafkajs"],
	allowBuilds: ["msgpackr-extract"],
	scripts: {
		"start:worker": "node dist/apps/worker/index.mjs",
		"start:cron": "node dist/apps/cron/index.mjs",
	},
	env: [
		{
			key: "REDIS_PORT",
			schema: "",
			example: "6379",
			composeOnly: true,
			comment: "Host port for local Redis",
		},
		{ key: "REDIS_URL", schema: "z.url()", example: "redis://localhost:6379/0" },
		{
			key: "JOBS_PREFIX",
			schema: 'z.string().default("bull")',
			example: "bull",
			comment: "Redis key prefix for queues",
		},
		{
			key: "WORKER_CONCURRENCY",
			schema: "z.coerce.number().int().positive().default(5)",
			example: "5",
		},
		{
			key: "KAFKA_BROKERS",
			schema: "z.string().optional()",
			example: "",
			comment: "Comma-separated brokers, for JOBS_DRIVER=kafka",
		},
		{
			key: "KAFKA_CLIENT_ID",
			schema: 'z.string().default("__APP_NAME__")',
			example: "__APP_NAME__",
		},
		{ key: "KAFKA_SSL", schema: "z.stringbool().default(false)", example: "false" },
		{ key: "KAFKA_SASL_USERNAME", schema: "z.string().optional()", example: "" },
		{ key: "KAFKA_SASL_PASSWORD", schema: "z.string().optional()", example: "" },
		{
			key: "SCHEDULE_TRIGGER_SECRET",
			schema: "z.string().min(16).optional()",
			example: "",
			comment:
				"Lets a platform scheduler POST /internal/schedules/<name> with Authorization: Bearer <secret>; unset, the route doesn't exist",
		},
	],
	variants: [
		{ when: ["postgres"], env: [jobsDriver(["bullmq", "postgres", "kafka", "inline"])] },
		{ unless: ["postgres"], env: [jobsDriver(["bullmq", "kafka", "inline"])] },
	],
	compose: { redis: REDIS_SERVICE },
	slots: [
		{
			file: "tsdown.config.ts",
			slot: "entries",
			content:
				'"apps/worker/index": "src/apps/worker/index.ts",\n"apps/cron/index": "src/apps/cron/index.ts",',
		},
		{
			file: "src/apps/http.ts",
			slot: "imports",
			content:
				'import { triggerSchedule } from "@tatara/jobs";\nimport { scheduleRunner } from "#apps/cron/runner";',
		},
		{
			// a triggered schedule runs as long as it takes; a 504 would only make the scheduler retry
			file: "src/apps/http.ts",
			slot: "timeout-paths",
			content: '"/internal/schedules/*": 15 * 60 * 1000,',
		},
		{
			// for a platform scheduler (Cloud Scheduler, EventBridge, a k8s CronJob) instead of apps/cron
			file: "src/apps/http.ts",
			slot: "routes",
			order: 3,
			content: [
				'if (name === "api" && env.SCHEDULE_TRIGGER_SECRET) {',
				"\tconst secret = env.SCHEDULE_TRIGGER_SECRET;",
				'\tapp.post("/internal/schedules/:name", async (c) => {',
				'\t\tconst { status, body } = await triggerSchedule(c.req.param("name"), c.req.header("authorization"), {',
				"\t\t\t...scheduleRunner,",
				'\t\t\tlogger: c.get("logger"),',
				"\t\t\tsecret,",
				"\t\t});",
				"\t\treturn c.json(body, status);",
				"\t});",
				"}",
			].join("\n"),
		},
		{
			file: "src/apps/cron/runner.ts",
			slot: "imports",
			when: ["auth-orgs"],
			content: 'import { auth } from "#modules/users/services/auth";',
		},
		{
			// forEachOrg visits every organization, a page at a time
			file: "src/apps/cron/runner.ts",
			slot: "options",
			when: ["auth-orgs"],
			content: [
				"async *orgs() {",
				"\tconst { adapter } = await auth.$context;",
				"\tfor (let offset = 0; ; offset += 100) {",
				"\t\tconst page = await adapter.findMany<{ id: string }>({",
				'\t\t\tmodel: "organization",',
				"\t\t\tlimit: 100,",
				"\t\t\toffset,",
				'\t\t\tsortBy: { field: "id", direction: "asc" },',
				"\t\t});",
				"\t\tfor (const org of page) yield org.id;",
				"\t\tif (page.length < 100) return;",
				"\t}",
				"},",
			].join("\n"),
		},
		{
			file: "tests/setup.ts",
			slot: "setup",
			content: [
				"",
				"// One Redis database per worker.",
				"if (process.env.REDIS_URL) {",
				"\tconst redisUrl = new URL(process.env.REDIS_URL);",
				'\tredisUrl.pathname = `/${process.env.VITEST_POOL_ID ?? "1"}`;',
				"\tprocess.env.REDIS_URL = redisUrl.toString();",
				"}",
			].join("\n"),
		},
		{
			file: "AGENTS.md",
			slot: "sections",
			content: `## Jobs and schedules

- Background work: \`enqueue(topic, payload, { orgId })\` from \`#core/jobs/index\`, typed by the app's
  consumers. A module handles a topic in \`consumers/<name>.ts\`
  (\`defineConsumer({ topic, schema, attempts?, backoffMs?, handle, onDeadLetter? })\` from \`@tatara/jobs\`).
  The consumer validates the payload; a payload that never validates goes straight to dead.
  Handlers must be idempotent: a failure retries with doubling backoff, and \`onDeadLetter\` runs once,
  after the last attempt.
- \`JOBS_DRIVER\` picks where jobs wait: \`bullmq\` (Redis, default), \`postgres\` (a \`tatara.jobs\` table;
  pass \`{ executor: inTransaction(tx) }\` and the job commits with your writes, a transactional
  outbox), \`kafka\`, or \`inline\` (tests: \`(jobs.driver as InlineDriver).drain()\`).
- Recurring work: \`schedules/<name>.ts\` (\`defineSchedule({ name, cron, run })\`); \`run({ forEachOrg })\`
  visits every org, one failure at a time. A lock (the cache) makes each tick run once however it
  was started: \`apps/cron\`, \`tatara run schedule:run --name <name>\`, or
  \`POST /internal/schedules/<name>\` with \`SCHEDULE_TRIGGER_SECRET\` (for a platform scheduler).
- Processes: \`apps/worker\` runs consumers, \`apps/cron\` runs schedules. \`dev\` starts both.
`,
		},
	],
};

export const events: Feature = {
	id: "events",
	kind: "addon",
	label: "Domain events (transactional outbox)",
	dependencies: ["@tatara/events"],
	slots: [
		{
			file: "AGENTS.md",
			slot: "sections",
			content: `## Domain events

- "This happened" notices between modules. Declare events in \`events/<name>.ts\`
  (\`export default defineEvent({ name: "billing.invoice.paid", schema })\`, or an array of them,
  from \`@tatara/events\`); react in \`event-subscribers/<name>.ts\`
  (\`export default defineSubscriber({ name, event, handle })\`). \`tatara sync\` lists both.
- Emit in the transaction that makes the change: \`events.emit(tx, invoicePaid, { payload, orgId,
  aggregateId, actor })\` from \`#core/events/index\`. Inside \`events.transaction(fn)\` the event is
  published right after commit; in a plain \`db.transaction\` the relay schedule picks it up within
  seconds. A rollback leaves no event. \`events.afterCommit(hook)\` runs work after commit only.
- Delivery is at-least-once, one delivery per (event, subscriber), retried alone with backoff and
  dead after 8 attempts, with no ordering: **subscribers must be idempotent per \`event.id\`**.
- Payloads are validated at emit; keep secrets and free text out of them. Bump \`version\` for a
  breaking payload change.
- Schedules \`events-relay\`, \`events-retry\`, \`events-reconcile\` and \`events-prune\` (published
  events older than 13 months) run in \`apps/cron\`; the worker runs deliveries. After fixing a dead
  delivery's handler: \`tatara run events:requeue-dead --subscriber <name>\`.
`,
		},
	],
};

const cacheDriver = (drivers: string[]) => ({
	key: "CACHE_DRIVER",
	schema: `localDefault(z.enum(${JSON.stringify(drivers)}), "redis")`,
	example: "redis",
	test: "memory",
	comment: `Where the cache lives: ${drivers.join(", ")} (memory is per process)`,
});

export const cache: Feature = {
	id: "cache",
	kind: "addon",
	label: "Cache (Redis, Postgres or memory)",
	dependencies: ["@tatara/cache", "ioredis"],
	env: [
		{
			key: "REDIS_PORT",
			schema: "",
			example: "6379",
			composeOnly: true,
			comment: "Host port for local Redis",
		},
		{ key: "REDIS_URL", schema: "z.url()", example: "redis://localhost:6379/0" },
	],
	variants: [
		{ when: ["postgres"], env: [cacheDriver(["redis", "postgres", "memory"])] },
		{ unless: ["postgres"], env: [cacheDriver(["redis", "memory"])] },
	],
	compose: { redis: REDIS_SERVICE },
	slots: [
		{
			file: "AGENTS.md",
			slot: "sections",
			content: `## Cache

- \`cache\` from \`#core/cache/index\`: \`get/set/del\`, \`wrap(key, ttlMs, fn)\` (cache-aside; a failing
  store falls back to \`fn\`), \`increment\` (fixed-window counters), \`add\`/\`take\` (single-use values)
  and \`lock(key, ttlMs, fn)\` (one holder across processes).
- Scope keys with \`orgKey(orgId, …)\` / \`userKey(userId, …)\` from \`@tatara/cache\`, and drop them all
  with \`cache.delPrefix(orgKey(orgId))\`.
- Rate-limit a route with \`middleware: [limitRequests({ name, windowMs, max })]\` from
  \`#core/http/rate-limit\` (per caller IP, or per \`key\`); past the limit it answers 429 RATE_LIMITED.
- \`CACHE_DRIVER\` picks the store (Redis by default; tests use memory). Values must be JSON.
`,
		},
	],
};

export const admin: Feature = {
	id: "admin",
	kind: "addon",
	label: "Admin API app",
	scripts: { "start:admin": "node dist/apps/admin/server.mjs" },
	env: [
		{ key: "ADMIN_PORT", schema: "z.coerce.number().int().default(3001)", example: "3001" },
		{
			key: "ADMIN_URL",
			schema: 'localDefault(z.url(), "http://localhost:3001")',
			example: "http://localhost:3001",
			comment: "Where the admin app is served; staff sign in there",
		},
		{
			key: "SEED_STAFF_EMAIL",
			schema: 'z.email().default("staff@example.com")',
			example: "staff@example.com",
			comment: "Development staff account created by `db:seed` (never in production)",
		},
		{
			key: "SEED_STAFF_PASSWORD",
			schema: "z.string().min(10).optional()",
			example: "",
			secret: true,
			comment: "Password for the development staff account (generated by tatara new)",
		},
	],
	slots: [
		{ file: "src/core/http/routes.ts", slot: "app-names", content: '"admin",' },
		{
			file: "tsdown.config.ts",
			slot: "entries",
			content: '"apps/admin/server": "src/apps/admin/server.ts",',
		},
		{
			file: "src/apps/http.ts",
			slot: "imports",
			content: [
				'import { requireRole } from "@tatara/auth";',
				'import { except } from "hono/combine";',
				'import { attachStaffPrincipal, staffAuth } from "#modules/staff/services/auth";',
			].join("\n"),
		},
		{
			// the admin app knows only staff; the api app only users
			file: "src/apps/http.ts",
			slot: "middleware",
			order: 50,
			content: 'app.use(name === "admin" ? attachStaffPrincipal : attachPrincipal);',
		},
		{
			file: "src/apps/http.ts",
			slot: "routes",
			order: 2,
			content:
				'if (name === "admin") app.on(["GET", "POST"], `${API_PREFIX}/auth/*`, (c) =>\n\tstaffAuth.handler(withClientIp(c.req.raw, clientIp(c, { trustedHops: env.TRUSTED_PROXY_HOPS }))),\n);',
		},
		{
			// every other admin /api route needs a staff principal
			file: "src/apps/http.ts",
			slot: "routes",
			order: 5,
			content:
				'if (name === "admin") app.use(`${API_PREFIX}/*`, except(`${API_PREFIX}/auth/*`, requireRole("staff")));',
		},
		{
			file: "src/core/authz/system-roles.ts",
			slot: "roles",
			content:
				'{ key: "staff", name: "Staff", description: "Internal staff: platform permissions on the admin app.", heldBy: "identity" },',
		},
		{
			// Keycloak shops sign staff in with Keycloak too: a token with the staff role
			file: "src/modules/staff/services/auth.ts",
			slot: "resolvers",
			when: ["auth-keycloak"],
			content: '() => (c) => keycloakPrincipal(auth, c.req.header("authorization")),',
		},
		{
			file: "src/modules/staff/services/auth.ts",
			slot: "imports",
			when: ["auth-keycloak"],
			content:
				'import { keycloakPrincipal } from "@tatara/keycloak";\nimport { auth } from "#modules/users/services/auth";',
		},
		{
			file: "tests/helpers/api.ts",
			slot: "imports",
			content: 'import { app as adminApp } from "#apps/admin/app";',
		},
		{
			file: "tests/helpers/api.ts",
			slot: "exports",
			content:
				"\n/** Calls the admin app in-process. */\nexport const adminApi = client(adminApp);",
		},
		{
			file: "AGENTS.md",
			slot: "sections",
			content: `## Admin app and staff

- \`apps/admin\` is a second HTTP app on \`ADMIN_PORT\`. Routes with \`defineRoutes({ app: "admin", … })\`
  are served only there, and every \`/api\` route on it needs a staff principal (role \`staff\`).
- Staff are separate accounts (\`src/modules/staff\`, tables \`staff_*\`), with their own better-auth
  mounted at \`/api/auth\` on the admin app. They never share a table or a session with users.
  There's no staff sign-up; the dev account comes from \`SEED_STAFF_EMAIL\`/\`SEED_STAFF_PASSWORD\`.
- Staff act in the \`platform\` org, so grant platform permissions to the built-in \`staff\` role.
- Test it with \`adminApi\` from \`#tests/helpers/api\` and \`asStaff()\` from \`#tests/helpers/staff\`.
`,
		},
	],
};

const MEMBERS = `/** The org's members, a page at a time. */
async function* members(orgId: string) {
	const { adapter } = await auth.$context;
	for (let offset = 0; ; offset += 100) {
		const page = await adapter.findMany<{ userId: string; role: string }>({
			model: "member",
			where: [{ field: "organizationId", value: orgId }],
			limit: 100,
			offset,
			sortBy: { field: "id", direction: "asc" },
		});
		yield* page;
		if (page.length < 100) return;
	}
}`;

const hasRole = 'm.role.split(",").map((r) => r.trim()).includes(role)';

export const notifications: Feature = {
	id: "notifications",
	kind: "addon",
	label: "Notifications (in-app, email, SMS, push)",
	dependencies: ["@tatara/notifications"],
	env: [
		{
			key: "SMS_DRIVER",
			schema: 'z.enum(["console", "twilio"]).default("console")',
			example: "console",
			test: "console",
			comment: "How notifications send SMS; console logs them",
		},
		{ key: "TWILIO_ACCOUNT_SID", schema: "z.string().optional()", example: "" },
		{ key: "TWILIO_AUTH_TOKEN", schema: "z.string().optional()", example: "" },
		{
			key: "TWILIO_FROM",
			schema: "z.string().optional()",
			example: "",
			comment: "A Twilio number, or a messaging service sid (MG…)",
		},
		{
			key: "PUSH_DRIVER",
			schema: 'z.enum(["console", "fcm"]).default("console")',
			example: "console",
			test: "console",
			comment: "How notifications push to devices; console logs them",
		},
		{ key: "FCM_PROJECT_ID", schema: "z.string().optional()", example: "" },
		{ key: "FCM_CLIENT_EMAIL", schema: "z.string().optional()", example: "" },
		{
			key: "FCM_PRIVATE_KEY",
			schema: "z.string().optional()",
			example: "",
			comment: "The Firebase service account's private key (\\n escapes are fine)",
		},
	],
	slots: [
		{
			file: "src/modules/notifications/services/notifier.ts",
			slot: "recipients",
			unless: ["auth-orgs"],
			content: [
				"// without organizations there is no org to look people up in: notify users by id",
				"recipients: {",
				"\trole() {",
				'\t\tthrow new Error("Notifying by role needs organizations (the orgs auth method)");',
				"\t},",
				"\tpermission() {",
				'\t\tthrow new Error("Notifying by permission needs organizations and the authz add-on");',
				"\t},",
				"},",
			].join("\n"),
		},
		{
			file: "src/modules/notifications/services/notifier.ts",
			slot: "helpers",
			when: ["auth-orgs"],
			content: MEMBERS,
		},
		{
			file: "src/modules/notifications/services/notifier.ts",
			slot: "recipients",
			when: ["auth-orgs"],
			unless: ["authz"],
			content: [
				"recipients: {",
				"\tasync *role(orgId, role) {",
				`\t\tfor await (const m of members(orgId)) if (${hasRole}) yield m.userId;`,
				"\t},",
				"\tpermission() {",
				'\t\tthrow new Error("Notifying by permission needs the authz add-on");',
				"\t},",
				"},",
			].join("\n"),
		},
		{
			file: "src/modules/notifications/services/notifier.ts",
			slot: "recipients",
			when: ["auth-orgs", "authz"],
			content: [
				"recipients: {",
				"\t// authz roles (assigned, or held by every member): better-auth's member role is only owner or member",
				"\tasync *role(orgId, role) {",
				"\t\tfor await (const m of members(orgId)) {",
				'\t\t\tconst who = { userId: m.userId, orgId, orgRole: m.role, roles: [], kind: "user" as const, claims: {} };',
				"\t\t\tif ((await authz.effectivePermissions(who)).roles.includes(role)) yield m.userId;",
				"\t\t}",
				"\t},",
				"\t// the same check a request makes: built-in roles, assigned roles and overlays",
				"\tasync *permission(orgId, permission) {",
				"\t\tfor await (const m of members(orgId)) {",
				'\t\t\tconst who = { userId: m.userId, orgId, orgRole: m.role, roles: [], kind: "user" as const, claims: {} };',
				"\t\t\tif (await checkPermission(who, permission as PermissionKey)) yield m.userId;",
				"\t\t}",
				"\t},",
				"},",
			].join("\n"),
		},
		{
			file: "src/modules/notifications/services/notifier.ts",
			slot: "imports",
			when: ["auth-orgs", "authz"],
			content:
				'import { authz, checkPermission } from "#core/authz/index";\nimport type { PermissionKey } from "#generated/permissions";',
		},
		{
			file: "src/modules/notifications/services/notifier.ts",
			slot: "senders",
			when: ["email"],
			content: "email: { send: (message) => sendEmail(message) },",
		},
		{
			file: "src/modules/notifications/services/notifier.ts",
			slot: "imports",
			when: ["email"],
			content: 'import { sendEmail } from "#core/email/send";',
		},
		{
			// an inbox belongs to the org the request acts in
			file: "src/modules/notifications/routes/notifications.routes.ts",
			slot: "guard",
			when: ["auth-orgs"],
			content: "requireOrg(),",
		},
		{
			file: "src/modules/notifications/routes/notifications.routes.ts",
			slot: "imports",
			when: ["auth-orgs"],
			content: 'import { requireOrg } from "#modules/users/services/auth";',
		},
		{
			file: "AGENTS.md",
			slot: "sections",
			content: `## Notifications

- \`notify({ orgId, to, notification, data, channels?, idempotencyKey?, executor? })\` from
  \`#modules/notifications/services/notifier\`. \`to\` is \`{ user }\`, \`{ users }\`, \`{ role }\` or
  \`{ permission }\` (role and permission need organizations; permission needs authz).
- A notification is \`notifications/<name>.ts\` in a module: \`defineNotification({ name, schema, channels,
  inApp?, email?, sms?, push? })\`, each renderer taking \`(data, language)\`. \`inApp\` returns text
  (\`title\`, \`body\`) or keys (\`titleKey\`, \`bodyKey\`, \`params\`) that the inbox translates when
  it's read, in the reader's language (\`services/translate.ts\`).
- Delivery runs through jobs (\`notifications.fanout\`, then one \`notifications.deliver\` per user); each
  channel goes out once per recipient, and the same \`idempotencyKey\` never notifies anyone twice.
  Channels are at most once (a crash mid-send loses that send); list one in the notifier's
  \`delivery\` as \`"at-least-once"\` to resend it after a crash, with a stable idempotency key per send.
  Pass \`executor\` (with the Postgres jobs driver) to send only if your transaction commits.
- The rules are the app's: \`allow({ userId, notification, channel, data })\` in the notifier decides
  who gets which channel (store preferences in your own table); the inbox routes and tables are
  yours to change too.
- The inbox: \`GET /api/notifications\` (cursor), \`/unread-count\`, \`POST /read\`, and
  \`POST|DELETE /push-tokens\` for devices. \`SMS_DRIVER=twilio\` and \`PUSH_DRIVER=fcm\` send for real.
- In tests, jobs run inline: \`await (jobs.driver as InlineDriver).drain()\` after \`notify\`.
`,
		},
	],
};

export const realtime: Feature = {
	id: "realtime",
	kind: "addon",
	label: "Realtime (websockets)",
	dependencies: [
		"@tatara/realtime",
		"socket.io",
		"@socket.io/redis-adapter",
		"@socket.io/redis-emitter",
		"ioredis",
	],
	devDependencies: ["socket.io-client"],
	env: [
		{
			key: "REALTIME_DRIVER",
			schema: 'z.enum(["socketio", "noop"]).default("socketio")',
			example: "socketio",
			comment: "noop turns websockets off (publishes do nothing)",
		},
		{
			key: "REALTIME_ADAPTER",
			schema: 'localDefault(z.enum(["redis", "memory"]), "redis")',
			example: "redis",
			test: "memory",
			comment: "redis shares rooms across api processes and lets workers publish",
		},
		{ key: "REALTIME_PATH", schema: 'z.string().default("/realtime")', example: "/realtime" },
		{
			key: "REALTIME_TICKET_TTL_SECONDS",
			schema: "z.coerce.number().int().positive().default(60)",
			example: "60",
		},
		{
			key: "REDIS_PORT",
			schema: "",
			example: "6379",
			composeOnly: true,
			comment: "Host port for local Redis",
		},
		{ key: "REDIS_URL", schema: "z.url()", example: "redis://localhost:6379/0" },
	],
	compose: { redis: REDIS_SERVICE },
	slots: [
		{
			file: "src/apps/api/server.ts",
			slot: "imports",
			content:
				'import { realtime } from "#core/realtime/index";\nimport { channels } from "#generated/channels";',
		},
		{
			file: "src/apps/api/server.ts",
			slot: "server-options",
			content: [
				"// websockets share the api's port; an api that can't serve them shouldn't run half-working",
				"onServer: (server) => {",
				"\trealtime.attach(server as never, { channels }).catch((err: unknown) => {",
				'\t\tlogger.fatal({ err }, "realtime could not attach");',
				"\t\tprocess.exit(1);",
				"\t});",
				"},",
			].join("\n"),
		},
		{
			// a socket acts in one org, like a request
			file: "src/modules/realtime/routes/realtime.routes.ts",
			slot: "guard",
			when: ["auth-orgs"],
			content: "requireOrg(),",
		},
		{
			file: "src/modules/realtime/routes/realtime.routes.ts",
			slot: "imports",
			when: ["auth-orgs"],
			content: 'import { requireOrg } from "#modules/users/services/auth";',
		},
		{
			// the inbox updates live in every open tab
			file: "src/modules/notifications/services/notifier.ts",
			slot: "senders",
			when: ["notifications"],
			content: [
				"onInApp: (row) =>",
				'\tpublishToUser(row.orgId, row.userId, "notification.created", {',
				"\t\tid: row.id,",
				"\t\ttitle: row.title,",
				"\t\tbody: row.body ?? null,",
				"\t\turl: row.url ?? null,",
				"\t}),",
			].join("\n"),
		},
		{
			file: "src/modules/notifications/services/notifier.ts",
			slot: "imports",
			when: ["notifications"],
			content: 'import { publishToUser } from "#core/realtime/index";',
		},
		{
			file: "AGENTS.md",
			slot: "sections",
			content: `## Realtime

- A client asks \`POST /api/realtime/ticket\` (signed in) for a single-use ticket, then connects with
  socket.io: \`io(API_URL, { path: "/realtime", transports: ["websocket"], auth: { ticket } })\`.
  A socket belongs to one user in one org, and joins that user's and that org's rooms.
- Publish from any process (api, worker, cron): \`publishToUser(orgId, userId, event, payload)\`,
  \`publishToOrg(orgId, event, payload)\` from \`#core/realtime/index\`. Clients receive every event on
  \`"rt"\` as \`{ id, v, ch, ev, ts, data }\` (\`ch\` is \`"org"\`, \`"user:<id>"\` or the channel name).
- \`disconnectUser(orgId, userId, reason)\` / \`disconnectOrg(orgId, reason)\` close sockets when access
  changes, after sending \`"rt:closed" { reason }\`; clients reconnect with a new ticket.
- Rooms of your own: \`channels/<name>.ts\` in a module, \`defineChannel({ name: "survey.{surveyId}",
  events: { "answer.created": schema }, permission?, feature?, authorize?(who, params) })\`. Clients
  \`emit("subscribe", name)\` and get \`{ ok, channel, code? }\`; publish with
  \`publishTo(channel, { orgId, params, event, payload })\` (typed; a bad payload is logged and dropped).
- With notifications, every inbox entry is also pushed as \`notification.created\`.
`,
		},
	],
};

export const observability: Feature = {
	id: "observability",
	kind: "addon",
	label: "Observability (OpenTelemetry)",
	dependencies: [
		"@tatara/observability",
		"@opentelemetry/api",
		"@opentelemetry/sdk-node",
		"@opentelemetry/sdk-trace",
		"@opentelemetry/sdk-metrics",
		"@opentelemetry/resources",
		"@opentelemetry/exporter-trace-otlp-http",
		"@opentelemetry/exporter-metrics-otlp-http",
		"@opentelemetry/auto-instrumentations-node",
		"@opentelemetry/instrumentation",
		"import-in-the-middle",
		"@hono/otel",
	],
	allowBuilds: ["protobufjs"],
	scripts: { start: "node --import ./dist/apps/instrument.mjs dist/apps/api/server.mjs" },
	variants: [
		{
			when: ["jobs"],
			scripts: {
				"start:worker": "node --import ./dist/apps/instrument.mjs dist/apps/worker/index.mjs",
				"start:cron": "node --import ./dist/apps/instrument.mjs dist/apps/cron/index.mjs",
			},
		},
		{
			when: ["admin"],
			scripts: {
				"start:admin": "node --import ./dist/apps/instrument.mjs dist/apps/admin/server.mjs",
			},
		},
	],
	env: [
		{
			key: "OTEL_EXPORTER_OTLP_ENDPOINT",
			schema: "z.url().optional()",
			example: "",
			comment: "OTLP/HTTP collector, e.g. http://localhost:4318; empty sends nothing",
		},
		{
			key: "OTEL_SERVICE_NAME",
			schema: 'z.string().default("__APP_NAME__")',
			example: "__APP_NAME__",
		},
		{
			key: "OTEL_TRACES_SAMPLE_RATIO",
			schema: "z.coerce.number().min(0).max(1).default(1)",
			example: "1",
			comment: "Share of new traces kept (0–1)",
		},
	],
	slots: [
		{
			file: "tsdown.config.ts",
			slot: "entries",
			content: '"apps/instrument": "src/apps/instrument.ts",',
		},
		{
			// every process the image runs (api, worker, cron, the CLI) starts instrumented
			file: "Dockerfile",
			slot: "docker-runtime",
			order: 60,
			content: 'ENV NODE_OPTIONS="--import /app/dist/apps/instrument.mjs"',
		},
		{
			file: "src/apps/http.ts",
			slot: "imports",
			content: 'import { httpTracing } from "@tatara/observability";',
		},
		{
			file: "src/apps/http.ts",
			slot: "middleware",
			order: 5,
			content: "app.use(httpTracing(env.OTEL_SERVICE_NAME));",
		},
		{
			file: "src/core/logging/logger.ts",
			slot: "imports",
			content: 'import { traceIds } from "@tatara/observability";',
		},
		{
			// log lines carry trace_id and span_id, so a log search lands on its trace
			file: "src/core/logging/logger.ts",
			slot: "logger-options",
			content: "mixin: traceIds,",
		},
		{
			file: "AGENTS.md",
			slot: "sections",
			content: `## Observability

- Set \`OTEL_EXPORTER_OTLP_ENDPOINT\` (any OTLP/HTTP collector: Grafana, Honeycomb, Datadog, Jaeger…)
  and every process sends traces and metrics. Requests, database, Redis and HTTP calls are traced
  for you; log lines carry \`trace_id\` and \`span_id\`.
- Processes start with \`node --import ./dist/apps/instrument.mjs\` (the Dockerfile sets it in
  \`NODE_OPTIONS\`); without it nothing is instrumented.
- Your own spans: \`trace.getTracer("billing").startActiveSpan(...)\` from \`@opentelemetry/api\`.
`,
		},
	],
};

export const storage: Feature = {
	id: "storage",
	kind: "addon",
	label: "File storage",
	dependencies: ["@tatara/storage", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"],
	env: [
		{
			key: "STORAGE_DRIVER",
			schema: 'localDefault(z.enum(["local", "s3"]), "local")',
			example: "s3",
			test: "local",
		},
		{ key: "STORAGE_LOCAL_DIR", schema: 'z.string().default(".storage")', example: ".storage" },
		{
			key: "S3_ENDPOINT",
			schema: "z.url().optional()",
			example: "http://localhost:9000",
			comment: "Empty for AWS S3",
		},
		{ key: "S3_REGION", schema: 'z.string().default("us-east-1")', example: "us-east-1" },
		{ key: "S3_BUCKET", schema: 'z.string().default("__APP_NAME__")', example: "__APP_NAME__" },
		{ key: "S3_ACCESS_KEY_ID", schema: "z.string().optional()", example: "tatara" },
		{ key: "S3_SECRET_ACCESS_KEY", schema: "z.string().optional()", example: "tatara-secret" },
		{ key: "S3_FORCE_PATH_STYLE", schema: "z.stringbool().default(true)", example: "true" },
		{ key: "STORAGE_PORT", schema: "", example: "9000", composeOnly: true },
		{ key: "STORAGE_CONSOLE_PORT", schema: "", example: "9001", composeOnly: true },
	],
	compose: {
		storage: {
			image: "rustfs/rustfs:1.0.1",
			environment: {
				RUSTFS_ACCESS_KEY: "tatara",
				RUSTFS_SECRET_KEY: "tatara-secret",
				RUSTFS_CONSOLE_ENABLE: "true",
			},
			ports: ["${STORAGE_PORT:-9000}:9000", "${STORAGE_CONSOLE_PORT:-9001}:9001"],
			volumes: ["storage-data:/data"],
			healthcheck: {
				test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:9000/health || exit 1"],
				interval: "2s",
				timeout: "3s",
				retries: 30,
			},
		},
	},
	composeVolumes: ["storage-data"],
	slots: [
		{
			file: "Dockerfile",
			slot: "docker-runtime",
			order: 50,
			// the image runs as node; STORAGE_DRIVER=local writes to STORAGE_LOCAL_DIR (.storage)
			content: "RUN mkdir -p .storage && chown node:node .storage",
		},
		{ file: ".gitignore", slot: "ignore", content: ".storage/" },
		{
			file: "AGENTS.md",
			slot: "sections",
			content: `## Storage

- Use \`storage\` from \`#core/storage/index\` (\`put\`, \`get\`, \`delete\`, \`url\`). \`STORAGE_DRIVER=s3\` works with
  any S3-compatible store (RustFS locally, AWS S3, R2); \`local\` writes to \`STORAGE_LOCAL_DIR\` (tests).
- \`tatara run storage:check\` creates the bucket and does a round-trip.
`,
		},
	],
};

export const email: Feature = {
	id: "email",
	kind: "addon",
	label: "Email",
	dependencies: ["@tatara/email", "nodemailer"],
	devDependencies: ["@types/nodemailer"],
	env: [
		{
			key: "EMAIL_DRIVER",
			schema: 'localDefault(z.enum(["smtp", "mailgun", "console"]), "console")',
			example: "smtp",
			test: "console",
		},
		{
			key: "MAILGUN_API_KEY",
			schema: "z.string().optional()",
			example: "",
			comment: "For EMAIL_DRIVER=mailgun",
		},
		{ key: "MAILGUN_DOMAIN", schema: "z.string().optional()", example: "" },
		{
			key: "MAILGUN_API_URL",
			schema: 'z.url().default("https://api.mailgun.net")',
			example: "https://api.mailgun.net",
			comment: "https://api.eu.mailgun.net for EU domains",
		},
		{
			key: "SMTP_URL",
			schema: 'localDefault(z.string(), "smtp://localhost:1025")',
			example: "smtp://localhost:1025",
		},
		{
			key: "EMAIL_FROM",
			schema: 'z.string().default("__APP_NAME__ <no-reply@example.com>")',
			example: "__APP_NAME__ <no-reply@example.com>",
		},
		{ key: "MAILPIT_SMTP_PORT", schema: "", example: "1025", composeOnly: true },
		{ key: "MAILPIT_UI_PORT", schema: "", example: "8025", composeOnly: true },
	],
	compose: {
		mailpit: {
			image: "axllent/mailpit:v1.31",
			ports: ["${MAILPIT_SMTP_PORT:-1025}:1025", "${MAILPIT_UI_PORT:-8025}:8025"],
			healthcheck: {
				test: ["CMD", "/mailpit", "readyz"],
				interval: "2s",
				timeout: "3s",
				retries: 30,
			},
		},
	},
	slots: [
		{
			file: "AGENTS.md",
			slot: "sections",
			content: `## Email

- \`sendEmail({ to, subject, text, html? })\` from \`#core/email/send\`. Locally it goes to Mailpit
  (UI on \`MAILPIT_UI_PORT\`); tests use the console driver; \`EMAIL_DRIVER=mailgun\` sends through Mailgun.
- Templates: \`emails/<name>.ts\` in a module (\`defineEmail({ name, schema, render(data, language) })\` from
  \`@tatara/email\`), sent with \`sendTemplate(name, to, data, language)\`.
`,
		},
	],
};

export const i18n: Feature = {
	id: "i18n",
	kind: "addon",
	label: "i18n",
	dependencies: ["@tatara/i18n"],
	env: [{ key: "DEFAULT_LANGUAGE", schema: 'z.enum(["en", "ar"]).default("en")', example: "en" }],
	slots: [
		{
			file: "src/apps/http.ts",
			slot: "imports",
			content: 'import { detectLanguage } from "#core/i18n/index";',
		},
		{
			file: "src/apps/http.ts",
			slot: "middleware",
			order: 10,
			content: "app.use(detectLanguage);",
		},
		{
			file: "src/apps/http.ts",
			slot: "imports",
			content: 'import { t } from "#core/i18n/index";',
		},
		{
			file: "src/apps/http.ts",
			slot: "error-options",
			content: [
				"message: (err, c) =>",
				'\terr.translatable ? t(c.get("language"), `errors.${err.code}`, err.message) : err.message,',
			].join("\n"),
		},
		{
			file: "AGENTS.md",
			slot: "sections",
			content: `## i18n

- Language comes from \`?lang\`, the \`lang\` cookie, then \`Accept-Language\` (\`c.var.language\`).
- Strings live in \`src/locales/<lang>.json\`; use \`t(language, "errors.NOT_FOUND")\`. Error responses are
  translated by code (\`errors.<CODE>\`), so add a key when you add an error code.
`,
		},
	],
};
