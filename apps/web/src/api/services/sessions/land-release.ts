/**
 * Issue #5 Phase B's bodies (`docs/plans/i5-ship-to-staging.md` §1.8–§1.9): after the merge, the
 * `SessionWorkflow` calls these through the `landRelease` / `landStaging` / `landHealth` hooks
 * (`hooks.ts`) — cut (or share) the patch release under the app's release claim, follow it to
 * `staging_active`, then wait for staging to answer healthy on its version.
 *
 * Each call is ONE Workflow step: a single idempotent read or action that answers what to do next
 * (`wait` with how long, or a verdict). The Workflow (S2) owns the round loop, the sleeps and the
 * `live` / `stalled` writes. So every bound below is judged from TIMESTAMPS on rows that outlive
 * the step — `landing.stageAt`, the release's `created_at`, the staging environment's
 * `app_health_checks` — never from a counter in memory, which a replayed step would reset.
 *
 * - **`landRelease`** (`land.release#K.R`): `landing.releaseId` set → that release. A release of
 *   the app already listing this PR (`app_releases.prs @> [{"number": n}]`) → share it. Otherwise
 *   take the app's release claim (`session:<id>`), re-check, and `createRelease({ bump: 'patch',
 *   userId: null, actor: SYSTEM, trigger: { sessionId } })`. Claim held by someone else → `wait`
 *   20 s, up to 15 minutes from `landing.mainCi.at` (issue #11: when `land.main-ci` let the release
 *   go; `landing.stageAt` on a landing without one). GitHub refusing the bump or the tag (a
 *   protected branch Launch cannot bypass, a tag that exists) → `stalled` `release_failed`. On
 *   success it records `releaseId` / `version` / `tag` on the landing and moves `releasing →
 *   deploying` in ONE compare-and-set, then emits `ship.released` (only when the CAS won, so a
 *   retried step never emits twice).
 * - **`landStaging`** (`land.staging#K.R`): reads the release, and while it is `tagged`/`staging`
 *   follows its tag's deploy run on GitHub (`followTagRun`, `releases/tag-run.ts` — throttled per
 *   release, a GitHub error ignored): a run that failed before the staging job (a red gate) moves
 *   the release to `failed` there and then. `staging_active` or later → `active`
 *   (`ship.staging {status:'active'}` emitted); `failed` on its staging run → `deploy_failed`;
 *   still `tagged` (or a staging run never finished) 45 minutes after the release was cut →
 *   `deploy_timeout`; else `wait` 2 minutes.
 * - **`landHealth`** (`land.health#K.R`): one `checkAppHealth` probe. Staging `up` on the release's
 *   version (or a newer one, which carries the change too) → `live` with staging's URL. Otherwise
 *   `wait` 30 s, until 10 probes of staging since it went live on the release (or since the landing
 *   reached `deploying`, whichever is later — the cron's own probes count too) → `unhealthy`.
 *
 * Decision §0.1: nothing here reopens the session. A failure after the merge is a `stalled` answer;
 * the Workflow's `land.stalled#K` records `stalledReason` and the sentence.
 */
import { compareReleaseVersions } from '@launch/shared/launch-promotion'
import { RELEASE_STAGING_TIMEOUT_MINUTES } from '@launch/shared/launch-releases'
import {
  type PrCheckState,
  type PrChecks,
  requiredCheckState,
  type SessionLanding,
  SHIP_MAIN_CI_MAX_MINUTES,
} from '@launch/shared/launch-sessions'
import { and, count, eq, gte, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type AppReleaseRow,
  type AppRow,
  appEnvironments,
  appHealthChecks,
  auditEvents,
  type SessionRow,
  sessions,
} from '../../../db/schema'
import { isApiError } from '../../utils/core/errors'
import type { ApprovalDeps } from '../approvals/types'
import { getAppRow } from '../launch/apps'
import { SYSTEM_ACTOR } from '../launch/audit'
import { getRef, listCheckRuns } from '../launch/github-app'
import { checkAppHealth } from '../launch/health'
import { type ReleaseClaimOutcome, withReleaseClaim } from '../launch/releases/claim'
import { withRepoToken } from '../launch/releases/github'
import {
  createRelease,
  getRelease,
  RELEASE_TRIGGER_SESSION_MERGE,
  releaseListingPr,
} from '../launch/releases/release'
import { followTagRun } from '../launch/releases/tag-run'
import { safeErrorMessage } from './events'
import type {
  LandHealthResult,
  LandReleaseResult,
  LandStagingResult,
  SessionStepContext,
} from './hooks'

/** `land.release-wait#K.R`: how long a landing that lost the release claim sleeps. */
export const LAND_RELEASE_WAIT_SECONDS = 20
/** A landing waits at most this long (from reaching `releasing`) for another holder's claim. */
export const LAND_RELEASE_CLAIM_MAX_MINUTES = 15
/** `land.staging-wait#K.R`: one round of following the release's staging deploy. */
export const LAND_STAGING_WAIT_SECONDS = 120
/** A release still not live on staging this long after it was cut has timed out. */
export const LAND_STAGING_MAX_MINUTES = RELEASE_STAGING_TIMEOUT_MINUTES
/** `land.health-wait#K.R`: the gap between two health probes of staging. */
export const LAND_HEALTH_WAIT_SECONDS = 30
/** Staging gets this many probes since it went live on the release before the landing stalls. */
export const LAND_HEALTH_MAX_PROBES = 10

/** The release statuses that mean "it went live on staging" (or past it). */
const STAGING_REACHED = new Set<AppReleaseRow['status']>([
  'staging_active',
  'awaiting_approval',
  'promoting',
  'production_active',
  'rejected',
])

/** The session, re-read tenant-first, and its landing (the step's row may be a round old). */
async function loadLanding(
  ctx: SessionStepContext,
  hook: string
): Promise<{ session: SessionRow; landing: SessionLanding }> {
  const [session] = await ctx.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, ctx.ref.tenantId), eq(sessions.id, ctx.ref.sessionId)))
    .limit(1)
  if (!session?.landing) {
    throw new Error(`${hook}: session ${ctx.ref.sessionId} has no landing to follow`)
  }
  return { session, landing: session.landing }
}

/** The landing's release, which `landRelease` recorded; a missing one is a Workflow bug. */
async function landingRelease(
  ctx: SessionStepContext,
  session: SessionRow,
  landing: SessionLanding,
  hook: string
): Promise<AppReleaseRow> {
  if (!landing.releaseId) {
    throw new Error(`${hook}: session ${session.id}'s landing has no release yet`)
  }
  return getRelease(
    { db: ctx.db },
    { tenantId: ctx.ref.tenantId, appId: session.appId, releaseId: landing.releaseId }
  )
}

/** Was `release` cut by another merge (or a person) than this session's? */
async function isShared(db: Database, release: AppReleaseRow, sessionId: string) {
  const [created] = await db
    .select({ summary: auditEvents.summary })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, release.tenantId),
        eq(auditEvents.appId, release.appId),
        eq(auditEvents.targetType, 'release'),
        eq(auditEvents.targetId, release.id),
        eq(auditEvents.action, 'release.created')
      )
    )
    .limit(1)
  const after = (created?.summary?.after ?? {}) as { trigger?: unknown; sessionId?: unknown }
  return !(after.trigger === RELEASE_TRIGGER_SESSION_MERGE && after.sessionId === sessionId)
}

/** Staging's environment row of the app (tenant-first), or null. */
async function stagingEnvironment(db: Database, tenantId: string, appId: string) {
  const [row] = await db
    .select()
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, tenantId),
        eq(appEnvironments.appId, appId),
        eq(appEnvironments.name, 'staging')
      )
    )
    .limit(1)
  return row ?? null
}

/**
 * Record the release on the landing — `releasing → deploying` in one compare-and-set — and emit
 * `ship.released` when this call made the move.
 */
async function recordReleased(
  ctx: SessionStepContext,
  release: AppReleaseRow,
  shared: boolean
): Promise<LandReleaseResult> {
  const now = ctx.now()
  const patch = {
    stage: 'deploying',
    stageAt: now.toISOString(),
    releaseId: release.id,
    version: release.version,
    tag: release.tag,
  } satisfies Partial<SessionLanding>
  const moved = await ctx.db
    .update(sessions)
    .set({
      landing: sql`${sessions.landing} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessions.tenantId, ctx.ref.tenantId),
        eq(sessions.id, ctx.ref.sessionId),
        sql`${sessions.landing}->>'stage' = 'releasing'`
      )
    )
    .returning({ id: sessions.id })
  if (moved.length > 0) {
    await ctx.emit({
      type: 'ship.released',
      turn: ctx.turn,
      data: { releaseId: release.id, version: release.version, tag: release.tag, shared },
    })
  }
  return {
    status: 'released',
    releaseId: release.id,
    version: release.version,
    tag: release.tag,
    shared,
  }
}

/**
 * Issue #21: what the release's bump commit will sit on. `land.main-ci` saw the merge commit's
 * `Gate` green, so the tag's deploy skips its gate — unless another merge landed on the default
 * branch since, which would make the bump's parent an untested commit and the deploy re-gate.
 *
 * - Not a `success` verdict (none, timeout, override): the deploy re-gates anyway — null.
 * - The head is still the merge commit (or GitHub cannot be read): null, release now.
 * - The head moved: its own `Gate` decides — `success` releases (the parent is tested);
 *   `failure` releases too (the deploy re-gates; the newer merge's own landing stalls on it);
 *   pending or not reported yet → `wait`, until {@link SHIP_MAIN_CI_MAX_MINUTES} after `land.main-ci`
 *   let the release go, then `timeout` (release; the deploy re-gates, as before issue #11).
 *
 * The state is recorded on `release.created` (`trigger.parentGate`).
 */
async function bumpParentGate(
  ctx: SessionStepContext,
  app: AppRow,
  landing: SessionLanding
): Promise<{ state: 'success' | 'failure' | 'timeout' | 'wait'; head: string } | null> {
  const gated = landing.mainCi
  if (gated?.verdict !== 'success' || !landing.mergeSha) return null
  let read: { head: string; state: PrCheckState } | null
  try {
    read = await withRepoToken(
      ctx.db,
      ctx.cfg,
      app,
      { contents: 'read', checks: 'read' },
      async (token, repo) => {
        const ref = await getRef(token, repo.owner, repo.repo, `heads/${repo.branch}`)
        const head = ref.object.sha
        if (head === gated.sha) return null
        const runs = await listCheckRuns(token, repo.owner, repo.repo, head)
        const checks = runs.map(r => ({
          name: r.name,
          state: (r.status !== 'completed'
            ? 'pending'
            : ['success', 'neutral', 'skipped'].includes(r.conclusion ?? '')
              ? 'success'
              : 'failure') as PrCheckState,
        }))
        return { head, state: requiredCheckState(checks as PrChecks['checks']) }
      }
    )
  } catch (err) {
    ctx.logger.warn({ err }, 'landRelease: could not read the default branch head; releasing')
    return null
  }
  if (!read) return null
  const { head, state } = read
  if (state === 'success' || state === 'failure') return { state, head }
  const waitedMs = ctx.now().getTime() - Date.parse(gated.at)
  if (waitedMs >= SHIP_MAIN_CI_MAX_MINUTES * 60_000) return { state: 'timeout', head }
  return { state: 'wait', head }
}

/** `land.release#K.R` (plan §1.8). */
export async function landRelease(ctx: SessionStepContext): Promise<LandReleaseResult> {
  const { db } = ctx
  const { tenantId, sessionId } = ctx.ref
  const { session, landing } = await loadLanding(ctx, 'landRelease')

  // Already recorded (a replayed step, or the Workflow asking again): that release, no new event.
  if (landing.releaseId) {
    const release = await landingRelease(ctx, session, landing, 'landRelease')
    return {
      status: 'released',
      releaseId: release.id,
      version: release.version,
      tag: release.tag,
      shared: await isShared(db, release, sessionId),
    }
  }
  if (landing.stage !== 'releasing') {
    throw new Error(`landRelease: session ${sessionId}'s landing is at '${landing.stage}'`)
  }

  const listing = { tenantId, appId: session.appId, number: landing.prNumber }
  const existing = await releaseListingPr(db, listing)
  if (existing) return recordReleased(ctx, existing, await isShared(db, existing, sessionId))

  const app = await getAppRow(db, tenantId, session.appId)
  const deps: ApprovalDeps = {
    db,
    env: ctx.env,
    cfg: ctx.cfg,
    logger: ctx.logger,
    realtime: ctx.realtime,
    now: ctx.now,
  }
  let outcome: ReleaseClaimOutcome<{ release: AppReleaseRow; shared: boolean } | { wait: true }>
  try {
    outcome = await withReleaseClaim(
      db,
      { tenantId, appId: app.id, holder: `session:${sessionId}`, now: ctx.now() },
      async () => {
        // Re-check under the claim: the holder we waited on may have cut the release with us in it.
        const again = await releaseListingPr(db, listing)
        if (again) return { release: again, shared: await isShared(db, again, sessionId) }
        // Issue #21: the bump's parent is the default branch's head NOW — gated only if it is
        // still the merge `land.main-ci` saw green, or its own `Gate` is green too.
        const parent = await bumpParentGate(ctx, app, landing)
        if (parent?.state === 'wait') return { wait: true as const }
        const release = await createRelease(deps, {
          tenantId,
          app,
          bump: 'patch',
          userId: null,
          actor: SYSTEM_ACTOR,
          trigger: { sessionId, ...(parent ? { parentGate: parent.state } : {}) },
        })
        return { release, shared: false }
      }
    )
  } catch (err) {
    // GitHub refused (502 `release_github_failed`, a protected branch Launch cannot bypass), the
    // version cannot be read or its tag exists (409): the merge is in, the release is not.
    if (!isApiError(err)) throw err
    return {
      status: 'stalled',
      reason: 'release_failed',
      error: safeErrorMessage(err, 'The release could not be cut'),
    }
  }
  if (outcome.claimed) {
    if ('wait' in outcome.value) return { status: 'wait', waitSeconds: LAND_RELEASE_WAIT_SECONDS }
    return recordReleased(ctx, outcome.value.release, outcome.value.shared)
  }

  // Issue #11: the claim's wait starts once `land.main-ci` let the release go, not at the merge —
  // or at a person's Retry (issue #21), which moves `stageAt` past it.
  const since = Math.max(
    Date.parse(landing.mainCi?.at ?? landing.stageAt),
    Date.parse(landing.stageAt)
  )
  const waitedMs = ctx.now().getTime() - since
  if (waitedMs >= LAND_RELEASE_CLAIM_MAX_MINUTES * 60_000) {
    return {
      status: 'stalled',
      reason: 'release_failed',
      error: `Another release of ${app.displayName} was being cut for ${LAND_RELEASE_CLAIM_MAX_MINUTES} minutes, so this merge was not released. Release it from the app page.`,
    }
  }
  return { status: 'wait', waitSeconds: LAND_RELEASE_WAIT_SECONDS }
}

/** `land.staging#K.R` (plan §1.9). */
export async function landStaging(ctx: SessionStepContext): Promise<LandStagingResult> {
  const { session, landing } = await loadLanding(ctx, 'landStaging')
  const read = await landingRelease(ctx, session, landing, 'landStaging')
  // While no staging job has gone live, the tag's run on GitHub: one that already failed (its gate
  // red) fails the release now, rather than after the 45-minute timeout below.
  const release =
    read.status === 'tagged' || read.status === 'staging'
      ? (
          await followTagRun(
            ctx.db,
            ctx.cfg,
            await getAppRow(ctx.db, ctx.ref.tenantId, session.appId),
            read,
            { now: ctx.now(), logger: ctx.logger, realtime: ctx.realtime }
          )
        ).release
      : read

  // A production run's failure (`failed` with a `production:` error) came after staging went live.
  const productionFailure = release.status === 'failed' && release.error?.startsWith('production:')
  if (STAGING_REACHED.has(release.status) || productionFailure) {
    const staging = await stagingEnvironment(ctx.db, ctx.ref.tenantId, session.appId)
    await ctx.emit({
      type: 'ship.staging',
      turn: ctx.turn,
      data: { status: 'active', version: release.version, url: staging?.url ?? null },
    })
    return { status: 'active' }
  }
  if (release.status === 'failed') {
    const why = release.error?.replace(/^staging:\s*/, '') || 'the deploy failed'
    return {
      status: 'stalled',
      reason: 'deploy_failed',
      error: safeErrorMessage(`The staging deploy of ${release.version} failed: ${why}`),
    }
  }
  // `tagged` (no run yet) or `staging` (a run started and never went live).
  const ageMs = ctx.now().getTime() - release.createdAt.getTime()
  if (ageMs >= LAND_STAGING_MAX_MINUTES * 60_000) {
    return {
      status: 'stalled',
      reason: 'deploy_timeout',
      error:
        release.status === 'tagged'
          ? `${release.version} was tagged ${LAND_STAGING_MAX_MINUTES} minutes ago and no staging deploy started. Check the repository's deploy workflow.`
          : `The staging deploy of ${release.version} started but did not go live within ${LAND_STAGING_MAX_MINUTES} minutes.`,
    }
  }
  return { status: 'wait', waitSeconds: LAND_STAGING_WAIT_SECONDS }
}

/** `land.health#K.R` (plan §1.9). */
export async function landHealth(ctx: SessionStepContext): Promise<LandHealthResult> {
  const { db } = ctx
  const { tenantId } = ctx.ref
  const { session, landing } = await loadLanding(ctx, 'landHealth')
  const release = await landingRelease(ctx, session, landing, 'landHealth')
  const version = release.version

  const before = await stagingEnvironment(db, tenantId, session.appId)
  // No URL to probe: staging went live on the release (`landStaging`), and that is all there is.
  if (!before?.url) return { status: 'live', url: null, version }

  const now = ctx.now()
  const envs = await checkAppHealth(db, tenantId, session.appId, { now })
  const staging = envs.find(e => e.id === before.id) ?? before
  const runs = staging.healthVersion
  if (
    staging.healthStatus === 'up' &&
    runs !== null &&
    compareReleaseVersions(runs, version) >= 0
  ) {
    return { status: 'live', url: staging.url, version: runs }
  }

  // Probes counted from when staging went live on this release, or from when the landing reached
  // `deploying` — whichever is later — so a step replay or a slow Workflow cannot reset the count.
  const since = new Date(
    Math.max(Date.parse(landing.stageAt), staging.lastDeployAt?.getTime() ?? 0)
  )
  const [probes] = await db
    .select({ n: count() })
    .from(appHealthChecks)
    .where(
      and(
        eq(appHealthChecks.tenantId, tenantId),
        eq(appHealthChecks.environmentId, staging.id),
        gte(appHealthChecks.checkedAt, since)
      )
    )
  if ((probes?.n ?? 0) < LAND_HEALTH_MAX_PROBES) {
    return { status: 'wait', waitSeconds: LAND_HEALTH_WAIT_SECONDS }
  }
  const seen = [
    staging.healthStatus,
    runs ? `on ${runs}` : null,
    staging.healthError ? `(${staging.healthError})` : null,
  ]
    .filter(Boolean)
    .join(' ')
  return {
    status: 'stalled',
    reason: 'unhealthy',
    error: safeErrorMessage(
      `Staging did not answer healthy on ${version} after ${LAND_HEALTH_MAX_PROBES} checks: last seen ${seen}.`
    ),
  }
}
