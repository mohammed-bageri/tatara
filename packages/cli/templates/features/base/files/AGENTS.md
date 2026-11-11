# __APP_NAME__ — working agreement

Read this before changing code. It applies to people and coding agents alike.

## Definition of done

- A change is done when `__PM_RUN__ verify` exits 0 (lint + layout + typecheck + tests + build).
- Never disable, skip or weaken a test, a type or a lint rule to make it pass. Fix the code.
- Report what you ran and its result, not that something "should work".

## Layout

```
src/apps/<name>/        one folder per process; thin wiring only
src/core/<area>/        shared infrastructure; never imports from modules
src/modules/<module>/   business code, one folder per domain
src/generated/          written by `tatara sync`; never edit or commit
tests/                  shared test helpers and setup
```

A module holds `routes/`, `services/`, `validators/`, and optionally `db/`, `commands/`
and other folders described below. Business logic lives in `services/`: plain functions
with no knowledge of Hono. Routes validate input, call services and shape the response.

Rules enforced by `tatara check` (part of lint):

- Import with `#core/…`, `#modules/…`, `#apps/…`, `#generated/…`, `#tests/…`; no `../` imports,
  side-effect imports, `vi.mock` or `vi.importActual` paths.
- `src/core` never imports from `src/modules`.
- A module uses another module only through its `services/`, its tables (`db/`: joins,
  foreign keys) and the domain events it publishes (`events/`, to subscribe). Everything else
  in a module is private.
- Module routers never call `use("*")`; attach middleware per route or per path.
- `process.env` is read only in `src/core/config/env.ts`.
- A module's folders are ones tatara knows: `routes`, `services`, `validators`, `db`, `commands`,
  `tests`, `consumers`, `schedules`, `events`, `event-subscribers`, `emails`, `notifications`,
  `channels`, `permissions`, plus the folder of each `registries` glob in `tatara.json`
  (`src/modules/*/<folder>/…`, or `src/modules/<module>/<folder>/…` for one module).
- `*.test.ts` files live in a `tests/` folder (`src/modules/<module>/tests/`, or top-level `tests/`).

## Generators

Prefer generators to hand-writing boilerplate; they only add files and never overwrite:

```
__PM_EXEC__ tatara make module <name>
__PM_EXEC__ tatara make resource <name> --module <module>   # CRUD slice
__PM_EXEC__ tatara make route|service|command <name> --module <module>
__PM_EXEC__ tatara run --list            # app commands
__PM_EXEC__ tatara routes                # every route and what protects it
__PM_EXEC__ tatara upgrade               # after bumping @tatara/cli: run its codemods, sync, verify
__PM_EXEC__ tatara add <add-on…>         # add jobs, cache, realtime… to this app later
```

## HTTP

- Every route uses `createRoute` from `@hono/zod-openapi`, with request and response schemas.
  Declare request bodies with `jsonBody(schema, description)` (required; a missing body is a 400),
  responses with `jsonContent(...)`.
  The spec is served at `/openapi.json`, the reference UI at `/docs`.
- Responses use the envelope: `success(data)`, `paginated(items, page, pageSize, total)`.
  Errors are thrown as `AppError` subclasses (`NotFoundError`, `ConflictError`,
  `BusinessRuleError`, `ForbiddenError`, …) and become
  `{ success: false, error, code, details }`. Give a case its own code when the client acts on it:
  `new NotFoundError("Job not found", { code: "JOB_NOT_FOUND" })` (translated as `errors.JOB_NOT_FOUND`).
- Route files are `routes/<name>.routes.ts` and default-export `defineRoutes({ app, basePath, router })`.
  They are found automatically; there is no central list to edit.
- Long or live lists page by cursor: `cursorQuerySchema` for the query, fetch `limit + 1` rows after
  `decodeCursor(positionSchema, cursor)`, answer `cursorPage(rows, limit, (row) => ({ createdAt, id }))`
  (schema: `cursorPageSchema(item)`).
- Requests time out after `REQUEST_TIMEOUT_MS` (504); give slow paths their own limit in
  `src/apps/http.ts` (`timeouts.paths`). Behind proxies, set `TRUSTED_PROXY_HOPS` and read the caller
  with `clientIp(c, { trustedHops })`.

## Configuration and logging

- Add environment variables to `src/core/config/env.ts` (validated at startup) and to
  `.env.example`. Never read `process.env` elsewhere.
- Log with `c.get("logger")` in requests and `logger` from `#core/logging/logger` elsewhere.
  No `console.*` outside commands and tests.
- Secrets and codes come from `@tatara/core`: `createEncryption(keys)` for secrets at rest (AES-GCM,
  rotatable keys), `randomToken()`, `numericCode()`, `randomCode()`, `hashToken()`, `safeEqual()`.
  Never `Math.random()` for anything a user could guess.
- User text: `text({ max })` and `url()` from `@tatara/core` in validators clean and check it (control,
  invisible and bidi characters, whitespace; only http(s) links). Escape when you render HTML.
  Rich text users write: `sanitizeHtml(html)` (or `"email"` for templates) from `@tatara/core/html`
  once `sanitize-html` is a dependency.

## Deploying

- Every deploy runs `node dist/apps/cli/index.mjs deploy`: commands with `phase: "deploy"` (migrations
  first, then the rest by `order`), and each `phase: "once"` command the first time a database sees
  it (recorded in a ledger). Commands without a phase only run when asked for.

## Tests

- Tests live next to the code in `src/modules/<module>/tests/`. Use `api` from
  `#tests/helpers/api` to call routes in-process.
- Test behaviour through the public surface (routes, services); mock only external services.

<!-- tatara:slot sections -->
