/**
 * `approvals.sweep` — the five-minute cron task (Launch P4, plan §1.3): expire pending requests
 * past `expires_at` (the kind's `onClosed`, `approval_expired` to the requester), then retry the
 * owed `applyAfter` of approved requests (`applied_at IS NULL AND apply_attempts < 5`), auditing
 * `approval.apply_failed` and notifying when the fifth attempt fails. Slice 4b fills `run`.
 *
 * Cross-tenant by design, like every cron (allow-listed in `unscoped-allowlist.test.ts`): the two
 * scans below read every tenant's due rows, and every write after them names the row's own
 * `tenant_id`. The scans are the real queries 4b builds on — keep them (or the allow-list entry
 * goes stale and its test fails).
 */
import { APPROVAL_MAX_APPLY_ATTEMPTS } from '@launch/shared/launch-approvals'
import { and, asc, eq, isNotNull, isNull, lt, lte } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type ApprovalRequestRow, approvalRequests } from '../../../db/schema'
import type { ScheduledTask } from '../../scheduled'

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

/** Registered on `*` + `/5` in `api/scheduled.ts`. A no-op until slice 4b. */
export const approvalsSweep: ScheduledTask = {
  name: 'approvals.sweep',
  async run({ logger }) {
    logger.debug('approvals.sweep: not wired yet (P4 slice 4b)')
  },
}
