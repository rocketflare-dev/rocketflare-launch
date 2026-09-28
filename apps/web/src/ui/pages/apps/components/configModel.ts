/**
 * What an app's Config page and card SAY about its shared config (Launch P5, spec/09), decided
 * here and nowhere else — pure, so the page, the card and the tests read one vocabulary.
 *
 * - `envGrantState(grant)` — one environment of one matched resource: `met` (held and pushed),
 *   `pushing` (approved, the push is landing), `push_failed`, `requested` (waiting on the owner
 *   team), `revoking`, or `missing` (never asked, or the last ask was rejected / expired / revoked);
 * - `ENV_STATE` — the badge tone and the word for each;
 * - `missingEnvironments(match)` — what a Request button pre-selects;
 * - `declaredByPlugin(view)` — the declared keys grouped by the plugin that declared them, each
 *   key with the resource it matched (or none: "ask an admin to add it").
 */
import { APP_ENVIRONMENT_NAMES, type AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  type AppConfigMatch,
  type AppConfigView,
  type AppGrant,
  type DeclaredConfigItem,
  KIT_CONFIG_PLUGIN_ID,
} from '@launch/shared/launch-grants'

export type EnvGrantState = 'met' | 'pushing' | 'push_failed' | 'requested' | 'revoking' | 'missing'

export function envGrantState(
  grant: Pick<AppGrant, 'status' | 'pushedVersion' | 'pushError'> | null
): EnvGrantState {
  if (!grant) return 'missing'
  switch (grant.status) {
    case 'requested':
      return 'requested'
    case 'revoking':
      return 'revoking'
    case 'active':
      if (grant.pushError) return 'push_failed'
      return grant.pushedVersion === null ? 'pushing' : 'met'
    case 'revoked':
    case 'rejected':
    case 'expired':
      return 'missing'
  }
}

/** The `.status-badge` tone and the word per state. */
export const ENV_STATE: Record<EnvGrantState, { tone: string; label: string }> = {
  met: { tone: 'active', label: 'Held' },
  pushing: { tone: 'running', label: 'Pushing' },
  push_failed: { tone: 'failed', label: 'Push failed' },
  requested: { tone: 'awaiting-review', label: 'Requested' },
  revoking: { tone: 'running', label: 'Revoking' },
  missing: { tone: 'draft', label: 'Missing' },
}

/** Whether a Request button makes sense for this state (nothing live in that environment). */
export function mayRequest(state: EnvGrantState): boolean {
  return state === 'missing'
}

/** The environments a Request pre-selects: those with nothing live. */
export function missingEnvironments(match: Pick<AppConfigMatch, 'grants'>): AppEnvironmentName[] {
  return APP_ENVIRONMENT_NAMES.filter(env => mayRequest(envGrantState(match.grants[env])))
}

/** A short line for why the last ask ended, when the state is `missing` because of it. */
export function lastOutcome(grant: Pick<AppGrant, 'status'> | null): string | null {
  if (!grant) return null
  switch (grant.status) {
    case 'rejected':
      return 'the last request was rejected'
    case 'expired':
      return 'the last grant expired'
    case 'revoked':
      return 'the last grant was revoked'
    default:
      return null
  }
}

export interface DeclaredKeyRow {
  item: DeclaredConfigItem
  /** The matched resource that covers this key, or null ("ask an admin to add it"). */
  resource: AppConfigMatch['resource'] | null
}

export interface PluginGroup {
  pluginId: string
  label: string
  keys: DeclaredKeyRow[]
}

/** The declared keys grouped by plugin (the kit's own last), each with its matched resource. */
export function declaredByPlugin(view: Pick<AppConfigView, 'declared' | 'matched'>): PluginGroup[] {
  const byKey = new Map<string, AppConfigMatch['resource']>()
  for (const match of view.matched) for (const key of match.keys) byKey.set(key, match.resource)
  const groups = new Map<string, PluginGroup>()
  for (const item of view.declared) {
    const group = groups.get(item.pluginId) ?? {
      pluginId: item.pluginId,
      label: item.pluginId === KIT_CONFIG_PLUGIN_ID ? 'The kit (optional)' : item.pluginId,
      keys: [],
    }
    group.keys.push({ item, resource: byKey.get(item.key) ?? null })
    groups.set(item.pluginId, group)
  }
  return [...groups.values()].sort((a, b) => {
    if (a.pluginId === KIT_CONFIG_PLUGIN_ID) return 1
    if (b.pluginId === KIT_CONFIG_PLUGIN_ID) return -1
    return a.pluginId.localeCompare(b.pluginId)
  })
}

/** "M365 is missing in production" — the card's one-line summary of what the app still needs. */
export function needsSummary(view: Pick<AppConfigView, 'matched'>): string | null {
  const missing = view.matched.flatMap(match => {
    if (match.resource.archived) return []
    const envs = missingEnvironments(match)
    if (envs.length === 0) return []
    const where = envs.length === APP_ENVIRONMENT_NAMES.length ? 'anywhere' : `in ${envs[0]}`
    return [`${match.resource.displayName} is not held ${where}`]
  })
  return missing.length ? missing.join('; ') : null
}
