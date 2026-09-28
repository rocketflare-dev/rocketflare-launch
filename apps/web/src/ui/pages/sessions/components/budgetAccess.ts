/**
 * Who may do what about a session's budget (Launch P4, plan §4c) — pure, decided once on the page
 * and handed to the header and the over-budget banner so the two never disagree.
 *
 * - `extend`: the app's owners and admins (the route's `mayDeployApp`; the app detail's
 *   `viewerCanDeploy`, or `manage Session`). Their click also approves.
 * - `ask`: anyone else who may act on the session (`viewerCanManage` — in practice its creator).
 *   Their click opens a `session.budget` approval.
 * - `null`: a reader, who is told who can.
 *
 * `pendingApprovalId` is the creator's open request, when there is one: the page links to it
 * instead of offering to ask twice (the engine would join the same request anyway).
 */
import type { Session } from '@launch/shared/launch-sessions'

export interface BudgetAccess {
  mode: 'extend' | 'ask' | null
  pendingApprovalId: string | null
}

export function budgetAccess(
  session: Pick<Session, 'viewerCanManage'>,
  canExtend: boolean,
  pendingApprovalId: string | null
): BudgetAccess {
  const mode = !session.viewerCanManage ? null : canExtend ? 'extend' : 'ask'
  return { mode, pendingApprovalId: mode ? pendingApprovalId : null }
}
