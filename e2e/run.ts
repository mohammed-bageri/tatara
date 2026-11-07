/**
 * End-to-end matrix: generate each app from the packed CLI, verify it, boot it, smoke-test every
 * feature it has, run the generators, verify again. Usage:
 *   node e2e/run.ts [--only a,b] [--parallel 2] [--keep] [--list]
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { hashTrackedFiles } from "../packages/cli/src/project/hashes.ts";
import { packCli, packLibraries, run } from "./lib.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";

const ROOT = resolve(import.meta.dirname, "..");
const WORK = join(ROOT, ".e2e");
const RUNS = join(WORK, "runs");
const CLI = join(ROOT, "packages/cli");

interface StepResult {
	step: string;
	ok: boolean;
	ms: number;
	detail?: string;
}

interface ScenarioResult {
	name: string;
	ok: boolean;
	ms: number;
	steps: StepResult[];
}

function args() {
	const argv = process.argv.slice(2);
	const get = (flag: string) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	return {
		only: get("--only")?.split(","),
		parallel: Number(get("--parallel") ?? "1"),
		keep: argv.includes("--keep"),
		list: argv.includes("--list"),
	};
}

/** Moves every local port by `offset` and gives the compose project a unique name. */
function remapPorts(dir: string, offset: number, project: string) {
	const ports = ["5432", "3306", "6379", "9000", "9001", "1025", "8025", "8080", "3000", "3001"];
	for (const file of [".env", ".env.test"]) {
		const path = join(dir, file);
		if (!existsSync(path)) continue;
		let text = readFileSync(path, "utf8");
		for (const port of ports) {
			const next = String(Number(port) + offset);
			text = text.replace(new RegExp(`(localhost:)${port}\\b`, "g"), `$1${next}`);
			text = text.replace(
				new RegExp(
					`^((?:DB|REDIS|STORAGE|STORAGE_CONSOLE|MAILPIT_SMTP|MAILPIT_UI|KEYCLOAK|ADMIN)_PORT|PORT)=${port}$`,
					"gm",
				),
				`$1=${next}`,
			);
		}
		if (file === ".env") text += `COMPOSE_PROJECT_NAME=${project}\n`;
		writeFileSync(path, text);
	}
}

function envOf(dir: string): Record<string, string> {
	return parseEnv(readFileSync(join(dir, ".env"), "utf8")) as Record<string, string>;
}

async function waitFor(url: string, timeoutMs = 30_000): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		try {
			const res = await fetch(url);
			if (res.ok) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}

class Check extends Error {}

function expect(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Check(message);
}

async function json(res: Response): Promise<Record<string, unknown>> {
	const text = await res.text();
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { raw: text };
	}
}

const BROWSER = { "content-type": "application/json", origin: "http://localhost:5173" };

/** A bearer token for a fresh user (and, with `admin`, for the seeded admin). */
async function tokenFor(
	s: Scenario,
	base: string,
	dir: string,
	who: "user" | "admin",
): Promise<string | undefined> {
	if (s.auth === "none") return undefined;
	if (s.authMethods?.includes("keycloak")) {
		const out = await run(
			"node",
			[
				"--env-file=.env",
				"dist/apps/cli/index.mjs",
				"keycloak:token",
				"--user",
				who === "admin" ? "alice" : "bob",
			],
			{ cwd: dir },
		);
		const token = out.out.trim().split("\n").at(-1) ?? "";
		expect(
			out.code === 0 && token.split(".").length === 3,
			`keycloak:token failed: ${out.out.slice(-300)}`,
		);
		return token;
	}
	const methods = s.authMethods ?? [];
	const env = envOf(dir);
	const email =
		who === "admin"
			? (env.SEED_ADMIN_EMAIL ?? "admin@example.com")
			: `e2e-${Date.now()}@example.com`;
	if (methods.includes("email-otp")) {
		await fetch(`${base}/api/auth/email-otp/send-verification-otp`, {
			method: "POST",
			headers: BROWSER,
			body: JSON.stringify({ email, type: "sign-in" }),
		});
		const outbox = await json(
			await fetch(`${base}/api/dev/outbox?to=${encodeURIComponent(email)}`),
		);
		const code = (outbox.messages as { code?: string }[] | undefined)?.[0]?.code;
		expect(code, "no OTP in the dev outbox");
		const res = await fetch(`${base}/api/auth/sign-in/email-otp`, {
			method: "POST",
			headers: BROWSER,
			body: JSON.stringify({ email, otp: code }),
		});
		const token = res.headers.get("set-auth-token");
		expect(res.ok && token, `email OTP sign-in failed (${res.status})`);
		return token;
	}
	if (methods.includes("password")) {
		const password = who === "admin" ? env.SEED_ADMIN_PASSWORD : "correct-horse-battery-staple";
		if (who === "user") {
			const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
				method: "POST",
				headers: BROWSER,
				body: JSON.stringify({ email, password, name: "E2E" }),
			});
			expect(signUp.ok, `sign-up failed (${signUp.status})`);
		}
		const res = await fetch(`${base}/api/auth/sign-in/email`, {
			method: "POST",
			headers: BROWSER,
			body: JSON.stringify({ email, password }),
		});
		const token = res.headers.get("set-auth-token");
		expect(res.ok && token, `password sign-in failed (${res.status})`);
		return token;
	}
	expect(who === "user", "admin sign-in needs email-otp or password");
	const phone = `+1555${String(Date.now()).slice(-7)}`;
	await fetch(`${base}/api/auth/phone-number/send-otp`, {
		method: "POST",
		headers: BROWSER,
		body: JSON.stringify({ phoneNumber: phone }),
	});
	const outbox = await json(await fetch(`${base}/api/dev/outbox?to=${encodeURIComponent(phone)}`));
	const code = (outbox.messages as { code?: string }[] | undefined)?.[0]?.code;
	expect(code, "no SMS code in the dev outbox");
	const res = await fetch(`${base}/api/auth/phone-number/verify`, {
		method: "POST",
		headers: BROWSER,
		body: JSON.stringify({ phoneNumber: phone, code }),
	});
	const token = res.headers.get("set-auth-token");
	expect(res.ok && token, `phone sign-in failed (${res.status})`);
	return token;
}

function start(dir: string, file: string, log: string): ChildProcess {
	const child = spawn("node", ["--env-file=.env", file], {
		cwd: dir,
		env: { ...process.env, FORCE_COLOR: "0" },
	});
	child.stdout?.on("data", (d: Buffer) => writeFileSync(log, d, { flag: "a" }));
	child.stderr?.on("data", (d: Buffer) => writeFileSync(log, d, { flag: "a" }));
	return child;
}

async function smoke(s: Scenario, dir: string, logDir: string): Promise<string[]> {
	const notes: string[] = [];
	const env = envOf(dir);
	const base = `http://localhost:${env.PORT}`;
	const children: ChildProcess[] = [
		start(dir, "dist/apps/api/server.mjs", join(logDir, "api.log")),
	];
	try {
		expect(await waitFor(`${base}/health`), "API did not start");
		const ready = await json(await fetch(`${base}/ready`));
		expect(ready.ready === true, `not ready: ${JSON.stringify(ready)}`);
		expect((await fetch(`${base}/docs`)).ok, "/docs failed");
		const spec = await json(await fetch(`${base}/openapi.json`));
		expect(Object.keys((spec.paths as object) ?? {}).length > 0, "OpenAPI has no paths");
		expect((await fetch(`${base}/api/greetings?name=E2E`)).ok, "greetings failed");
		if (s.database !== "none") {
			// what a deploy runs: migrations, then the deploy commands; the second run finds nothing to do once
			for (let i = 0; i < 2; i++) {
				const deploy = await run("node", ["--env-file=.env", "dist/apps/cli/index.mjs", "deploy"], {
					cwd: dir,
				});
				expect(deploy.code === 0, `deploy: ${deploy.out.slice(-400)}`);
			}
			notes.push("deploy");
		}

		const user = await tokenFor(s, base, dir, "user");
		// apps with organizations act in one: set once the admin has created it
		let orgHeader: Record<string, string> = {};
		const auth = (token?: string): Record<string, string> =>
			token
				? { authorization: `Bearer ${token}`, "content-type": "application/json", ...orgHeader }
				: { "content-type": "application/json" };
		if (user) {
			const me = await json(await fetch(`${base}/api/me`, { headers: auth(user) }));
			expect(
				(me.data as { userId?: string } | undefined)?.userId,
				`/api/me failed: ${JSON.stringify(me)}`,
			);
			expect((await fetch(`${base}/api/me`)).status === 401, "/api/me without token was not 401");
			notes.push("auth");
		}

		let crudToken = user;
		if (s.addons.includes("authz") && user) {
			const admin =
				s.authMethods?.includes("orgs") || s.authMethods?.includes("keycloak")
					? await tokenFor(s, base, dir, "admin")
					: undefined;
			if (admin) crudToken = admin;
			if (admin && s.authMethods?.includes("orgs") && s.authMethods?.includes("keycloak")) {
				// Keycloak tokens carry the org (the dev realm's Demo School); act in it
				const me = await json(await fetch(`${base}/api/me`, { headers: auth(admin) }));
				const orgId = (me.data as { orgId?: string | null } | undefined)?.orgId;
				expect(orgId, `the Keycloak token named no organization: ${JSON.stringify(me)}`);
				orgHeader = { "x-org-id": orgId as string };
			} else if (admin && s.authMethods?.includes("orgs")) {
				const org = await json(
					await fetch(`${base}/api/auth/organization/create`, {
						method: "POST",
						headers: auth(admin),
						body: JSON.stringify({ name: "E2E School", slug: `e2e-${Date.now()}` }),
					}),
				);
				const orgId = (org as { id?: string }).id;
				expect(orgId, `organization/create failed: ${JSON.stringify(org)}`);
				orgHeader = { "x-org-id": orgId as string };
			}
			if (!admin) {
				const me = await json(await fetch(`${base}/api/me`, { headers: auth(user) }));
				const userId = (me.data as { userId: string }).userId;
				const grant = await run(
					"node",
					[
						"--env-file=.env",
						"dist/apps/cli/index.mjs",
						"authz:grant-role",
						"--user",
						userId,
						"--role",
						"admin",
					],
					{ cwd: dir },
				);
				expect(grant.code === 0, `authz:grant-role failed: ${grant.out.slice(-300)}`);
			}
			const perms = await json(
				await fetch(`${base}/api/authorization/me`, { headers: auth(crudToken) }),
			);
			expect(
				(perms.data as { roles?: string[] } | undefined)?.roles?.includes("admin"),
				`authorization/me: ${JSON.stringify(perms)}`,
			);
			expect(
				(await fetch(`${base}/api/authorization/roles`, { headers: auth(crudToken) })).ok,
				"roles list failed",
			);
			if (crudToken !== user) {
				// members may read projects; creating one is for admins
				expect(
					(
						await fetch(`${base}/api/projects`, {
							method: "POST",
							headers: auth(user),
							body: JSON.stringify({ name: "Nope" }),
						})
					).status === 403,
					"plain user could create a project",
				);
			}
			notes.push("authz");
		}

		if (s.database !== "none") {
			if (user)
				expect(
					(await fetch(`${base}/api/projects`)).status === 401,
					"projects without token was not 401",
				);
			const created = await fetch(`${base}/api/projects`, {
				method: "POST",
				headers: auth(crudToken),
				body: JSON.stringify({ name: "E2E project" }),
			});
			const body = await json(created);
			expect(created.status === 201, `create project: ${created.status} ${JSON.stringify(body)}`);
			const id = (body.data as { id: string }).id;
			const list = await json(await fetch(`${base}/api/projects`, { headers: auth(crudToken) }));
			expect((list.meta as { total: number }).total >= 1, "project list empty");
			const removed = await fetch(`${base}/api/projects/${id}`, {
				method: "DELETE",
				headers: auth(crudToken),
			});
			expect(removed.status === 204, `delete project: ${removed.status}`);
			notes.push("crud");
		}

		if (s.addons.includes("i18n")) {
			const res = await json(
				await fetch(`${base}/api/greetings?name=${"x".repeat(60)}`, {
					headers: { "accept-language": "ar" },
				}),
			);
			expect(res.error === "الطلب غير صالح", `i18n: ${JSON.stringify(res)}`);
			notes.push("i18n");
		}

		if (s.addons.includes("admin")) {
			const adminBase = `http://localhost:${env.ADMIN_PORT}`;
			children.push(start(dir, "dist/apps/admin/server.mjs", join(logDir, "admin.log")));
			expect(await waitFor(`${adminBase}/health`), "admin app did not start");
			expect(
				(await fetch(`${adminBase}/api/greetings`)).status === 401,
				"admin without token was not 401",
			);
			// users' sessions belong to the api app; the admin app knows only staff
			if (user)
				expect(
					[401, 403].includes(
						(await fetch(`${adminBase}/api/greetings`, { headers: auth(user) })).status,
					),
					"a user token worked on the admin app",
				);
			let staffToken: string | undefined;
			if (s.authMethods?.includes("keycloak")) {
				staffToken = await tokenFor(s, base, dir, "admin"); // alice has the staff realm role
			} else {
				const signIn = await fetch(`${adminBase}/api/auth/sign-in/email`, {
					method: "POST",
					headers: BROWSER,
					body: JSON.stringify({
						email: env.SEED_STAFF_EMAIL ?? "staff@example.com",
						password: env.SEED_STAFF_PASSWORD,
					}),
				});
				staffToken = signIn.headers.get("set-auth-token") ?? undefined;
				expect(
					staffToken,
					`staff sign-in on the admin app: ${signIn.status} ${await signIn.text()}`,
				);
			}
			const res = await fetch(`${adminBase}/api/greetings`, {
				headers: { authorization: `Bearer ${staffToken}` },
			});
			expect(res.status === 200, `admin with a staff token: ${res.status}`);
			notes.push("admin");
		}

		if (s.addons.includes("storage")) {
			const res = await run(
				"node",
				["--env-file=.env", "dist/apps/cli/index.mjs", "storage:check"],
				{ cwd: dir },
			);
			expect(
				res.code === 0 && res.out.includes("storage OK"),
				`storage:check: ${res.out.slice(-400)}`,
			);
			notes.push("storage");
		}

		if (s.addons.includes("email")) {
			const res = await run(
				"node",
				[
					"--env-file=.env",
					"dist/apps/cli/index.mjs",
					"email:send-test",
					"--to",
					"e2e@example.com",
				],
				{ cwd: dir },
			);
			expect(res.code === 0, `email:send-test: ${res.out.slice(-400)}`);
			const box = await json(
				await fetch(`http://localhost:${env.MAILPIT_UI_PORT}/api/v1/messages`),
			);
			expect(Number(box.total) >= 1, "Mailpit received nothing");
			notes.push("email");
		}

		if (s.addons.includes("observability")) {
			// the production start: instrumented, sending to a collector (here, a stand-in)
			const paths: string[] = [];
			let traces = "";
			const collector = createServer((req, res) => {
				paths.push(req.url ?? "");
				req.on("data", (chunk: Buffer) => {
					if (req.url === "/v1/traces") traces += chunk.toString();
				});
				req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
			});
			await new Promise<void>((r) => collector.listen(0, r));
			const port = Number(env.PORT) + 50;
			const traced = spawn(
				"node",
				["--env-file=.env", "--import", "./dist/apps/instrument.mjs", "dist/apps/api/server.mjs"],
				{
					cwd: dir,
					env: {
						...process.env,
						PORT: String(port),
						OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${(collector.address() as AddressInfo).port}`,
					},
				},
			);
			try {
				expect(await waitFor(`http://localhost:${port}/health`), "instrumented API did not start");
				expect(
					(await fetch(`http://localhost:${port}/api/greetings?name=OTel`)).ok,
					"greetings failed",
				);
				// /ready queries the database: its span proves the libraries themselves were patched
				await fetch(`http://localhost:${port}/ready`);
			} finally {
				// a graceful stop flushes the spans
				traced.kill("SIGTERM");
				await new Promise((r) => traced.once("exit", r));
				collector.close();
			}
			expect(
				paths.includes("/v1/traces"),
				`no traces reached the collector (got ${paths.join(", ")})`,
			);
			if (s.database === "postgres")
				expect(
					traces.includes("instrumentation-pg"),
					"no Postgres spans: the ESM hooks didn't patch pg",
				);
			notes.push("telemetry");
		}

		if (s.addons.includes("realtime") && crudToken) {
			// a real client on the running api; the publish comes from another process, through Redis
			const ticket = await json(
				await fetch(`${base}/api/realtime/ticket`, { method: "POST", headers: auth(crudToken) }),
			);
			const t = (ticket.data as { ticket?: string } | undefined)?.ticket;
			expect(t, `realtime/ticket failed: ${JSON.stringify(ticket)}`);
			const me = await json(await fetch(`${base}/api/me`, { headers: auth(crudToken) }));
			const who = me.data as { userId: string; orgId: string | null };
			const client = run(
				"node",
				[
					"--input-type=module",
					"-e",
					`import { io } from "socket.io-client";
const s = io(${JSON.stringify(base)}, { path: "/realtime", transports: ["websocket"], auth: { ticket: ${JSON.stringify(t)} }, reconnection: false });
const fail = setTimeout(() => { console.error("no event"); process.exit(1); }, 15000);
s.on("connect_error", (e) => { console.error(e.message); process.exit(1); });
s.on("connect", () => console.log("connected"));
s.on("rt", (m) => { if (m.ev !== "e2e.ping") return; clearTimeout(fail); console.log(JSON.stringify(m.data)); process.exit(0); });`,
				],
				{ cwd: dir },
			);
			await new Promise((r) => setTimeout(r, 1500));
			const published = await run(
				"node",
				[
					"--env-file=.env",
					"dist/apps/cli/index.mjs",
					"realtime:publish",
					"--org",
					who.orgId ?? "default",
					"--user",
					who.userId,
					"--event",
					"e2e.ping",
					"--data",
					'{"ok":true}',
				],
				{ cwd: dir },
			);
			expect(published.code === 0, `realtime:publish: ${published.out.slice(-300)}`);
			const received = await client;
			expect(received.code === 0, `the socket got no event: ${received.out.slice(-300)}`);
			notes.push("realtime");
		}

		if (s.addons.includes("jobs")) {
			const workerLog = join(logDir, "worker.log");
			children.push(start(dir, "dist/apps/worker/index.mjs", workerLog));
			children.push(start(dir, "dist/apps/cron/index.mjs", join(logDir, "cron.log")));
			const queued = await run(
				"node",
				[
					"--env-file=.env",
					"dist/apps/cli/index.mjs",
					"jobs:enqueue",
					"--topic",
					"example.send-welcome",
					"--data",
					'{"name":"E2E"}',
				],
				{ cwd: dir },
			);
			expect(queued.code === 0, `jobs:enqueue: ${queued.out.slice(-300)}`);
			const end = Date.now() + 15_000;
			let handled = false;
			while (Date.now() < end && !handled) {
				await new Promise((r) => setTimeout(r, 300));
				handled = existsSync(workerLog) && readFileSync(workerLog, "utf8").includes("welcome sent");
			}
			expect(handled, "worker did not process the job");
			expect(
				readFileSync(join(logDir, "cron.log"), "utf8").includes("cron started"),
				"cron did not start",
			);
			// a platform scheduler's way in: the same schedule, under the same lock
			const scheduled = await run(
				"node",
				[
					"--env-file=.env",
					"dist/apps/cli/index.mjs",
					"schedule:run",
					"--name",
					"example.heartbeat",
				],
				{ cwd: dir },
			);
			expect(scheduled.code === 0, `schedule:run: ${scheduled.out.slice(-300)}`);
			notes.push("jobs");
		}
	} finally {
		for (const child of children) child.kill("SIGTERM");
		await new Promise((r) => setTimeout(r, 500));
	}
	return notes;
}

const GENERATORS: { kind: string; name: string; when?: (s: Scenario) => boolean }[] = [
	{ kind: "module", name: "billing" },
	{ kind: "route", name: "report" },
	{ kind: "service", name: "pricing" },
	{ kind: "command", name: "recalculate" },
	{ kind: "resource", name: "invoice", when: (s) => s.database !== "none" },
	{ kind: "schema", name: "line-item", when: (s) => s.database !== "none" },
	{ kind: "consumer", name: "invoice-paid", when: (s) => s.addons.includes("jobs") },
	{ kind: "schedule", name: "nightly-close", when: (s) => s.addons.includes("jobs") },
	{ kind: "permission", name: "ledger", when: (s) => s.addons.includes("authz") },
];

async function runScenario(
	s: Scenario,
	slot: number,
	packed: string,
	librarySpecs: string,
	keep: boolean,
): Promise<ScenarioResult> {
	const started = Date.now();
	const dir = join(RUNS, s.name);
	const logDir = join(WORK, "logs", s.name);
	const project = `tatara-e2e-${s.name}`;
	const steps: StepResult[] = [];
	const pmRun = s.pm === "npm" ? ["npm", "run"] : [s.pm, "run"];
	const pathEnv =
		s.pm === "bun" ? { PATH: `${join(WORK, "tools/node_modules/.bin")}:${process.env.PATH}` } : {};
	const tatara = join(dir, "node_modules/.bin/tatara");

	if (existsSync(dir)) {
		await run("docker", ["compose", "down", "--volumes", "--remove-orphans"], { cwd: dir });
		rmSync(dir, { recursive: true, force: true });
	}
	rmSync(logDir, { recursive: true, force: true });
	mkdirSync(logDir, { recursive: true });
	mkdirSync(RUNS, { recursive: true });

	const step = async (name: string, fn: () => Promise<string | undefined | void>) => {
		const t = Date.now();
		try {
			const detail = (await fn()) ?? undefined;
			steps.push({ step: name, ok: true, ms: Date.now() - t, ...(detail ? { detail } : {}) });
			return true;
		} catch (error) {
			steps.push({
				step: name,
				ok: false,
				ms: Date.now() - t,
				detail: (error as Error).message.slice(0, 1500),
			});
			return false;
		}
	};
	const sh = async (cmd: string, cmdArgs: string[], label: string, env: NodeJS.ProcessEnv = {}) => {
		const res = await run(cmd, cmdArgs, {
			cwd: dir,
			env: { ...pathEnv, ...env },
			log: join(logDir, `${label}.log`),
		});
		if (res.code !== 0) throw new Error(`${label} exited ${res.code}:\n${res.out.slice(-1200)}`);
		return res.out;
	};

	const ok =
		(await step("new", async () => {
			const res = await run(
				"node",
				// --framework-tests: tatara's own wiring tests run in every scenario, not in real apps
				[
					join(CLI, "dist/bin.mjs"),
					"new",
					dir,
					...s.flags,
					"--yes",
					"--no-git",
					"--framework-tests",
				],
				{
					cwd: RUNS,
					env: {
						...pathEnv,
						TATARA_CLI_SPEC: `file:${packed}`,
						TATARA_PACKAGE_SPECS: librarySpecs,
					},
					log: join(logDir, "new.log"),
				},
			);
			if (res.code !== 0) throw new Error(res.out.slice(-1500));
			if (res.out.includes("Formatting reported problems"))
				throw new Error(`formatting problems:\n${res.out.slice(-1500)}`);
			const recorded = (
				JSON.parse(readFileSync(join(dir, "tatara.json"), "utf8")) as {
					generated?: { files: Record<string, string> };
				}
			).generated?.files;
			if (!recorded) throw new Error("tatara.json has no generated.files");
			const actual = await hashTrackedFiles(dir);
			const paths = [...new Set([...Object.keys(recorded), ...Object.keys(actual)])].sort();
			const differs = paths.find((p) => recorded[p] !== actual[p]);
			if (differs) throw new Error(`generated.files does not match ${differs} on disk`);
			remapPorts(dir, 10_000 + slot * 100, project);
		})) &&
		(await step("services", async () => {
			if (!existsSync(join(dir, "compose.yaml"))) return "none";
			await sh("docker", ["compose", "up", "--detach", "--wait"], "compose-up");
		})) &&
		(await step("verify", async () => {
			await sh(pmRun[0] ?? "pnpm", [...pmRun.slice(1), "verify"], "verify");
		})) &&
		(await step("dev --prepare", async () => {
			await sh(tatara, ["dev", "--prepare"], "prepare");
		})) &&
		(await step("smoke", async () => (await smoke(s, dir, logDir)).join(", "))) &&
		(await step("routes + doctor", async () => {
			const routes = JSON.parse(await sh(tatara, ["routes", "--json"], "routes")) as unknown[];
			if (routes.length === 0) throw new Error("no routes listed");
			const doctor = JSON.parse(await sh(tatara, ["doctor", "--json"], "doctor")) as {
				name: string;
				ok: boolean;
				detail: string;
			}[];
			const failed = doctor.filter((c) => !c.ok);
			if (failed.length) throw new Error(`doctor: ${JSON.stringify(failed)}`);
			return `${routes.length} routes`;
		})) &&
		(await step("contracts", async () => {
			await sh(tatara, ["contracts"], "contracts");
			const types = readFileSync(join(dir, "contracts/api.ts"), "utf8");
			if (!types.includes('"/api/me"') && !types.includes('"/api/greetings"'))
				throw new Error("contracts/api.ts lacks the app's paths");
			await sh(tatara, ["contracts", "--check"], "contracts-check");
			writeFileSync(join(dir, "contracts/api.ts"), "// stale\n");
			const caught = await sh(tatara, ["contracts", "--check"], "contracts-stale").then(
				() => false,
				() => true,
			);
			if (!caught) throw new Error("contracts --check passed on a stale file");
			await sh(tatara, ["contracts"], "contracts");
		})) &&
		(await step("without example templates", async () => {
			// apps delete the examples; an empty convention folder must still compile
			if (!s.addons.includes("email")) return "skipped";
			rmSync(join(dir, "src/modules/example/emails"), { recursive: true, force: true });
			await sh(pmRun[0] ?? "pnpm", [...pmRun.slice(1), "typecheck"], "typecheck-no-emails");
		})) &&
		(await step("tatara add", async () => {
			// growing an app later: jobs (and the cache it brings) onto one made without them
			if (s.addons.includes("jobs") || s.database === "none") return "skipped";
			await sh(tatara, ["add", "jobs"], "add-jobs");
			const added = JSON.parse(readFileSync(join(dir, "tatara.json"), "utf8")) as {
				addons: string[];
			};
			if (!added.addons.includes("cache"))
				throw new Error("tatara add jobs didn't bring the cache");
		})) &&
		(await step("generators", async () => {
			const made: string[] = [];
			for (const g of GENERATORS) {
				if (g.when && !g.when(s)) continue;
				await sh(
					tatara,
					["make", g.kind, g.name, ...(g.kind === "module" ? [] : ["--module", "billing"])],
					`make-${g.kind}`,
				);
				made.push(g.kind);
			}
			const dry = await sh(
				tatara,
				["make", "service", "pricing", "--module", "billing", "--dry-run"],
				"make-dry",
			).catch((e: Error) => e.message);
			if (!dry.includes("Refusing to overwrite"))
				throw new Error("generator overwrote or did not refuse an existing file");
			if (s.database !== "none")
				await sh(tatara, ["db", "generate", "--name", "billing"], "db-generate");
			return made.join(", ");
		})) &&
		(await step("verify after generators", async () => {
			await sh(pmRun[0] ?? "pnpm", [...pmRun.slice(1), "verify"], "verify-2");
		})) &&
		(!s.eject ||
			(await step(`eject ${s.eject}`, async () => {
				await sh(tatara, ["eject", s.eject as string, "--with-dependents"], "eject");
				await sh(s.pm, ["install"], "install-after-eject");
				// new code from generators must import the ejected copy too
				await sh(tatara, ["make", "route", "receipts", "--module", "billing"], "make-after-eject");
				await sh(pmRun[0] ?? "pnpm", [...pmRun.slice(1), "verify"], "verify-3");
				const leftover = await sh(
					"grep",
					["-rln", `"@tatara/${s.eject}"`, "src", "tests"],
					"grep-ejected",
				).catch(() => "");
				if (leftover.trim()) throw new Error(`still importing @tatara/${s.eject}: ${leftover}`);
				const ejected = (
					JSON.parse(readFileSync(join(dir, "tatara.json"), "utf8")) as { ejected?: object }
				).ejected;
				return Object.keys(ejected ?? {}).join(", ");
			})));

	if (!keep) {
		await run("docker", ["compose", "down", "--volumes", "--remove-orphans"], { cwd: dir });
		if (ok) rmSync(dir, { recursive: true, force: true });
	} else {
		await run("docker", ["compose", "down"], { cwd: dir });
	}
	return { name: s.name, ok, ms: Date.now() - started, steps };
}

async function main() {
	const options = args();
	const scenarios = SCENARIOS.filter((s) => !options.only || options.only.includes(s.name));
	if (options.list) {
		for (const s of SCENARIOS) console.log(`${s.name.padEnd(28)} ${s.flags.join(" ")}`);
		return;
	}
	mkdirSync(WORK, { recursive: true });

	console.log("building and packing the CLI…");
	const packed = await packCli(WORK);
	const librarySpecs = await packLibraries(WORK);

	if (
		scenarios.some((s) => s.pm === "bun") &&
		!existsSync(join(WORK, "tools/node_modules/.bin/bun"))
	) {
		console.log("installing bun locally for bun scenarios…");
		await run("npm", ["install", "--prefix", join(WORK, "tools"), "bun"], { cwd: ROOT });
	}

	const results: ScenarioResult[] = [];
	const queue = [...scenarios];
	const workers = Array.from({ length: Math.max(1, options.parallel) }, async (_, slot) => {
		for (let s = queue.shift(); s; s = queue.shift()) {
			console.log(`▶ ${s.name}`);
			const result = await runScenario(s, slot, packed, librarySpecs, options.keep);
			results.push(result);
			const failed = result.steps.find((x) => !x.ok);
			console.log(
				`${result.ok ? "✔" : "✖"} ${s.name} (${Math.round(result.ms / 1000)}s)${failed ? ` — ${failed.step}: ${failed.detail?.split("\n").slice(0, 6).join(" | ")}` : ""}`,
			);
		}
	});
	await Promise.all(workers);

	results.sort((a, b) => a.name.localeCompare(b.name));
	writeFileSync(join(WORK, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
	console.log("\nscenario                     result  time   steps");
	for (const r of results) {
		const steps = r.steps.map((x) => `${x.ok ? "✔" : "✖"}${x.step}`).join(" ");
		console.log(
			`${r.name.padEnd(28)} ${(r.ok ? "PASS" : "FAIL").padEnd(6)}  ${String(Math.round(r.ms / 1000)).padStart(4)}s  ${steps}`,
		);
	}
	const failed = results.filter((r) => !r.ok).length;
	console.log(`\n${results.length - failed}/${results.length} passed`);
	if (failed > 0) process.exitCode = 1;
}

await main();
