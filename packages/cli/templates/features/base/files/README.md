# __APP_NAME__

A Hono API created with [tatara](https://github.com/mohammed-bageri/tatara).

## Getting started

```sh
__PM_RUN__ dev
```

This starts the local services, prepares the database and runs every process with
reload. Then open:

- API: http://localhost:3000/api
- API reference: http://localhost:3000/docs
- Health: http://localhost:3000/health

## Scripts

| Script | What it does |
|---|---|
| `dev` | Start local services and every process in watch mode |
| `dev:down` / `dev:reset` | Stop local services / stop and delete their data |
| `verify` | Lint, layout checks, typecheck, tests and build |
| `test` | Run tests |
| `build` | Bundle to `dist/` |
| `start` | Run the built API |

Conventions are in [AGENTS.md](./AGENTS.md).

<!-- tatara:slot readme -->
