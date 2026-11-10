# tatara

Create opinionated [Hono](https://hono.dev) backends, then grow them with generators.

```sh
npm create tatara@latest my-app
cd my-app
pnpm dev
```

`tatara` is a CLI, not a framework: the generated app owns all of its code and has no tatara
runtime dependency. The CLI stays in the app as a devDependency for `sync`, `check`, `dev` and
the generators, pinned per project.

## What you get

- **Hono + OpenAPI**: every route is a `@hono/zod-openapi` route; `/openapi.json` and a Scalar
  reference at `/docs`.
- **Modules with auto-discovery**: drop a file in `src/modules/<module>/routes/*.routes.ts`
  (or `commands/`, `consumers/`, `schedules/`, `permissions/`, `db/`) and it is wired in.
  No central list to edit, so generators only ever add files. An app adds its own kinds with
  tatara.json `registries` (below).
- **One command for local dev**: `pnpm dev` starts the containers the app needs, migrates, seeds
  and runs every process with reload.
- **`verify` as definition of done**: lint (Biome) + layout rules + typecheck + tests + build.
- **Conventions for people and agents**: a generated `AGENTS.md` (and `CLAUDE.md`).

## Options

| | |
|---|---|
| ORM | Drizzle, Prisma |
| Database | PostgreSQL, MySQL |
| Auth | better-auth with any of: email OTP, phone OTP, email + password, Keycloak access tokens (resource server), organizations + roles; or none. `--auth keycloak` is shorthand for `--auth better-auth --auth-methods keycloak` |
| Add-ons | permission system (roles, scopes, overlays, audit), jobs + cron (BullMQ), domain events (transactional outbox; Postgres + Drizzle), admin API app, storage (S3 / local), email (SMTP / Mailpit), i18n, AI (Gemini / OpenAI with fallback) |
| Package manager | pnpm, npm, bun (runtime is Node 24) |

Non-interactive:

```sh
npm create tatara@latest my-app -- --orm drizzle --db postgres --auth better-auth \
  --auth-methods email-otp,password,orgs --addons authz,jobs,admin,storage,email,i18n --pm pnpm --yes
```

## Inside an app

```sh
pnpm tatara make module billing
pnpm tatara make resource invoice --module billing   # schema, validators, service, CRUD routes, tests
pnpm tatara make route|service|schema|command|consumer|schedule|permission <name> --module billing
pnpm tatara db generate --name add-invoices          # migration from schema changes
pnpm tatara run --list                               # app commands; tatara run <command> --flag value
pnpm tatara routes                                   # every route and what protects it
pnpm tatara doctor                                   # toolchain, services, env, layout
pnpm tatara upgrade                                  # after bumping @tatara/cli: codemods, sync, verify
pnpm tatara eject <package> [--with-dependents]     # copy a @tatara/* package into src/ejected and own it
pnpm tatara tinker                                   # REPL with db and services loaded
```

### App-declared registries

`tatara sync` also lists the app's own discovery kinds. Each `registries` entry becomes
`src/generated/<name>.ts`, imported as `#generated/<name>`:

```jsonc
"registries": [
	{
		"name": "approvalSubjects",                          // export const approvalSubjects
		"glob": "src/modules/*/approval-subjects/*.ts",      // string or array; tests and .d.ts skipped
		"export": "subject",                                 // "default" (default), "*" (namespace) or a named export
		"type": { "import": "#modules/approvals/subjects", "name": "ApprovalSubject" },
		"unique": "subjectType"                              // throws on load when two items share it
	},
	// each: "array" spreads every file's T[] into one list; "record" lists Record<string, T> maps
	{ "name": "automationNodes", "glob": "src/modules/*/automation-nodes/*.ts", "export": "nodes", "each": "array" },
	// shape: "entries" lists { owner: "module:<name>" | "core:<name>", file, value }
	{ "name": "workItemSources", "glob": "src/modules/*/work-item-sources/index.ts", "export": "workItemSources", "each": "array", "shape": "entries" }
]
```

Files are ordered core before modules, then by path. Without `type`, the list keeps the exports'
inferred types.

## Repository

```
packages/cli            the `tatara` binary (engine, commands, generators, feature definitions)
packages/cli/templates  template files: features/<id>/files[+<feature>...]/, generators/<kind>/
packages/create-tatara  `npm create tatara`
e2e/                    generates every scenario, verifies, boots and smoke-tests it
docs/                   design spec, plan, contributor guide
```

```sh
pnpm install
pnpm verify        # lint, typecheck, unit tests, build
pnpm e2e           # full matrix (Docker required); --only <name>, --parallel <n>, --list
pnpm versions:update
```

See [docs/contributing.md](docs/contributing.md) for how templates and features work.

## License

MIT
