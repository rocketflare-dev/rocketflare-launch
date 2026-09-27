/**
 * An app's deploys under `/api/apps` (Launch P2, slice 2d), over `services/launch/deploy/decisions.ts`:
 *
 * - `GET /:id/deploys` — the deploy tickets, newest first (`deployTicketListResponseSchema`).
 *   Every member may read (`read App`).
 * - `POST /:id/deploys/:ticketId/decide` — approve or reject a pending production deploy while
 *   its run waits (`deployDecisionSchema`). The app's owners (a named owner or its owner group)
 *   and the organisation's admins (`manage App`); anyone else 403. Answers the ticket
 *   (`deployTicketSchema`); 409 once it is no longer pending.
 * - `POST /:id/deploys/production` — "Deploy to production": a pre-approval the next production
 *   run claims, plus the `deploy.yml` dispatch → 202 `{ ticket }`. Same people as deciding.
 *
 * Mounted by `routes/apps.ts` with `appsRouter.route('/', appDeploysRouter)` BEFORE its own
 * `/:slug` routes, behind the `/api/apps` mount's `authMiddleware`. Every lookup is tenant-first,
 * so another organisation's app or ticket is a 404.
 */
import { deployDecisionSchema } from '@launch/shared/launch-pipeline'
import { can, guardPermission } from '../middleware/permissions'
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

export const appDeploysRouter = createRouter()

/** The caller as `mayDeployApp` / `getAppDetail` see them. */
export function appViewer(c: AppContext): AppViewer {
  const { user, auth } = withAuthAndDb(c)
  return { userId: user.id, groupIds: auth.groups.map(g => g.id), isAdmin: can(c, 'manage', 'App') }
}

/** The app, if the caller may decide its deploys: an admin, or one of its owners. Else 403. */
async function deployableApp(c: AppContext) {
  guardPermission(c, 'read', 'App')
  const ctx = withAuthAndDb(c)
  const app = await getAppRow(ctx.db, ctx.tenantId, uuidParam(c, 'id'))
  if (!(await mayDeployApp(ctx.db, ctx.tenantId, app, appViewer(c)))) {
    throw new ForbiddenError('Only the app’s owners and admins decide its deploys', 'forbidden')
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
    const { db, tenantId, user, app } = await deployableApp(c)
    const ticket = await decideDeploy(db, {
      tenantId,
      app,
      ticketId: uuidParam(c, 'ticketId'),
      decision: c.req.valid('json'),
      userId: user.id,
      actor: auditActor(c),
    })
    return c.json(ticket)
  }
)

appDeploysRouter.post('/:id/deploys/production', async c => {
  const { db, cfg, tenantId, user, app } = await deployableApp(c)
  const ticket = await requestProductionDeploy(db, cfg, {
    tenantId,
    app,
    userId: user.id,
    actor: auditActor(c),
  })
  return c.json({ ticket }, 202)
})
