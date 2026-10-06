/**
 * Issue #5's landing (`docs/plans/i5-ship-to-staging.md` §1.1–§1.9, CONCEPTS §18.13): what a
 * shipped PR goes through in `staging` mode, as plain step bodies the `SessionWorkflow` runs.
 *
 * **Phase A** — status `shipping`, inside the turn loop (`SessionWorkflow.land`), one round `N`:
 *
 *   land.ci#N       the PR and its CI on the GATE SHA, read fresh — decided on the REQUIRED check
 *                   `Gate` alone (issue #9, `requiredCheckState`: a red optional check such as an
 *                   evals run does not stop it; no `Gate` at all falls back to the fold over the
 *                   other checks; Launch's own `launch/gate` never counts; the fold of every
 *                   check stays what the panel shows): green → `approval` (a review is
 *                   required) or `merging`; red → reopen `ci_failed` with the failing check's
 *                   redacted log tail; nothing after `SHIP_CI_NONE_GRACE_MINUTES` → `ci_none`; still
 *                   pending after `SHIP_CI_MAX_MINUTES` → `ci_timeout`; merged by hand → Phase B;
 *                   closed → `pr_closed`; another head → `head_moved`. Else wait a round (30 s for the
 *                   first 10 minutes, then 2 minutes).
 *   land.review#N   open the `session.merge` approval idempotently and read it: pending → wait;
 *                   approved (on this head) → merge; rejected / expired / cancelled → reopen.
 *   land.merge#N    read first (a recorded or GitHub-side merge wins), the head and `Gate` again, the
 *                   approval again, then ONE squash on the gate SHA (a refused one reads the PR
 *                   again: an earlier instance's squash that just landed is recorded, not
 *                   reopened), then ONE compare-and-set `shipping → shipped`, stage `releasing`.
 *   land.reopen#N   give the session back: `ready` while the container is still the loop's, else
 *                   `suspended`; the landing cleared.
 *   land.wait#N     (the Workflow's) `waitForEvent(SESSION_WAKE_EVENT)` for one round.
 *
 * While it waits in `ci` past the policy's `idleSuspendMinutes`, in `approval` as long, or under a
 * drain, the container is backed up and destroyed (`releaseLandingContainer`); a reopen then
 * suspends, and the next message resumes cold.
 *
 * **Phase B** — status `shipped`, after `cleanup` (`SessionWorkflow.release`): first
 * `land.main-ci#K.R` (`landMainCiStep`, issue #11) waits for the SQUASH commit's own `Gate` on the
 * default branch — green → release (the tag's deploy then skips its gate); red → stalled
 * `main_ci_failed`, no release; nothing reported within `SHIP_MAIN_CI_NONE_GRACE_MINUTES`, or still
 * running past `SHIP_MAIN_CI_MAX_MINUTES` → release anyway (the deploy re-gates); then the
 * `landRelease` / `landStaging` / `landHealth` hooks (`land-release.ts`, slice S3) through the
 * wrappers here (`landReleaseStep` …), then `land.live#K` (`landLiveStep`) or `land.stalled#K`
 * (`landStalledStep`). After the merge nothing reopens (decision §0.1): a failure stalls.
 *
 * Rules on top of `steps.ts`'s: every landing write is a compare-and-set on the status AND
 * `landing->>'stage'` (a jsonb merge, so a concurrent field write is not lost); every query names
 * the tenant; a check's log is redacted before it reaches an event (and through it, the system
 * note a fix turn reads); each round stamps `last_activity_at` (and beats it while it runs —
 * `withHeartbeat`), the liveness the safety-net cron (`nudgeLandingSessions`, on `sessions.checks`)
 * and the reconcile (`reconcile.ts`, which restarts an instance alive in name only) read.
 */
import {
  DEFAULT_APPROVAL_POLICIES,
  SESSION_MERGE_EXPIRY_HOURS,
} from '@launch/shared/launch-approvals'
import {
  MOVING_LANDING_STAGES,
  type PrChecks,
  RETRYABLE_STALLED_REASONS,
  requiredCheckState,
  resolveSessionPolicy,
  type SessionLanding,
  type SessionShipCiData,
  type SessionStatus,
  SHIP_CI_MAX_MINUTES,
  SHIP_CI_NONE_GRACE_MINUTES,
  SHIP_MAIN_CI_MAX_MINUTES,
  SHIP_MAIN_CI_NONE_GRACE_MINUTES,
  type ShipLandingStage,
  type ShipMainCiVerdict,
  type ShipReopenReason,
  type ShipStalledReason,
  sessionShipSummarySchema,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type ApprovalRequestRow,
  approvalRequests,
  apps,
  type SessionRow,
  sessionEvents,
  sessions,
  tenants,
  tenantUsers,
  users,
} from '../../../db/schema'
import type { AppBindings } from '../../types'
import type { Logger } from '../../utils/core/logger'
import { isMissingInstanceError } from '../agents/runs'
import { open } from '../approvals/engine'
import { cancelMergeApproval, mergeDecider } from '../approvals/kinds/session-merge'
import type { ApprovalDeps, ApprovalRequester } from '../approvals/types'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import { recordedPrNumbers, recordPrMerged } from '../launch/releases/pr-audit'
import { reviewPolicyFor } from '../launch/ship-settings'
import { checkContainer, SESSION_BOOT_MARKER } from './boot-marker'
import { type WarnLogger, wakeSession } from './chat'
import { safeErrorMessage } from './events'
import type { LandHealthResult, LandReleaseResult, LandStagingResult } from './hooks'
import { restartSessionInstance, sessionsPaused } from './lifecycle'
import { redactModelKeyText } from './model-key'
import type { FailedCheckLog, RepoPullRequest } from './ports'
import { FAILED_CHECK_LOG_LINES } from './repo/github-repo-host'
import { tailOf } from './rocketflare-dev'
import { sessionRepo } from './ship'
import {
  backupWorkspace,
  emitterFor,
  hookContext,
  landingOf,
  limitsOf,
  loadSession,
  type StepScope,
  sandboxFor,
  transition,
} from './steps'

/**
 * What a Phase A round tells the loop to do next.
 *
 * - `wait`: nothing to do yet — `land.wait#N` waits `waitSeconds` for `SESSION_WAKE_EVENT`;
 * - `review`: CI is green and a review is required — `land.review#N` next;
 * - `merge`: CI is green and no review is required, or the review approved — `land.merge#N`;
 * - `release`: merged (by Launch, or by a person meanwhile) — the loop returns, `cleanup` runs,
 *   then Phase B;
 * - `reopen`: give the session back — `land.reopen#N` with the reason and the person's sentence;
 * - `none`: the row is no longer where this step expected (another instance moved it) — the loop's
 *   next `inspect` reads it again.
 */
export type LandRound =
  | { next: 'wait'; waitSeconds: number }
  | { next: 'review' }
  | { next: 'merge' }
  | { next: 'release'; mergeSha: string }
  | { next: 'reopen'; reason: ShipReopenReason; message: string }
  | { next: 'none' }

/** What `land.ci#N` read on the gate SHA (plan §1.4). */
export type LandCiVerdict =
  | 'pending'
  | 'success'
  | 'failure'
  | 'none'
  | 'merged'
  | 'closed'
  | 'head_moved'

// ---- timings -----------------------------------------------------------------------------------

/** CI rounds: every 30 s for the first 10 minutes of the `ci` stage, then every 2 minutes. */
export const LAND_CI_FAST_SECONDS = 30
export const LAND_CI_FAST_WINDOW_MINUTES = 10
export const LAND_CI_SLOW_SECONDS = 120
/** A round in `approval`: the approval's own effects wake the session; this is the backstop. */
export const LAND_APPROVAL_ROUND_SECONDS = 30 * 60
/** After a land step threw (GitHub did not answer): try again after this long. */
export const LAND_RETRY_SECONDS = 120
/** A merge that has not landed this long after the stage began gives the session back. */
export const LAND_MERGE_MAX_MINUTES = 30

/**
 * One round's length per moving stage — the safety-net cron wakes a landing quiet for
 * {@link LAND_NUDGE_ROUNDS} of them (by `landing.stageAt` AND `last_activity_at`).
 */
export const LAND_ROUND_SECONDS: Record<(typeof MOVING_LANDING_STAGES)[number], number> = {
  ci: LAND_CI_SLOW_SECONDS,
  approval: LAND_APPROVAL_ROUND_SECONDS,
  merging: 120,
  releasing: 120,
  deploying: 120,
}
export const LAND_NUDGE_ROUNDS = 3

/** How long a failed check's log tail an event and the system note carry, at most. */
export const LAND_CHECK_LOG_MAX_CHARS = 6_000

// ---- the row -----------------------------------------------------------------------------------

/**
 * Compare-and-set the landing: the row must be in one of `statuses` with `landing->>'stage'` in
 * `stages` (and the same gate SHA); `patch` is MERGED into the jsonb, `set` written beside it. The
 * row after, or null when it had moved.
 */
export async function casLanding(
  scope: Pick<StepScope, 'db' | 'params' | 'realtime'>,
  where: {
    statuses: readonly SessionStatus[]
    stages: readonly ShipLandingStage[]
    gateSha?: string
  },
  patch: Partial<SessionLanding>,
  set: Partial<typeof sessions.$inferInsert> = {}
): Promise<SessionRow | null> {
  const [row] = await scope.db
    .update(sessions)
    .set({
      ...set,
      landing: sql`${sessions.landing} || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(
      and(
        eq(sessions.tenantId, scope.params.tenantId),
        eq(sessions.id, scope.params.sessionId),
        inArray(sessions.status, [...where.statuses]),
        inArray(sql<string>`${sessions.landing}->>'stage'`, [...where.stages]),
        where.gateSha === undefined
          ? undefined
          : sql`${sessions.landing}->>'gateSha' = ${where.gateSha}`
      )
    )
    .returning()
  return row ?? null
}

/** "This landing is alive": `last_activity_at`, the clock the safety-net cron reads. */
async function stamp(scope: StepScope): Promise<void> {
  await scope.db
    .update(sessions)
    .set({ lastActivityAt: scope.now() })
    .where(
      and(eq(sessions.tenantId, scope.params.tenantId), eq(sessions.id, scope.params.sessionId))
    )
}

const sinceMs = (scope: StepScope, iso: string) => scope.now().getTime() - Date.parse(iso)
const short = (sha: string) => sha.slice(0, 7)

/** A failed check's log as an event may carry it: the last lines, redacted like the gate's tail. */
export function redactCheckLog(log: string): string {
  const text = redactModelKeyText(tailOf(log, [], FAILED_CHECK_LOG_LINES)).replace(
    /\b(gh[psuor]_[A-Za-z0-9]{8,}|x-access-token:[^\s@]+)/g,
    '<secret>'
  )
  return text.length > LAND_CHECK_LOG_MAX_CHARS ? `…${text.slice(-LAND_CHECK_LOG_MAX_CHARS)}` : text
}

/** The sentence a reopen gives the person, by reason. */
export function reopenMessage(
  reason: ShipReopenReason,
  detail: {
    check?: string
    prNumber?: number
    gateSha?: string
    by?: string
    note?: string | null
    message?: string
  } = {}
): string {
  switch (reason) {
    case 'ci_failed':
      return `CI failed on GitHub${detail.check ? ` (${detail.check})` : ''}, so nothing was merged. Ask Claude to fix it, then ship again.`
    case 'ci_timeout':
      return `CI did not finish within ${SHIP_CI_MAX_MINUTES} minutes, so nothing was merged. Ship again to try once more.`
    case 'ci_none':
      return `The repository's CI never reported on the pull request (${SHIP_CI_NONE_GRACE_MINUTES} minutes), so Launch did not merge it. Check the repository's workflows, then ship again.`
    case 'head_moved':
      return `The pull request's branch moved on after Launch's gate${detail.gateSha ? ` (it is no longer ${short(detail.gateSha)})` : ''}, so nothing was merged. Ship again to gate and land the new head.`
    case 'pr_closed':
      return `The pull request${detail.prNumber ? ` #${detail.prNumber}` : ''} was closed without being merged. Ship again to open a new one.`
    case 'review_rejected':
      return detail.message
        ? detail.message
        : `${detail.by ?? 'A reviewer'} rejected the merge${detail.note ? `: ${detail.note}` : ''}. Carry on in the chat, then ship again.`
    case 'review_expired':
      return `Nobody reviewed the merge within ${SESSION_MERGE_EXPIRY_HOURS} hours, so the request expired. Ship again to ask again.`
    case 'merge_refused':
      return `GitHub refused the merge${detail.message ? `: ${detail.message}` : ''}. Nothing was merged; ship again once it can be.`
  }
}

const reopen = (
  reason: ShipReopenReason,
  detail: Parameters<typeof reopenMessage>[1] = {}
): Extract<LandRound, { next: 'reopen' }> => ({
  next: 'reopen',
  reason,
  message: reopenMessage(reason, detail),
})

// ---- the merge, however it happened ------------------------------------------------------------

/**
 * The PR is merged (by Launch's squash, or by a person in GitHub meanwhile): ONE compare-and-set
 * `shipping → shipped`, stage `releasing`, then `pr.merged` (unless already recorded), audit
 * `session.merged`, event `ship.merged`, and a still-pending review cancelled. The merge SHA, or
 * null when the row had moved and holds no merge.
 */
async function recordMerge(
  scope: StepScope,
  session: SessionRow,
  landing: SessionLanding,
  merge: { sha: string; mergedAt: string; title: string; url: string },
  via: 'session.merge' | 'sessions.checks'
): Promise<string | null> {
  const now = scope.now()
  const row = await casLanding(
    scope,
    { statuses: ['shipping'], stages: ['ci', 'approval', 'merging'], gateSha: landing.gateSha },
    {
      stage: 'releasing',
      stageAt: now.toISOString(),
      mergeSha: merge.sha,
      mergedAt: merge.mergedAt,
    },
    { status: 'shipped', lastActivityAt: now }
  )
  if (!row) {
    const current = await loadSession(scope)
    return current.status === 'shipped' ? (landingOf(current)?.mergeSha ?? null) : null
  }
  const number = landing.prNumber
  const recorded = await recordedPrNumbers(scope.db, session.tenantId, session.appId, [number])
  if (!recorded.has(number)) {
    await recordPrMerged(scope.db, {
      tenantId: session.tenantId,
      appId: session.appId,
      via,
      pr: {
        number,
        title: merge.title || `#${number}`,
        author: null,
        mergedAt: new Date(merge.mergedAt).toISOString(),
        mergeSha: merge.sha,
        url: merge.url,
        sessionId: session.id,
      },
    })
  }
  const approved = landing.approvalId && via === 'session.merge' ? landing.approvalId : null
  if (landing.approvalId && via !== 'session.merge') {
    await cancelMergeApproval(scope.db, {
      tenantId: session.tenantId,
      approvalId: landing.approvalId,
      reason: 'The pull request was merged in GitHub',
      now,
    })
  }
  await recordAudit(scope.db, {
    ...SYSTEM_ACTOR,
    tenantId: session.tenantId,
    action: 'session.merged',
    targetType: 'session',
    targetId: session.id,
    appId: session.appId,
    approvalId: approved,
    summary: {
      after: {
        prNumber: number,
        gateSha: landing.gateSha,
        mergeSha: merge.sha,
        approvalId: approved,
        by: via === 'session.merge' ? 'launch' : 'github',
      },
    },
  })
  await emitterFor(scope)({
    type: 'ship.merged',
    turn: row.turnCount,
    data: {
      number,
      sha: merge.sha,
      url: merge.url,
      approvalId: approved,
      by: via === 'session.merge' ? 'launch' : 'github',
    },
  })
  return merge.sha
}

/** A PR GitHub reports merged, as `recordMerge` takes it. */
function mergeOf(pr: RepoPullRequest, scope: StepScope) {
  return {
    sha: pr.mergeSha ?? pr.headSha,
    mergedAt: pr.mergedAt ?? scope.now().toISOString(),
    title: pr.title,
    url: pr.url,
  }
}

// ---- the container -----------------------------------------------------------------------------

/**
 * Release the container while the landing waits in `ci` or `approval` — backup + destroy
 * (`backupWorkspace`), `landing.containerReleased = true` (plan §1.7). True when it released one
 * now. The work is all on the branch already (the gate SHA); the backup only saves the next resume
 * its clone and install.
 */
export async function releaseLandingContainer(
  scope: StepScope,
  reason: 'idle' | 'approval' | 'drain'
): Promise<boolean> {
  const session = await loadSession(scope)
  const landing = landingOf(session)
  if (session.status !== 'shipping' || !landing || landing.containerReleased) return false
  if (landing.stage !== 'ci' && landing.stage !== 'approval') return false
  const sandbox = sandboxFor(scope, session)
  if ((await sandbox.readFile(SESSION_BOOT_MARKER).catch(() => null)) !== null) {
    await backupWorkspace(scope, session, sandbox)
  }
  await sandbox.destroy().catch(err => {
    scope.logger.warn({ err, reason }, 'session landing: could not destroy the container')
  })
  const row = await casLanding(
    scope,
    { statuses: ['shipping'], stages: ['ci', 'approval'] },
    { containerReleased: true },
    { containerKeptAt: null }
  )
  if (row)
    scope.logger.info({ sessionId: session.id, reason }, 'session landing: released the container')
  return row !== null
}

/** Release the container when its time has come (see the header); never throws. */
async function releaseIfDue(scope: StepScope, session: SessionRow, landing: SessionLanding) {
  if (landing.containerReleased) return
  try {
    const idleMs = resolveSessionPolicy(session.policy).idleSuspendMinutes * 60_000
    if (await sessionsPaused(scope.db)) {
      await releaseLandingContainer(scope, 'drain')
    } else if (sinceMs(scope, landing.stageAt) >= idleMs) {
      await releaseLandingContainer(scope, landing.stage === 'approval' ? 'approval' : 'idle')
    }
  } catch (err) {
    scope.logger.warn({ err }, 'session landing: could not release the container')
  }
}

// ---- land.ci -----------------------------------------------------------------------------------

/** Whether `next` says something `prev` did not (the panel's `ship.ci` row is per change). */
function checksChanged(prev: PrChecks | null, next: PrChecks): boolean {
  if (!prev || prev.headSha !== next.headSha) return true
  return (
    prev.state !== next.state ||
    // Issue #9: `Gate` reporting can leave the fold's counts as they were (`launch/gate` beside it).
    requiredCheckState(prev.checks) !== requiredCheckState(next.checks) ||
    prev.passed !== next.passed ||
    prev.failed !== next.failed ||
    prev.pending !== next.pending
  )
}

/**
 * `land.ci#N` (plan §1.4–§1.5): `getPullRequest` + `getChecks` on `landing.gateSha`, fresh each
 * round; a red CI carries `failedCheckLog`'s REDACTED tail on `ship.ci`. See the header.
 */
export async function landCiStep(
  scope: StepScope
): Promise<LandRound & { verdict: LandCiVerdict }> {
  const session = await loadSession(scope)
  const landing = landingOf(session)
  if (session.status !== 'shipping' || landing?.stage !== 'ci') {
    return { next: 'none', verdict: 'pending' }
  }
  await stamp(scope)
  const repo = await sessionRepo(scope.db, session)
  const host = scope.ports.repoHost(scope.db)
  const pr = await host.getPullRequest(repo, landing.prNumber)
  if (pr?.merged) {
    const sha = await recordMerge(scope, session, landing, mergeOf(pr, scope), 'sessions.checks')
    return sha
      ? { next: 'release', mergeSha: sha, verdict: 'merged' }
      : { next: 'none', verdict: 'merged' }
  }
  if (!pr || pr.state === 'closed') {
    return { ...reopen('pr_closed', { prNumber: landing.prNumber }), verdict: 'closed' }
  }
  if (pr.headSha !== landing.gateSha) {
    return { ...reopen('head_moved', { gateSha: landing.gateSha }), verdict: 'head_moved' }
  }

  const checks = await host.getChecks(repo, {
    prNumber: landing.prNumber,
    headSha: landing.gateSha,
  })
  await scope.db
    .update(sessions)
    .set({ prChecks: checks })
    .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, session.id)))
  // Issue #9: the landing acts on `Gate`, not on the fold of every check (`checks.state`).
  const state = requiredCheckState(checks.checks)
  const ci: SessionShipCiData = {
    state,
    headSha: landing.gateSha,
    passed: checks.passed,
    failed: checks.failed,
    pending: checks.pending,
  }
  const emit = emitterFor(scope)
  const changed = checksChanged(session.prChecks ?? null, checks)
  const elapsedMs = sinceMs(scope, landing.stageAt)

  if (state === 'failure') {
    const failed = await host.failedCheckLog(repo, { headSha: landing.gateSha }).catch(err => {
      scope.logger.warn({ err }, 'session landing: could not read the failed check')
      return null
    })
    const failedCheck = failed
      ? {
          name: failed.name,
          url: failed.url,
          ...(failed.logTail ? { logTail: redactCheckLog(failed.logTail) } : {}),
        }
      : undefined
    await emit({
      type: 'ship.ci',
      turn: session.turnCount,
      data: { ...ci, ...(failedCheck ? { failedCheck } : {}) },
    })
    return { ...reopen('ci_failed', { check: failedCheck?.name }), verdict: 'failure' }
  }
  if (changed) await emit({ type: 'ship.ci', turn: session.turnCount, data: ci })

  if (state === 'success') {
    const review = landing.reviewMode !== 'none'
    const now = scope.now().toISOString()
    const moved = await casLanding(
      scope,
      { statuses: ['shipping'], stages: ['ci'], gateSha: landing.gateSha },
      { stage: review ? 'approval' : 'merging', stageAt: now }
    )
    if (!moved) return { next: 'none', verdict: 'success' }
    return review ? { next: 'review', verdict: 'success' } : { next: 'merge', verdict: 'success' }
  }
  if (state === 'none' && elapsedMs >= SHIP_CI_NONE_GRACE_MINUTES * 60_000) {
    return { ...reopen('ci_none'), verdict: 'none' }
  }
  if (state === 'pending' && elapsedMs >= SHIP_CI_MAX_MINUTES * 60_000) {
    return { ...reopen('ci_timeout'), verdict: 'pending' }
  }
  await releaseIfDue(scope, session, landing)
  const waitSeconds =
    elapsedMs < LAND_CI_FAST_WINDOW_MINUTES * 60_000 ? LAND_CI_FAST_SECONDS : LAND_CI_SLOW_SECONDS
  return { next: 'wait', waitSeconds, verdict: state }
}

// ---- land.review -------------------------------------------------------------------------------

async function findApproval(
  db: Database,
  tenantId: string,
  where: { id: string } | { sessionId: string }
): Promise<ApprovalRequestRow | null> {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.kind, 'session.merge'),
        'id' in where
          ? eq(approvalRequests.id, where.id)
          : and(
              eq(approvalRequests.subjectType, 'session'),
              eq(approvalRequests.subjectId, where.sessionId),
              eq(approvalRequests.status, 'pending')
            )
      )
    )
    .limit(1)
  return row ?? null
}

/** Everyone who wrote a `user.message` in the session — none of them may approve its merge. */
async function messageWriters(db: Database, session: SessionRow): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: sql<string | null>`${sessionEvents.data}->>'userId'` })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, session.tenantId),
        eq(sessionEvents.sessionId, session.id),
        eq(sessionEvents.type, 'user.message')
      )
    )
  return rows.flatMap(r => (r.userId && /^[0-9a-f-]{36}$/i.test(r.userId) ? [r.userId] : []))
}

/** The session's creator as the approvals engine takes a requester. */
async function requesterOf(db: Database, session: SessionRow): Promise<ApprovalRequester> {
  if (session.createdByUserId) {
    const [creator] = await db
      .select({ userId: users.id, email: users.email, role: tenantUsers.role })
      .from(users)
      .leftJoin(
        tenantUsers,
        and(eq(tenantUsers.userId, users.id), eq(tenantUsers.tenantId, session.tenantId))
      )
      .where(eq(users.id, session.createdByUserId))
    if (creator) return { userId: creator.userId, email: creator.email, role: creator.role }
  }
  return { label: `Launch session ${session.shortId}` }
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Open (or find) the `session.merge` request for this landing (plan §1.12). */
async function openMergeApproval(
  scope: StepScope,
  session: SessionRow,
  landing: SessionLanding
): Promise<ApprovalRequestRow> {
  const [app] = await scope.db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, session.tenantId), eq(apps.id, session.appId)))
  if (!app) throw new Error('The session’s app no longer exists')
  const review = await reviewPolicyFor(scope.db, session.tenantId, app)
  const summary = sessionShipSummarySchema.safeParse(session.shipSummary)
  const ship = summary.success ? summary.data : null
  const deps: ApprovalDeps = {
    db: scope.db,
    env: scope.env,
    cfg: scope.cfg,
    logger: scope.logger,
    realtime: scope.realtime,
    now: scope.now,
  }
  const opened = await open(deps, {
    tenantId: session.tenantId,
    kind: 'session.merge',
    subject: { type: 'session', id: session.id },
    appId: session.appId,
    requester: await requesterOf(scope.db, session),
    reason: null,
    context: {
      kind: 'session.merge',
      sessionId: session.id,
      shortId: session.shortId,
      title: session.title,
      appSlug: app.slug,
      prNumber: landing.prNumber,
      prUrl: session.prUrl ?? '',
      prTitle: clip(ship?.title ?? session.title ?? `Session ${session.shortId}`, 200),
      summary: clip(ship?.body ?? '', 4000),
      diffStat: clip(ship?.diffStat ?? '', 6000),
      headSha: landing.gateSha,
      sessionPath: `/apps/${app.slug}/sessions/${session.id}`,
    },
    excludedUserIds: [
      ...new Set([
        ...(session.createdByUserId ? [session.createdByUserId] : []),
        ...(await messageWriters(scope.db, session)),
      ]),
    ],
    policy: review.policy ?? DEFAULT_APPROVAL_POLICIES['session.merge'],
  })
  return opened.request
}

/**
 * `land.review#N` (plan §1.11–§1.12): open the `session.merge` approval idempotently
 * (`landing.approvalId` first, then the pending-subject index — a request for another head is
 * cancelled, not reused), then read it: pending → `wait`, approved on this head → `merge`,
 * rejected / expired / cancelled → `reopen`.
 */
export async function landReviewStep(scope: StepScope): Promise<LandRound> {
  const session = await loadSession(scope)
  const landing = landingOf(session)
  if (session.status !== 'shipping' || landing?.stage !== 'approval') return { next: 'none' }
  await stamp(scope)
  const tenantId = session.tenantId
  let request = landing.approvalId
    ? await findApproval(scope.db, tenantId, { id: landing.approvalId })
    : null
  if (!request) {
    const pending = await findApproval(scope.db, tenantId, { sessionId: session.id })
    if (pending?.context.kind === 'session.merge' && pending.context.headSha !== landing.gateSha) {
      await cancelMergeApproval(scope.db, {
        tenantId,
        approvalId: pending.id,
        reason: 'The session shipped another head',
        now: scope.now(),
      })
    } else {
      request = pending
    }
  }
  const emit = emitterFor(scope)
  if (!request) request = await openMergeApproval(scope, session, landing)
  if (landing.approvalId !== request.id) {
    const recorded = await casLanding(
      scope,
      { statuses: ['shipping'], stages: ['approval'], gateSha: landing.gateSha },
      { approvalId: request.id }
    )
    if (!recorded) return { next: 'none' }
    await emit({
      type: 'ship.review',
      turn: session.turnCount,
      data: { status: 'requested', approvalId: request.id },
    })
  }

  const ofThisHead =
    request.context.kind === 'session.merge' && request.context.headSha === landing.gateSha
  switch (request.status) {
    case 'pending': {
      await releaseIfDue(scope, session, landing)
      return { next: 'wait', waitSeconds: LAND_APPROVAL_ROUND_SECONDS }
    }
    case 'approved': {
      if (!ofThisHead) {
        return reopen('review_rejected', {
          message:
            'The approval was for another head of the branch, so nothing was merged. Ship again.',
        })
      }
      // `applyInTx` moved the stage already; this covers a request approved before it was recorded.
      await casLanding(
        scope,
        { statuses: ['shipping'], stages: ['approval'], gateSha: landing.gateSha },
        { stage: 'merging', stageAt: scope.now().toISOString() }
      )
      return { next: 'merge' }
    }
    case 'rejected': {
      const by = await mergeDecider(scope.db, request, 'reject')
      await emit({
        type: 'ship.review',
        turn: session.turnCount,
        data: {
          status: 'rejected',
          approvalId: request.id,
          ...(by ? { by: by.name } : {}),
          ...(by?.comment ? { note: by.comment } : {}),
        },
      })
      return reopen('review_rejected', { by: by?.name, note: by?.comment ?? null })
    }
    case 'expired': {
      await emit({
        type: 'ship.review',
        turn: session.turnCount,
        data: { status: 'expired', approvalId: request.id },
      })
      return reopen('review_expired')
    }
    default: {
      await emit({
        type: 'ship.review',
        turn: session.turnCount,
        data: { status: 'cancelled', approvalId: request.id },
      })
      return reopen('review_rejected', {
        message: 'The review was cancelled, so nothing was merged. Ship again to ask again.',
      })
    }
  }
}

// ---- land.merge --------------------------------------------------------------------------------

/**
 * `land.merge#N` (plan §1.6): read first (a recorded or GitHub-side merge wins), check the head,
 * CI and the approval again, squash on the gate SHA, then one CAS `shipping → shipped` / stage
 * `releasing`. Answers `release`, `reopen`, or `none` (the row moved), never `wait`.
 */
export async function landMergeStep(
  scope: StepScope
): Promise<Extract<LandRound, { next: 'release' | 'reopen' | 'none' }>> {
  const session = await loadSession(scope)
  const landing = landingOf(session)
  if (session.status === 'shipped' && landing?.mergeSha) {
    return { next: 'release', mergeSha: landing.mergeSha }
  }
  if (session.status !== 'shipping' || landing?.stage !== 'merging') return { next: 'none' }
  await stamp(scope)
  if (landing.mergeSha) return { next: 'release', mergeSha: landing.mergeSha }
  const repo = await sessionRepo(scope.db, session)
  const host = scope.ports.repoHost(scope.db)
  const pr = await host.getPullRequest(repo, landing.prNumber)
  if (pr?.merged) {
    const sha = await recordMerge(scope, session, landing, mergeOf(pr, scope), 'session.merge')
    return sha ? { next: 'release', mergeSha: sha } : { next: 'none' }
  }
  if (!pr || pr.state === 'closed') return reopen('pr_closed', { prNumber: landing.prNumber })
  if (pr.headSha !== landing.gateSha) return reopen('head_moved', { gateSha: landing.gateSha })
  if (sinceMs(scope, landing.stageAt) >= LAND_MERGE_MAX_MINUTES * 60_000) {
    return reopen('merge_refused', {
      message: `Launch could not merge it within ${LAND_MERGE_MAX_MINUTES} minutes`,
    })
  }
  const checks = await host.getChecks(repo, {
    prNumber: landing.prNumber,
    headSha: landing.gateSha,
  })
  if (requiredCheckState(checks.checks) !== 'success') {
    return {
      next: 'reopen',
      reason: 'ci_failed',
      message: 'CI is no longer green on the pull request, so nothing was merged. Ship again.',
    }
  }
  let approvedBy: string | null = null
  if (landing.reviewMode !== 'none') {
    const approval = landing.approvalId
      ? await findApproval(scope.db, session.tenantId, { id: landing.approvalId })
      : null
    const covers =
      approval?.status === 'approved' &&
      approval.context.kind === 'session.merge' &&
      approval.context.headSha === landing.gateSha
    if (!approval || !covers) {
      return reopen('review_rejected', {
        message: 'The merge has no approval for this head, so nothing was merged. Ship again.',
      })
    }
    approvedBy = (await mergeDecider(scope.db, approval, 'approve'))?.name ?? null
  }

  const summary = sessionShipSummarySchema.safeParse(session.shipSummary)
  const title =
    (summary.success ? summary.data.title : '') || pr.title || session.title || 'Launch session'
  const body = summary.success ? summary.data.body.trim() : ''
  const signature = `Merged by Launch from session ${session.shortId}${approvedBy ? `, approved by ${approvedBy}` : ''}.`
  const merged = await host.mergePullRequest(repo, {
    prNumber: landing.prNumber,
    sha: landing.gateSha,
    commitTitle: `${title} (#${landing.prNumber})`,
    commitMessage: body ? `${body}\n\n${signature}` : signature,
  })
  if (!merged.merged) {
    // A merge already in flight when this round began — an earlier instance's squash, killed
    // after GitHub took it (the reconcile restarts a landing in `merging`) — is refused as "not
    // mergeable": read the PR once more before calling it refused, so it is recorded, not reopened.
    const after = await host.getPullRequest(repo, landing.prNumber).catch(() => null)
    if (after?.merged) {
      const sha = await recordMerge(scope, session, landing, mergeOf(after, scope), 'session.merge')
      return sha ? { next: 'release', mergeSha: sha } : { next: 'none' }
    }
    if (merged.code === 'head_moved') return reopen('head_moved', { gateSha: landing.gateSha })
    await recordAudit(scope.db, {
      ...SYSTEM_ACTOR,
      tenantId: session.tenantId,
      action: 'session.merge_refused',
      targetType: 'session',
      targetId: session.id,
      appId: session.appId,
      approvalId: landing.approvalId,
      summary: {
        after: {
          prNumber: landing.prNumber,
          gateSha: landing.gateSha,
          message: safeErrorMessage(merged.message, 'GitHub refused the merge'),
        },
      },
    })
    return reopen('merge_refused', { message: safeErrorMessage(merged.message, '', 400) })
  }
  const sha = await recordMerge(
    scope,
    session,
    landing,
    { sha: merged.sha, mergedAt: scope.now().toISOString(), title, url: pr.url },
    'session.merge'
  )
  return sha ? { next: 'release', mergeSha: sha } : { next: 'none' }
}

// ---- land.reopen -------------------------------------------------------------------------------

/**
 * `land.reopen#N` (plan §1.7): `shipping → ready` while the container is still the loop's
 * (`bootId`'s boot marker, and not released), else `shipping → suspended` (the next message
 * resumes); `landing := null`, a pending review cancelled, events `ship.reopened` + `error`, audit
 * `session.ship_reopened`. Null when the row was no longer `shipping` (another instance settled it).
 */
export async function landReopenStep(
  scope: StepScope,
  input: { reason: ShipReopenReason; message: string; bootId: string | null }
): Promise<{ status: 'ready' | 'suspended' } | null> {
  const session = await loadSession(scope)
  if (session.status !== 'shipping') return null
  const landing = landingOf(session)
  const sandbox = sandboxFor(scope, session)
  const ours =
    landing !== null &&
    !landing.containerReleased &&
    input.bootId !== null &&
    (await checkContainer(sandbox, input.bootId, limitsOf(scope).controlMs)) === 'ours'
  const to = ours ? 'ready' : 'suspended'
  const now = scope.now()
  const row = await transition(scope, ['shipping'], to, {
    landing: null,
    lastActivityAt: now,
    cancelRequestedAt: null,
    ...(to === 'suspended' ? { suspendedAt: now, containerKeptAt: null } : {}),
  })
  if (!row) return null
  if (!ours && !landing?.containerReleased) {
    // Not the loop's container (or nobody can tell): nothing in it is unsaved — the gate SHA is
    // on the branch — so it goes, and the next message resumes from the branch.
    await sandbox.destroy().catch(err => {
      scope.logger.warn({ err }, 'session landing: could not destroy the container')
    })
  }
  if (landing?.approvalId) {
    await cancelMergeApproval(scope.db, {
      tenantId: session.tenantId,
      approvalId: landing.approvalId,
      reason: 'The session was given back',
      now,
    })
  }
  await emitterFor(scope)([
    {
      type: 'ship.reopened',
      turn: row.turnCount,
      data: { reason: input.reason, message: input.message },
    },
    { type: 'error', turn: row.turnCount, data: { message: input.message } },
  ])
  await recordAudit(scope.db, {
    ...SYSTEM_ACTOR,
    tenantId: session.tenantId,
    action: 'session.ship_reopened',
    targetType: 'session',
    targetId: session.id,
    appId: session.appId,
    approvalId: landing?.approvalId ?? null,
    summary: {
      after: {
        reason: input.reason,
        status: to,
        prNumber: landing?.prNumber ?? session.prNumber,
        gateSha: landing?.gateSha ?? null,
      },
    },
  })
  return { status: to }
}

// ---- Phase B -----------------------------------------------------------------------------------

/** A Phase B step found nothing to do: the landing is no longer moving (another instance ended it). */
export type LandDone = { status: 'done' }

async function phaseB(
  scope: StepScope
): Promise<{ session: SessionRow; landing: SessionLanding } | null> {
  const session = await loadSession(scope)
  const landing = landingOf(session)
  if (session.status !== 'shipped' || !landing) return null
  if (landing.stage !== 'releasing' && landing.stage !== 'deploying') return null
  return { session, landing }
}

/**
 * `land.main-ci#K.R`'s answer (issue #11): `ready` — cut the release now; `wait` — read again after
 * `waitSeconds` (`land.main-ci-wait#K.R`); `stalled` — the merge commit's `Gate` is red.
 */
export type LandMainCiResult =
  | { status: 'ready'; verdict: ShipMainCiVerdict | 'skipped' }
  | { status: 'wait'; waitSeconds: number }
  | { status: 'stalled'; reason: 'main_ci_failed'; error: string }

/**
 * `land.main-ci#K.R` (issue #11): the squash commit's checks on the default branch, read fresh —
 * decided like `land.ci` on the required `Gate` (`requiredCheckState`) — before `land.release`
 * cuts the release whose `release: X.Y.Z` bump is that commit's child. The kit's `deploy.yml`
 * skips the tag's gate only when the bump's parent already has a COMPLETED green `CI` run, so a
 * release cut while it still runs pays for a second gate. Green → `ready` (`success`); red →
 * `stalled` `main_ci_failed` (the change is merged, nothing is released); nothing reported after
 * {@link SHIP_MAIN_CI_NONE_GRACE_MINUTES} (no CI on a push to main) → `ready` (`none`); still
 * pending after {@link SHIP_MAIN_CI_MAX_MINUTES} → `ready` (`timeout`: the deploy re-gates, as
 * before issue #11); else wait a round (30 s for the first 10 minutes, then 2). Bounds are judged
 * from `landing.stageAt` (reaching `releasing`), so a replayed step cannot reset them, and a
 * GitHub that does not answer past the cap is a `timeout` too. A `ready` verdict is recorded on
 * `landing.mainCi` (one compare-and-set), so a later round or a fresh instance goes straight on;
 * a landing already past `releasing`, already holding a release, or with no merge SHA is `skipped`.
 */
export async function landMainCiStep(scope: StepScope): Promise<LandMainCiResult | LandDone> {
  const found = await phaseB(scope)
  if (!found) return { status: 'done' }
  const { session, landing } = found
  if (landing.stage !== 'releasing' || landing.releaseId || !landing.mergeSha) {
    return { status: 'ready', verdict: 'skipped' }
  }
  if (landing.mainCi) return { status: 'ready', verdict: landing.mainCi.verdict }
  await stamp(scope)
  const sha = landing.mergeSha
  const elapsedMs = sinceMs(scope, landing.stageAt)
  const record = async (verdict: ShipMainCiVerdict): Promise<LandMainCiResult> => {
    await casLanding(
      scope,
      { statuses: ['shipped'], stages: ['releasing'] },
      { mainCi: { verdict, sha, at: scope.now().toISOString() } },
      { lastActivityAt: scope.now() }
    )
    scope.logger.info({ sessionId: session.id, sha, verdict }, 'session landing: main CI read')
    return { status: 'ready', verdict }
  }

  const repo = await sessionRepo(scope.db, session)
  const host = scope.ports.repoHost(scope.db)
  let checks: PrChecks
  try {
    checks = await host.getChecks(repo, { prNumber: landing.prNumber, headSha: sha })
  } catch (err) {
    // GitHub not answering must not hold the release past the cap: the deploy re-gates.
    if (elapsedMs >= SHIP_MAIN_CI_MAX_MINUTES * 60_000) return record('timeout')
    throw err
  }
  const state = requiredCheckState(checks.checks)
  if (state === 'success') return record('success')
  if (state === 'failure') {
    const failed = await host.failedCheckLog(repo, { headSha: sha }).catch(err => {
      scope.logger.warn({ err }, 'session landing: could not read the failed main check')
      return null
    })
    const check = failed?.name ? ` (${failed.name})` : ''
    // Issue #21: a job GitHub never ran (no runner picked it up) is not the change's fault.
    const error = infrastructureFailure(failed)
      ? `GitHub did not run the default branch's CI${check} for the merge commit ${short(sha)} — the job never started on a runner — so Launch did not cut a release. Retry re-runs it`
      : `CI failed on the default branch${check} for the merge commit ${short(sha)}, so Launch did not cut a release`
    return { status: 'stalled', reason: 'main_ci_failed', error }
  }
  if (state === 'none' && elapsedMs >= SHIP_MAIN_CI_NONE_GRACE_MINUTES * 60_000) {
    return record('none')
  }
  if (elapsedMs >= SHIP_MAIN_CI_MAX_MINUTES * 60_000) return record('timeout')
  const waitSeconds =
    elapsedMs < LAND_CI_FAST_WINDOW_MINUTES * 60_000 ? LAND_CI_FAST_SECONDS : LAND_CI_SLOW_SECONDS
  return { status: 'wait', waitSeconds }
}

/**
 * What GitHub's runners say when a job never ran — Actions' own words, matched loosely. A job that
 * waited for a hosted runner and never got one ends `failure` with only this as its annotation.
 */
const INFRASTRUCTURE_FAILURE_RE =
  /not acquired by runner|was not acquired|lost communication with the server|no runner|runner .*(?:shut down|offline)|startup failure/i

/**
 * Issue #21: whether a failed check failed before the change was ever tested — GitHub's
 * `startup_failure` / `cancelled` conclusion, or a log (annotations) saying no runner took the job.
 * A check with no log at all says nothing either way: false. Pure.
 */
export function infrastructureFailure(
  failed: Pick<FailedCheckLog, 'conclusion' | 'logTail'> | null | undefined
): boolean {
  if (!failed) return false
  if (failed.conclusion === 'startup_failure' || failed.conclusion === 'cancelled') return true
  return Boolean(failed.logTail && INFRASTRUCTURE_FAILURE_RE.test(failed.logTail))
}

/** `land.release#K.R`: the `landRelease` hook (S3), or the release the landing already holds. */
export async function landReleaseStep(scope: StepScope): Promise<LandReleaseResult | LandDone> {
  const found = await phaseB(scope)
  if (!found) return { status: 'done' }
  const { session, landing } = found
  if (landing.stage === 'deploying' && landing.releaseId && landing.version && landing.tag) {
    return {
      status: 'released',
      releaseId: landing.releaseId,
      version: landing.version,
      tag: landing.tag,
      shared: false,
    }
  }
  await stamp(scope)
  return scope.hooks.landRelease(hookContext(scope, session, session.turnCount))
}

/** `land.staging#K.R`: the `landStaging` hook (S3). */
export async function landStagingStep(scope: StepScope): Promise<LandStagingResult | LandDone> {
  const found = await phaseB(scope)
  if (!found) return { status: 'done' }
  await stamp(scope)
  return scope.hooks.landStaging(hookContext(scope, found.session, found.session.turnCount))
}

/** `land.health#K.R`: the `landHealth` hook (S3). */
export async function landHealthStep(scope: StepScope): Promise<LandHealthResult | LandDone> {
  const found = await phaseB(scope)
  if (!found) return { status: 'done' }
  await stamp(scope)
  return scope.hooks.landHealth(hookContext(scope, found.session, found.session.turnCount))
}

/**
 * `land.live#K` (plan §1.9): stage `live` with `stagingUrl` and the version,
 * `ship.staging {status:'live'}`, audit `session.landed`.
 */
export async function landLiveStep(
  scope: StepScope,
  input: { url: string | null; version: string }
): Promise<void> {
  const session = await loadSession(scope)
  const landing = landingOf(session)
  if (!landing) return
  const row = await casLanding(
    scope,
    { statuses: ['shipped'], stages: ['releasing', 'deploying'] },
    {
      stage: 'live',
      stageAt: scope.now().toISOString(),
      stagingUrl: input.url,
      version: input.version,
      error: null,
    },
    { lastActivityAt: scope.now() }
  )
  if (!row) return
  await emitterFor(scope)({
    type: 'ship.staging',
    turn: row.turnCount,
    data: { status: 'live', version: input.version, url: input.url },
  })
  await recordAudit(scope.db, {
    ...SYSTEM_ACTOR,
    tenantId: session.tenantId,
    action: 'session.landed',
    targetType: 'session',
    targetId: session.id,
    appId: session.appId,
    summary: {
      after: {
        prNumber: landing.prNumber,
        mergeSha: landing.mergeSha,
        releaseId: landing.releaseId,
        version: input.version,
        tag: landing.tag,
        url: input.url,
      },
    },
  })
}

const STALLED_STAGING_STATUS: Record<
  Exclude<ShipStalledReason, 'release_failed' | 'main_ci_failed'>,
  'failed' | 'timeout' | 'unhealthy'
> = { deploy_failed: 'failed', deploy_timeout: 'timeout', unhealthy: 'unhealthy' }

/**
 * `land.stalled#K` (decision §0.1): stage `stalled` with the reason and a sentence linking the app
 * page; the session stays `shipped`, never reopens.
 */
export async function landStalledStep(
  scope: StepScope,
  input: { reason: ShipStalledReason; error: string }
): Promise<void> {
  const session = await loadSession(scope)
  const landing = landingOf(session)
  if (!landing) return
  const [app] = await scope.db
    .select({ slug: apps.slug })
    .from(apps)
    .where(and(eq(apps.tenantId, session.tenantId), eq(apps.id, session.appId)))
  const detail = safeErrorMessage(input.error, 'The release did not reach staging', 600)
  // Issue #21: nothing was released yet — the session's own Retry moves it on.
  const retry = (RETRYABLE_STALLED_REASONS as readonly string[]).includes(input.reason)
    ? ' Retry from the session, or open'
    : ' Open'
  const where = app
    ? `${retry} the app page (/apps/${app.slug}) to release or deploy it by hand.`
    : ''
  const sentence = `${detail.replace(/\.?$/, '.')} The change is merged.${where}`
  const row = await casLanding(
    scope,
    { statuses: ['shipped'], stages: ['releasing', 'deploying'] },
    {
      stage: 'stalled',
      stageAt: scope.now().toISOString(),
      stalledReason: input.reason,
      error: sentence,
    },
    { lastActivityAt: scope.now() }
  )
  if (!row) return
  const emit = emitterFor(scope)
  // Nothing was released (`release_failed`, `main_ci_failed`): no staging row to speak of.
  if (input.reason !== 'release_failed' && input.reason !== 'main_ci_failed') {
    await emit({
      type: 'ship.staging',
      turn: row.turnCount,
      data: {
        status: STALLED_STAGING_STATUS[input.reason],
        version: landing.version ?? '',
        url: landing.stagingUrl,
        error: detail,
      },
    })
  }
  await emit({ type: 'error', turn: row.turnCount, data: { message: sentence } })
  await recordAudit(scope.db, {
    ...SYSTEM_ACTOR,
    tenantId: session.tenantId,
    action: 'session.land_stalled',
    targetType: 'session',
    targetId: session.id,
    appId: session.appId,
    summary: {
      after: {
        reason: input.reason,
        prNumber: landing.prNumber,
        mergeSha: landing.mergeSha,
        releaseId: landing.releaseId,
        version: landing.version,
        error: detail,
      },
    },
  })
}

// ---- the safety net ----------------------------------------------------------------------------

const LIVE_INSTANCE = new Set(['queued', 'running', 'waiting', 'waitingForPause', 'paused'])

/** Whether a landing has been quiet for three of its stage's rounds (stage AND activity). */
export function landingQuiet(
  row: Pick<SessionRow, 'landing' | 'lastActivityAt' | 'updatedAt'>,
  now: Date
): boolean {
  const landing = landingOf(row)
  if (!landing) return false
  const round = LAND_ROUND_SECONDS[landing.stage as keyof typeof LAND_ROUND_SECONDS]
  if (round === undefined) return false
  const cutoff = now.getTime() - LAND_NUDGE_ROUNDS * round * 1000
  const active = (row.lastActivityAt ?? row.updatedAt).getTime()
  return Date.parse(landing.stageAt) < cutoff && active < cutoff
}

/**
 * Move a landing's Workflow on: wake its instance while it is alive, else start a fresh one
 * (`<id>-rN`, `restartSessionInstance`) — a finished instance takes no more events, so a landing
 * whose instance ended (a lost one, or a session shipped before issue #5 whose hand merge the cron
 * adopted, `land-adopt.ts`) needs a new one, whose `claim` resumes it where `landing.stage` says.
 * `woken` / `restarted`, or null when the instance's status could not be read (the next pass tries
 * again). Throws when a restart fails.
 */
export async function wakeOrRestartLanding(
  db: Database,
  workflow: Workflow,
  row: SessionRow,
  logger: WarnLogger
): Promise<'woken' | 'restarted' | null> {
  let status: string | null
  try {
    status = (await (await workflow.get(row.instanceId ?? row.id)).status()).status
  } catch (err) {
    status = isMissingInstanceError(err) ? 'not found' : null
  }
  if (status === null) return null
  if (LIVE_INSTANCE.has(status) && (await wakeSession(workflow, row, logger))) return 'woken'
  await restartSessionInstance(db, workflow, row)
  logger.warn(
    { sessionId: row.id, instanceStatus: status },
    'sessions.checks: restarted a landing whose Workflow was gone'
  )
  return 'restarted'
}

/**
 * The `sessions.checks` cron's safety net (plan §1.4): wake every `shipping`/`shipped` session
 * whose landing is in a moving stage (`MOVING_LANDING_STAGES`) and quiet for three of its rounds —
 * or restart its instance when that is gone or finished (`<id>-rN`; `claim` resumes the landing).
 * Cross-tenant like the rest of that cron, one tenant at a time and tenant-first (`tenantIds`
 * narrows it, for tests). Returns how many it woke or restarted.
 */
export async function nudgeLandingSessions(
  db: Database,
  env: AppBindings,
  logger: Logger,
  now: Date,
  opts: { tenantIds?: string[]; limitPerTenant?: number } = {}
): Promise<number> {
  const workflow = (env as { SESSION_WORKFLOW?: Workflow }).SESSION_WORKFLOW
  if (!workflow) return 0
  const tenantIds =
    opts.tenantIds ?? (await db.select({ id: tenants.id }).from(tenants)).map(t => t.id)
  let nudged = 0
  for (const tenantId of tenantIds) {
    const rows = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          inArray(sessions.status, ['shipping', 'shipped']),
          inArray(sql<string>`${sessions.landing}->>'stage'`, [...MOVING_LANDING_STAGES])
        )
      )
      .limit(opts.limitPerTenant ?? 100)
    for (const row of rows) {
      if (!landingQuiet(row, now)) continue
      try {
        if (await wakeOrRestartLanding(db, workflow, row, logger)) nudged++
      } catch (err) {
        logger.warn({ err, sessionId: row.id }, 'sessions.checks: could not nudge a landing')
      }
    }
  }
  return nudged
}
