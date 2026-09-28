/**
 * `/api/approvals` (Launch P4, spec/08, `docs/plans/p4-approvals.md` §4b) — the inbox and the
 * decision, over `services/approvals/engine.ts`. Behind `authMiddleware`; every member may `read
 * Approval` and the ENGINE filters the rows and decides eligibility per request — deciding is not
 * a CASL action.
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
 * `approvalDepsOf(c)` is how any route hands the engine its dependencies (4c and 4d reuse it).
 */
import {
  type ApprovalCount,
  type ApprovalListResponse,
  approvalListQuerySchema,
  cancelApprovalSchema,
  decideApprovalSchema,
} from '@launch/shared/launch-approvals'
import { guardPermission } from '../middleware/permissions'
import { cancel, count, decide, detail, list } from '../services/approvals/engine'
import { type ApprovalDeps, approvalViewerOf } from '../services/approvals/types'
import { auditActor } from '../services/launch/audit'
import type { AppContext } from '../types'
import { loggerFor } from '../utils/core/logger'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const approvalsRouter = createRouter()

/** The engine's dependencies for this request: its client, bindings, config, logger and nudges. */
export function approvalDepsOf(c: AppContext): ApprovalDeps {
  const { db, cfg, realtime } = withAuthAndDb(c)
  // The engine logs through a plain pino `Logger` (it runs in the cron too); hono-pino's request
  // logger is another type, so an engine line carries the component rather than the request id.
  return { db, env: c.env, cfg, logger: loggerFor(cfg, { component: 'approvals' }), realtime }
}

function viewer(c: AppContext) {
  guardPermission(c, 'read', 'Approval')
  const ctx = withAuthAndDb(c)
  return { ...ctx, viewer: approvalViewerOf({ ...ctx.auth, tenantId: ctx.tenantId }) }
}

approvalsRouter.get('/', validate('query', approvalListQuerySchema), async c => {
  const { db, viewer: who } = viewer(c)
  const body: ApprovalListResponse = {
    items: await list({ db }, { viewer: who, query: c.req.valid('query') }),
  }
  return c.json(body)
})

approvalsRouter.get('/count', async c => {
  const { db, viewer: who } = viewer(c)
  const body: ApprovalCount = { count: await count({ db }, { viewer: who }) }
  return c.json(body)
})

approvalsRouter.get('/:id', async c => {
  const { db, viewer: who } = viewer(c)
  return c.json(await detail({ db }, { requestId: uuidParam(c, 'id'), viewer: who }))
})

approvalsRouter.post('/:id/decide', validate('json', decideApprovalSchema), async c => {
  const { viewer: who } = viewer(c)
  const body = c.req.valid('json')
  const result = await decide(approvalDepsOf(c), {
    requestId: uuidParam(c, 'id'),
    viewer: who,
    decision: body.decision,
    comment: body.comment ?? null,
    actor: auditActor(c),
  })
  return c.json(result)
})

approvalsRouter.post('/:id/cancel', validate('json', cancelApprovalSchema), async c => {
  const { viewer: who } = viewer(c)
  const body = c.req.valid('json')
  const result = await cancel(approvalDepsOf(c), {
    requestId: uuidParam(c, 'id'),
    viewer: who,
    reason: body.reason ?? null,
    actor: auditActor(c),
  })
  return c.json(result)
})
