/**
 * A shared resource's pushes under `/api/shared-resources` (Launch P5, plan §1.10, §4 5c), mounted
 * by `shared-resources.ts` with `.route('/', …)` before its own routes, behind the mount's
 * `authMiddleware`. Every member may `read SharedResource`; the pushes themselves are for the
 * resource's owners and admins only (the service answers everyone else the same 404 as a push that
 * does not exist). Over `services/grants/push.ts`:
 *
 * - `GET /:id/pushes?environment=&limit=` → `grantPushListResponseSchema`, newest first;
 * - `GET /:id/pushes/:pushId` → `grantPushSchema` (with every target);
 * - `POST /:id/pushes/:pushId/retry` → 202 `grantPushSchema` (a `partial` / `failed` push starts
 *   again as `<pushId>-rN`; 409 `push_in_progress` while one runs, `push_not_retryable` for a
 *   push that succeeded; 503 `grants_not_configured` without the binding).
 */
import { grantPushListQuerySchema } from '@launch/shared/launch-grants'
import { guardPermission } from '../middleware/permissions'
import { approvalViewerOf } from '../services/approvals/types'
import { getPush, listPushes, retryPush } from '../services/grants/push'
import { auditActor } from '../services/launch/audit'
import type { AppContext } from '../types'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { approvalDepsOf } from './approvals'

export const sharedResourcePushesRouter = createRouter()

function viewer(c: AppContext) {
  guardPermission(c, 'read', 'SharedResource')
  const ctx = withAuthAndDb(c)
  return { ...ctx, viewer: approvalViewerOf({ ...ctx.auth, tenantId: ctx.tenantId }) }
}

sharedResourcePushesRouter.get(
  '/:id/pushes',
  validate('query', grantPushListQuerySchema),
  async c => {
    const { db, viewer: who } = viewer(c)
    return c.json(await listPushes(db, who, uuidParam(c, 'id'), c.req.valid('query')))
  }
)

sharedResourcePushesRouter.get('/:id/pushes/:pushId', async c => {
  const { db, viewer: who } = viewer(c)
  return c.json(await getPush(db, who, uuidParam(c, 'id'), uuidParam(c, 'pushId')))
})

sharedResourcePushesRouter.post('/:id/pushes/:pushId/retry', async c => {
  const { viewer: who } = viewer(c)
  const push = await retryPush(
    approvalDepsOf(c),
    who,
    uuidParam(c, 'id'),
    uuidParam(c, 'pushId'),
    auditActor(c)
  )
  return c.json(push, 202)
})
