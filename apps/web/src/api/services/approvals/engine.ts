/**
 * The approvals engine (Launch P4, plan §1.2–§1.4) — slice 4b builds it; 4a gives every entry
 * point its final signature and a `NotWiredError` body, so 4c and 4d compile against it from the
 * start.
 *
 * - `open`: resolve the policy (`policy.ts`), snapshot it with the excluded set, auto-approve when
 *   `autoApproveRole` is met (still a row, decided by `system`, audited), an idempotent insert
 *   against the pending-subject index, audit `approval.requested`, notify (`notify.ts`).
 * - `decide`: ONE transaction — `SELECT … FOR UPDATE` the pending row, eligibility and the
 *   excluded set, insert the decision (unique `(request_id, user_id)` → 409 `already_decided`),
 *   one reject vetoes and N approvals approve, `applyInTx`, audit `approval.decided` (+
 *   `approval.approved|rejected`) — then `applyAfter` after commit with `applied_at` as a CAS.
 * - `cancel` (the requester or an admin), `expire` (the sweep), `list(box)`, `detail`, `count`.
 */
import type { ApprovalDetail, ApprovalRequest } from '@launch/shared/launch-approvals'
import type { ApprovalRequestRow } from '../../../db/schema'
import {
  type ApprovalDeps,
  type ApprovalViewer,
  type CancelApprovalInput,
  type DecideApprovalInput,
  type ListApprovalsInput,
  NotWiredError,
  type OpenApprovalInput,
  type OpenApprovalResult,
} from './types'

export async function open(
  _deps: ApprovalDeps,
  _input: OpenApprovalInput
): Promise<OpenApprovalResult> {
  throw new NotWiredError('approvals.open', '4b')
}

export async function decide(
  _deps: ApprovalDeps,
  _input: DecideApprovalInput
): Promise<ApprovalDetail> {
  throw new NotWiredError('approvals.decide', '4b')
}

export async function cancel(
  _deps: ApprovalDeps,
  _input: CancelApprovalInput
): Promise<ApprovalDetail> {
  throw new NotWiredError('approvals.cancel', '4b')
}

/** Expire one pending request past its `expires_at` (the sweep calls this); null if not due. */
export async function expire(
  _deps: ApprovalDeps,
  _input: { tenantId: string; requestId: string }
): Promise<ApprovalRequestRow | null> {
  throw new NotWiredError('approvals.expire', '4b')
}

/** Retry an approved request's owed `applyAfter` (the sweep calls this). */
export async function retryApply(
  _deps: ApprovalDeps,
  _input: { tenantId: string; requestId: string }
): Promise<'applied' | 'failed' | 'gave_up' | 'not_owed'> {
  throw new NotWiredError('approvals.retryApply', '4b')
}

export async function list(
  _deps: Pick<ApprovalDeps, 'db'>,
  _input: ListApprovalsInput
): Promise<ApprovalRequest[]> {
  throw new NotWiredError('approvals.list', '4b')
}

export async function detail(
  _deps: Pick<ApprovalDeps, 'db'>,
  _input: { requestId: string; viewer: ApprovalViewer }
): Promise<ApprovalDetail> {
  throw new NotWiredError('approvals.detail', '4b')
}

/** Pending requests waiting on `viewer` — the nav badge. */
export async function count(
  _deps: Pick<ApprovalDeps, 'db'>,
  _input: { viewer: ApprovalViewer }
): Promise<number> {
  throw new NotWiredError('approvals.count', '4b')
}
