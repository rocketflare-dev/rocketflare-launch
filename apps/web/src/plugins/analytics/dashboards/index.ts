/**
 * Dashboard template registry (D19, D31). `DASHBOARD_TEMPLATES()` is the ONLY definition of "the
 * dashboards every tenant gets": `ensureDefaultDashboards` (tenant creation + lazy on first list),
 * `resetToTemplate`, `recreateTemplates`, `GET /api/analytics/templates` and
 * `tests/config/all-templates.test.ts` all read it.
 *
 * **Server-side only.** It composes in every template another installed plugin contributed through
 * `analyticsExtensions({ dashboardTemplates })`, and reading that means reading the SERVER plugin
 * barrel — which drags the whole Worker into any bundle that imports this file. The UI imports
 * `./registry` instead, which is this plugin's own templates as plain data.
 *
 * A FUNCTION, not a const, for the same reason `allCubes()` is one: evaluated at module scope the
 * barrel read would close a cycle and find `serverPlugins` undefined. `contributedDashboardTemplates`
 * memoises, so the walk is paid once per isolate.
 */
import { contributedDashboardTemplates } from '../extensions'
import { ANALYTICS_TEMPLATES, getTemplate as ownTemplate, sortTemplates } from './registry'
import type { DashboardTemplate } from './types'

/**
 * A contributed key that collides with an existing one is a mistake with consequences — `key`
 * doubles as the page SLUG, which is unique per tenant — so it throws rather than overwriting.
 */
export function DASHBOARD_TEMPLATES(): Record<string, DashboardTemplate> {
  const all: Record<string, DashboardTemplate> = { ...ANALYTICS_TEMPLATES }
  for (const template of contributedDashboardTemplates()) {
    if (all[template.key]) {
      throw new Error(`dashboard template key '${template.key}' is declared twice`)
    }
    all[template.key] = template
  }
  return all
}

export function getTemplate(key: string): DashboardTemplate | null {
  return DASHBOARD_TEMPLATES()[key] ?? ownTemplate(key)
}

/**
 * Every template the caller may see, in nav order. `features` is `AuthContext.features`; a template
 * declaring a `feature` nobody holds is omitted everywhere templates are read — listed, seeded,
 * reset and recreated — because those are the four ways a page reaches a tenant (D30).
 */
export function listTemplates(features: readonly string[] = []): DashboardTemplate[] {
  return sortTemplates(DASHBOARD_TEMPLATES(), features)
}

export type { DashboardTemplate }
export { ANALYTICS_TEMPLATES }
