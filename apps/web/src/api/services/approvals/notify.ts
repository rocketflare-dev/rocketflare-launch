/**
 * Approval notifications (Launch P4, plan §1.13) — slice 4b builds it.
 *
 * - In app: `notifyMany` to the eligible approvers (`approval_requested`) and to the requester
 *   (`approval_decided`, `approval_expired`) — the types in `APPROVAL_NOTIFICATION_TYPES`, linked
 *   to `approvalPath(id)` by `notificationLink` — and the realtime nudge
 *   `entity.changed { entity: APPROVAL_REALTIME_ENTITY, id }` (`nudgeUsers`).
 * - Email: an `email.send` job per recipient with an `emailShell` template (`services/email.ts`;
 *   the templates live in `email.ts` beside this file, 4b's).
 *
 * Every function is best-effort after commit: a notification that fails never undoes a decision.
 */
import type { ApprovalRequestRow } from '../../../db/schema'
import { type ApprovalDeps, NotWiredError } from './types'

export async function notifyRequested(
  _deps: ApprovalDeps,
  _request: ApprovalRequestRow,
  _approverIds: readonly string[]
): Promise<void> {
  throw new NotWiredError('approvals.notifyRequested', '4b')
}

export async function notifyDecided(
  _deps: ApprovalDeps,
  _request: ApprovalRequestRow
): Promise<void> {
  throw new NotWiredError('approvals.notifyDecided', '4b')
}

export async function notifyExpired(
  _deps: ApprovalDeps,
  _request: ApprovalRequestRow
): Promise<void> {
  throw new NotWiredError('approvals.notifyExpired', '4b')
}
