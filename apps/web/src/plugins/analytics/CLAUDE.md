# `analytics` — the analytics plugin (D31, Phase C)

Dashboards, the semantic layer, the drizzle-cube API and one example fact table. It was the kit's
§8 until 0.6.0; it is now a plugin, and the kit knows nothing about drizzle-cube.
`docs/CONCEPTS.md` §8 is the pointer, this directory is the reference.

Install: `pnpm plugin add https://github.com/rocketflare-dev/rocketflare-plugins.git --subdir plugins/analytics --apply`
— it is in `.rocketflare.json` `defaultPlugins`, so `bash scripts/bootstrap.sh` installs it for you.
Requires kit `>=0.7.0` and declares `requires.pluginApi: "1"`, which is what holds it STRICTLY to
the import rule below rather than merely warning about it.

## The four published entries, and nothing else

| Entry | What it declares |
|---|---|
| `index.ts` | `mounts` (`/api/analytics`, `/cubejs-api`, `/mcp`), `apiPrefixes`, the refresh `jobHandlers`, `scheduledTasks['15 * * * *']`, `grants` for `Dashboard` / `Analytics`, `visibilityResources`, `hooks` — plus the extension helpers another plugin imports |
| `ui/index.ts` | three lazy routes, one nav item, one Home quick link, the query-key family |
| `@launch/shared/plugins/analytics/index` | the contracts, the two CASL subjects, the `analytics.refresh-facts` job, the realtime root |
| `apps/cli/src/plugins/analytics/index.ts` | `launch analytics pages list \| check-facts \| refresh-facts` |

Everything else here is private. Core reaching past those four, or another plugin doing it, is a
`tests/config/plugins.test.ts` failure rather than a convention.

## Where this plugin reaches the host

**One sentence, and it is checked**: *a plugin imports only from declared entries, and receives
everything else as injected context* (`docs/plugin-api.md`). In practice:

| Layer | Entry |
|---|---|
| routes | `const ctx: RequestCtx = requestCtx(c)` — **the annotation is required**, or `ctx.notFound(...)` does not narrow |
| the cron task | `CronCtx` via `cronCtx(raw)`, adapted once in `api/scheduled.ts` |
| the refresh job | `JobCtx` via `jobCtx(raw)`, adapted once in `jobs/refresh-facts.ts` |
| hooks | `HookCtx` / `SeedCtx` |
| table files | `@/db/schema/kit`, **by relative path** — drizzle-kit bundles them and resolves no alias |
| `ui/index.ts` | `@/plugins/api/ui-wiring` only (it ships in the MAIN bundle) |
| pages and their components | `@/plugins/api/ui` |
| tests | `@testkit/integration` (the harness) and `@testkit/unit` (the context builders) |
| the CLI half | `../api` |

Three escapes, each deliberate and each in one file: `extensions()` / `extensionSources()` and
`allTables()` from `@/plugins/api/peers` (`extensions.ts`, `cube-api.ts`), and `ctx.detached()` for
the cube security context, which drizzle-cube calls where no request exists.

Every kit table this plugin names — `tenants`, `users`, `groups`, `group_types`, `activity_events`,
`tenant_users` — comes from `@/db/schema/kit`, so the cubes and the fact-table registry are plain
module-scope consts. The one exception is `group_members`, which the schema kit does not export and
which one test reads through `allTables()`, inside a hook.

**`services/visibility.ts` is the plugin's own half of D29.** The kit publishes what it takes to
DECLARE a restrictable resource and reads that declaration; it does not publish
`grantsForResources`, `setResourceGroups` or `resolveRequestedVisibility`, so they live here, over
this plugin's own registry entry, keeping both rules: a group id is checked against the tenant
before it is stored, and a member may share only with groups they are in (403 `group_not_yours`).

## The three rules this plugin exists to demonstrate

**Cubes scope themselves, and nothing else does it for them.** Every cube filters on
`tenantIdOf(ctx)` inside its own `sql()`; drizzle-cube joins whatever a query asks for and adds no
second line of defence, so `tests/api/cube-isolation.test.ts` is mandatory and its coverage
assertion compares the case keys to `allCubes()`. A cube with no case fails the host's suite.
`cubes/CLAUDE.md` is the detail.

**Another plugin may contribute, and it is narrowed loudly.** `extensions.ts` reads every installed
plugin's `extensions` for `analytics:{cubes,factTables,dashboardTemplates,cubeIsolationCases}`,
zod-narrows each, and THROWS naming the contributing plugin when it cannot. `unknown[]` at the core
boundary is the point (D31 decision 6): the kit stays ignorant of what a "cube" is.

**Three registries are FUNCTIONS, not consts, and that is load-bearing.** `allCubes()`,
`factTables()` and `DASHBOARD_TEMPLATES()` compose in what other plugins contributed, which means
reading the server plugin barrel — and that barrel imports this plugin. Evaluated at module scope
one side finds it still `undefined`, and the failure is `undefined.flatMap` at IMPORT time: the
Worker never starts, and which entry point loses the race depends on nothing a reader can see. Read
at call time, live bindings are always resolved; each memoises. The same rule put
`sharedWithMyGroups` and `accessScopeOf` in the kit's leaf `api/services/access-sql.ts` and made its
`visibilityResources()` a function.

## Bundle boundaries

`dashboards/registry.ts` is pure data the BROWSER may import; `dashboards/index.ts` composes in
other plugins' templates and therefore drags the whole Worker — keep the UI on `registry`.
`ui/index.ts` ships in the main bundle, so every page is `lazy(() => import(...))` and
drizzle-cube, recharts, d3 and react-grid-layout stay inside the analytics chunk
(`grep -c recharts apps/web/dist/ui/assets/index-*.js` must be 0).
`drizzle-cube-theme.css` sits beside the library's own stylesheet in `CubeClientProvider`, so a
bare kit carries none of it.

## What the host has to do by hand

A plugin edits no toml, no `package.json` and no core file. `pnpm plugin add` prints these; this is
the list:

- `[triggers].crons` in BOTH wrangler tomls gains `"15 * * * *"`, and `[assets].run_worker_first`
  gains `/cubejs-api`, `/cubejs-api/*`, `/mcp`, `/mcp/*` (the parity test reads `API_PREFIXES`, so
  a forgotten one fails the gate rather than silently serving the app shell).
- `apps/web/vite.config.ts`: `/cubejs-api` and `/mcp` in the dev proxy, `'@nivo/heatmap'` aliased to
  `./src/plugins/analytics/ui/lib/nivo-heatmap.tsx` (drizzle-cube's heat-map chunk names that
  optional peer and Rollup fails without it), and `'recharts'` in `dedupe`.
- `pnpm db:generate --name plugin-analytics-<version>`, then `pnpm db:migrate`.

## Things that moved and are not coming back

`pnpm web db:refresh-facts` and `db:check-facts` were `apps/web/scripts/*.ts`, which is not a
directory a plugin may own. They are `launch analytics refresh-facts` and `check-facts` now:
one organisation rather than every tenant, over a route rather than a bare `DATABASE_URL`, and the
refresh ENQUEUES (`analytics.refresh-facts`) because a route never runs long work. The `:15` cron is
still the cross-tenant path and is unchanged.

The fact table is `analytics_tenant_activity_daily_facts` — the `<id>_*` rule. There is no
compatibility path (D31 decision 7): an app that carried the kit's `tenant_activity_daily_facts`
sees it dropped and the new one rebuilt by the next cron. `analytics_pages` and
`analytics_page_groups` already carried the prefix, so their ROWS survive untouched.
