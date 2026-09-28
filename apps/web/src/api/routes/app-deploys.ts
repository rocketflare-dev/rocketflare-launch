/**
 * An app's deploys under `/api/apps` (Launch P2, slice 2d; P4 slice 4d), over
 * `services/launch/deploy/decisions.ts`:
 *
 * - `GET /:id/deploys` — the deploy tickets, newest first (`deployTicketListResponseSchema`).
 *   Every member may read (`read App`).
 * - `POST /:id/deploys/:ticketId/decide` — approve or reject a production run waiting in GitHub
 *   (`deployDecisionSchema`). From P4 a thin redirect to the ticket's `deploy.production` approval
 *   (`engine.decide`): whoever that approval's policy names decides — by default the app's owners
 *   and the organisation's admins, never the run's own authors — and the engine answers 403
 *   `not_an_approver` / `self_approval` and 409 `already_decided` / `not_pending`; 409
 *   `deploy_run_gone` once the run stopped waiting. Answers the ticket (`deployTicketSchema`).
 * - `POST /:id/deploys/production` — "Deploy to production" with no release (the app's owners and
 *   admins, `mayDeployApp`): opens a `deploy.production` approval → 202 `{ ticket: null,
 *   approvalId }` (`ticket` is the pre-approval when a policy auto-approved it on the spot).
 *
 * Mounted by `routes/apps.ts` with `appsRouter.route('/', appDeploysRouter)` BEFORE its own
 * `/:slug` routes, behind the `/api/apps` mount's `authMiddleware`. Every lookup is tenant-first,
 * so another organisation's app or ticket is a 404.
 */
import { deployDecisionSchema, type ProductionDeployResponse } from '@launch/shared/launch-pipeline'
import { can, guardPermission } from '../middleware/permissions'
import { approvalViewerOf } from '../services/approvals/types'
import { type AppViewer, getAppRow, mayDeployApp } from '../services/launch/apps'
import { auditActor } from '../services/launch/audit'
import {
  decideDeploy,
  listDeploys,
  requestProductionDeploy,
} from '../services/launch/deploy/decisions'
import type { AppContext } from '../types'
import { ForbiddenError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { approvalDepsOf } from './approvals'

export const appDeploysRouter = createRouter()

/** The caller as `mayDeployApp` / `getAppDetail` see them. */
export function appViewer(c: AppContext): AppViewer {
  const { user, auth } = withAuthAndDb(c)
  return { userId: user.id, groupIds: auth.groups.map(g => g.id), isAdmin: can(c, 'manage', 'App') }
}

/** The app, if the caller may start its deploys: an admin, or one of its owners. Else 403. */
export async function deployableApp(c: AppContext) {
  guardPermission(c, 'read', 'App')
  const ctx = withAuthAndDb(c)
  const app = await getAppRow(ctx.db, ctx.tenantId, uuidParam(c, 'id'))
  if (!(await mayDeployApp(ctx.db, ctx.tenantId, app, appViewer(c)))) {
    throw new ForbiddenError('Only the app’s owners and admins deploy it', 'forbidden')
  }
  return { ...ctx, app }
}

appDeploysRouter.get('/:id/deploys', async c => {
  guardPermission(c, 'read', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  return c.json({ items: await listDeploys(db, tenantId, app.id) })
})

appDeploysRouter.post(
  '/:id/deploys/:ticketId/decide',
  validate('json', deployDecisionSchema),
  async c => {
    // Who may decide is the approval's policy, evaluated by the engine — not `mayDeployApp`.
    guardPermission(c, 'read', 'App')
    const ctx = withAuthAndDb(c)
    const app = await getAppRow(ctx.db, ctx.tenantId, uuidParam(c, 'id'))
    const ticket = await decideDeploy(approvalDepsOf(c), {
      tenantId: ctx.tenantId,
      app,
      ticketId: uuidParam(c, 'ticketId'),
      decision: c.req.valid('json'),
      viewer: approvalViewerOf({ ...ctx.auth, tenantId: ctx.tenantId }),
      actor: auditActor(c),
    })
    return c.json(ticket)
  }
)

appDeploysRouter.post('/:id/deploys/production', async c => {
  const ctx = await deployableApp(c)
  const body: ProductionDeployResponse = await requestProductionDeploy(approvalDepsOf(c), {
    tenantId: ctx.tenantId,
    app: ctx.app,
    user: { id: ctx.user.id, email: ctx.user.email, role: ctx.auth.tenantUser?.role ?? null },
    actor: auditActor(c),
  })
  return c.json(body, 202)
})
