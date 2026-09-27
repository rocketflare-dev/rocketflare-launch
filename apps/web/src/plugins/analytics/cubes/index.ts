/**
 * Cube registry (D19, D31): `allCubes()` is what `api/routes/cube-api.ts` hands to `createCubeApp`
 * on every request and what `tests/api/cube-isolation.test.ts` walks. Adding a cube = a file here +
 * an entry below + a case in that test. Another PLUGIN adds one through
 * `analyticsExtensions({ cubes, cubeIsolationCases })` (D31 decision 6). Read ./CLAUDE.md first.
 *
 */
import type { Cube } from 'drizzle-cube/server'
import { contributedCubes } from '../extensions'
import { activityEventsCube } from './activity-events'
import { tenantActivityDailyCube } from './tenant-activity-daily'
import { tenantUsersCube } from './tenant-users'
import { usersCube } from './users'

/** This plugin's own cubes, sorted by title — the order the schema explorer shows. */
export const ANALYTICS_CUBES: Cube[] = [
  activityEventsCube, // Activity Events
  tenantActivityDailyCube, // Daily Activity
  tenantUsersCube, // Members
  usersCube, // Users
]

/**
 * Every cube this app has: this plugin's, plus every cube another installed plugin contributed
 * through `analyticsExtensions({ cubes })` (D31 decision 6). A FUNCTION because reading the plugin
 * barrel at module scope here would close a cycle — the barrel imports this plugin's entry, which
 * reaches this file — and because `contributedCubes` memoises, so the walk is paid once per isolate.
 *
 * It stays the FULL registry: the isolation test walks it and its coverage assertion must see
 * every cube, because a cube's tenant scoping has to be proven whether or not its feature is on
 * today. Feature filtering happens per request in `cubesFor` below.
 */
export function allCubes(): Cube[] {
  return [...ANALYTICS_CUBES, ...contributedCubes()]
}

/**
 * Cubes belonging to a feature that ships dark (D30). `allCubes` stays the FULL registry, so the
 * filtering happens per request in `routes/cube-api.ts` instead.
 *
 * The kit ships none. An app gating, say, a CRM adds `crm: [companiesCube, dealsCube]`.
 */
const FEATURE_CUBES: Record<string, readonly string[]> = {}

/**
 * The cubes this request may compile against. A cube whose feature is off is absent from
 * `/cubejs-api/v1/meta` and from `/mcp`, so a dark feature is not discoverable through the analytics
 * surface either — the gate has to cover every door, not just the nav.
 */
export function cubesFor(features: readonly string[]): Cube[] {
  const all = allCubes()
  const hidden = new Set<string>()
  for (const [feature, names] of Object.entries(FEATURE_CUBES)) {
    if (!features.includes(feature)) for (const name of names) hidden.add(name)
  }
  return hidden.size === 0 ? all : all.filter(cube => !hidden.has(cube.name))
}

export { analyticsSecurityContext, buildSecurityContext, groupFilter, tenantIdOf } from './security'
export { activityEventsCube, tenantActivityDailyCube, tenantUsersCube, usersCube }
