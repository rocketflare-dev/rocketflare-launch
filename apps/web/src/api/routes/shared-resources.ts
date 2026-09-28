/**
 * `/api/shared-resources` (Launch P5, spec/09, `docs/plans/p5-grants.md` §4 5b) — shared config:
 * the bundles, their values and who holds them, over `services/grants/{resources,values,access}.ts`.
 * Behind `authMiddleware`; every member may `read SharedResource` (they need the names to ask),
 * admins `manage` it, and the OWNER group's rights are decided by the service:
 *
 * - `GET /` → `sharedResourceListResponseSchema` (`?archived=true` includes the archived ones);
 * - `POST /` `createSharedResourceSchema` → 201 `sharedResourceDetailSchema` (admins; 409
 *   `shared_resource_slug_taken`);
 * - `GET /:id` → `sharedResourceDetailSchema` (`holders` and var values for owners and admins);
 * - `PATCH /:id` `patchSharedResourceSchema` → `sharedResourceDetailSchema` (owners: name,
 *   description, items; admins also the owner group and the policies — 403 `not_resource_admin`);
 * - `PUT /:id/values/:env` `putSharedResourceValuesSchema` → 202 (a rotation started) or 200
 *   `putSharedResourceValuesResponseSchema` (owners and admins; 403 `not_resource_owner`);
 * - `DELETE /:id` → 204, archived (admins; 409 `resource_has_holders`).
 *
 * `create` and `delete` also pass CASL (`create` / `delete SharedResource`, admins); `PATCH` and
 * `PUT` are `read` at the gate because an owner group's MEMBER may edit, and the service decides.
 * No handler here ever answers a value: the services build every body from the shared schemas,
 * and a var's value is only in the detail's `vars`, for owners and admins.
 *
 * The push routes (`GET /:id/pushes[/:pushId]`, `POST /:id/pushes/:pushId/retry`) are slice 5c's,
 * in `shared-resource-pushes.ts`, mounted first below so neither slice edits the other's file.
 */
import {
  createSharedResourceSchema,
  patchSharedResourceSchema,
  putSharedResourceValuesSchema,
  SHARED_RESOURCE_REALTIME_ENTITY,
  sharedResourceEnvParamSchema,
  sharedResourceListQuerySchema,
} from '@launch/shared/launch-grants'
import { guardPermission } from '../middleware/permissions'
import { approvalViewerOf } from '../services/approvals/types'
import {
  archiveResource,
  createResource,
  getResource,
  listResources,
  patchResource,
} from '../services/grants/resources'
import type { GrantDeps } from '../services/grants/types'
import { setValues } from '../services/grants/values'
import { auditActor } from '../services/launch/audit'
import { nudge, realtimeEvent } from '../services/realtime'
import type { AppContext } from '../types'
import { loggerFor } from '../utils/core/logger'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { sharedResourcePushesRouter } from './shared-resource-pushes'

export const sharedResourcesRouter = createRouter()

// Slice 5c: `GET /:id/pushes`, `GET /:id/pushes/:pushId`, `POST /:id/pushes/:pushId/retry`.
sharedResourcesRouter.route('/', sharedResourcePushesRouter)

/** The request's context plus the person asking, after the CASL gate for `action`. */
function asking(c: AppContext, action: 'read' | 'create' | 'delete') {
  guardPermission(c, action, 'SharedResource')
  const ctx = withAuthAndDb(c)
  return { ...ctx, viewer: approvalViewerOf({ ...ctx.auth, tenantId: ctx.tenantId }) }
}

/** What a grant service runs with, from a route (the approvals engine's `approvalDepsOf` shape). */
function grantDepsOf(c: AppContext): GrantDeps {
  const { db, cfg, realtime } = withAuthAndDb(c)
  return { db, env: c.env, cfg, logger: loggerFor(cfg, { component: 'grants' }), realtime }
}

function nudgeResource(c: AppContext, id: string): void {
  const { tenantId, realtime } = withAuthAndDb(c)
  nudge(
    realtime,
    realtimeEvent('entity.changed', tenantId, { entity: SHARED_RESOURCE_REALTIME_ENTITY, id })
  )
}

sharedResourcesRouter.get('/', validate('query', sharedResourceListQuerySchema), async c => {
  const { db, cfg, viewer } = asking(c, 'read')
  return c.json(await listResources(db, cfg, viewer, c.req.valid('query')))
})

sharedResourcesRouter.post('/', validate('json', createSharedResourceSchema), async c => {
  const { db, cfg, viewer } = asking(c, 'create')
  const detail = await createResource(db, cfg, viewer, c.req.valid('json'), auditActor(c))
  nudgeResource(c, detail.id)
  return c.json(detail, 201)
})

sharedResourcesRouter.get('/:id', async c => {
  const { db, cfg, viewer } = asking(c, 'read')
  return c.json(await getResource(db, cfg, viewer, uuidParam(c, 'id')))
})

sharedResourcesRouter.patch('/:id', validate('json', patchSharedResourceSchema), async c => {
  const { db, cfg, viewer } = asking(c, 'read')
  const id = uuidParam(c, 'id')
  const detail = await patchResource(db, cfg, viewer, id, c.req.valid('json'), auditActor(c))
  nudgeResource(c, id)
  return c.json(detail)
})

sharedResourcesRouter.put(
  '/:id/values/:env',
  validate('param', sharedResourceEnvParamSchema),
  validate('json', putSharedResourceValuesSchema),
  async c => {
    const { viewer } = asking(c, 'read')
    const { id, env } = c.req.valid('param')
    const body = await setValues(
      grantDepsOf(c),
      viewer,
      id,
      env,
      c.req.valid('json'),
      auditActor(c)
    )
    return c.json(body, body.pushId ? 202 : 200)
  }
)

sharedResourcesRouter.delete('/:id', async c => {
  const { db, viewer } = asking(c, 'delete')
  const id = uuidParam(c, 'id')
  await archiveResource(db, viewer, id, auditActor(c))
  nudgeResource(c, id)
  return c.body(null, 204)
})
