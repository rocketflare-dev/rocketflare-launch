/**
 * Issue #16: the per-app PREBUILD — a workspace backup (`workspace-backup.ts`) of the app's
 * default branch with its dependencies installed, which a NEW session restores instead of cloning
 * and running `pnpm install`. One per app, on `app_prebuilds`; the step bodies are
 * `prebuild-steps.ts`.
 *
 * - **Built in a container of its own**, never in a person's: a `prebuild` session
 *   (`SESSION_KINDS`) — no database, no branch, no chat — that `SessionWorkflow` runs as
 *   `sandbox.start → prebuild.build (clone + install) → prebuild.save (createBackup) → cleanup`.
 *   Taking it from a live session's container instead would hold that container's control
 *   connection for the archive (23 s for 369 MB measured, issue #3) while the person's first turn
 *   waits behind it, and would carry the session's `.dev.vars` (its branch URI and encryption key).
 *   A run of its own costs about a minute of container time per build, holds no credential, and its
 *   archive has nothing session-specific in it ({@link PREBUILD_EXCLUDES} is only a guard).
 * - **Asked for** ({@link requestPrebuild}) by a step, never run there: after a first boot that
 *   found none to use (none yet, another image, too old — not merely one built for the other
 *   sandbox host or backup mode, which would only ping-pong) or whose lockfile no longer matched
 *   it (`prebuild.request`), and after every merge Launch makes to the default branch
 *   (`prebuild.refresh#N`, the base moved). Only while two of the host's container slots are free
 *   (`container-capacity.ts`: a prebuild never takes the slot a person needs). Then a claim on the
 *   app's row — one build per app at a time, none while a failed one is recent
 *   ({@link PREBUILD_RETRY_AFTER_MS}, from the failure), none when the current prebuild is already
 *   newer than what the caller saw — then the `prebuild` session's row and its Workflow instance.
 *   A request refused because a build is in flight leaves `refresh_requested_at`, and that build
 *   asks again when it is done ({@link followUpPrebuild}). A request that cannot be made is a
 *   reason, never an error: a prebuild never slows or fails the session that asked.
 * - **Keyed** on the app (the row), the default-branch commit and its tree, the lockfile's hash,
 *   the session image (the one the BUILD booted on), the backup mode and the sandbox host. A
 *   restore needs the last three to MATCH ({@link unusablePrebuild}) — `node_modules` is only good on its image, and an archive is
 *   only readable the way it was written. The commit need not: the session checks its own commit
 *   out over the restored one in place (`checkoutScript`'s `restored`). The lockfile need not
 *   either: a different one runs `pnpm install` over the restored `node_modules` (fast — most of it
 *   is there) and asks for a new prebuild.
 * - **Replaced, never accumulated**: a saved build deletes the archive it replaces (one per app);
 *   a session restoring that very archive at that moment falls back to the clone. Archives expire
 *   ({@link PREBUILD_TTL_SECONDS}) under the bucket's 14-day `backups/` lifecycle rule, and an app's
 *   deletion takes its row with it (the R2 lifecycle rule is the backstop for the archive).
 *
 * Off with `SESSION_PREBUILD=off`, and wherever workspace backups are off for the session's host
 * (`workspaceBackupMode`): then nothing is asked for, nothing restored, and a boot is today's.
 */
import {
  newPreviewToken,
  newSessionShortId,
  TERMINAL_SESSION_STATUSES,
} from '@launch/shared/launch-sessions'
import type { SessionSandboxHost } from '@launch/shared/launch-setup'
import { and, eq, isNotNull, isNull, lt, not, or, type SQL, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import {
  type AppPrebuildBackup,
  type AppPrebuildRow,
  appPrebuilds,
  apps,
  type SessionRow,
  sessions,
} from '../../../db/schema'
import type { AppBindings } from '../../types'
import {
  containerCapFor,
  liveContainerCount,
  PREBUILD_CONTAINER_HEADROOM,
} from './container-capacity'
import { loadSessionPolicy, sessionsPaused } from './lifecycle'
import { SESSION_IMAGE_VERSION } from './rocketflare-dev'
import { type WorkspaceBackupMode, workspaceBackupMode } from './workspace-backup'

/**
 * How long the SDK keeps a prebuild restorable: under the 14-day lifecycle rule on `backups/`
 * (`docs/DEPLOY.md`), which deletes the archive itself.
 */
export const PREBUILD_TTL_SECONDS = 13 * 24 * 3600
/** A prebuild older than this is not restored (its archive is near its TTL): a new one is asked for. */
export const PREBUILD_MAX_AGE_MS = 12 * 24 * 3600_000
/** A claim held longer than this is abandoned (its `prebuild` run died without saying so). */
export const PREBUILD_BUILD_STALE_MS = 30 * 60_000
/** After a failed build, how long a request waits before it builds again (no container per boot). */
export const PREBUILD_RETRY_AFTER_MS = 15 * 60_000

/**
 * What a prebuild's archive never carries, relative to the workspace: the session-specific files a
 * boot writes (`.dev.vars` — a branch URI and an encryption key — the dev server's own config and
 * state, Launch's runtime settings) and caches that belong to one dev server. A `prebuild` run
 * writes none of them; this keeps it so should that change.
 */
export const PREBUILD_EXCLUDES = [
  'apps/web/.dev.vars',
  '.dev.vars',
  'apps/web/.wrangler',
  'apps/web/wrangler.session.toml',
  '.claude/settings.local.json',
  'node_modules/.vite',
  'apps/web/node_modules/.vite',
] as const

/** `SESSION_PREBUILD` is not `off`. */
export function prebuildsEnabled(cfg: Pick<AppConfig, 'SESSION_PREBUILD'>): boolean {
  return cfg.SESSION_PREBUILD !== 'off'
}

/** The backup mode a prebuild for a session on `host` uses, or null when there are none. */
export function prebuildModeFor(
  cfg: AppConfig,
  host: SessionSandboxHost
): WorkspaceBackupMode | null {
  if (!prebuildsEnabled(cfg)) return null
  const mode = workspaceBackupMode(cfg, host)
  return mode === 'off' ? null : mode
}

/** The app's prebuild row (tenant-first), or null when it has never asked for one. */
export async function loadPrebuild(
  db: Database,
  tenantId: string,
  appId: string
): Promise<AppPrebuildRow | null> {
  const [row] = await db
    .select()
    .from(appPrebuilds)
    .where(and(eq(appPrebuilds.tenantId, tenantId), eq(appPrebuilds.appId, appId)))
  return row ?? null
}

/** Why a prebuild cannot be restored, and whether a new one should be built for that reason. */
export interface PrebuildUnusable {
  reason: string
  /**
   * False when the prebuild is fine but for ANOTHER sandbox host or backup mode (a laptop running
   * both): rebuilding it for this one would only make the other side rebuild in turn.
   */
  rebuild: boolean
}

/** Why `row`'s prebuild cannot be restored into a session on `host` now, or null when it can. */
export function unusablePrebuild(
  row: AppPrebuildRow | null,
  cfg: AppConfig,
  host: SessionSandboxHost,
  now: Date
): PrebuildUnusable | null {
  if (!prebuildsEnabled(cfg)) return { reason: 'prebuilds are off', rebuild: false }
  const mode = workspaceBackupMode(cfg, host)
  if (mode === 'off') return { reason: 'backups are off', rebuild: false }
  if (!row?.backup) return { reason: 'no prebuild yet', rebuild: true }
  if (row.imageVersion !== SESSION_IMAGE_VERSION) {
    return { reason: 'it was built on another session image', rebuild: true }
  }
  if (row.mode !== mode || row.sandboxHost !== host) {
    return {
      reason: `it was built for ${row.mode ?? 'other'} backups on the ${row.sandboxHost ?? 'other'} sandbox host`,
      rebuild: false,
    }
  }
  if (!row.builtAt || now.getTime() - row.builtAt.getTime() > PREBUILD_MAX_AGE_MS) {
    return { reason: 'it is too old', rebuild: true }
  }
  return null
}

const TERMINAL_STATUS_SQL = sql.raw(
  TERMINAL_SESSION_STATUSES.map(status => `'${status}'`).join(', ')
)

/**
 * Claim the app's next build for `sessionId` — the row is made when missing. False when a build
 * is in flight (a claim younger than {@link PREBUILD_BUILD_STALE_MS} whose session is not
 * settled), when the last one failed under {@link PREBUILD_RETRY_AFTER_MS} ago, or when the current
 * prebuild was built after `notBuiltSince` (it is already newer than what the caller saw; null:
 * whatever it is) — and when `appId` is not the tenant's app (no row is made for it: the FK names
 * the app alone). A claim refused because a build is IN FLIGHT stamps `refresh_requested_at`: that
 * build may have cloned before the change the caller saw, so it asks again when it is done
 * ({@link followUpPrebuild}).
 */
export async function claimPrebuild(
  db: Database,
  input: {
    tenantId: string
    appId: string
    sessionId: string
    now: Date
    notBuiltSince: Date | null
  }
): Promise<boolean> {
  const { tenantId, appId, now } = input
  const [app] = await db
    .select({ id: apps.id })
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
  if (!app) return false
  await db.insert(appPrebuilds).values({ tenantId, appId }).onConflictDoNothing()
  const staleBefore = new Date(now.getTime() - PREBUILD_BUILD_STALE_MS)
  const retryBefore = new Date(now.getTime() - PREBUILD_RETRY_AFTER_MS)
  const row = and(eq(appPrebuilds.tenantId, tenantId), eq(appPrebuilds.appId, appId))
  const free = or(
    isNull(appPrebuilds.buildingSessionId),
    lt(appPrebuilds.buildingSince, staleBefore),
    sql`exists (select 1 from ${sessions} where ${sessions.tenantId} = ${tenantId} and ${sessions.id} = ${appPrebuilds.buildingSessionId} and ${sessions.status} in (${TERMINAL_STATUS_SQL}))`
  ) as SQL
  const claimed = await db
    .update(appPrebuilds)
    .set({ buildingSessionId: input.sessionId, buildingSince: now, lastAttemptAt: now })
    .where(
      and(
        row,
        free,
        or(
          isNull(appPrebuilds.lastError),
          isNull(appPrebuilds.lastAttemptAt),
          lt(appPrebuilds.lastAttemptAt, retryBefore)
        ),
        input.notBuiltSince
          ? or(isNull(appPrebuilds.builtAt), lt(appPrebuilds.builtAt, input.notBuiltSince))
          : undefined
      )
    )
    .returning({ id: appPrebuilds.id })
  if (claimed.length > 0) return true
  // A build in flight: leave word for it (a no-op when the claim is free — refused for another reason).
  await db
    .update(appPrebuilds)
    .set({ refreshRequestedAt: now })
    .where(and(row, isNotNull(appPrebuilds.buildingSessionId), not(free)))
  return false
}

/**
 * Give the claim back when `sessionId` holds it: a failed or abandoned build (`error`, which holds
 * off the next request for {@link PREBUILD_RETRY_AFTER_MS}). A no-op when the claim is someone
 * else's or already settled. Called by `fail`, `cleanup` and a request that could not start.
 */
export async function releasePrebuildClaim(
  db: Database,
  ref: { tenantId: string; appId: string; sessionId: string; error: string; now: Date }
): Promise<boolean> {
  const released = await db
    .update(appPrebuilds)
    .set({
      buildingSessionId: null,
      buildingSince: null,
      lastError: ref.error.slice(0, 2000),
      // The backoff runs from the failure, not from the claim a long build took.
      lastAttemptAt: ref.now,
    })
    .where(
      and(
        eq(appPrebuilds.tenantId, ref.tenantId),
        eq(appPrebuilds.appId, ref.appId),
        eq(appPrebuilds.buildingSessionId, ref.sessionId)
      )
    )
    .returning({ id: appPrebuilds.id })
  return released.length > 0
}

/** What a saved build recorded ({@link recordPrebuild}). */
export interface PrebuildRecord {
  backup: AppPrebuildBackup
  mode: WorkspaceBackupMode
  sandboxHost: SessionSandboxHost
  baseSha: string
  treeSha: string
  lockfileHash: string | null
  buildMs: number
  builtAt: Date
  /** The session image the BUILD ran on (its `sessions.image_version`, stamped at its claim). */
  imageVersion: string
}

/**
 * Make `record` the app's prebuild — only while `sessionId` still holds the claim (a stale claim
 * taken over means another build owns the row now). Returns whether it was recorded and the
 * archive it replaced (the caller deletes it).
 */
export async function recordPrebuild(
  db: Database,
  ref: { tenantId: string; appId: string; sessionId: string },
  record: PrebuildRecord
): Promise<{ recorded: boolean; replaced: AppPrebuildBackup | null }> {
  const before = await loadPrebuild(db, ref.tenantId, ref.appId)
  const updated = await db
    .update(appPrebuilds)
    .set({
      ...record,
      buildingSessionId: null,
      buildingSince: null,
      lastError: null,
    })
    .where(
      and(
        eq(appPrebuilds.tenantId, ref.tenantId),
        eq(appPrebuilds.appId, ref.appId),
        eq(appPrebuilds.buildingSessionId, ref.sessionId)
      )
    )
    .returning({ id: appPrebuilds.id })
  if (updated.length === 0) return { recorded: false, replaced: null }
  const replaced = before?.backup && before.backup.id !== record.backup.id ? before.backup : null
  return { recorded: true, replaced }
}

export type PrebuildRequest =
  | { requested: true; sessionId: string }
  | { requested: false; reason: string }

/**
 * Ask for a new prebuild of `appId` on `host` — see the header. The claim, then the `prebuild`
 * session's row and its `SessionWorkflow` instance; anything after the claim that fails gives it
 * back. `notBuiltSince`: a prebuild built after it is already the one the caller wanted.
 */
export async function requestPrebuild(
  db: Database,
  env: Pick<AppBindings, 'SESSION_WORKFLOW'>,
  cfg: AppConfig,
  input: {
    tenantId: string
    appId: string
    host: SessionSandboxHost
    now: Date
    /** A prebuild built after it is already the one the caller wanted; null: build regardless. */
    notBuiltSince: Date | null
  }
): Promise<PrebuildRequest> {
  if (!prebuildsEnabled(cfg)) return { requested: false, reason: 'prebuilds are off' }
  if (workspaceBackupMode(cfg, input.host) === 'off') {
    return { requested: false, reason: 'backups are off' }
  }
  const workflow = env.SESSION_WORKFLOW
  if (!workflow) return { requested: false, reason: 'no SESSION_WORKFLOW binding' }
  if (await sessionsPaused(db)) return { requested: false, reason: 'sessions are paused' }
  const { tenantId, appId } = input
  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
  if (!app?.repoOwner || !app.repoName)
    return { requested: false, reason: 'the app has no repository' }
  // Never the slot a person is about to need: every kind's containers count (`max_instances`).
  const live = await liveContainerCount(db, input.host)
  const cap = containerCapFor(cfg, input.host)
  if (live > cap - PREBUILD_CONTAINER_HEADROOM) {
    return {
      requested: false,
      reason: `the ${input.host} sandbox host is near its container cap (${live} of ${cap} in use)`,
    }
  }
  const sessionId = crypto.randomUUID()
  const claimed = await claimPrebuild(db, {
    tenantId,
    appId,
    sessionId,
    now: input.now,
    notBuiltSince: input.notBuiltSince,
  })
  if (!claimed) return { requested: false, reason: 'a prebuild is being built, or is new enough' }
  try {
    await db.insert(sessions).values({
      id: sessionId,
      tenantId,
      appId,
      createdByUserId: null,
      kind: 'prebuild',
      shortId: newSessionShortId(),
      previewToken: newPreviewToken(),
      title: 'Prebuild',
      baseRef: app.defaultBranch ?? 'main',
      branch: null,
      sandboxHost: input.host,
      policy: await loadSessionPolicy(db),
      instanceId: sessionId,
      lastActivityAt: input.now,
    })
    await workflow.create({ id: sessionId, params: { sessionId, tenantId } })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await releasePrebuildClaim(db, { tenantId, appId, sessionId, error: reason, now: input.now })
    return { requested: false, reason: `the prebuild could not start: ${reason}` }
  }
  return { requested: true, sessionId }
}

/**
 * After a `prebuild` run gave its claim back (saved, failed or abandoned): when a request came
 * while it was building (`refresh_requested_at` later than the run's start), ask again — the
 * newer default branch, or lockfile, is what that request wanted. The stamp is cleared only by a
 * request that went through; one refused (the failure backoff, the container cap) leaves it for
 * the next run's follow-up or a later boot. Never throws.
 */
export async function followUpPrebuild(
  db: Database,
  env: Pick<AppBindings, 'SESSION_WORKFLOW'>,
  cfg: AppConfig,
  run: Pick<SessionRow, 'id' | 'tenantId' | 'appId' | 'createdAt' | 'sandboxHost'>,
  now: Date
): Promise<PrebuildRequest | null> {
  const row = await loadPrebuild(db, run.tenantId, run.appId)
  const asked = row?.refreshRequestedAt
  if (!asked || asked.getTime() < run.createdAt.getTime() || row?.buildingSessionId) return null
  const host = run.sandboxHost === 'remote' ? 'remote' : 'local'
  const result = await requestPrebuild(db, env, cfg, {
    tenantId: run.tenantId,
    appId: run.appId,
    host,
    now,
    notBuiltSince: null,
  })
  if (result.requested) {
    await db
      .update(appPrebuilds)
      .set({ refreshRequestedAt: null })
      .where(
        and(
          eq(appPrebuilds.tenantId, run.tenantId),
          eq(appPrebuilds.appId, run.appId),
          lt(appPrebuilds.refreshRequestedAt, new Date(now.getTime() + 1))
        )
      )
  }
  return result
}
