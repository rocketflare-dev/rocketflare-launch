/**
 * An app's shared config and grants under `/api/apps` (Launch P5, plan §1.7, §4 5d), mounted by
 * `routes/apps.ts` with `appsRouter.route('/', appConfigRouter)` BEFORE its own `/:slug` routes,
 * behind the `/api/apps` mount's `authMiddleware`, over `services/grants/requests.ts` and
 * `revoke.ts`:
 *
 * - `GET /:id/config` → `appConfigSchema` (anyone who may read the app, `read App`);
 * - `POST /:id/grants` `requestGrantSchema` → 202 `requestGrantResponseSchema` (the app's owners
 *   and admins; one grant and one `grant.request` per environment; 503 `grants_not_configured`
 *   before any row; 409 `grant_already_held` / `values_not_set` / `shared_resource_archived`);
 * - `DELETE /:id/grants/:gid` `revokeGrantSchema` (the body is optional) → 202
 *   `grantActionResponseSchema` (the app's owners, the resource's owners, admins — 5c's check);
 * - `POST /:id/grants/:gid/repush` → 202 `grantActionResponseSchema`.
 *
 * Who may do what is the service's check (ownership is not a CASL condition), so every route here
 * guards only `read App`. Every lookup is tenant-first, so another organisation's app or grant is
 * a 404. Each answer is parsed through its shared schema on the way out.
 *
 * `POST /:id/config/scan` is slice 5e's, in `app-config-scan.ts`.
 */
import {
  appConfigSchema,
  type GrantActionResponse,
  grantActionResponseSchema,
  requestGrantResponseSchema,
  requestGrantSchema,
  revokeGrantSchema,
} from '@launch/shared/launch-grants'
import { guardPermission } from '../middleware/permissions'
import { approvalViewerOf } from '../services/approvals/types'
import { appConfigView, appGrantView, repushGrant, requestGrant } from '../services/grants/requests'
import { revokeGrant } from '../services/grants/revoke'
import { getAppRow } from '../services/launch/apps'
import { auditActor } from '../services/launch/audit'
import type { AppContext } from '../types'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { approvalDepsOf } from './approvals'

export const appConfigRouter = createRouter()

/** The caller as the grant services see them (the approvals engine's viewer). */
function grantViewer(c: AppContext) {
  guardPermission(c, 'read', 'App')
  const ctx = withAuthAndDb(c)
  return { ...ctx, viewer: approvalViewerOf({ ...ctx.auth, tenantId: ctx.tenantId }) }
}

/** Return an app's shared config view. Requires `read App`. */
appConfigRouter.get('/:id/config', async c => {
  const { db, viewer } = grantViewer(c)
  return c.json(appConfigSchema.parse(await appConfigView(db, viewer, uuidParam(c, 'id'))))
})

/**
 * Request a grant of a shared resource for an app's environment. The app's owners and admins may
 * call it (the service's own check; the route only guards `read App`). 503
 * `grants_not_configured` before any row; 409 `grant_already_held`, `values_not_set` or
 * `shared_resource_archived`.
 */
appConfigRouter.post('/:id/grants', validate('json', requestGrantSchema), async c => {
  const { viewer } = grantViewer(c)
  const result = await requestGrant(
    approvalDepsOf(c),
    viewer,
    uuidParam(c, 'id'),
    c.req.valid('json'),
    auditActor(c)
  )
  return c.json(requestGrantResponseSchema.parse(result), 202)
})

/**
 * Revoke a grant of a shared resource from an app. The app's owners, the resource's owners or
 * admins may call it (the service's own check). 404 for a grant of another app.
 */
appConfigRouter.delete('/:id/grants/:gid', validate('json', revokeGrantSchema), async c => {
  const { db, tenantId, viewer } = grantViewer(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  const grantId = uuidParam(c, 'gid')
  // 404 for a grant of another app before the revoke is even considered.
  await appGrantView(db, tenantId, app.id, grantId)
  const { pushId } = await revokeGrant(approvalDepsOf(c), viewer, {
    appId: app.id,
    grantId,
    reason: c.req.valid('json').reason ?? null,
    actor: auditActor(c),
  })
  const body: GrantActionResponse = {
    grant: await appGrantView(db, tenantId, app.id, grantId),
    pushId,
  }
  return c.json(grantActionResponseSchema.parse(body), 202)
})

/**
 * Re-push a grant's values to the app's deployment. Requires `read App` (the service checks
 * further).
 */
appConfigRouter.post('/:id/grants/:gid/repush', async c => {
  const { viewer } = grantViewer(c)
  const result = await repushGrant(
    approvalDepsOf(c),
    viewer,
    uuidParam(c, 'id'),
    uuidParam(c, 'gid'),
    auditActor(c)
  )
  return c.json(grantActionResponseSchema.parse(result), 202)
})
