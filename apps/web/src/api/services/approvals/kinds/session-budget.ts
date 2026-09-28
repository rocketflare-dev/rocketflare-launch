/**
 * `session.budget` (Launch P4, plan §4c): a coding session asks for more budget. The subject is the
 * session and the requester its CREATOR, whoever clicked; `requestBudgetExtension`
 * (`services/sessions/budget-request.ts`) opens it and, when the caller is an eligible approver
 * other than the creator, records their approval in the same call (P3's one click).
 *
 * - `defaultPolicy`: the app's owners and admins; it expires with a suspended session
 *   (`launch_settings.session_policy.suspendedExpiryHours`) — a request outliving the session it
 *   would unblock helps nobody.
 * - `applyInTx` = `extendBudget` by the REQUEST's `extraUsd` (from its context, whatever a later
 *   click asked for): the cap rises atomically, `session.budget.extended` is audited in the
 *   approver's name with the approval id, and a `blocked` session under both caps goes `ready`.
 * - `applyAfter` = `wakeOrRestart` when the session is `ready` with a message waiting (the one
 *   that hit the cap). Safe to repeat: a session that is not waiting is left alone.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { and, eq } from 'drizzle-orm'
import { sessions } from '../../../../db/schema'
import { extendBudget } from '../../sessions/budget'
import { loadSessionPolicy, wakeOrRestart } from '../../sessions/lifecycle'
import type { KindHandler } from '../types'
import { deciderActor } from './decider'

const MIN_EXPIRY_MINUTES = 5

export const sessionBudgetHandler: KindHandler<'session.budget'> = {
  kind: 'session.budget',
  async defaultPolicy(db) {
    const { suspendedExpiryHours } = await loadSessionPolicy(db)
    return {
      ...DEFAULT_APPROVAL_POLICIES['session.budget'],
      expiresAfterMinutes: Math.max(MIN_EXPIRY_MINUTES, suspendedExpiryHours * 60),
    }
  },
  describe(request) {
    if (request.context.kind !== 'session.budget') return `More budget for ${request.subjectId}`
    const { extraUsd, sessionTitle, sessionId } = request.context
    return `$${extraUsd} more budget for session ${sessionTitle ?? sessionId.slice(0, 8)}`
  },
  async applyInTx(tx, request) {
    if (request.context.kind !== 'session.budget') {
      throw new Error(`session.budget handler given a ${request.context.kind} request`)
    }
    const actor = await deciderActor(tx, request, 'approve')
    await extendBudget(tx, {
      tenantId: request.tenantId,
      sessionId: request.context.sessionId,
      extraUsd: request.context.extraUsd,
      actor,
      approvalId: request.id,
    })
  },
  async applyAfter(request, deps) {
    const sessionId =
      request.context.kind === 'session.budget' ? request.context.sessionId : request.subjectId
    const [row] = await deps.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, request.tenantId), eq(sessions.id, sessionId)))
    if (!row || row.status !== 'ready' || !row.pendingMessage) return
    const workflow = (deps.env as { SESSION_WORKFLOW?: Workflow }).SESSION_WORKFLOW
    if (!workflow) return
    await wakeOrRestart(deps.db, workflow, row, deps.logger)
  },
}
