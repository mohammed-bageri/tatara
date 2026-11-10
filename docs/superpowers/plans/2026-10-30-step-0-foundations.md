# Step 0 — Monorepo, releases, upgrade harness and bench

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare tatara-cli so later steps can move code into `@tatara/*` packages safely. This covers package conventions, independent releases from CI, a record of what each app was generated with, a `tatara upgrade` command with a codemod harness, and performance budgets measured against plain Hono.

**Architecture:**
- **Packages:** live under `packages/`, built with tsdown (with type declarations) and checked by a conventions test.
- **Releases:** Changesets versions them, and a GitHub workflow publishes them with npm trusted publishing.
- **Generation record:** `tatara new` records the CLI version and a hash of every framework file it wrote.
- **Upgrade:** `tatara upgrade` compares an app's files with those hashes, or with what a released CLI version would have generated, and runs codemods.
- **Bench:** a script in `bench/` checks request overhead, cold boot, package size and `sync` time against budgets.

**Tech Stack:** Node 24, pnpm 11.25.0, TypeScript 7, tsdown 0.23, Vitest 5, Changesets 3, Biome 2.5, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-30-framework-packages-design.md`. This plan implements its step 0 ("Order" table) and the parts of "Versions and releases", "`tatara upgrade` and `tatara eject`", "How packages fit into an app" and "Ideas kept" that step 0 needs.

## Global Constraints

- Node `>=24`, pnpm `11.25.0`. Run tools as `mise exec node@24 -- pnpm …`, because this machine defaults to Node 26.
- Definition of done for every task: root `pnpm verify` exits 0. Tasks that touch generation also need `pnpm e2e --only no-db-minimal,pr-pg-better-auth-full` to pass.
- No new runtime dependencies in `@tatara/cli` unless a task names one with a reason. Node built-ins (`node:crypto`, `node:fs`, `node:child_process`) cover hashing and processes.
- Commits never carry AI attribution. Work on a branch and open a **draft** PR.
- Releases are independent per package, except `@tatara/cli` and `create-tatara`, which stay `fixed` together (as `.changeset/config.json` has them today).
- Budgets, as in spec § "Ideas kept" 5:
  - per-request overhead < 0.1 ms
  - cold boot < 300 ms
  - `@tatara/core` + `@tatara/http` installed size < 500 KB (skipped until those packages exist)
  - `sync` on 100 modules < 2 s
- Framework files that `upgrade` tracks, which are the paths a package can replace: `src/core/**`, `src/apps/**`, `tests/helpers/**`, `tests/setup.ts`, `tests/global-setup.ts`.

## Review Focus

1. **An app created with `--no-install` has no record of its files.** Expected: `generated.files` is still written, hashed from the written content; the formatting step is the only thing skipped. *(Task 3 test `records hashes without installing`.)*
2. **A file that differs only in formatting from a released template is reported as changed.** Expected: release baselines are formatted with the app's own Biome before hashing. *(Task 4 test `treats a reformatted template file as unchanged`.)*
3. **`tatara upgrade` is run twice.** Expected: the second run finds nothing to do and changes no files. *(Task 5 test `is idempotent`.)*
4. **A codemod fails halfway through.** Expected: files already written stay written, `tatara.json` keeps the old version, and the command exits non-zero and names the codemod. *(Task 5 test `keeps the old version when a codemod fails`.)*
5. **The bench is noisy on shared CI runners.** Expected: each measurement is the median of several runs, and a budget fails only when the median is over the limit. *(Task 6 test `reports the median of runs`.)*

---

### Task 1: Package conventions

**Files:**
- Create: `tsdown.base.ts`, `scripts/new-package.ts`, `packages/conventions.test.ts`, `docs/packages.md`
- Modify: `package.json` (`typecheck` script), `vitest.config.ts`, `docs/contributing.md`

**Interfaces:**
- Produces:
  - `libraryConfig(entry: Record<string, string>): UserConfig` from `tsdown.base.ts`. It returns esm, node24, `dts: true`, `clean: true` and `outDir: "dist"`.
  - `pnpm new-package <name> [--peer <pkg>…]` writes `packages/<name>/` (package.json, tsconfig.json, tsdown.config.ts, `src/index.ts`, `src/index.test.ts`, README.md).
  - The conventions every later package must pass.

Conventions (checked for every `packages/*/package.json` except `cli` and `create-tatara`, which are apps, not libraries):

| Field | Rule |
|---|---|
| `name` | `@tatara/<dir>` |
| `type` | `"module"` |
| `exports` | an object with `"."` having `types` and `import` under `./dist/` |
| `files` | exactly `["dist"]` |
| `sideEffects` | `false` |
| `publishConfig.access` | `"public"` |
| `repository.directory` | `packages/<dir>` |
| `engines.node` | `">=24"` |
| `dependencies` | must not list `hono`, `@hono/zod-openapi`, `better-auth`, `prisma`, `@prisma/client`, `drizzle-orm` or `zod`; these go in `peerDependencies` |

- [ ] **Step 0: Branch**

Run: `git switch -c step-0-foundations`. All six tasks commit to this branch.

- [ ] **Step 1: Write the failing test** in `packages/conventions.test.ts`
  - It loads every library package and asserts each rule above, naming the package and the field in the failure message.
  - It also has a test `new-package scaffolds a package that passes the conventions`: run the script into a temp copy of the repo's `packages/` folder (env `TATARA_PACKAGES_DIR`), then check the scaffold against the same rules.

- [ ] **Step 2: Run it and see it fail**

Run: `mise exec node@24 -- pnpm vitest run packages/conventions.test.ts`
Expected: FAIL. The scaffold test fails because `scripts/new-package.ts` doesn't exist. The per-package tests pass vacuously, because there are no library packages yet.

- [ ] **Step 3: Implement**
  - Add `tsdown.base.ts` and `scripts/new-package.ts`. `--peer` adds `peerDependencies` with the version from `packages/cli/templates/versions.json`.
  - Add `"new-package": "node scripts/new-package.ts"` to the root scripts.
  - Change `typecheck` to `pnpm -r --filter "./packages/*" run typecheck && tsc -p tsconfig.tools.json`.
  - Add `packages/*.test.ts` to the vitest `include`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `mise exec node@24 -- pnpm vitest run packages/conventions.test.ts`
Expected: PASS.

- [ ] **Step 5: Document and verify**
  - Write `docs/packages.md`: the conventions table, `pnpm new-package`, and "libraries the app owns are peers".
  - Link it from `docs/contributing.md`.
  - Run `mise exec node@24 -- pnpm verify`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "build: conventions and scaffold for @tatara/* library packages"
```

---

### Task 2: Releases from CI with npm trusted publishing

**Files:**
- Create: `.github/workflows/release.yml`, `docs/releasing.md`
- Modify: `.changeset/config.json` (only if needed: keep `fixed: [["@tatara/cli", "create-tatara"]]`; everything else independent), `package.json` (`changeset`, `version-packages`, `release` scripts)

**Interfaces:**
- Produces:
  - `pnpm changeset` to add a change note.
  - On `main`, the workflow opens a "Version packages" PR. Merging that PR publishes every package whose version changed, with provenance.

- [ ] **Step 1: Write the workflow**
  - Trigger: `push` to `main`. Permissions: `contents: write`, `pull-requests: write`, `id-token: write`.
  - Steps: checkout, pnpm, Node 24 with `registry-url: https://registry.npmjs.org`, `pnpm install --frozen-lockfile`, `pnpm verify`, then `changesets/action@v1` with `version: pnpm version-packages` and `publish: pnpm release`.
  - `release` = `pnpm build && changeset publish`. With trusted publishing, npm authenticates through GitHub OIDC; no `NPM_TOKEN` secret is used.

- [ ] **Step 2: Lint the workflow**

Run: `mise exec actionlint@1.7.12 shellcheck@0.11.0 -- actionlint .github/workflows/release.yml`
Expected: no output.

- [ ] **Step 3: Check Changesets reads the config**

Run: `mise exec node@24 -- pnpm changeset status`
Expected: exits 0 and reports no pending changesets.

- [ ] **Step 4: Write `docs/releasing.md`**
  - Adding a changeset.
  - What the Version PR does.
  - **[USER]** one-time setup: on npmjs.com, for each package, Settings → Trusted publishing → GitHub Actions, repo `mohammed-bageri/tatara`, workflow `release.yml`. New packages must be published once by hand before a trusted publisher can be added to them.
  - npm's staged-release approval may still apply to each release.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "ci: release with changesets and npm trusted publishing"
```

- [ ] **Step 6 [USER]: Configure trusted publishing**

The user does the npm setup above for `@tatara/cli` and `create-tatara`. This isn't needed to finish the task, only before the first CI release.

---

### Task 3: Record what each app was generated with

**Files:**
- Create: `packages/cli/src/project/hashes.ts`, `packages/cli/src/project/hashes.test.ts`
- Modify: `packages/cli/src/project/config.ts` (`ProjectConfig.generated`), `packages/cli/src/commands/new.ts` (write the record last, after formatting or with `--no-install`), `schema/tatara.json`, `e2e/run.ts` (assert the record after `new`)

**Interfaces:**
- Produces:
  - `TRACKED_PATTERNS: readonly string[]` holds the framework-file globs from Global Constraints.
  - `hashContent(text: string): string` returns `"sha256-" + base64 sha256`.
  - `hashTrackedFiles(root: string): Promise<Record<string, string>>` returns relative POSIX path → hash for files matching `TRACKED_PATTERNS`.
  - `ProjectConfig.generated?: { cli: string; files: Record<string, string> }` is written to `tatara.json` as `"generated"`.

- [ ] **Step 1: Write the failing tests** in `hashes.test.ts`

```ts
it("hashes only framework files", async () => { /* temp dir with src/core/http/app.ts, src/modules/x/routes/x.routes.ts, tests/helpers/api.ts → keys are exactly src/core/http/app.ts and tests/helpers/api.ts */ });
it("is stable for the same content", () => expect(hashContent("a\n")).toBe(hashContent("a\n")));
it("changes when one byte changes", () => expect(hashContent("a\n")).not.toBe(hashContent("b\n")));
it("uses forward slashes on every platform", async () => { /* keys contain no backslash */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `mise exec node@24 -- pnpm vitest run packages/cli/src/project/hashes.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**
  - Implement `hashes.ts` using `tinyglobby` (already a dependency) and `node:crypto`.
  - In `newApp`, after the format step (or straight after `writeFiles` with `--no-install`), set `config.generated = { cli: cliVersion(), files: await hashTrackedFiles(root) }` and rewrite `tatara.json`.
  - Add `generated` to `schema/tatara.json`.

- [ ] **Step 4: Run them and see them pass**

Run: `mise exec node@24 -- pnpm vitest run packages/cli/src/project/hashes.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Add the e2e assertion and the `--no-install` test (Review Focus 1)**
  - In `e2e/run.ts`, right after the "new" step, read `tatara.json` and check that `generated.files` matches `hashTrackedFiles(dir)` exactly. Fail the step with the first differing path.
  - Add a unit test `records hashes without installing`: run `newApp(tmp, { yes: true, install: false, orm: "none", db: "none", auth: "none", pm: "pnpm" })`, then check that `tatara.json.generated.files["src/core/http/app.ts"]` equals `hashContent(<file content>)`.

- [ ] **Step 6: Verify and commit**

Run: `mise exec node@24 -- pnpm verify && mise exec node@24 -- pnpm e2e --only no-db-minimal,pr-pg-better-auth-full`
Expected: verify exits 0, and `2/2 passed`.

```bash
git add -A && git commit -m "feat(cli): record CLI version and framework file hashes in tatara.json"
```

---

### Task 4: Release baselines: "is this file unchanged?"

**Files:**
- Create: `packages/cli/src/upgrade/baseline.ts`, `packages/cli/src/upgrade/baseline.test.ts`

**Interfaces:**
- Consumes: `hashContent`, `hashTrackedFiles`, `TRACKED_PATTERNS` (Task 3); `ProjectConfig` (`config.ts`).
- Produces:
  - `releasedVersions(): Promise<string[]>` returns `@tatara/cli` versions from the npm registry, excluding prereleases like `0.0.0-stage`.
  - `releaseBaseline(version: string, config: ProjectConfig, opts?: { formatWith?: string }): Promise<Record<string, string>>`. It runs `pnpm dlx @tatara/cli@<version> new <tmp>/app` with flags rebuilt from `config`, plus `--yes --no-install --no-git`. If `formatWith` (the app root) is given, it formats the temp app with the app's own Biome (`<app>/node_modules/.bin/biome check --write`, using the app's `biome.json`). It then returns `hashTrackedFiles`. Results are cached in `~/.cache/tatara/baselines/<version>-<sha of config options>.json`.
  - `createBaseline(project: Project): Promise<Baseline>`, where `Baseline` is `{ isUnchanged(path: string, content: string): Promise<boolean> }`. A file is unchanged if its hash equals `tatara.json.generated.files[path]`. Failing that, it's unchanged if it equals the hash in any `releaseBaseline(v)` for `v` from the app's recorded version up to the current CLI version. Baselines load lazily and are kept in memory.

- [ ] **Step 1: Write the failing tests**
  - `uses the recorded hash first`: a project whose `generated.files` has the content's hash → true, with no network call (inject `releasedVersions` / `releaseBaseline` as test doubles through a `createBaseline(project, deps)` parameter).
  - `falls back to released templates`: no record; the injected `releaseBaseline("0.1.1")` has the hash → true.
  - `reports a changed file`: no hash matches → false.
  - `treats a reformatted template file as unchanged` (Review Focus 2). This one is an integration test, tagged `it.runIf(process.env.TATARA_NETWORK_TESTS)`. Render `releaseBaseline("0.1.3", minimalConfig, { formatWith })` against a fixture app with a Biome config that uses a different line width. The file's formatted content must match.

- [ ] **Step 2: Run them and see them fail**

Run: `mise exec node@24 -- pnpm vitest run packages/cli/src/upgrade/baseline.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `baseline.ts`**

Rebuilding the flags from `config`:
- `--orm`, `--db`, `--auth`, `--pm` come straight from the config.
- `--auth-methods` and `--addons` are comma-joined, and left out when empty.

- [ ] **Step 4: Run them and see them pass**

Run: `mise exec node@24 -- pnpm vitest run packages/cli/src/upgrade/baseline.test.ts`, then `TATARA_NETWORK_TESTS=1 mise exec node@24 -- pnpm vitest run packages/cli/src/upgrade/baseline.test.ts`
Expected: 3 passed with 1 skipped, then 4 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): tell whether an app file is unchanged from a released template"
```

---

### Task 5: `tatara upgrade` and the codemod harness

**Files:**
- Create: `packages/cli/src/upgrade/codemods.ts` (the registry, empty in step 0), `packages/cli/src/upgrade/context.ts`, `packages/cli/src/commands/upgrade.ts`, `packages/cli/src/commands/upgrade.test.ts`
- Modify: `packages/cli/src/bin.ts` (register `upgrade`), `packages/cli/templates/features/base/files/AGENTS.md` (one line under the CLI commands), `README.md` (commands list)

**Interfaces:**
- Consumes: `createBaseline` (Task 4), `hashTrackedFiles` (Task 3), `sync`, `verify`, `loadProject`.
- Produces:
  - **Codemod type:**
    ```ts
    export interface Codemod {
      /** CLI version that introduces it; runs when upgrading across it */
      version: string;
      id: string;
      description: string;
      run(ctx: UpgradeContext): Promise<void>;
    }
    export const CODEMODS: readonly Codemod[] = [];
    ```
  - **`UpgradeContext`:**
    - `project`
    - `baseline`
    - `read(path): Promise<string>`, `write(path, text)`
    - `removeIfUnchanged(path): Promise<"removed" | "kept" | "missing">`: kept files are added to `report.kept` with a unified diff against the baseline
    - `rewriteImports(from: string, to: string): Promise<number>`: rewrites import specifiers in `src/**/*.ts` and `tests/**/*.ts` exactly matching `from` or starting with `from + "/"`; returns the number of files changed
    - `addDependency(name, range, { dev?: boolean })`
    - `report: { removed: string[]; kept: { path: string; diff: string }[]; notes: string[] }`
  - **`upgrade(project, opts: { dryRun?: boolean; codemods?: readonly Codemod[] }): Promise<UpgradeReport>`**:
    1. Runs the codemods whose `version` is greater than `tatara.json.version` and at most `cliVersion()`, in semver order.
    2. Then `sync`.
    3. Then sets `tatara.json.version = cliVersion()` and `generated = { cli, files: hashTrackedFiles }`.
    4. With `dryRun`, it writes nothing and returns the report.
  - **CLI:** `tatara upgrade [--dry-run] [--no-verify]`. It runs `verify` at the end unless `--no-verify` is passed, and prints the report.

- [ ] **Step 1: Write the failing tests** in `upgrade.test.ts`

They use a temp project fixture (minimal `tatara.json` + files) and test codemods passed through `opts.codemods`:
- `runs codemods newer than the app, in order`: codemods for `0.1.2`, `0.1.4`, `0.1.5`, with the app at `0.1.3` and the CLI at `0.1.5` (version injected) → ran `["0.1.4", "0.1.5"]`.
- `removes unchanged files and keeps changed ones with a diff`: one file matches the recorded hash, one doesn't → `report.removed` / `report.kept[0].diff` contains the changed line.
- `rewrites imports`: `rewriteImports("#core/http/errors", "@tatara/http")` changes `import { NotFoundError } from "#core/http/errors";` and leaves `#core/http/errors-extra` alone.
- `is idempotent` (Review Focus 3): run twice → the second report is empty and file contents are byte-identical.
- `keeps the old version when a codemod fails` (Review Focus 4): the second codemod throws → rejects with a message naming its `id`, the first codemod's write is on disk, and `tatara.json.version` is unchanged.
- `dry run writes nothing`.

- [ ] **Step 2: Run them and see them fail**

Run: `mise exec node@24 -- pnpm vitest run packages/cli/src/commands/upgrade.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement** `context.ts`, `codemods.ts`, `commands/upgrade.ts`, and the `bin.ts` registration.
  - Version comparison is numeric `major.minor.patch`. Prereleases are ignored, so no semver dependency is needed.
  - Diffs come from `git diff --no-index` through `tinyexec` when git is available, otherwise from a plain "baseline / current" listing.

- [ ] **Step 4: Run them and see them pass**

Run: `mise exec node@24 -- pnpm vitest run packages/cli/src/commands/upgrade.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Check it on a real generated app**

Run: `mise exec node@24 -- pnpm e2e --only no-db-minimal --keep`, then in `.e2e/runs/no-db-minimal` run `node ../../packages/cli/dist/bin.mjs upgrade`.
Expected: "nothing to upgrade", verify passes, and `git status` in the app shows only `tatara.json` changed, or nothing at all.

- [ ] **Step 6: Verify and commit**

```bash
mise exec node@24 -- pnpm verify
git add -A && git commit -m "feat(cli): tatara upgrade with a codemod harness"
```

---

### Task 6: Bench and budgets

**Files:**
- Create: `bench/run.ts`, `bench/budgets.json`, `bench/baseline-app/` (plain Hono: `package.json`, `src/app.ts`), `bench/stats.ts`, `bench/stats.test.ts`, `docs/performance.md`
- Modify: `package.json` (`"bench": "node bench/run.ts"`), `tsconfig.tools.json` (include `bench`), `vitest.config.ts` (include `bench/*.test.ts`), `.github/workflows/ci.yml` (job `bench`, needs `verify`)

**Interfaces:**
- Consumes: `e2e/run.ts`'s generate-and-install flow. Extract the parts the bench needs into `e2e/lib.ts` (`packCli()`, `generateApp(scenario, dir)`), and have `e2e/run.ts` import them.
- Produces:
  - `median(samples: number[]): number`.
  - `pnpm bench [--json]` measures, compares with `bench/budgets.json`, prints a table, and exits 1 if any median is over budget.

Measurements:

| Key | How | Budget |
|---|---|---|
| `requestOverheadMs` | In process, `GET /health` 20 000 times on the generated `no-db-minimal` app (`createHttpApp`) and on `bench/baseline-app` (plain `Hono` with the same route); mean difference per request; 5 runs → median | `0.1` |
| `coldBootMs` | Spawn `node dist/apps/api/server.mjs` of `no-db-minimal`, time until `GET /health` returns 200; 5 runs → median | `300` |
| `corePackagesKb` | Sum of the `dist/` sizes of `packages/core` and `packages/http`; **skipped** (reported "n/a") while those packages don't exist | `500` |
| `sync100Ms` | Generated `no-db-minimal` app with 100 modules written directly, each `routes/<m>.routes.ts` + `commands/<m>.ts`; time `tatara sync`; 5 runs → median | `2000` |

- [ ] **Step 1: Write the failing test** in `bench/stats.test.ts` (Review Focus 5)

```ts
it("reports the median of runs", () => expect(median([5, 1, 100, 3, 4])).toBe(4));
it("uses the mean of the middle two for an even count", () => expect(median([1, 2, 3, 10])).toBe(2.5));
it("rejects an empty list", () => expect(() => median([])).toThrow());
```

- [ ] **Step 2: Run it and see it fail**

Run: `mise exec node@24 -- pnpm vitest run bench/stats.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement** `stats.ts`, `run.ts`, `baseline-app`, `budgets.json` (the four keys and limits above), the `e2e/lib.ts` extraction, and the CI `bench` job (`pnpm bench`).

- [ ] **Step 4: Run the tests, then the bench**

Run: `mise exec node@24 -- pnpm vitest run bench/stats.test.ts && mise exec node@24 -- pnpm bench`
Expected: 3 passed, and a table with three measured rows and `corePackagesKb` = n/a. If a budget fails on today's generated app, **don't raise it**. Record the number in `docs/performance.md` as the starting point and raise it with the user, because the spec requires the budget.

- [ ] **Step 5: Record the baseline and verify**
  - Write `docs/performance.md`: what each number means, how to run the bench, and today's numbers with the date and the machine.
  - Run `mise exec node@24 -- pnpm verify && mise exec node@24 -- pnpm e2e --only no-db-minimal,pr-pg-better-auth-full`. Expected: exit 0 and `2/2 passed`, which confirms the `e2e/lib.ts` extraction didn't break e2e.

- [ ] **Step 6: Commit and open the draft PR**

```bash
git add -A && git commit -m "perf: bench and budgets against a plain-Hono baseline"
git push -u origin step-0-foundations
gh pr create --draft --title "Step 0: packages, releases, upgrade harness, bench" --body "Implements step 0 of docs/superpowers/specs/2026-10-30-framework-packages-design.md. Verified: pnpm verify, e2e no-db-minimal + pr-pg-better-auth-full, pnpm bench (numbers in docs/performance.md)."
```
