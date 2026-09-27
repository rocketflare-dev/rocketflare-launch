/**
 * The plugin's TanStack query families (D31), declared once here and handed to the host twice: to
 * `UiPlugin.queryKeys`, which merges them into the app-wide `queryKeys` so anything may reach them,
 * and to this plugin's own hooks, which read them directly.
 *
 * **Every root starts with `<id>:`** — `tests/config/plugins.test.ts` is the check — so one
 * plugin's invalidation can never reach another's cache, and `ANALYTICS_DASHBOARDS_ENTITY` is the
 * same string the server puts in its `entity.changed` nudge and in `SharedPlugin.realtimeRoots`,
 * which is what makes the socket wiring free.
 *
 * One family, not four: pages, templates, the fact-table status and the cube meta all invalidate
 * together when somebody's access moves (D29), and a create/reset/recreate has to reach the list
 * and every open detail at once.
 */
import { ANALYTICS_DASHBOARDS_ENTITY } from '@launch/shared/plugins/analytics/index'

export const analyticsKeys = {
  all: [ANALYTICS_DASHBOARDS_ENTITY] as const,
  pages: {
    all: [ANALYTICS_DASHBOARDS_ENTITY, 'pages'] as const,
    list: [ANALYTICS_DASHBOARDS_ENTITY, 'pages', 'list'] as const,
    detail: (id: string) => [ANALYTICS_DASHBOARDS_ENTITY, 'pages', 'detail', id] as const,
  },
  templates: [ANALYTICS_DASHBOARDS_ENTITY, 'templates'] as const,
  factsStatus: [ANALYTICS_DASHBOARDS_ENTITY, 'facts-status'] as const,
  /** Changes only with a deploy, so it is cached hard; kept in the family so `access.changed` clears it. */
  cubeMeta: [ANALYTICS_DASHBOARDS_ENTITY, 'cube-meta'] as const,
}

export const analyticsQueryKeys = {
  [ANALYTICS_DASHBOARDS_ENTITY]: analyticsKeys,
} as const
