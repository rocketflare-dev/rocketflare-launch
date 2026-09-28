/**
 * Detecting what an app needs (Launch P5, plan §1.14–§1.15, §4 5e) — read-only, through the
 * adapter's `declaredConfig` (`launch/rocketflare/declared-config.ts`):
 *
 * - `scanAppConfig`: read the repo at `ref` (`withRepoToken(…, { contents: 'read' })` +
 *   `getRepoFile`), match each declared key to resource items by exact name, upsert
 *   `app_config_scans` (`declared`, `needs`), and notify the app's owners ONCE (`grant_needed`) for
 *   each newly needed resource. Called after commit by `importApp`, `createRelease` (at the tag) and
 *   `POST /api/apps/:id/config/scan`. A failure is recorded on `app_config_scans.error` and never
 *   thrown to the caller — it must not fail an import, a release or a ship;
 * - `scanShipConfig`: the same scan at a session's PR head, returned as the `ship.config_needs`
 *   event's data and never stored (`sessions/ship.ts` emits it after `openPullRequest`). It DOES
 *   throw: `ship` catches and ships without the event.
 *
 * **Matching.** A shared resource matches when any of its item keys is a declared key (exact
 * name). Archived resources match nothing — they cannot be granted. A matched resource is NEEDED
 * when the app holds no live grant of it (`requested | active | revoking`) in any environment:
 * one already asked for is not nagged about.
 *
 * **Notifying once.** `grant_needed` goes out for the resources in this scan's `needs` that were
 * not in the previous scan's, read under a row lock in the transaction that writes the new ones —
 * so two scans racing cannot both notify. A resource that stops being needed (granted) and comes
 * back (revoked, re-declared) is new again, and notifies again. The recipients are the app's owners
 * (named, and its owner group's members), else whoever created it; the link is the app's config
 * page (`notificationLink` → `appConfigPath(appSlug)`), where the Request button is.
 *
 * Tenant isolation: the app is looked up tenant-first (another organisation's is a 404), and only
 * this tenant's resources and grants are read.
 */
import {
  APP_CONFIG_REALTIME_ENTITY,
  type DeclaredConfigItem,
  GRANT_NOTIFICATION_TYPES,
  KIT_CONFIG_PLUGIN_ID,
  LIVE_GRANT_STATUSES,
} from '@launch/shared/launch-grants'
import type { SessionShipConfigNeedsData } from '@launch/shared/launch-sessions'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type AppConfigScanRow,
  type AppRow,
  appConfigScans,
  appGrants,
  appOwners,
  groupMembers,
  sharedResources,
} from '../../../db/schema'
import { getAppRow } from '../launch/apps'
import { getRepoFile } from '../launch/github-app'
import type { ImportGitHub } from '../launch/import'
import { withRepoToken } from '../launch/releases/github'
import { declaredConfig } from '../launch/rocketflare/declared-config'
import { notifyMany } from '../notifications'
import { nudge, realtimeEvent } from '../realtime'
import { safeErrorMessage } from '../sessions/events'
import type { GrantDeps } from './types'

export type ScanTrigger = 'import' | 'release' | 'rescan'

/**
 * What a scan runs with: the database and config (the GitHub App credential), and optionally a
 * logger, realtime (the config page's nudge, the bell's), a test's `fetch` and clock. Narrower than
 * `GrantDeps`, so `importApp` — which has no bindings — can scan too. `github` skips the credential
 * store (the import's own, or a test's).
 */
export type ScanDeps = Pick<GrantDeps, 'db' | 'cfg'> &
  Partial<Pick<GrantDeps, 'logger' | 'realtime' | 'fetch' | 'now'>> & { github?: ImportGitHub }

export interface ScanAppConfigInput {
  tenantId: string
  appId: string
  /** The ref to read (a tag, a sha, a branch); null = the default branch. */
  ref: string | null
  /** The commit `ref` points at, when the caller knows it (a Release's tag). */
  sha?: string | null
  trigger: ScanTrigger
}

/** One matched resource and the declared keys it covers. */
export interface ConfigMatch {
  resource: { id: string; slug: string; displayName: string }
  keys: string[]
  declaredBy: string[]
}

export interface ConfigMatchResult {
  matches: ConfigMatch[]
  /** The matches the app holds no live grant of, in any environment. */
  needs: ConfigMatch[]
  /** Plugin keys no resource covers (the kit's optional keys are left out: nobody must add them). */
  unmatched: string[]
}

const SHA_RE = /^[0-9a-f]{40}$/i

/** A scan's failure as stored and shown: first line, secret-free, within the column's check. */
function scanError(err: unknown): string {
  return safeErrorMessage(err, 'The scan failed').slice(0, 500)
}

/** The declared keys at `ref` (default: the app's default branch), under a read-only repo token. */
async function readDeclared(
  deps: ScanDeps,
  app: AppRow,
  ref: string | null
): Promise<{ ref: string; declared: DeclaredConfigItem[] }> {
  const gh = { fetch: deps.fetch }
  return withRepoToken(
    deps.db,
    deps.cfg,
    app,
    { contents: 'read' },
    async (token, { owner, repo, branch }) => {
      const at = ref ?? branch
      const declared = await declaredConfig(path => getRepoFile(token, owner, repo, path, at, gh))
      return { ref: at, declared }
    },
    { ...gh, github: deps.github }
  )
}

/**
 * Match `declared` against the tenant's live resources and the app's live grants. Pure reads —
 * shared by the stored scan and the ship event.
 */
export async function matchDeclaredConfig(
  db: Database,
  tenantId: string,
  appId: string,
  declared: readonly DeclaredConfigItem[]
): Promise<ConfigMatchResult> {
  const pluginsByKey = new Map<string, Set<string>>()
  for (const item of declared) {
    const set = pluginsByKey.get(item.key) ?? new Set<string>()
    set.add(item.pluginId)
    pluginsByKey.set(item.key, set)
  }
  if (pluginsByKey.size === 0) return { matches: [], needs: [], unmatched: [] }

  const resources = await db
    .select({
      id: sharedResources.id,
      slug: sharedResources.slug,
      displayName: sharedResources.displayName,
      items: sharedResources.items,
    })
    .from(sharedResources)
    .where(and(eq(sharedResources.tenantId, tenantId), isNull(sharedResources.archivedAt)))
    .orderBy(sharedResources.slug)

  const covered = new Set<string>()
  const matches: ConfigMatch[] = []
  for (const resource of resources) {
    const keys = (resource.items ?? []).map(i => i.key).filter(key => pluginsByKey.has(key))
    if (keys.length === 0) continue
    for (const key of keys) covered.add(key)
    const declaredBy = new Set(keys.flatMap(key => [...(pluginsByKey.get(key) ?? [])]))
    matches.push({
      resource: { id: resource.id, slug: resource.slug, displayName: resource.displayName },
      keys,
      declaredBy: [...declaredBy].sort(),
    })
  }

  const held = new Set<string>()
  if (matches.length > 0) {
    const grants = await db
      .select({ resourceId: appGrants.resourceId })
      .from(appGrants)
      .where(
        and(
          eq(appGrants.tenantId, tenantId),
          eq(appGrants.appId, appId),
          inArray(
            appGrants.resourceId,
            matches.map(m => m.resource.id)
          ),
          inArray(appGrants.status, [...LIVE_GRANT_STATUSES])
        )
      )
    for (const g of grants) held.add(g.resourceId)
  }

  const unmatched = [...pluginsByKey]
    .filter(
      ([key, plugins]) => !covered.has(key) && [...plugins].some(p => p !== KIT_CONFIG_PLUGIN_ID)
    )
    .map(([key]) => key)
  return { matches, needs: matches.filter(m => !held.has(m.resource.id)), unmatched }
}

/** The app's owners — named, and its owner group's members — else whoever created it. */
async function appOwnerUserIds(db: Database, app: AppRow): Promise<string[]> {
  const named = await db
    .select({ userId: appOwners.userId })
    .from(appOwners)
    .where(and(eq(appOwners.tenantId, app.tenantId), eq(appOwners.appId, app.id)))
  const viaGroup = app.ownerGroupId
    ? await db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(eq(groupMembers.tenantId, app.tenantId), eq(groupMembers.groupId, app.ownerGroupId))
        )
    : []
  const ids = new Set([...named, ...viaGroup].map(r => r.userId))
  if (ids.size === 0 && app.createdByUserId) ids.add(app.createdByUserId)
  return [...ids]
}

/** `grant_needed` to the app's owners — best-effort after commit (the scan row is the truth). */
async function notifyNeeded(deps: ScanDeps, app: AppRow, fresh: ConfigMatch[]): Promise<void> {
  try {
    const owners = await appOwnerUserIds(deps.db, app)
    const names = fresh.map(m => m.resource.displayName)
    const keys = [...new Set(fresh.flatMap(m => m.keys))]
    await notifyMany(
      deps.db,
      owners,
      {
        tenantId: app.tenantId,
        type: GRANT_NOTIFICATION_TYPES.needed,
        title: `${app.displayName} needs ${names.join(', ')}`,
        body: `It declares ${keys.join(', ')}. Request access on its config page.`,
        data: { appId: app.id, appSlug: app.slug, resourceIds: fresh.map(m => m.resource.id) },
      },
      deps.realtime
    )
  } catch (err) {
    deps.logger?.warn({ err, appId: app.id }, 'grants: grant_needed notification failed')
  }
}

function nudgeAppConfig(deps: ScanDeps, tenantId: string, appId: string): void {
  nudge(
    deps.realtime,
    realtimeEvent('entity.changed', tenantId, { entity: APP_CONFIG_REALTIME_ENTITY, id: appId })
  )
}

/** A failed read: recorded on the row, the previous scan's `declared` and `needs` kept. */
async function recordFailure(
  deps: ScanDeps,
  input: ScanAppConfigInput,
  now: Date,
  error: string
): Promise<AppConfigScanRow> {
  const [row] = await deps.db
    .insert(appConfigScans)
    .values({
      tenantId: input.tenantId,
      appId: input.appId,
      ref: input.ref,
      sha: input.sha ?? null,
      scannedAt: now,
      error,
    })
    .onConflictDoUpdate({ target: appConfigScans.appId, set: { scannedAt: now, error } })
    .returning()
  if (!row) throw new Error('app_config_scans upsert returned no row')
  return row
}

/** Read, match and write the scan; throws on any failure (the caller records it). */
async function runScan(
  deps: ScanDeps,
  app: AppRow,
  input: ScanAppConfigInput,
  now: Date
): Promise<{ row: AppConfigScanRow; fresh: ConfigMatch[] }> {
  const read = await readDeclared(deps, app, input.ref)
  const result = await matchDeclaredConfig(deps.db, input.tenantId, app.id, read.declared)
  const needs = result.needs.map(m => m.resource.id)
  const sha = input.sha ?? (SHA_RE.test(read.ref) ? read.ref : null)
  return deps.db.transaction(async tx => {
    // The previous needs under a row lock: two scans racing notify once between them.
    const [before] = await tx
      .select({ needs: appConfigScans.needs })
      .from(appConfigScans)
      .where(and(eq(appConfigScans.tenantId, input.tenantId), eq(appConfigScans.appId, app.id)))
      .for('update')
    const values = {
      ref: read.ref,
      sha,
      scannedAt: now,
      declared: read.declared,
      needs,
      error: null,
    }
    const [row] = await tx
      .insert(appConfigScans)
      .values({ tenantId: input.tenantId, appId: app.id, ...values })
      .onConflictDoUpdate({ target: appConfigScans.appId, set: values })
      .returning()
    if (!row) throw new Error('app_config_scans upsert returned no row')
    const previous = new Set(before?.needs ?? [])
    return { row, fresh: result.needs.filter(m => !previous.has(m.resource.id)) }
  })
}

/**
 * Scan the app's repo at `input.ref` and record it. Throws only when the app is not this tenant's
 * (404 `app_not_found`); every other failure is the row's `error`.
 */
export async function scanAppConfig(
  deps: ScanDeps,
  input: ScanAppConfigInput
): Promise<AppConfigScanRow> {
  const now = deps.now?.() ?? new Date()
  const app = await getAppRow(deps.db, input.tenantId, input.appId)
  try {
    const { row, fresh } = await runScan(deps, app, input, now)
    if (fresh.length > 0) await notifyNeeded(deps, app, fresh)
    nudgeAppConfig(deps, input.tenantId, app.id)
    return row
  } catch (err) {
    const error = scanError(err)
    deps.logger?.warn({ err, appId: app.id, trigger: input.trigger }, 'grants: config scan failed')
    try {
      const row = await recordFailure(deps, input, now, error)
      nudgeAppConfig(deps, input.tenantId, app.id)
      return row
    } catch (recordErr) {
      // Not even the failure could be written: answer it, still without throwing.
      deps.logger?.error({ err: recordErr, appId: app.id }, 'grants: config scan not recorded')
      const { tenantId, ref } = input
      const sha = input.sha ?? null
      return { tenantId, appId: app.id, ref, sha, scannedAt: now, declared: [], needs: [], error }
    }
  }
}

export interface ScanShipConfigInput {
  tenantId: string
  appId: string
  /** The PR head. */
  sha: string
}

/**
 * The needs at a session's PR head, as the `ship.config_needs` event's data. Nothing is stored and
 * nobody is notified: the PR is not merged, and the person shipping reads it on the ship panel.
 * Throws on a failed read — `ship` catches it.
 */
export async function scanShipConfig(
  deps: ScanDeps,
  input: ScanShipConfigInput
): Promise<SessionShipConfigNeedsData> {
  const app = await getAppRow(deps.db, input.tenantId, input.appId)
  const { declared } = await readDeclared(deps, app, input.sha)
  const result = await matchDeclaredConfig(deps.db, input.tenantId, app.id, declared)
  return {
    needs: result.needs.map(m => ({
      resourceId: m.resource.id,
      slug: m.resource.slug,
      displayName: m.resource.displayName,
      keys: m.keys,
    })),
    unmatched: result.unmatched,
    sha: input.sha,
  }
}
