/**
 * The create-an-app pipeline under `/api/apps` (Launch P2, slice 2c), over
 * `services/launch/pipeline/*` and the two Workflow bindings. Routes START runs; the Workflows do
 * the work.
 *
 * - `POST /` → 202 `{ app, runId }` (`createAppResponseSchema`): `manage App` AND at least
 *   `launch_settings.app_create_role` (default admin; 403 below it). Refusals before any write: an
 *   invalid, reserved or `launch-` slug (400), a taken one (409 `slug_taken`), Setup unfinished
 *   (503 `launch_not_set_up`) or no `APP_LAUNCH_WORKFLOW` binding (503
 *   `app_pipeline_not_configured`).
 * - `GET /:id/pipeline[?kind=create|teardown]` → `pipelineViewSchema` (`read App`).
 * - `POST /:id/pipeline/retry` `{ kind }` → 202 `{ runId, instanceId }` — only when the latest run
 *   of that kind is `failed` (409 `run_not_failed`).
 * - `POST /:id/teardown` `{ confirmSlug, deleteRepo }` → 202 `{ runId }` — a wrong slug is 400
 *   `confirm_slug_mismatch`.
 *
 * Audited: `app.create.requested`, `app.pipeline.retried`, `app.teardown.requested` (and the
 * Workflows add `app.launched`, `app.launch_failed`, `app.archived`, `app.teardown_failed`).
 *
 * Mounted by `routes/apps.ts` with `appsRouter.route('/', appPipelineRouter)` BEFORE its own
 * `/:slug` routes, behind the `/api/apps` mount's `authMiddleware`.
 */
import {
  createAppRequestSchema,
  pipelineQuerySchema,
  retryPipelineRequestSchema,
  teardownRequestSchema,
} from '@launch/shared/launch-pipeline'
import { meetsAppCreateRole } from '@launch/shared/launch-setup'
import { guardPermission, isGlobalAdmin } from '../middleware/permissions'
import { getAppDetail, getAppRow } from '../services/launch/apps'
import { auditActor } from '../services/launch/audit'
import { loadPipelineSettings } from '../services/launch/pipeline/context'
import { createApp, startTeardown } from '../services/launch/pipeline/create'
import { defaultPorts } from '../services/launch/pipeline/ports'
import { retryPipeline } from '../services/launch/pipeline/retry'
import { pipelineView } from '../services/launch/pipeline/runs'
import { ForbiddenError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const appPipelineRouter = createRouter()

appPipelineRouter.post('/', validate('json', createAppRequestSchema), async c => {
  const auth = guardPermission(c, 'manage', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const { appCreateRole } = await loadPipelineSettings(db)
  if (!isGlobalAdmin(auth) && !meetsAppCreateRole(auth.tenantUser?.role ?? '', appCreateRole)) {
    throw new ForbiddenError(`Creating apps is limited to the ${appCreateRole} role and above`)
  }
  const { app, runId } = await createApp(
    db,
    c.env.APP_LAUNCH_WORKFLOW,
    defaultPorts(),
    tenantId,
    c.req.valid('json'),
    auditActor(c)
  )
  return c.json({ app: await getAppDetail(db, tenantId, app.slug), runId }, 202)
})

appPipelineRouter.get('/:id/pipeline', validate('query', pipelineQuerySchema), async c => {
  guardPermission(c, 'read', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  return c.json(await pipelineView(db, tenantId, app, c.req.valid('query').kind))
})

appPipelineRouter.post(
  '/:id/pipeline/retry',
  validate('json', retryPipelineRequestSchema),
  async c => {
    guardPermission(c, 'manage', 'App')
    const { db, tenantId } = withAuthAndDb(c)
    const result = await retryPipeline(
      db,
      c.env,
      tenantId,
      uuidParam(c, 'id'),
      c.req.valid('json').kind,
      auditActor(c)
    )
    return c.json(result, 202)
  }
)

appPipelineRouter.post('/:id/teardown', validate('json', teardownRequestSchema), async c => {
  guardPermission(c, 'manage', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const result = await startTeardown(
    db,
    c.env.APP_TEARDOWN_WORKFLOW,
    tenantId,
    uuidParam(c, 'id'),
    c.req.valid('json'),
    auditActor(c)
  )
  return c.json(result, 202)
})
