/**
 * `analytics` — the analytics plugin's SERVER entry (D31, Phase C).
 *
 * One of the four published files a plugin has (this, `./ui`, the shared entry and the CLI one);
 * everything else under this directory is private, which is what lets the plugin's own semver
 * cover a knowable surface. `tests/config/plugins.test.ts` enforces it: nothing outside the plugin
 * may name a file inside it except the five barrel lines.
 *
 * Read this file top to bottom and you have the whole server half: three mounts and the two extra
 * prefixes they need, the fact-refresh job, the hourly cron, the two CASL subjects with their
 * grants, dashboards as a restrictable resource, and what a new organisation and the demo seed get.
 *
 * **It is also the boundary.** The registration slots below are the KIT's shapes — a `JobHandler`,
 * a `ScheduledTask`, the hook signatures — while everything the plugin's own code is written
 * against is the plugin surface. So the adapters (`jobCtx`, `cronCtx`, and the two hook spreads)
 * are called here, once each, and nowhere else. That is the sentence the whole contract makes
 * true: *a plugin imports only from declared entries, and receives everything else as injected
 * context.*
 *
 * **Everything here was core until 0.6.0.** `Dashboard` and `Analytics` left `CORE_SUBJECTS` and
 * the kit's ability matrix; `/cubejs-api` and `/mcp` left `CORE_API_PREFIXES`; the `15 * * * *`
 * entry left `CORE_SCHEDULED_TASKS` and both tomls' `[triggers]`; `ensureDefaultDashboards` left
 * `onTenantCreated`; the dashboards entry left `CORE_VISIBILITY_RESOURCES`. The kit is bare, and
 * this file is what puts analytics back.
 */
import {
  ANALYTICS_REFRESH_FACTS_JOB,
  ANALYTICS_SUBJECT,
  analyticsShared,
  DASHBOARD_SUBJECT,
} from '@launch/shared/plugins/analytics/index'
import type { ServerPlugin } from '@/plugins/api'
import { onTenantCreated, seedDemo } from './api/hooks'
import { analyticsPagesRouter } from './api/routes/analytics-pages'
import { cubeApiRouter } from './api/routes/cube-api'
import { refreshFactTablesTask } from './api/scheduled'
import { handleAnalyticsRefreshFacts } from './jobs/refresh-facts'
import { analyticsPageVisibility } from './visibility'

export const analyticsServer = {
  shared: analyticsShared,
  /**
   * Three mounts, two of them the SAME router: drizzle-cube's Hono adapter registers ABSOLUTE
   * paths (`/cubejs-api/v1/{load,meta,sql,batch,dry-run}` and `/mcp`), so the raw request is
   * forwarded rather than a prefix-stripped one, and mounting one router twice is how both
   * prefixes reach it. No `requireFeature` here: analytics is a whole plugin, and not installing
   * it is how a deployment ships without it.
   *
   */
  mounts: [
    ['/api/analytics', analyticsPagesRouter],
    ['/cubejs-api', cubeApiRouter],
    ['/mcp', cubeApiRouter],
  ],
  /**
   * The two prefixes the kit's own router table does not already own (`/api` does). They matter in
   * three places: the SPA catch-all answers a JSON 404 under them instead of `index.html`, the
   * Vite dev proxy forwards them, and `[assets] run_worker_first` keeps them off Cloudflare's asset
   * router — the last one is a wrangler toml edit, so `pnpm plugin add` prints it as a numbered
   * step and `pnpm provision cloudflare <env>` writes it.
   */
  apiPrefixes: ['/cubejs-api', '/mcp'],
  jobHandlers: { [ANALYTICS_REFRESH_FACTS_JOB]: handleAnalyticsRefreshFacts },
  /** The hourly per-tenant rebuild. The expression is also `plugin.json`'s `crons`. */
  scheduledTasks: { '15 * * * *': [refreshFactTablesTask] },
  /**
   * Additive only, over this plugin's own two subjects (CASL can take a rule back with `cannot`,
   * and a plugin that revoked a kit grant would change what every role may do merely by being
   * installed). The shape is exactly the matrix analytics had inside the kit: `analytics_pages`
   * CRUD is admin+ while every member may read a dashboard, and the cube API is `read` for
   * everybody because it is read-only by nature and every cube scopes its own `sql()` by tenant.
   */
  grants: {
    owner: can => {
      can('manage', DASHBOARD_SUBJECT)
      can('read', ANALYTICS_SUBJECT)
    },
    admin: can => {
      can('manage', DASHBOARD_SUBJECT)
      can('read', ANALYTICS_SUBJECT)
    },
    support: can => {
      can('manage', DASHBOARD_SUBJECT)
      can('read', ANALYTICS_SUBJECT)
    },
    member: can => {
      can('read', DASHBOARD_SUBJECT)
      can('read', ANALYTICS_SUBJECT)
    },
  },
  /** Dashboards are restrictable to groups (D29) — see `./visibility.ts`. */
  visibilityResources: [analyticsPageVisibility],
  /**
   * Post-commit, idempotent, best-effort — each try/caught by the host, so neither may ever break
   * sign-up. The kit hands them its own shapes; `HookCtx` / `SeedCtx` is what the bodies read.
   */
  hooks: {
    onTenantCreated: (db, tenant, userId, features) =>
      onTenantCreated({ db, tenant, tenantId: tenant.id, userId, features }),
    seedDemo: (db, ctx) =>
      seedDemo({
        db,
        tenantId: ctx.tenantId,
        ownerId: ctx.ownerId,
        demoId: ctx.demoId,
        log: ctx.log,
      }),
  },
} satisfies ServerPlugin<typeof analyticsShared>

/**
 * What a CONTRIBUTING plugin imports (D31 decision 6) — cubes, fact tables, dashboard templates and
 * cube-isolation cases, typed here and `unknown[]` at the core boundary. Published deliberately:
 * these are part of the four-entry API surface this plugin's semver covers.
 */
export {
  ANALYTICS_EXTENSION_KEYS,
  type AnalyticsContribution,
  analyticsExtensions,
} from './extensions'
export type { CubeIsolationCase, IsolationRows, IsolationSide } from './testing'
