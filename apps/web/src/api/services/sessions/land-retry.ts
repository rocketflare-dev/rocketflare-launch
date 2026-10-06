/**
 * Retrying a stalled landing from the session (issue #21, CONCEPTS §18.13) — `POST
 * /api/sessions/:id/landing/retry`. After the merge a landing never reopens (decision §0.1); the
 * two stalls that released NOTHING (`RETRYABLE_STALLED_REASONS`) can safely go round again:
 *
 * - **`main_ci_failed`, `retry`**: the merge commit's failed Actions runs are re-run first
 *   (`RepoHostPort.rerunFailedRuns` — GitHub's "Re-run failed jobs"; a run already going again
 *   counts), then the landing goes back to `releasing` with `mainCi` cleared, so `land.main-ci`
 *   waits for the new attempt from scratch (its bounds run from the new `stageAt`). Nothing on the
 *   commit to re-run → 409 `landing_nothing_to_rerun` (Release anyway, or the app page).
 * - **`main_ci_failed`, `release_anyway`**: back to `releasing` with `mainCi.verdict = 'override'`
 *   — `land.main-ci` goes straight on, and the tag's deploy runs the full gate itself.
 * - **`release_failed`, `retry`**: back to `releasing`; `land.release` runs again (its claim bound
 *   from the new `stageAt`).
 *
 * The move is ONE compare-and-set on `status = 'shipped'`, stage `stalled` and the same
 * `stalledReason`, so a double press retries once: the loser finds the landing already moving and
 * answers it as it is. Then the Workflow is woken or restarted (`wakeOrRestartLanding`; the stalled
 * instance has finished, so a fresh one — whose `claim` routes `shipped` + `releasing` to Phase B).
 * A restart that fails is the safety net's (`nudgeLandingSessions` restarts a quiet `releasing`
 * landing). Audited `session.land_retried`. Every query names the tenant.
 */
import {
  type LandingRetryRequest,
  landingRetryable,
  MOVING_LANDING_STAGES,
} from '@launch/shared/launch-sessions'
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type SessionRow, sessions } from '../../../db/schema'
import { ConflictError } from '../../utils/core/errors'
import { type AuditActor, recordAudit } from '../launch/audit'
import type { WarnLogger } from './chat'
import { wakeOrRestartLanding } from './land'
import type { RepoHostPort, RerunFailedRunsResult } from './ports'
import { sessionRepo } from './ship'
import { landingOf } from './steps'

export interface RetryLandingInput {
  db: Database
  workflow: Workflow
  repoHost: RepoHostPort
  row: SessionRow
  action: LandingRetryRequest['action']
  actor: AuditActor
  logger: WarnLogger
  now?: Date
}

export interface RetryLandingOutcome {
  row: SessionRow
  /** False when another press had already moved the landing on (nothing done here). */
  retried: boolean
}

function notRetryable(message: string): ConflictError {
  return new ConflictError(message, 'landing_not_retryable')
}

export async function retryLanding(input: RetryLandingInput): Promise<RetryLandingOutcome> {
  const { db, row, action } = input
  const now = input.now ?? new Date()
  const landing = landingOf(row)
  if (row.status !== 'shipped' || !landing || !landingRetryable(landing)) {
    // A second press: the first already moved it on.
    if (
      row.status === 'shipped' &&
      landing &&
      (MOVING_LANDING_STAGES as readonly string[]).includes(landing.stage)
    ) {
      return { row, retried: false }
    }
    throw notRetryable('Only a landing that stalled before its release can be retried')
  }
  const reason = landing.stalledReason
  if (action === 'release_anyway' && reason !== 'main_ci_failed') {
    throw notRetryable('Release anyway is only for a merge whose default-branch CI failed')
  }

  let rerun: RerunFailedRunsResult | null = null
  if (reason === 'main_ci_failed' && action === 'retry') {
    if (!landing.mergeSha) throw notRetryable('This landing recorded no merge commit to re-run')
    rerun = await input.repoHost.rerunFailedRuns(await sessionRepo(db, row), {
      headSha: landing.mergeSha,
    })
    if (rerun.rerun.length === 0 && rerun.running.length === 0) {
      throw new ConflictError(
        'The merge commit has no failed GitHub Actions run to re-run. Release anyway, or release it from the app page.',
        'landing_nothing_to_rerun'
      )
    }
  }

  const stamp = now.toISOString()
  const patch = {
    stage: 'releasing',
    stageAt: stamp,
    stalledReason: null,
    error: null,
    ...(reason === 'main_ci_failed'
      ? {
          mainCi:
            action === 'release_anyway'
              ? { verdict: 'override', sha: landing.mergeSha ?? landing.gateSha, at: stamp }
              : null,
        }
      : {}),
  }
  const [moved] = await db
    .update(sessions)
    .set({
      landing: sql`${sessions.landing} || ${JSON.stringify(patch)}::jsonb`,
      lastActivityAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessions.tenantId, row.tenantId),
        eq(sessions.id, row.id),
        eq(sessions.status, 'shipped'),
        sql`${sessions.landing}->>'stage' = 'stalled'`,
        sql`${sessions.landing}->>'stalledReason' = ${reason}`
      )
    )
    .returning()
  if (!moved) {
    const [current] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
    if (current) return { row: current, retried: false }
    throw notRetryable('The session is gone')
  }

  await recordAudit(db, {
    ...input.actor,
    tenantId: row.tenantId,
    action: 'session.land_retried',
    targetType: 'session',
    targetId: row.id,
    appId: row.appId,
    summary: {
      before: { stage: 'stalled', stalledReason: reason },
      after: {
        stage: 'releasing',
        action,
        prNumber: landing.prNumber,
        mergeSha: landing.mergeSha,
        ...(rerun ? { rerunRuns: rerun.rerun, runningRuns: rerun.running } : {}),
      },
    },
  })

  let current = moved
  try {
    await wakeOrRestartLanding(db, input.workflow, moved, input.logger)
    const [after] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
    current = after ?? moved
  } catch (err) {
    // The safety net restarts a quiet `releasing` landing.
    input.logger.warn({ err, sessionId: row.id }, 'session landing: retry could not start Phase B')
  }
  return { row: current, retried: true }
}
