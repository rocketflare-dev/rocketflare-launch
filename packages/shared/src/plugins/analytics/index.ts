/**
 * `analytics` — the analytics plugin's SHARED entry (D31, Phase C).
 *
 * One of the four published files a plugin has (this, the server entry, `ui/index.ts` and the CLI
 * one); everything else under `packages/shared/src/plugins/analytics/` is private, which is what
 * lets the plugin's own semver cover a knowable surface. Imported as
 * `@launch/shared/plugins/analytics/index` — the package's `./*` export maps to a FILE, so the
 * `/index` is load-bearing and is not a typo.
 *
 * It carries the contracts `./contracts.ts` used to hold at `@launch/shared/plugins/analytics/index` when
 * analytics was part of the kit, plus the four slots the seam needs from the shared half:
 *
 *   subjects        `Dashboard` (an `analytics_pages` row) and `Analytics` (the cube API itself),
 *                   which leave the kit's `CORE_SUBJECTS` with this plugin.
 *   jobs            `analytics.refresh-facts` — what `launch analytics refresh-facts` and
 *                   `POST /api/analytics/facts/refresh` enqueue, because a route never runs long
 *                   work and a fact rebuild is a full DELETE+INSERT per table.
 *   realtimeRoots   the dashboards query-key root, added to `access.changed` so somebody whose
 *                   group membership moved re-fetches the pages they may now no longer open (D29).
 *
 * **This module never imports a composer at runtime** (`permissions.ts`, `features.ts`, `jobs.ts`,
 * `ai/agents.ts`, `realtime.ts`): those five read the plugin barrel, so importing one back closes a
 * cycle that crashes at module evaluation rather than failing to compile.
 */
import { z } from 'zod'
import type { SharedPlugin } from '../types'

/** The plugin's id — and the namespace for every key below. */
export const ANALYTICS_PLUGIN_ID = 'analytics'

/**
 * The plugin's TanStack query-key family root, and the `entity.changed` entity that nudges it.
 * `<id>:<thing>`, which is the rule that keeps one plugin's invalidation out of another's cache —
 * and the kit's convention that an `entity.changed` entity IS a query-key family root is what makes
 * the socket wiring free.
 */
export const ANALYTICS_DASHBOARDS_ENTITY = 'analytics:dashboards'

/** `analytics_pages` rows: admin+ `manage`, every member `read`. */
export const DASHBOARD_SUBJECT = 'Dashboard'
/** The cube API itself (`/cubejs-api`, `/mcp`): `read` for every role, tenant-scoped by every cube. */
export const ANALYTICS_SUBJECT = 'Analytics'

/** Rebuild this organisation's fact tables. `<id>.<verb>`, so it cannot collide with a kit type. */
export const ANALYTICS_REFRESH_FACTS_JOB = 'analytics.refresh-facts'

/**
 * The refresh job's payload. **One tenant, always** — the `:15` cron is the cross-tenant path and
 * it runs in the Worker's own scheduled handler; a job a tenant API key can enqueue must never
 * rebuild somebody else's rows. `table` narrows it to one fact table (the CLI's `--table`).
 */
export const analyticsRefreshFactsPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  table: z.string().min(1).optional(),
})
export type AnalyticsRefreshFactsPayload = z.infer<typeof analyticsRefreshFactsPayloadSchema>

/** `POST /api/analytics/facts/refresh` — the envelope the route enqueued, so a caller can find it. */
export const analyticsRefreshFactsResponseSchema = z.object({
  jobId: z.string().uuid(),
  type: z.literal(ANALYTICS_REFRESH_FACTS_JOB),
  enqueuedAt: z.string().datetime(),
})
export type AnalyticsRefreshFactsResponse = z.infer<typeof analyticsRefreshFactsResponseSchema>

export * from './contracts'

/**
 * `as const satisfies SharedPlugin` on both halves: `satisfies` checks the shape here, where the
 * author is looking, and `as const` keeps `subjects` a tuple of literals so the composed subject
 * union names `'Dashboard' | 'Analytics'` rather than widening to `string`.
 */
export const analyticsShared = {
  id: ANALYTICS_PLUGIN_ID,
  label: 'Analytics',
  version: '1.0.2',
  subjects: [DASHBOARD_SUBJECT, ANALYTICS_SUBJECT],
  jobs: [
    z.object({
      type: z.literal(ANALYTICS_REFRESH_FACTS_JOB),
      payload: analyticsRefreshFactsPayloadSchema,
    }),
  ],
  realtimeRoots: [ANALYTICS_DASHBOARDS_ENTITY],
} as const satisfies SharedPlugin
