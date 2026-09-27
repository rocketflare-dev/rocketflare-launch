/**
 * How ANOTHER plugin contributes cubes, fact tables, dashboard templates and cube-isolation cases
 * to this one (D31 decision 6).
 *
 * The kit's core stays ignorant of drizzle-cube, which is the whole point: `ServerPlugin.extensions`
 * is `Record<string, readonly unknown[]>` — `unknown[]` AT THE CORE BOUNDARY deliberately, because
 * the host cannot know what anybody means by a "cube" and should not pretend to. The OWNING plugin
 * narrows, and **fails loudly**: an extension this file cannot parse throws at registry build time
 * naming the plugins that contributed under that key, rather than producing a cube that silently
 * returns nobody's rows or a template that silently does not appear.
 *
 * A contributor writes:
 *
 *     import { analyticsExtensions } from '@/plugins/analytics'
 *     export const crmServer = {
 *       shared: crmShared,
 *       extensions: analyticsExtensions({ cubes: [dealsCube], cubeIsolationCases: [dealsCase] }),
 *     } satisfies ServerPlugin<typeof crmShared>
 *
 * and declares `requires: { plugins: ['analytics'] }` in its `plugin.json`, so installing it
 * without this plugin is refused rather than quietly doing nothing.
 *
 * **Everything here is read LAZILY, inside a function**, through the kit's `extensions(key)`
 * accessor. That accessor reads the server barrel, and the barrel imports this plugin — so
 * evaluating it at module scope here would close a cycle and leave one side holding `undefined` at
 * module evaluation, which takes the Worker down at IMPORT time rather than failing one request.
 * Live bindings make the call-time read safe; the memo below makes it cheap.
 */

import { ANALYTICS_PLUGIN_ID } from '@launch/shared/plugins/analytics/index'
import type { Cube } from 'drizzle-cube/server'
import { z } from 'zod'
import { extensionSources, extensions } from '@/plugins/api/peers'
import type { DashboardTemplate } from './dashboards'
import type { FactTableDefinition } from './services/fact-tables'
import type { CubeIsolationCase } from './testing'

/** The `extensions` keys this plugin reads. Namespaced, so two plugins can never collide. */
export const ANALYTICS_EXTENSION_KEYS = {
  cubes: `${ANALYTICS_PLUGIN_ID}:cubes`,
  factTables: `${ANALYTICS_PLUGIN_ID}:factTables`,
  dashboardTemplates: `${ANALYTICS_PLUGIN_ID}:dashboardTemplates`,
  cubeIsolationCases: `${ANALYTICS_PLUGIN_ID}:cubeIsolationCases`,
} as const

export interface AnalyticsContribution {
  cubes?: readonly Cube[]
  factTables?: readonly FactTableDefinition[]
  dashboardTemplates?: readonly DashboardTemplate[]
  /**
   * One per contributed cube. **Not optional in practice**: the coverage assertion in this
   * plugin's isolation test compares the case keys to the registry, so a cube with no case fails
   * the host's suite — which is the only place a contributed cube's tenant scoping is ever proven.
   */
  cubeIsolationCases?: readonly CubeIsolationCase[]
}

/** Build the `extensions` record for a contributing plugin's `ServerPlugin`. Typed here, `unknown[]` there. */
export function analyticsExtensions(
  contribution: AnalyticsContribution
): Record<string, readonly unknown[]> {
  const out: Record<string, readonly unknown[]> = {}
  if (contribution.cubes) out[ANALYTICS_EXTENSION_KEYS.cubes] = contribution.cubes
  if (contribution.factTables) out[ANALYTICS_EXTENSION_KEYS.factTables] = contribution.factTables
  if (contribution.dashboardTemplates) {
    out[ANALYTICS_EXTENSION_KEYS.dashboardTemplates] = contribution.dashboardTemplates
  }
  if (contribution.cubeIsolationCases) {
    out[ANALYTICS_EXTENSION_KEYS.cubeIsolationCases] = contribution.cubeIsolationCases
  }
  return out
}

// ---- Narrowing ---------------------------------------------------------------------------------

/**
 * Structural, not exhaustive. A `Cube` is mostly functions and drizzle handles, which no schema can
 * meaningfully re-describe — so these check the shape THIS plugin reads and let the rest through.
 * The value of the check is not validation for its own sake: it is that a contributor who returns
 * the wrong thing (a cube factory instead of a cube, say) finds out by name at build time.
 */
const fn = z.custom<(...args: never[]) => unknown>(v => typeof v === 'function', {
  message: 'expected a function',
})
const obj = z.custom<object>(v => typeof v === 'object' && v !== null, {
  message: 'expected an object',
})

const cubeSchema = z.object({ name: z.string().min(1), sql: fn }).passthrough()

const factTableSchema = z
  .object({
    name: z.string().min(1),
    table: obj,
    refreshIntervalMinutes: z.number().int().positive(),
    source: z.object({ name: z.string().min(1), table: obj, timestampColumn: obj }).passthrough(),
    selectForTenant: fn,
  })
  .passthrough()

const dashboardTemplateSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    order: z.number().int(),
    isDefault: z.boolean().optional(),
    feature: z.string().optional(),
    config: z.object({ portlets: z.array(z.unknown()) }).passthrough(),
  })
  .passthrough()

const cubeIsolationCaseSchema = z
  .object({ cube: z.string().min(1), query: obj, expect: fn, seed: fn.optional() })
  .passthrough()

/**
 * Narrow every contribution under one key, or throw naming the plugins that contributed it.
 *
 * `extensions(key)` flattens across plugins, so the contributor of a bad entry is not in the value
 * itself — `extensionSources(key)` is what names them. A list rather than the one culprit is the
 * honest answer to what the accessor can tell us, and it is still a name to go and look at rather
 * than "an extension failed to parse".
 */
function narrow<T>(key: string, schema: z.ZodType<unknown>): T[] {
  const out: T[] = []
  for (const [index, value] of extensions(key).entries()) {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      const from = extensionSources(key).join(', ') || 'an installed plugin'
      throw new Error(
        `${key}[${index}] from ${from} is unusable: ` +
          parsed.error.issues.map(i => `${i.path.join('.') || '<root>'} ${i.message}`).join('; ')
      )
    }
    out.push(value as T)
  }
  return out
}

/**
 * Memoised per isolate. The contributions come from `as const` module-scope objects, so they cannot
 * change within an isolate; and `cubesFor` runs per request, which is exactly where re-walking and
 * re-validating every plugin would be paid for.
 */
function memo<T>(read: () => T[]): () => T[] {
  let cached: T[] | null = null
  return () => {
    if (cached === null) cached = read()
    return cached
  }
}

export const contributedCubes = memo<Cube>(() =>
  narrow<Cube>(ANALYTICS_EXTENSION_KEYS.cubes, cubeSchema)
)
export const contributedFactTables = memo<FactTableDefinition>(() =>
  narrow<FactTableDefinition>(ANALYTICS_EXTENSION_KEYS.factTables, factTableSchema)
)
export const contributedDashboardTemplates = memo<DashboardTemplate>(() =>
  narrow<DashboardTemplate>(ANALYTICS_EXTENSION_KEYS.dashboardTemplates, dashboardTemplateSchema)
)
export const contributedCubeIsolationCases = memo<CubeIsolationCase>(() =>
  narrow<CubeIsolationCase>(ANALYTICS_EXTENSION_KEYS.cubeIsolationCases, cubeIsolationCaseSchema)
)
