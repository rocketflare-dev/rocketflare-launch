/**
 * Asking for more session budget (Launch P4, plan §4c) — `POST /api/sessions/:id/budget`'s half.
 * P3 let the app's owners and admins raise the cap directly; from P4 the cap only rises as the
 * effect of an approved `session.budget` request (`services/approvals/kinds/session-budget.ts`).
 *
 * 1. Open (or JOIN — the engine's open is idempotent per session while one is pending) the
 *    request. Its requester is always the session's CREATOR, whoever clicked: the one whose work
 *    is blocked, and the person an approver must not be. A creator who has left the organisation
 *    (the row's `created_by_user_id` set null) falls back to the caller.
 * 2. If the caller is someone else, they are probably an approver (the route only lets the
 *    creator, the app's owners and admins see a session): their approval is recorded in the same
 *    call — P3's one click. The engine decides whether it counts: `not_an_approver`,
 *    `self_approval`, `already_decided` (and the 404 of someone the policy gives no part in it)
 *    leave the request waiting rather than failing the call.
 *
 * So the creator extending their own session waits for an owner, even when they ARE an owner.
 */

import { microcentsToUsd } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import type { ApprovalRequestRow, SessionRow } from '../../../db/schema'
import { approvalRequests, tenantUsers, users } from '../../../db/schema'
import { ApiError } from '../../utils/core/errors'
import { decide, open } from '../approvals/engine'
import type { ApprovalDeps, ApprovalRequester, ApprovalViewer } from '../approvals/types'
import type { AuditActor } from '../launch/audit'
import { getSessionRow } from './access'
import { sessionSpend } from './budget'

/** A decide refusal that means "not this person", not "something broke" — the request waits. */
const WAIT_CODES = new Set(['not_an_approver', 'self_approval', 'already_decided'])

export interface BudgetRequestInput {
  session: SessionRow
  caller: ApprovalViewer
  extraUsd: number
  reason?: string | null
  actor: AuditActor
}

export interface BudgetRequestResult {
  /** The session as it is now — extended already when the one click approved it. */
  session: SessionRow
  request: ApprovalRequestRow
}

async function creatorOf(
  deps: ApprovalDeps,
  session: SessionRow,
  caller: ApprovalViewer
): Promise<ApprovalRequester> {
  if (session.createdByUserId && session.createdByUserId !== caller.userId) {
    const [creator] = await deps.db
      .select({ userId: users.id, email: users.email, role: tenantUsers.role })
      .from(users)
      .leftJoin(
        tenantUsers,
        and(eq(tenantUsers.userId, users.id), eq(tenantUsers.tenantId, session.tenantId))
      )
      .where(eq(users.id, session.createdByUserId))
    if (creator) return { userId: creator.userId, email: creator.email, role: creator.role }
  }
  return { userId: caller.userId, email: caller.email, role: caller.role }
}

export async function requestBudgetExtension(
  deps: ApprovalDeps,
  input: BudgetRequestInput
): Promise<BudgetRequestResult> {
  const { session, caller } = input
  const requester = await creatorOf(deps, session, caller)
  const spend = sessionSpend(session)
  const opened = await open(deps, {
    tenantId: session.tenantId,
    kind: 'session.budget',
    subject: { type: 'session', id: session.id },
    appId: session.appId,
    requester,
    reason: input.reason || null,
    context: {
      kind: 'session.budget',
      sessionId: session.id,
      sessionTitle: session.title,
      extraUsd: input.extraUsd,
      spentUsd: microcentsToUsd(spend.spentMicrocents),
      capUsd: microcentsToUsd(spend.capMicrocents),
    },
    actor: input.actor,
  })

  if (
    opened.request.status === 'pending' &&
    'userId' in requester &&
    requester.userId !== caller.userId
  ) {
    try {
      await decide(deps, {
        requestId: opened.request.id,
        viewer: caller,
        decision: 'approve',
        actor: input.actor,
      })
    } catch (err) {
      // A caller the policy does not name may not even SEE the request (404): it waits for those
      // who can.
      const waits =
        err instanceof ApiError &&
        (err.statusCode === 404 || (err.code !== undefined && WAIT_CODES.has(err.code)))
      if (!waits) throw err
    }
  }

  const [request] = await deps.db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, session.tenantId),
        eq(approvalRequests.id, opened.request.id)
      )
    )
  return {
    session: await getSessionRow(deps.db, session.tenantId, session.id),
    request: request ?? opened.request,
  }
}
