/**
 * `session.merge` (issue #5, `docs/plans/i5-ship-to-staging.md` §1.11–§1.12): a coding session's
 * PR passed CI and waits for a person in Launch before it merges. The subject is the session and
 * the requester its CREATOR; `land.review#N` (`services/sessions/land.ts`) opens it idempotently
 * with the app's review policy (`reviewPolicyFor`, passed as `OpenApprovalInput.policy`) and
 * excludes everyone who wrote a `user.message` in the session, plus the creator.
 *
 * - `defaultPolicy` / `describe`: the engine and the policy page read them.
 * - `applyInTx`: compare-and-set the landing `approval → merging` — only for the session still
 *   `shipping`, in `approval`, on THIS request and the head it approved — and say so on the
 *   session (`ship.review { approved }`), inside the decide transaction. A session that moved on
 *   (reopened, ended) is left alone: `land.merge` re-checks the approval before it merges anything.
 * - `applyAfter` / `onClosed`: `wakeOrRestart` the session while its landing still waits on this
 *   request, so `land.merge#N` runs (approved) or `land.review#N` reads the rejection, expiry or
 *   cancellation and reopens the session (`review_rejected` / `review_expired`, the decision's
 *   comment as the note). Both are safe to repeat.
 *
 * `cancelMergeApproval` is the system's own cancel — an End during `approval`, a reopen, a PR merged
 * by hand: `pending → cancelled`, audited `approval.cancelled` as the system, no `onClosed` (the
 * caller is the one moving the session).
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { sessionLandingSchema } from '@launch/shared/launch-sessions'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import {
  type ApprovalRequestRow,
  approvalDecisions,
  approvalRequests,
  type SessionRow,
  sessions,
  users,
} from '../../../../db/schema'
import { recordAudit, SYSTEM_ACTOR } from '../../launch/audit'
import { createSessionEmitter, nudgeSession } from '../../sessions/events'
import { wakeOrRestart } from '../../sessions/lifecycle'
import type { ApprovalDeps, KindHandler } from '../types'

const sessionIdOf = (request: ApprovalRequestRow) =>
  request.context.kind === 'session.merge' ? request.context.sessionId : request.subjectId

async function loadSession(db: Database, tenantId: string, sessionId: string) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)))
  return row ?? null
}

/** Whether `row`'s landing is still waiting on `request` (shipping, `approval`, this request). */
function waitsOn(row: SessionRow | null, request: ApprovalRequestRow): row is SessionRow {
  if (!row || row.status !== 'shipping') return false
  const landing = sessionLandingSchema.safeParse(row.landing)
  if (!landing.success) return false
  return landing.data.approvalId === request.id && landing.data.stage === 'approval'
}

/**
 * Who decided `request` with `decision`, by name (the latest such decision), with their comment —
 * what `ship.review` and the squash message say. Null when nobody did (an expiry, a cancel).
 */
export async function mergeDecider(
  db: Database,
  request: Pick<ApprovalRequestRow, 'id' | 'tenantId'>,
  decision: 'approve' | 'reject'
): Promise<{ name: string; comment: string | null } | null> {
  const [row] = await db
    .select({
      name: users.name,
      email: approvalDecisions.userEmail,
      comment: approvalDecisions.comment,
    })
    .from(approvalDecisions)
    .leftJoin(users, eq(users.id, approvalDecisions.userId))
    .where(
      and(
        eq(approvalDecisions.tenantId, request.tenantId),
        eq(approvalDecisions.requestId, request.id),
        eq(approvalDecisions.decision, decision)
      )
    )
    .orderBy(desc(approvalDecisions.at))
    .limit(1)
  if (!row) return null
  return { name: row.name?.trim() || row.email, comment: row.comment }
}

/** Wake the session's Workflow when its landing still waits on `request`. */
async function wakeWaiting(request: ApprovalRequestRow, deps: ApprovalDeps): Promise<void> {
  const row = await loadSession(deps.db, request.tenantId, sessionIdOf(request))
  if (!row || row.status !== 'shipping') return
  const workflow = (deps.env as { SESSION_WORKFLOW?: Workflow }).SESSION_WORKFLOW
  if (!workflow) return
  const woken = await wakeOrRestart(deps.db, workflow, row, deps.logger)
  nudgeSession(deps.realtime, woken)
}

/**
 * The system's cancel of a pending `session.merge` request (see the header). True when this call
 * cancelled it; false when it was not pending (decided, expired, cancelled already) or not found.
 */
export async function cancelMergeApproval(
  db: Database,
  input: { tenantId: string; approvalId: string; reason: string; now?: Date }
): Promise<boolean> {
  const now = input.now ?? new Date()
  const [row] = await db
    .update(approvalRequests)
    .set({ status: 'cancelled', decidedAt: now, updatedAt: now })
    .where(
      and(
        eq(approvalRequests.tenantId, input.tenantId),
        eq(approvalRequests.id, input.approvalId),
        eq(approvalRequests.kind, 'session.merge'),
        eq(approvalRequests.status, 'pending')
      )
    )
    .returning()
  if (!row) return false
  await recordAudit(db, {
    ...SYSTEM_ACTOR,
    tenantId: row.tenantId,
    action: 'approval.cancelled',
    targetType: row.subjectType,
    targetId: row.subjectId,
    appId: row.appId,
    approvalId: row.id,
    summary: {
      before: { status: 'pending' },
      after: { status: 'cancelled', reason: input.reason },
    },
  })
  return true
}

export const sessionMergeHandler: KindHandler<'session.merge'> = {
  kind: 'session.merge',
  async defaultPolicy() {
    return DEFAULT_APPROVAL_POLICIES['session.merge']
  },
  describe(request) {
    if (request.context.kind !== 'session.merge') return `Merge session ${request.subjectId}`
    const { prTitle, prNumber, title, shortId } = request.context
    return `Merge “${prTitle}” (#${prNumber}) from session ${title ?? shortId}`
  },
  async applyInTx(tx, request, deps) {
    if (request.context.kind !== 'session.merge') {
      throw new Error(`session.merge handler given a ${request.context.kind} request`)
    }
    const { sessionId, headSha } = request.context
    const now = (deps.now?.() ?? new Date()).toISOString()
    const [row] = await tx
      .update(sessions)
      .set({
        landing: sql`${sessions.landing} || ${JSON.stringify({ stage: 'merging', stageAt: now })}::jsonb`,
      })
      .where(
        and(
          eq(sessions.tenantId, request.tenantId),
          eq(sessions.id, sessionId),
          eq(sessions.status, 'shipping'),
          sql`${sessions.landing}->>'stage' = 'approval'`,
          sql`${sessions.landing}->>'approvalId' = ${request.id}`,
          sql`${sessions.landing}->>'gateSha' = ${headSha}`
        )
      )
      .returning()
    if (!row) return
    const by = await mergeDecider(tx, request, 'approve')
    await createSessionEmitter(tx, { id: row.id, tenantId: row.tenantId })({
      type: 'ship.review',
      turn: row.turnCount,
      data: {
        status: 'approved',
        approvalId: request.id,
        ...(by ? { by: by.name } : {}),
        ...(by?.comment ? { note: by.comment } : {}),
      },
    })
  },
  async applyAfter(request, deps) {
    await wakeWaiting(request, deps)
  },
  async onClosed(request, _status, deps) {
    const row = await loadSession(deps.db, request.tenantId, sessionIdOf(request))
    if (!waitsOn(row, request)) return
    await wakeWaiting(request, deps)
  },
}
