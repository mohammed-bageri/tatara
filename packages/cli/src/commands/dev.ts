import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import pc from "picocolors";
import type { Project } from "../project/config.ts";
import { NODE_FLAGS, runAppCli } from "./app-cli.ts";
import { sync } from "./sync.ts";
import { runInherit } from "./verify.ts";

export interface DevFlags {
	down?: boolean;
	reset?: boolean;
	/** start services, migrate and seed, then exit (used by CI and e2e) */
	prepare?: boolean;
}

interface Process {
	name: string;
	file: string;
	color: (s: string) => string;
}

export function devProcesses(project: Project): Process[] {
	const list: Process[] = [{ name: "api", file: "src/apps/api/server.ts", color: pc.cyan }];
	if (project.has("admin"))
		list.push({ name: "admin", file: "src/apps/admin/server.ts", color: pc.magenta });
	if (project.has("jobs")) {
		list.push({ name: "worker", file: "src/apps/worker/index.ts", color: pc.yellow });
		list.push({ name: "cron", file: "src/apps/cron/index.ts", color: pc.blue });
	}
	if (project.has("temporal")) {
		list.push({ name: "temporal", file: "src/apps/temporal-worker/index.ts", color: pc.green });
	}
	return list;
}

function readEnv(project: Project): Record<string, string> {
	const file = join(project.root, ".env");
	return existsSync(file) ? (parseEnv(readFileSync(file, "utf8")) as Record<string, string>) : {};
}

async function compose(project: Project, args: string[]): Promise<number> {
	if (!existsSync(join(project.root, "compose.yaml"))) return 0;
	return runInherit("docker", ["compose", ...args], project.root);
}

function prefixed(child: ChildProcess, label: string) {
	for (const stream of [child.stdout, child.stderr]) {
		let buffer = "";
		stream?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) process.stdout.write(`${label} ${line}\n`);
		});
	}
}

const CONVENTION =
	/\/(routes|commands|consumers|schedules|workflows|activities|workflow-schedules|permissions|db|emails|notifications|channels)\/[^/]+\.ts$/;

/** Re-runs `tatara sync` when convention files appear or disappear, so --watch picks them up. */
function watchConventions(project: Project): FSWatcher[] {
	const watchers: FSWatcher[] = [];
	let timer: NodeJS.Timeout | undefined;
	for (const dir of ["src/modules", "src/core", "prisma/models"]) {
		const full = join(project.root, dir);
		if (!existsSync(full)) continue;
		const watcher = watch(full, { recursive: true }, (_event, file) => {
			if (!file || !(CONVENTION.test(`/${file}`) || file.endsWith(".prisma"))) return;
			clearTimeout(timer);
			timer = setTimeout(() => {
				sync(project).catch((error: unknown) => console.error(pc.red(String(error))));
			}, 150);
		});
		watchers.push(watcher);
	}
	return watchers;
}

export async function dev(project: Project, flags: DevFlags = {}): Promise<number> {
	if (flags.down) return compose(project, ["down"]);
	if (flags.reset && (await compose(project, ["down", "--volumes"])) !== 0) return 1;

	if (existsSync(join(project.root, "compose.yaml"))) {
		console.log(pc.bold("▶ starting local services"));
		if ((await compose(project, ["up", "--detach", "--wait"])) !== 0) {
			console.error(
				pc.red("Local services did not become healthy. Is Docker running? Try `tatara doctor`."),
			);
			return 1;
		}
	}
	await sync(project);
	if (project.has("db")) {
		console.log(pc.bold("▶ migrating and seeding"));
		if ((await runAppCli(project, ["db:migrate"])) !== 0) return 1;
		if ((await runAppCli(project, ["db:seed"])) !== 0) return 1;
	}
	if (flags.prepare) return 0;

	const env = readEnv(project);
	const port = env.PORT ?? "3000";
	const children = devProcesses(project).map((p) => {
		const child = spawn(process.execPath, [...NODE_FLAGS, "--watch", p.file], {
			cwd: project.root,
			stdio: ["inherit", "pipe", "pipe"],
			env: { ...process.env, FORCE_COLOR: "1" },
		});
		prefixed(child, p.color(`[${p.name}]`.padEnd(8)));
		return child;
	});
	const watchers = watchConventions(project);

	const urls = [
		`API         http://localhost:${port}/api`,
		`Reference   http://localhost:${port}/docs`,
	];
	if (project.has("admin"))
		urls.push(`Admin API   http://localhost:${env.ADMIN_PORT ?? "3001"}/docs`);
	if (project.has("email"))
		urls.push(`Mailpit     http://localhost:${env.MAILPIT_UI_PORT ?? "8025"}`);
	if (project.has("storage"))
		urls.push(`Storage UI  http://localhost:${env.STORAGE_CONSOLE_PORT ?? "9001"}`);
	if (project.has("auth-keycloak"))
		urls.push(`Keycloak    http://localhost:${env.KEYCLOAK_PORT ?? "8080"}/admin (admin/admin)`);
	console.log(`\n${urls.map((u) => `  ${pc.green("➜")} ${u}`).join("\n")}\n`);

	return new Promise((resolve) => {
		const stop = () => {
			for (const watcher of watchers) watcher.close();
			let running = children.filter((c) => c.exitCode === null).length;
			if (running === 0) resolve(0);
			for (const child of children) {
				child.once("exit", () => {
					running -= 1;
					if (running <= 0) resolve(0);
				});
				child.kill("SIGTERM");
			}
			setTimeout(() => resolve(0), 5000).unref();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}
