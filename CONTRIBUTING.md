# Contributing

Welcome — thanks for your interest in Launch.

Launch is maintained by [Clifton Cunningham](https://github.com/cliftonc) and community
contributors. All contributions are reviewed and approved by the maintainer.

Ways to contribute:

- [Submitting a bug report](#bug-report)
- [Submitting a feature request](#feature-request)
- [Providing feedback](#feedback)
- [Contribution guidelines](#contribution-guidelines)

## <a name="bug-report"></a> Submitting a bug report

Open an [issue](https://github.com/rocketflare-dev/rocketflare-launch/issues/new) with a title starting
"Bug: ". Include the command you ran, the output, and whether a fresh clone following `SETUP.md`
Part 1 reproduces it. Security issues go through [`SECURITY.md`](SECURITY.md), not a public issue.

## <a name="feature-request"></a> Submitting a feature request

Open an [issue](https://github.com/rocketflare-dev/rocketflare-launch/issues/new) with a title starting
"Feature Request: ". Say which subsystem it belongs to (`docs/CONCEPTS.md` has one section per
subsystem, each ending in **Known gaps** — check there first; many good ideas are already listed as
deliberate omissions with a reason).

## <a name="feedback"></a> Providing feedback

- Start a thread in [Discussions](https://github.com/rocketflare-dev/rocketflare-launch/discussions).
- Mention the maintainer on [BlueSky — @cliftonc.nl](https://bsky.app/profile/cliftonc.nl).

## <a name="contribution-guidelines"></a> Contribution guidelines

- [Setup](#setup)
- [Repository structure](#repository-structure)
- [What a change must include](#what-a-change-must-include)
- [Running tests](#running-tests)
- [Commit message guidelines](#commit-message-guidelines)
- [PR guidelines](#pr-guidelines)
- [Cutting a release](#cutting-a-release)
- [Architecture guidelines](#architecture-guidelines)

### <a name="setup"></a> Setup

Node 24 (`.nvmrc`), pnpm 10 (`corepack enable` reads `packageManager`), Docker; macOS or Linux
(Windows: WSL2). Then:

```bash
git clone <this repository> launch && cd launch
bash scripts/bootstrap.sh        # toolchain → install → .dev.vars → Postgres → migrate → seed --demo → pnpm dev, signed in
pnpm test:db:up && pnpm test     # the full suite against a throwaway Postgres on :5499
```

The bootstrap is [`SETUP.md`](SETUP.md) Part 1 as one re-runnable command — every step prints a
`✔ n/10` verification line; the numbered steps there are what it runs, for doing it by hand or
debugging one step (`pnpm preflight` is the read-only check). No external credentials are needed:
magic links are logged; chat, agents and embeddings run on Workers AI through a logged-in Cloudflare
account, or answer 503 with `bash scripts/bootstrap.sh --offline` until a key exists. If you are working somewhere Docker cannot run, `pnpm web test:config` and
`pnpm --filter @launch/cli test` need no database; the `api`, `api-isolated` and `ui` projects do.

### <a name="repository-structure"></a> Repository structure

A pnpm workspace; `CLAUDE.md` is the map and every significant directory has its own `CLAUDE.md`.

- 📂 `apps/web/` — `@launch/web`: the Cloudflare Worker (Hono API, queue and cron handlers, the
  Durable Object and Workflow) and the React UI, plus `wrangler*.toml`, `migrations/`, `scripts/`, `tests/`
- 📂 `apps/cli/` — `@launch/cli`: the `launch` command-line client
- 📂 `packages/shared/` — `@launch/shared`: the zod contracts the API validates with and the UI
  and CLI parse with (private, consumed as TypeScript source)
- 📂 `docs/` — `CONCEPTS.md` (how each subsystem works, the decision record, and its known gaps),
  `ADAPTING.md`, `DEPLOY.md`, `RLS.md`
- 📂 `scripts/` — first-run tooling (`bootstrap.sh` / `bootstrap.mjs`), the plugin tooling
  (`plugin.mjs`, `plugin-api-doc.mjs`), `deployer.mjs` and `lib/`
- 📂 `.claude/rules/` — layer conventions (api, database, ui, cli, testing, code-quality,
  cloudflare), loaded by path when you or a coding agent touch that layer; `.claude/skills/` — the
  `/launch-setup`, `/launch-preflight`, `/launch-provision`, `/launch-plugin` and the other `launch-*`
  slash commands

### <a name="what-a-change-must-include"></a> What a change must include

The repo's **non-negotiables** are listed in `CLAUDE.md`; the ones contributors hit most:

- **The gate is green**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before every
  commit. `typecheck` regenerates `apps/web/worker-configuration.d.ts` — commit it if it changed.
- **A user-visible change adds a line to `CHANGELOG.md`** under `## Unreleased`.
- **Never rewrite released history.** Do not force-push over a released tag.
- **Contracts first**: a new or changed API surface starts as a zod schema in
  `packages/shared/src/`, then the route validates with it, then the UI/CLI parse with it.
- **Tenant isolation**: every domain query filters by the tenant from the auth context; every tenant
  table calls `tenantIsolation()`; every analytics cube scopes its SQL and has a case in
  the analytics plugin's own `cube-isolation.test.ts`.
- **Routes enqueue, never run** long work; concurrency is a database claim row, never a `Map`.
- **Two tomls, one shape**: a binding, cron or `[vars]` key is added to both `wrangler*.toml` files.
- **Docs in sync**: a behaviour change updates `docs/CONCEPTS.md` (and its "Known gaps"), `SETUP.md`,
  `docs/DEPLOY.md` or the relevant `.claude/rules/*.md` in the same PR. The table in
  `.claude/rules/code-quality.md` says which.
- **No secrets** in a toml, a test, a fixture comment or a response body; `gitleaks` runs in CI over
  the full history.

### <a name="running-tests"></a> Running tests

Tests run under Node against the real Hono app and a **real Postgres** on port 5499
(`pnpm test:db:up`), never a mock database. `apps/web/vitest.config.ts` defines four projects:

| Project | Needs a database | Covers |
|---|---|---|
| `api` | yes | routes, services, queue consumers, Workflow steps, cron tasks, the Durable Object's RPC |
| `api-isolated` | yes | the same, for files marked `// @vitest-isolate` (they mock modules or globals) |
| `ui` | no (jsdom) | components, hooks, providers, streaming and websocket clients |
| `config` | no | wrangler parity, env schema, permissions matrix, dashboard templates, pure helpers |

```bash
pnpm test                       # every package
pnpm web test:api               # or test:ui, test:config
pnpm --filter @launch/cli test
pnpm test:coverage
```

Conventions (`.claude/rules/testing.md`): tests never truncate tables — create unique data and let
it stay; a file that uses `vi.mock` / `vi.stubGlobal` / `vi.spyOn(globalThis…)` starts with exactly
`// @vitest-isolate`; every API test file has a tenant-isolation assertion, a 401, a wrong-role 403
and one error-envelope check. A new job type, cube, fact table, agent or realtime event has a named
test shape in that file — follow it.

### <a name="commit-message-guidelines"></a> Commit message guidelines

```
<subject>
<BLANK LINE>
<body>
```

Subject in the imperative, under 72 characters, no trailing period; the body says *why* and what a
reader should know (the doc that changed, the test that pins it). Example:

```
Queue the access-request decision email

The route answered only after Resend returned; a provider outage failed
the approval. Enqueue email.send instead — the consumer retries with backoff.
```

> [!WARNING]
> Sign your commits before opening a PR — see GitHub's guide to
> [commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification).

### <a name="pr-guidelines"></a> PR guidelines

1. Title: `[<area>] <subject>` — area is `web`, `cli`, `shared`, `docs`, `ci`, or a subsystem such as
   `auth`, `analytics`, `ai`.
2. The description says what changed, why, and how you verified it (the gate, plus any manual check
   from `SETUP.md`).
3. Tests for the feature or the bug, in the project and shape above.
4. Docs updated in the same PR (see "Docs in sync").
5. One concern per PR; a rename or refactor travels separately from a behaviour change.

### <a name="cutting-a-release"></a> Cutting a release

Maintainers only. `SETUP.md` 3.7 is the release dance: move the `## Unreleased` lines in
`CHANGELOG.md` under the new version, bump the root `package.json` version, then
`git commit -am "Release X.Y.Z" && git tag -m "Release X.Y.Z" X.Y.Z && git push origin main X.Y.Z`.
`deploy.yml` refuses a tag that does not equal the root `package.json` version.

### <a name="architecture-guidelines"></a> Architecture guidelines

- **One Worker, one target.** Everything ships as a single Cloudflare Worker; no Node-only APIs in
  `apps/web/src/` (`pnpm build:api` catches what `tsc` cannot).
- **Postgres is the truth.** Realtime events are nudges that make the UI re-query; job and run state
  lives in rows; vectors live in pgvector under the tenant predicate.
- **Drizzle only, parameters only.** SQL goes through Drizzle or the `sql` tag with bound parameters;
  never string concatenation. Two drivers (D35) — Neon serverless or postgres.js — behind
  `openDatabase`; code outside `db/client.ts` never sees which, and reads raw results through
  `rows()` / `affected()`.
- **Optional bindings degrade loudly or silently by design.** A missing binding either no-ops
  (rate limit, tracing, realtime) or throws/503s (queue, storage, workflows) — the service header says
  which; a new binding must choose.
- **Frozen names.** Cube members, job `type` strings and realtime event types are contracts stored or
  consumed elsewhere — add, never rename.
- **Agent-readable by default.** If you change a convention, change the `.claude/rules/*.md` or
  directory `CLAUDE.md` that states it; a future contributor's coding agent reads those first.

## Getting help

- 📖 `docs/CONCEPTS.md`, `SETUP.md`, `docs/DEPLOY.md`
- 🐛 [Existing issues](https://github.com/rocketflare-dev/rocketflare-launch/issues)
- 💬 [Discussions](https://github.com/rocketflare-dev/rocketflare-launch/discussions)

Thank you for contributing to Launch! 🚀
