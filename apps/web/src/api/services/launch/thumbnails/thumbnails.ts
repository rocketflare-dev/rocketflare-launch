/**
 * App thumbnails (`docs/CONCEPTS.md` §18.21): after a deploy goes live, a screenshot of the
 * environment's root URL becomes the app's picture in the catalogue, on Home and in the app header.
 *
 * - **When.** `/ci/deploy/:id/finish` on a deployed ticket enqueues `app.thumbnail` for that
 *   environment (`enqueueThumbnailAfterDeploy`) — every deploy reaches Launch there: a release, a
 *   rollback, and the first build of a created app. "Refresh thumbnail" (`requestThumbnailRefresh`,
 *   admins) enqueues a FORCED capture of every environment with a URL, at most once a minute per
 *   app — a compare-and-set on `apps.thumbnail_refresh_at`, never a `Map`.
 * - **Debounce.** A capture of a version that already has a picture is skipped, twice over: the
 *   enqueue checks the row (no message for a re-sent `finish`), and so does the handler (no second
 *   picture for a redelivered message). `force` bypasses both.
 * - **Where it may look.** ONLY the URL Launch recorded for the environment — the message carries
 *   ids, never a URL — and only if it is `https`, has no credentials, names a public host, and, for
 *   an app Launch CREATED, is the host it provisioned (`<slug>[-staging].<apps_domain>`). The
 *   capture opens the origin's `/`, nothing else (`captureTarget`). Unauthenticated, no cookies: an
 *   app behind sign-in shows its login page (a known gap, accepted).
 * - **Where it goes.** R2 `FILES` at `tenants/<tenantId>/apps/<appId>/thumbnail-<env>.webp` —
 *   under the tenant's prefix, so `tenant.purge` removes it — one object per environment,
 *   overwritten in place; the row records the key, when, and the version pictured.
 * - **What is shown.** Live's picture, else Staging's (`thumbnailOf`), served by Launch's authed
 *   `GET /api/apps/:id/thumbnail` — the app's own host is never put in front of the browser.
 *
 * Failure policy (the jobs rules): no `BROWSER` or `FILES` binding, an archived app, no URL, a
 * refused URL or an oversized picture is PERMANENT — logged and acked. A navigation error or a
 * timeout throws, so the consumer retries with backoff until the toml's `max_retries`, then the
 * message is dropped quietly and the app keeps its previous picture.
 */

import type { AppThumbnailPayload } from '@launch/shared/jobs'
import {
  type AppEnvironmentName,
  type AppThumbnail,
  THUMBNAIL_REFRESH_MIN_INTERVAL_SECONDS,
  THUMBNAIL_VIEWPORT,
} from '@launch/shared/launch-apps'
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppEnvironmentRow, type AppRow, appEnvironments, apps } from '../../../../db/schema'
import { ConflictError, RateLimitedError } from '../../../utils/core/errors'
import { enqueueJob, type JobsQueue } from '../../jobs'
import { nudge, type Realtime, realtimeEvent } from '../../realtime'
import { type StorageService, tenantStoragePrefix } from '../../storage'
import { getSetting } from '../credentials'
import { isLocalHostname } from '../public-url'
import { appResourceNames } from '../rocketflare/names'
import type { ScreenshotPort } from './screenshot'

/** The capture's budget: navigation to `load` plus waiting for the network to go quiet. */
export const THUMBNAIL_CAPTURE_TIMEOUT_MS = 15_000

/** A picture larger than this is not stored (a WebP of 1280×800 is normally well under 200 KB). */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024

/** The query-key root a capture nudges, so every open list and app page refetches. */
export const THUMBNAIL_REALTIME_ENTITY = 'apps'

interface Logger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

/** `tenants/<tenantId>/apps/<appId>/thumbnail-<env>.webp` — inside the tenant's purge prefix. */
export function thumbnailKey(tenantId: string, appId: string, env: AppEnvironmentName): string {
  return `${tenantStoragePrefix(tenantId)}apps/${appId}/thumbnail-${env}.webp`
}

// ---- where a capture may look ---------------------------------------------------------------------

export type CaptureTarget = { url: string; problem: null } | { url: null; problem: string }

/**
 * The URL to capture for an environment, or why there is none. Pure. `recorded` is the
 * environment's `url` column — what Launch provisioned or read from the app's own toml at import —
 * and nothing else is ever an input. For a created app, `appsDomain` pins the host to the one
 * Launch provisioned; an imported app's host is whatever its toml said, which is still its own.
 */
export function captureTarget(
  recorded: string | null,
  app: Pick<AppRow, 'slug' | 'source'>,
  env: AppEnvironmentName,
  appsDomain: string | null
): CaptureTarget {
  if (!recorded) return { url: null, problem: 'the environment has no URL' }
  let parsed: URL
  try {
    parsed = new URL(recorded)
  } catch {
    return { url: null, problem: 'the recorded URL does not parse' }
  }
  if (parsed.protocol !== 'https:') return { url: null, problem: 'the recorded URL is not https' }
  if (parsed.username || parsed.password) {
    return { url: null, problem: 'the recorded URL carries credentials' }
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (isLocalHostname(host) || (!host.includes('.') && !host.includes(':'))) {
    return { url: null, problem: 'the recorded host is not a public hostname' }
  }
  if (app.source === 'created' && appsDomain) {
    const provisioned = appResourceNames(app.slug, env, appsDomain).host
    if (host !== provisioned) {
      return { url: null, problem: `the recorded host is not ${provisioned}` }
    }
  }
  // The root of the app's own origin — never a path, query or fragment from anywhere.
  return { url: `${parsed.origin}/`, problem: null }
}

// ---- reading ---------------------------------------------------------------------------------------

/** The route a thumbnail is served from; the capture time busts the browser's cache. Pure. */
export function thumbnailUrl(appId: string, capturedAt: Date): string {
  return `/api/apps/${appId}/thumbnail?v=${capturedAt.getTime()}`
}

/** The environment whose picture an app shows: Live's, else Staging's, else none. Pure. */
export function thumbnailEnvironment<
  T extends Pick<AppEnvironmentRow, 'name' | 'thumbnailKey' | 'thumbnailCapturedAt'>,
>(rows: readonly T[]): T | null {
  const has = (name: AppEnvironmentName) =>
    rows.find(row => row.name === name && row.thumbnailKey && row.thumbnailCapturedAt) ?? null
  return has('production') ?? has('staging')
}

/** The wire shape for an app's list/detail row (`appThumbnailSchema`). Pure. */
export function thumbnailOf(
  appId: string,
  rows: readonly Pick<
    AppEnvironmentRow,
    'name' | 'thumbnailKey' | 'thumbnailCapturedAt' | 'thumbnailVersion'
  >[]
): AppThumbnail | null {
  const row = thumbnailEnvironment(rows)
  if (!row?.thumbnailCapturedAt) return null
  return {
    url: thumbnailUrl(appId, row.thumbnailCapturedAt),
    capturedAt: row.thumbnailCapturedAt,
    env: row.name,
    version: row.thumbnailVersion,
  }
}

// ---- enqueueing ------------------------------------------------------------------------------------

/**
 * After `/ci/deploy/:id/finish` closed a DEPLOYED ticket: queue a capture of that environment unless
 * its picture already shows `version` (a `finish` sent twice). Never throws — the deploy is live
 * whatever happens here, and a missing queue or a send that fails costs a picture, nothing more.
 */
export async function enqueueThumbnailAfterDeploy(
  db: Database,
  queue: JobsQueue | undefined | null,
  input: {
    tenantId: string
    appId: string
    environment: AppEnvironmentName
    version: string | null
  },
  logger?: Pick<Logger, 'warn'>
): Promise<boolean> {
  try {
    const [row] = await db
      .select({ key: appEnvironments.thumbnailKey, version: appEnvironments.thumbnailVersion })
      .from(appEnvironments)
      .where(
        and(
          eq(appEnvironments.tenantId, input.tenantId),
          eq(appEnvironments.appId, input.appId),
          eq(appEnvironments.name, input.environment)
        )
      )
    if (row?.key && input.version && row.version === input.version) return false
    await enqueueJob(queue, {
      type: 'app.thumbnail',
      payload: { tenantId: input.tenantId, appId: input.appId, environment: input.environment },
    })
    return true
  } catch (err) {
    logger?.warn(
      { ...input, err: err instanceof Error ? err.message : String(err) },
      'thumbnail: could not queue the post-deploy capture'
    )
    return false
  }
}

/**
 * "Refresh thumbnail": a FORCED capture of every environment of the app with a URL. 409 for an
 * archived app or one with no URL at all; 429 `rate_limited` when the app's claim was taken less
 * than `THUMBNAIL_REFRESH_MIN_INTERVAL_SECONDS` ago. The claim is ONE compare-and-set, so two clicks
 * in two isolates queue one capture.
 */
export async function requestThumbnailRefresh(
  db: Database,
  queue: JobsQueue | undefined | null,
  app: Pick<AppRow, 'id' | 'tenantId' | 'status'>,
  now: Date = new Date()
): Promise<AppEnvironmentName[]> {
  if (app.status === 'archived') {
    throw new ConflictError('An archived app has nothing to capture', 'app_archived')
  }
  const envs = await db
    .select({ name: appEnvironments.name })
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, app.tenantId),
        eq(appEnvironments.appId, app.id),
        isNotNull(appEnvironments.url)
      )
    )
  if (envs.length === 0) {
    throw new ConflictError('No environment of this app has an address yet', 'no_environment_url')
  }
  const cutoff = new Date(now.getTime() - THUMBNAIL_REFRESH_MIN_INTERVAL_SECONDS * 1000)
  const claimed = await db
    .update(apps)
    .set({ thumbnailRefreshAt: now })
    .where(
      and(
        eq(apps.tenantId, app.tenantId),
        eq(apps.id, app.id),
        or(isNull(apps.thumbnailRefreshAt), lt(apps.thumbnailRefreshAt, cutoff))
      )
    )
    .returning({ id: apps.id })
  if (claimed.length === 0) {
    throw new RateLimitedError(
      'The thumbnail was refreshed less than a minute ago',
      THUMBNAIL_REFRESH_MIN_INTERVAL_SECONDS
    )
  }
  const names = envs.map(e => e.name).sort((a, b) => (a === b ? 0 : a === 'staging' ? -1 : 1))
  for (const environment of names) {
    await enqueueJob(queue, {
      type: 'app.thumbnail',
      payload: { tenantId: app.tenantId, appId: app.id, environment, force: true },
    })
  }
  return names
}

// ---- capturing (the job) --------------------------------------------------------------------------

export interface CaptureDeps {
  /** Null: this deployment has no `BROWSER` binding. */
  screenshots: ScreenshotPort | null
  /** Null: no `FILES` binding. */
  storage: StorageService | null
  logger: Logger
  realtime?: Realtime
  now?: () => Date
}

export type CaptureOutcome =
  | { status: 'captured'; key: string; bytes: number; version: string | null }
  | { status: 'skipped'; reason: string }

/**
 * The `app.thumbnail` job's body. Returns what happened for the log and the tests; throws only
 * for what a retry can fix (the capture itself, the R2 write, the database).
 */
export async function captureAppThumbnail(
  db: Database,
  deps: CaptureDeps,
  payload: AppThumbnailPayload
): Promise<CaptureOutcome> {
  const { tenantId, appId, environment } = payload
  const skip = (reason: string): CaptureOutcome => {
    deps.logger.info({ tenantId, appId, environment, reason }, 'thumbnail: skipped')
    return { status: 'skipped', reason }
  }
  if (!deps.screenshots) {
    deps.logger.warn(
      { tenantId, appId, environment },
      'thumbnail: no BROWSER binding — Browser Rendering is not configured, no capture'
    )
    return { status: 'skipped', reason: 'no_browser_binding' }
  }
  if (!deps.storage) {
    deps.logger.warn({ tenantId, appId, environment }, 'thumbnail: no FILES binding, no capture')
    return { status: 'skipped', reason: 'no_files_binding' }
  }

  const [row] = await db
    .select({ app: apps, env: appEnvironments })
    .from(appEnvironments)
    .innerJoin(apps, and(eq(apps.id, appEnvironments.appId), eq(apps.tenantId, tenantId)))
    .where(
      and(
        eq(appEnvironments.tenantId, tenantId),
        eq(appEnvironments.appId, appId),
        eq(appEnvironments.name, environment)
      )
    )
  if (!row) return skip('no_such_environment')
  if (row.app.status === 'archived') return skip('app_archived')
  const version = row.env.lastDeployVersion
  if (!payload.force && row.env.thumbnailKey && version && row.env.thumbnailVersion === version) {
    return skip('already_captured')
  }

  const appsDomain =
    row.app.source === 'created' ? await getSetting<string>(db, 'apps_domain') : null
  const target = captureTarget(
    row.env.url,
    row.app,
    environment,
    typeof appsDomain === 'string' ? appsDomain : null
  )
  if (!target.url) {
    deps.logger.warn(
      { tenantId, appId, environment, problem: target.problem },
      'thumbnail: refusing to capture'
    )
    return { status: 'skipped', reason: 'refused_url' }
  }

  deps.logger.info(
    { tenantId, appId, environment, host: new URL(target.url).host },
    'thumbnail: capturing'
  )
  // Throws on a navigation error or a timeout: the consumer retries with backoff.
  const shot = await deps.screenshots.capture({
    url: target.url,
    viewport: { ...THUMBNAIL_VIEWPORT },
    timeoutMs: THUMBNAIL_CAPTURE_TIMEOUT_MS,
  })
  if (shot.bytes.byteLength === 0) throw new Error('thumbnail: the capture returned no bytes')
  if (shot.bytes.byteLength > THUMBNAIL_MAX_BYTES) {
    deps.logger.warn(
      { tenantId, appId, environment, bytes: shot.bytes.byteLength },
      'thumbnail: the picture is over the size cap, not stored'
    )
    return { status: 'skipped', reason: 'too_large' }
  }

  const key = thumbnailKey(tenantId, appId, environment)
  await deps.storage.put(key, shot.bytes, {
    contentType: shot.contentType,
    metadata: { appId, environment, ...(version ? { version } : {}) },
  })
  const now = deps.now?.() ?? new Date()
  await db
    .update(appEnvironments)
    .set({
      thumbnailKey: key,
      thumbnailCapturedAt: now,
      thumbnailVersion: version,
      // Not `updatedAt`: a picture is not a change to the environment anybody made.
      updatedAt: sql`${appEnvironments.updatedAt}`,
    })
    .where(and(eq(appEnvironments.tenantId, tenantId), eq(appEnvironments.id, row.env.id)))
  nudge(
    deps.realtime,
    realtimeEvent('entity.changed', tenantId, { entity: THUMBNAIL_REALTIME_ENTITY, id: appId })
  )
  deps.logger.info(
    {
      tenantId,
      appId,
      environment,
      version,
      bytes: shot.bytes.byteLength,
      landedOn: new URL(shot.finalUrl || target.url).host,
    },
    'thumbnail: captured'
  )
  return { status: 'captured', key, bytes: shot.bytes.byteLength, version }
}

// ---- serving ---------------------------------------------------------------------------------------

/** The stored picture an app shows (Live's, else Staging's), or null — the route's 404. */
export async function readAppThumbnail(
  db: Database,
  storage: StorageService,
  tenantId: string,
  appId: string
) {
  const rows = await db
    .select({
      name: appEnvironments.name,
      thumbnailKey: appEnvironments.thumbnailKey,
      thumbnailCapturedAt: appEnvironments.thumbnailCapturedAt,
    })
    .from(appEnvironments)
    .where(and(eq(appEnvironments.tenantId, tenantId), eq(appEnvironments.appId, appId)))
  const row = thumbnailEnvironment(rows)
  if (!row?.thumbnailKey) return null
  // The key is ours, but it is still checked against the tenant's prefix before any read.
  if (!row.thumbnailKey.startsWith(tenantStoragePrefix(tenantId))) return null
  return storage.get(row.thumbnailKey)
}
