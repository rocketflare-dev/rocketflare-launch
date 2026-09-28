/**
 * `/api/approvals` (Launch P4, spec/08, `docs/plans/p4-approvals.md` §4b) — the inbox and the
 * decision, over `services/approvals/engine.ts`. Behind `authMiddleware`; every member may `read
 * Approval` and the ENGINE filters the rows and decides eligibility per request — deciding is not
 * a CASL action. Slice 4b builds it:
 *
 * - `GET /?box=mine|requested|all&status=&kind=&appId=` → `approvalListResponseSchema` (`all` is
 *   admin+; anyone else gets `mine`);
 * - `GET /count` → `approvalCountSchema` (the nav badge: pending and waiting on me);
 * - `GET /:id` → `approvalDetailSchema` (with `decisions`, `canDecide`, `whyNot`, `canCancel`);
 *   a request the caller may not see is the same 404 as a missing one;
 * - `POST /:id/decide` `decideApprovalSchema` → `approvalDetailSchema`: 403 `not_an_approver` /
 *   `self_approval`, 409 `already_decided` / `not_pending` (`APPROVAL_ERROR_CODES`);
 * - `POST /:id/cancel` `cancelApprovalSchema` → `approvalDetailSchema` (the requester or an admin).
 *
 * From 4a the list and the count answer empty, so the inbox, the badge and the CLI render before
 * the engine exists; nothing else is registered.
 */
import {
  type ApprovalCount,
  type ApprovalListResponse,
  approvalListQuerySchema,
} from '@launch/shared/launch-approvals'
import { guardPermission } from '../middleware/permissions'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const approvalsRouter = createRouter()

approvalsRouter.get('/', validate('query', approvalListQuerySchema), c => {
  guardPermission(c, 'read', 'Approval')
  const body: ApprovalListResponse = { items: [] }
  return c.json(body)
})

approvalsRouter.get('/count', c => {
  guardPermission(c, 'read', 'Approval')
  const body: ApprovalCount = { count: 0 }
  return c.json(body)
})
