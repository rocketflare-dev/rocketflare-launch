/**
 * `approvals.sweep` — the five-minute cron task (Launch P4, plan §1.3): expire pending requests
 * past `expires_at` (`engine.expire`: the kind's `onClosed`, `approval_expired` to the requester),
 * then retry the owed `applyAfter` of approved requests (`applied_at IS NULL AND apply_attempts <
 * 5`, `engine.retryApply`), which audits `approval.apply_failed` and notifies when the fifth attempt
 * fails. A retry is skipped while the row was touched within `APPLY_RETRY_BACKOFF_MS` (a first
 * attempt still running, or another sweep's claim) — and the claim re-checks that in the database,
 * so two overlapping sweeps never run one effect twice at once.
 *
 * Cross-tenant by design, like every cron (allow-listed in `unscoped-allowlist.test.ts`): the two
 * scans below read every tenant's due rows, and every write after them (all in `engine.ts`) names
 * the row's own `tenant_id`. One row failing is logged and never stops the rest.
 */
import { APPROVAL_MAX_APPLY_ATTEMPTS } from '@launch/shared/launch-approvals'
import { and, asc, eq, isNotNull, isNull, lt, lte } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type ApprovalRequestRow, approvalRequests } from '../../../db/schema'
import type { ScheduledTask } from '../../scheduled'
import { APPLY_RETRY_BACKOFF_MS, expire, retryApply } from './engine'
import type { ApprovalDeps } from './types'

/** Rows handled per sweep and per pass; the rest wait five minutes. */
export const SWEEP_BATCH = 200

/** Pending requests whose `expires_at` has passed, oldest deadline first, across every tenant. */
export async function dueForExpiry(
  db: Database,
  now: Date,
  limit = SWEEP_BATCH
): Promise<ApprovalRequestRow[]> {
  return db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.status, 'pending'),
        isNotNull(approvalRequests.expiresAt),
        lte(approvalRequests.expiresAt, now)
      )
    )
    .orderBy(asc(approvalRequests.expiresAt))
    .limit(limit)
}

/** Approved requests whose `applyAfter` is still owed and has attempts left, across every tenant. */
export async function dueForApplyRetry(
  db: Database,
  limit = SWEEP_BATCH
): Promise<ApprovalRequestRow[]> {
  return db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.status, 'approved'),
        isNull(approvalRequests.appliedAt),
        lt(approvalRequests.applyAttempts, APPROVAL_MAX_APPLY_ATTEMPTS)
      )
    )
    .orderBy(asc(approvalRequests.decidedAt))
    .limit(limit)
}

export interface SweepReport {
  expired: number
  applied: number
  failed: number
  gaveUp: number
  errors: number
}

/** One pass: expiries first (a request that expires is never applied), then the owed effects. */
export async function sweepApprovals(deps: ApprovalDeps): Promise<SweepReport> {
  const now = deps.now?.() ?? new Date()
  const report: SweepReport = { expired: 0, applied: 0, failed: 0, gaveUp: 0, errors: 0 }
  for (const row of await dueForExpiry(deps.db, now)) {
    try {
      if (await expire(deps, { tenantId: row.tenantId, requestId: row.id })) report.expired++
    } catch (err) {
      report.errors++
      deps.logger.error({ err, approvalId: row.id }, 'approvals.sweep: expire failed')
    }
  }
  const quietSince = now.getTime() - APPLY_RETRY_BACKOFF_MS
  for (const row of await dueForApplyRetry(deps.db)) {
    if (row.updatedAt.getTime() > quietSince) continue
    try {
      const outcome = await retryApply(deps, { tenantId: row.tenantId, requestId: row.id })
      if (outcome === 'applied') report.applied++
      else if (outcome === 'failed') report.failed++
      else if (outcome === 'gave_up') report.gaveUp++
    } catch (err) {
      report.errors++
      deps.logger.error({ err, approvalId: row.id }, 'approvals.sweep: retry failed')
    }
  }
  return report
}

/** Registered on `*` + `/5` in `api/scheduled.ts`. Nudges go out through the cron's `waitUntil`. */
export const approvalsSweep: ScheduledTask = {
  name: 'approvals.sweep',
  async run({ db, env, config, logger, waitUntil }) {
    const report = await sweepApprovals({
      db,
      env,
      cfg: config,
      logger,
      realtime: {
        env,
        defer: fn =>
          waitUntil(fn().catch(err => logger.warn({ err }, 'approvals.sweep: a nudge failed'))),
      },
    })
    if (report.expired + report.applied + report.failed + report.gaveUp + report.errors > 0) {
      logger.info(report, 'approvals.sweep')
    }
  },
}
