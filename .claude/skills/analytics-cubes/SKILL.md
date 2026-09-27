---
name: analytics-cubes
description: Define, extend and test drizzle-cube cubes and fact tables in this app's analytics plugin — add a measure or dimension, model a new table as a cube, add joins, add a pre-aggregated fact table, contribute a cube from ANOTHER plugin through analyticsExtensions, and prove tenant isolation with the mandatory cube-isolation test. Use when someone wants a new metric, KPI, cube, measure, dimension, join, fact table or semantic-layer change, or asks why a cube leaks or fails to compile.
argument-hint: "[add-measure <Cube> | new-cube <table> | fact-table <name> | contribute <plugin> | test]"
---

# Cubes — define, extend and prove them

Cubes live in `apps/web/src/plugins/analytics/cubes/`, one file per cube. They are registered in
`cubes/index.ts` (`ANALYTICS_CUBES`, then `allCubes()`) and served per request by
`api/routes/cube-api.ts`. **Read `cubes/CLAUDE.md` before you write anything.** `reference.md`
beside this file has the drizzle-cube **0.8.3** API: measure and dimension types, join shapes and
the event-stream metadata.

**Ground rules, in every mode:**
- **Every cube scopes its base query to the active tenant.** No exceptions. There is no second line
  of defence, so a cube without the tenant predicate leaks every organisation's rows to every member.
- **Every cube has an isolation case.** The test fails until it does, and that is intended. Never
  delete or loosen a case to make it pass.
- **Member names are frozen once shipped.** Dashboards store `Cube.member` strings in
  `analytics_pages.config`, so renaming one silently breaks every tenant's saved dashboards. Add a
  new member instead; the old one can stay.
- Show the diff and get a yes before editing a cube that is already in use.

## Preconditions

1. The app runs (`pnpm dev`) and the test database is up (`pnpm test:db:up`).
2. The plugin is healthy: the `analytics` skill, **Health** mode.

## The shape of a cube in this app (0.8.3)

```ts
import type { BaseQueryDefinition, Cube, QueryContext } from 'drizzle-cube/server'
import { defineCube } from 'drizzle-cube/server'
import { eq } from 'drizzle-orm'
import { orders } from '../db/schema/orders'          // or '@/db/schema/kit' for a KIT table
import { tenantIdOf } from './security'

export const ordersCube: Cube = defineCube('Orders', {   // name is the FIRST argument
  title: 'Orders',
  description: 'One row per order',

  // REQUIRED: a function of the query context returning { from, where } — the tenant predicate.
  sql: (ctx: QueryContext): BaseQueryDefinition => ({
    from: orders,
    where: eq(orders.tenantId, tenantIdOf(ctx)),
  }),

  dimensions: {
    id: { name: 'id', title: 'Order ID', type: 'string', sql: orders.id, primaryKey: true },
    status: { name: 'status', title: 'Status', type: 'string', sql: orders.status },
    createdAt: { name: 'createdAt', title: 'Created', type: 'time', sql: orders.createdAt },
  },

  measures: {
    count: { name: 'count', title: 'Orders', type: 'count', sql: orders.id },
    revenue: { name: 'revenue', title: 'Revenue', type: 'sum', sql: orders.amount },
    paidCount: {
      name: 'paidCount', title: 'Paid orders', type: 'count', sql: orders.id,
      filters: [() => eq(orders.status, 'paid')],    // an array of FUNCTIONS returning SQL
    },
  },
})
```

**Warning for anyone reading generic drizzle-cube examples**, including the upstream
`dc-cube-definition` skill: they show `defineCube({ name, sql: securityContext => eq(...) })`,
`sql: () => column` and `filters: [{ sql: () => … }]`. Those forms **do not type-check on 0.8.3**,
or on the current 0.9.x. In this app:
- the name is the first argument;
- `sql` returns `{ from, where }`;
- `name` is required on every measure and dimension;
- a measure filter is a bare function `(ctx) => SQL`;
- a dimension's `sql` is the column itself (a function is also allowed).

**Tables without `tenant_id`** (like the kit's `users`) are scoped through membership. Copy
`cubes/users.ts`: `inArray(users.id, <select user_id from tenant_users where tenant_id = …>)`.

**Group narrowing (D29)** applies only when your OWN table carries a group column. Use `groupFilter(ctx, '<Group type name>', table.groupColumn)`
from `./security`, ANDed with the tenant predicate. A reader with no group of that type sees
nothing; admins are not narrowed. See `cubes/CLAUDE.md`.

## Mode: add a measure or dimension to an existing cube

1. Open the cube file and add the member. Follow the naming in the file: camelCase keys and a
   human `title`.
2. `pnpm typecheck`.
3. Prove it returns data. Start `pnpm dev`, then use `analytics-queries` to `POST
   /cubejs-api/v1/load` with the new member, or pick it in `/analytics/explore`.
4. **Extend the cube's isolation case** in `tests/api/cube-isolation.test.ts` if the new member is
   one a tenant could see another tenant through (anything touching a join or a new column).
5. Run the tests (see **Test**).

## Mode: model a new table as a cube

1. **The table must be tenant-scoped.** It carries `tenantRef()` and calls `tenantIsolation()`,
   which RLS coverage enforces. If it's a kit table, import it from `@/db/schema/kit`. If it belongs
   to this plugin, it is prefixed `analytics_` and lives under `db/schema/`. Otherwise it belongs to
   another plugin: use **contribute**.
2. Create `cubes/<name>.ts` in the shape above. Give it exactly one `primaryKey: true` dimension. For
   a junction table with no id, copy the synthetic-key trick in `cubes/tenant-users.ts`.
3. **Joins:**
   - Declare them on the `belongsTo` side only, e.g. `Orders → Users` with
     `on: [{ source: orders.userId, target: users.id }]` and `targetCube: () => usersCube` (the thunk
     breaks import cycles).
   - drizzle-cube walks the join in both directions, so don't add the reverse `hasMany`. In this app,
     a declared `hasMany` between two cubes makes every ungrouped (`recordsTable`) query that mixes
     them a 400.
4. **Register it** in `cubes/index.ts`: add it to `ANALYTICS_CUBES` (sorted by title) and to the
   named exports.
5. **Add its isolation case** (see **Test**): seed rows for both tenants, and assert that each sees
   only its own.
6. If the cube has an event column (actor, time, event name), add `meta.eventStream` to unlock the
   funnel, flow and retention modes. Copy `cubes/activity-events.ts`.
7. **Feature-gated?** If the cube belongs to a feature that may ship dark (D30), add it to
   `FEATURE_CUBES` in `cubes/index.ts`. It then disappears from `/meta` and `/mcp` for tenants
   without the feature. `allCubes()` stays complete, so the isolation test still proves its scoping.
8. Run `pnpm typecheck`, then the tests, then check it appears in `/analytics/explore`.

## Mode: add a fact table (pre-aggregation)

Use a fact table when a dashboard would otherwise scan a large event table on every view. Read
`services/fact-tables/CLAUDE.md` first. The steps:

1. **Schema.** Create `db/schema/facts/<name>.ts` with `tenantRef()`, a `fact_refreshed_at`
   timestamp, `tenantIsolation()`, and a unique constraint on the grain (use `NULLS NOT DISTINCT` if
   a grain column is nullable). Export it from `db/schema/facts/index.ts`.
2. **Query.** Create `services/fact-tables/queries/<name>.ts`: a parameterised `sql` SELECT for ONE
   tenant, **with columns in the same order as the schema file**, because the INSERT uses that order.
3. **Register it.** Add one entry to `ANALYTICS_FACT_TABLES` in `services/fact-tables/registry.ts`:
   `{ name, table, refreshIntervalMinutes, source: { name, table, timestampColumn }, selectForTenant }`.
4. **Add a cube** over the fact table, with the same tenant predicate, plus an isolation case. The
   case should call `refreshFactTable(db, '<name>', { tenantId })` in its seed.
5. **Migrate the host.** The plugin ships no migrations; the host generates them:
   `pnpm db:generate --name plugin-analytics-<version>`, read the SQL, then `pnpm db:migrate`.
6. **Verify.**
   - `pnpm cli analytics refresh-facts` (admin) enqueues a rebuild for your organisation.
   - `pnpm cli analytics check-facts` should then show the table as `fresh`.
   - When deployed, the `15 * * * *` cron rebuilds every tenant hourly.

**Limits to tell the person:**
- A refresh is a full rebuild per tenant (DELETE then INSERT in one transaction).
- Don't run a manual refresh while the cron is due. Two rebuilds of one tenant can collide; the
  result is safe, but that tenant is reported in `errors[]`.
- Past a few hundred tenants, the cron should fan out through the queue instead of looping.
- `REFRESH MATERIALIZED VIEW` doesn't work through Hyperdrive.

## Mode: contribute a cube from another plugin

Another plugin (say `crm`) may add cubes, fact tables, dashboard templates and isolation cases
without touching this plugin. It does so through `extensions`, and this plugin validates the input
strictly: a malformed contribution throws at startup, naming the contributing plugin.

1. In the contributing plugin's server entry:

   ```ts
   import { analyticsExtensions } from '@/plugins/analytics'
   export const crmServer = {
     shared: crmShared,
     extensions: analyticsExtensions({
       cubes: [dealsCube],
       cubeIsolationCases: [dealsIsolationCase],   // NOT optional in practice
       // factTables: [...], dashboardTemplates: [...]
     }),
   } satisfies ServerPlugin<typeof crmShared>
   ```

2. Declare the dependency in the contributing plugin's `rocketflare-plugin.json` as
   `"requires": { "plugins": ["analytics"] }`. Installing it without analytics is then refused, and
   plugin CI installs analytics first.
3. The isolation case uses the `CubeIsolationCase` type (`apps/web/src/plugins/analytics/testing.ts`):
   `{ cube, seed?(db, { tenantId, userId }), query, expect(rows, side) }`. `seed` runs once for
   each of the two tenants; `expect` must pass for tenant `'a'` and for tenant `'b'`.
4. Namespacing: the contributed cube's tables are the contributing plugin's own (`crm_*`), and its
   cube name must not collide with an existing one. `/meta` shows the whole set.

## Test

The mandatory test is `apps/web/src/plugins/analytics/tests/api/cube-isolation.test.ts`. It:
- seeds two tenants;
- runs every cube in `allCubes()` through the real `POST /cubejs-api/v1/load` as each tenant;
- asserts each tenant gets exactly its own rows;
- checks that none of tenant B's ids appear in tenant A's results;
- runs every dashboard-template portlet query.

Its coverage assertion compares the case keys to `allCubes()`, so a new cube with no case fails.
To add a case for a cube owned by this plugin, add it to the `cases` record in that file. For a
contributed cube, use `cubeIsolationCases`.

```bash
pnpm test:db:up
pnpm web test:api        # every API project, including this plugin's tests
pnpm web test:config     # includes all-templates.test.ts (template members exist in allCubes())
```

To run just this file:

```bash
cd apps/web && NODE_ENV=test pnpm exec dotenv -e .env.test -- vitest run --project api src/plugins/analytics/tests/api/cube-isolation.test.ts
```

**Success** is every case green in both directions. Then run the full gate before committing:
`pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cube query without a tenant in the security context` | a cube was queried outside the route, e.g. from a script | only query through `/cubejs-api` or `/mcp`; the route builds the security context |
| Type error on `defineCube({ name: … })` or `filters: [{ sql }]` | generic or upstream example syntax | use the 0.8.3 shape above |
| 400 on a table-style (ungrouped) query that mixes two cubes | a declared `hasMany` between them | declare the `belongsTo` side only |
| isolation test: "keys differ from allCubes()" | a new cube with no case | add the case |
| a tenant sees rows it shouldn't | the tenant predicate is missing, or on the wrong column, or a join reaches an unscoped table | fix `sql`; every cube reached through a join needs its own predicate |
| startup error `analytics:cubes[0] from <plugin> is unusable` | a contribution isn't a cube (e.g. a factory function was passed) | pass the `defineCube(...)` result |
| a dashboard shows "member not found" after a change | a member was renamed | restore the old name; add the new one alongside it |

## Sources

- drizzle-cube docs, cube definitions: https://www.drizzle-cube.dev
- drizzle-cube 0.8.3 types, checked against the published package (`npm pack drizzle-cube@0.8.3`: `dist/server/cube-utils.d.ts` `defineCube(name, definition)`, `dist/server/types/cube.d.ts` `Measure.filters: Array<(ctx) => SQL>`, `CubeJoin`): https://www.npmjs.com/package/drizzle-cube/v/0.8.3
- Upstream skill this adapts (MIT, generic syntax corrected above): https://github.com/cliftonc/drizzle-cube-plugin/blob/main/skills/dc-cube-definition/SKILL.md
- This app: `apps/web/src/plugins/analytics/cubes/CLAUDE.md`, `services/fact-tables/CLAUDE.md`, `extensions.ts`, `testing.ts`
