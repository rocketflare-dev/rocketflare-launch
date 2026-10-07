/**
 * The create-an-app pipeline under `/api/apps` (Launch P2, slice 2c), over
 * `services/launch/pipeline/*` and the two Workflow bindings. Routes START runs; the Workflows do
 * the work.
 *
 * - `POST /` → 202 `{ app, runId, approvalId }` (`createAppResponseSchema`): any member (`read
 *   App`) — from P4 creating an app is an `app.create` approval (plan §4c). The route writes the
 *   `requested` app (`requestApp`) and opens the approval: a creator at or above
 *   `launch_settings.app_create_role` (default admin) is auto-approved and the launch starts at
 *   once (`approvalId: null`); anyone else gets `approvalId` and the run id stays reserved until an
 *   admin approves (a rejection or expiry archives the app). Refusals before any write: an
 *   invalid, reserved or `launch-` slug (400), a taken one (409 `slug_taken`), Setup unfinished
 *   (503 `launch_not_set_up`), no `APP_LAUNCH_WORKFLOW` binding (503
 *   `app_pipeline_not_configured`), or Launch not reachable from the internet at `APP_URL` (409
 *   `launch_not_reachable` — the scaffold and deploy jobs call it back; `public-url.ts`).
 * - `GET /:id/pipeline[?kind=create|teardown]` → `pipelineViewSchema` (`read App`), through
 *   `pipeline/read.ts`. It first polls a create run's open wait (`pipeline/wait-poll.ts`, once per
 *   20 s per wait): a job that died on GitHub fails its wait with the run URL, and the Workflow is
 *   nudged. Then it reconciles a stale running run against its Workflow instance
 *   (`pipeline/reconcile.ts`): one that died mid-step is failed there. Either way Retry is offered.
 * - `POST /:id/pipeline/retry` `{ kind }` → 202 `{ runId, instanceId }` — after the same
 *   reconcile, only when the latest run of that kind is `failed` (409 `run_not_failed`); a create
 *   retry re-dispatches CI, so it is refused like a create while Launch is not reachable (409
 *   `launch_not_reachable`).
 * - `POST /:id/pipeline/rescaffold` → 202 `rescaffoldPipelineResponseSchema` (`manage App`, no
 *   body) — scaffold an app that never deployed AGAIN from the CURRENT kit pin, keeping its
 *   repository, database, storage, Workers, sign-in client and secrets (`pipeline/rescaffold.ts`):
 *   after the same reconcile, only for a failed create run of an app that is not live or archived
 *   and has never deployed (a deploy handed the migrator credential but never activated: that
 *   environment's database is asked first — the only Neon call here) — else 409 `run_not_failed` / `app_live` / `app_archived` /
 *   `app_already_deployed` / `no_run` (a deployed app takes a kit upgrade). It re-dispatches the
 *   scaffold job, so it is refused like a create while Launch is not reachable.
 * - `POST /:id/pipeline/cancel` → 200 `cancelPipelineResponseSchema` (`manage App`) — stop a create
 *   run that is still running (a stuck wait), so it can be retried; 409 `run_not_running`.
 * - `POST /:id/teardown` `{ confirmSlug, deleteRepo }` → 202 `{ runId }` — a wrong slug is 400
 *   `confirm_slug_mismatch`.
 *
 * Audited: `app.create.requested`, `app.pipeline.retried`, `app.pipeline.rescaffolded`,
 * `app.pipeline.cancelled`,
 * `app.teardown.requested`, `app.pipeline.reconciled` (and the
 * Workflows add `app.launched`, `app.launch_failed`, `app.archived`, `app.teardown_failed`; the
 * engine adds `approval.*`, and a rejected or expired `app.create` adds `app.create.rejected`).
 *
 * Mounted by `routes/apps.ts` with `appsRouter.route('/', appPipelineRouter)` BEFORE its own
 * `/:slug` routes, behind the `/api/apps` mount's `authMiddleware`.
 */
import {
  type CancelPipelineResponse,
  type CreateAppResponse,
  createAppRequestSchema,
  pipelineQuerySchema,
  type RescaffoldPipelineResponse,
  retryPipelineRequestSchema,
  teardownRequestSchema,
} from '@launch/shared/launch-pipeline'
import { guardPermission, isGlobalAdmin } from '../middleware/permissions'
import { open as openApproval } from '../services/approvals/engine'
import type { OpenApprovalResult } from '../services/approvals/types'
import { getAppDetail, getAppRow } from '../services/launch/apps'
import { auditActor } from '../services/launch/audit'
import { cancelLaunch } from '../services/launch/pipeline/cancel'
import { markLaunchFailed, requestApp, startTeardown } from '../services/launch/pipeline/create'
import { pipelineDeps } from '../services/launch/pipeline/launch-steps'
import { defaultPorts } from '../services/launch/pipeline/ports'
import { readPipeline } from '../services/launch/pipeline/read'
import { reconcilePipelineSafely } from '../services/launch/pipeline/reconcile'
import { rescaffoldPipeline } from '../services/launch/pipeline/rescaffold'
import { loadNeonClient } from '../services/launch/pipeline/rescaffold-database'
import { retryPipeline } from '../services/launch/pipeline/retry'
import { requirePublicUrl } from '../services/launch/public-url'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { appViewer } from './app-deploys'
import { approvalDepsOf } from './approvals'

export const appPipelineRouter = createRouter()

/**
 * Request a new app, launching it at once if the creator is at or above
 * `launch_settings.app_create_role` (default admin), else opening an `app.create` approval.
 * Requires `read App` (any member may ask). 400 for an invalid, reserved or `launch-` slug, 409
 * `slug_taken`, 503 `launch_not_set_up` or `app_pipeline_not_configured`, 409 `launch_not_reachable`
 * when Launch is not reachable from the internet. Audits `app.create.requested`.
 */
appPipelineRouter.post('/', validate('json', createAppRequestSchema), async c => {
  // Every member may ASK; whether the ask is granted at once is the `app.create` policy's.
  const auth = guardPermission(c, 'read', 'App')
  const { db, tenantId, user } = withAuthAndDb(c)
  const input = c.req.valid('json')
  const actor = auditActor(c)
  // Before any write: the jobs this launch dispatches must be able to call Launch back.
  await requirePublicUrl(db, c.get('config'))
  const { app, runId } = await requestApp(
    db,
    c.env.APP_LAUNCH_WORKFLOW,
    defaultPorts(),
    tenantId,
    input,
    actor
  )
  let opened: OpenApprovalResult
  try {
    opened = await openApproval(approvalDepsOf(c), {
      tenantId,
      kind: 'app.create',
      subject: { type: 'app', id: app.id },
      appId: app.id,
      // A global admin acting from outside the organisation ranks as its owner, as in P2.
      requester: {
        userId: user.id,
        email: user.email,
        role: isGlobalAdmin(auth) ? 'owner' : (auth.tenantUser?.role ?? null),
      },
      context: {
        kind: 'app.create',
        slug: app.slug,
        displayName: app.displayName,
        description: app.description,
        ownerGroupId: app.ownerGroupId,
      },
      actor,
    })
  } catch (err) {
    // No approval, no way forward: the reserved app must not sit `requested` for ever.
    await markLaunchFailed(db, tenantId, app.id, runId, err)
    throw err
  }
  const body: CreateAppResponse = {
    app: await getAppDetail(db, tenantId, app.slug, appViewer(c)),
    runId,
    approvalId: opened.autoApproved ? null : opened.request.id,
  }
  return c.json(body, 202)
})

/**
 * Return the create or teardown pipeline's current view, polling an open wait and reconciling a
 * stale running run against its Workflow instance first. Requires `read App`.
 */
appPipelineRouter.get('/:id/pipeline', validate('query', pipelineQuerySchema), async c => {
  guardPermission(c, 'read', 'App')
  const { db, tenantId, cfg, logger } = withAuthAndDb(c)
  const kind = c.req.valid('query').kind
  const id = uuidParam(c, 'id')
  // An open wait's job is polled and a dead instance reconciled first (neither throws).
  const deps = pipelineDeps(db, cfg, {}, { ports: defaultPorts })
  return c.json(await readPipeline(db, c.env, deps, tenantId, id, kind, { logger }))
})

/**
 * Retry the latest run of the given kind after reconciling it, when it is `failed`. Requires
 * `manage App`. 409 `run_not_failed`; a create retry is refused like a create while Launch is not
 * reachable (409 `launch_not_reachable`). Audits `app.pipeline.retried`.
 */
appPipelineRouter.post(
  '/:id/pipeline/retry',
  validate('json', retryPipelineRequestSchema),
  async c => {
    guardPermission(c, 'manage', 'App')
    const { db, tenantId, logger } = withAuthAndDb(c)
    const kind = c.req.valid('json').kind
    if (kind === 'create') await requirePublicUrl(db, c.get('config'))
    const id = uuidParam(c, 'id')
    // A run stuck on a dead instance is retryable without a page load first reconciling it.
    const app = await getAppRow(db, tenantId, id)
    await reconcilePipelineSafely(db, c.env, tenantId, app, kind, logger)
    const result = await retryPipeline(db, c.env, tenantId, id, kind, auditActor(c))
    return c.json(result, 202)
  }
)

/**
 * Re-scaffold an app that never deployed, from the current kit pin, keeping its repository,
 * database, storage, Workers, sign-in client and secrets. Requires `manage App`. 409
 * `run_not_failed`, `app_live`, `app_archived`, `app_already_deployed` or `no_run`; also refused
 * (409 `launch_not_reachable`) while Launch is not reachable. Audits `app.pipeline.rescaffolded`.
 */
appPipelineRouter.post('/:id/pipeline/rescaffold', async c => {
  guardPermission(c, 'manage', 'App')
  const { db, tenantId, logger } = withAuthAndDb(c)
  // The new scaffold job calls Launch back, as every create run's jobs do.
  await requirePublicUrl(db, c.get('config'))
  const id = uuidParam(c, 'id')
  const app = await getAppRow(db, tenantId, id)
  await reconcilePipelineSafely(db, c.env, tenantId, app, 'create', logger)
  const result: RescaffoldPipelineResponse = await rescaffoldPipeline(
    db,
    c.env,
    tenantId,
    id,
    auditActor(c),
    () => loadNeonClient(db, c.get('config'))
  )
  return c.json(result, 202)
})

/**
 * Cancel a create run that is still running (a stuck wait), so it can be retried. Requires `manage
 * App`. 409 `run_not_running`. Audits `app.pipeline.cancelled`.
 */
appPipelineRouter.post('/:id/pipeline/cancel', async c => {
  guardPermission(c, 'manage', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const result: CancelPipelineResponse = await cancelLaunch(
    db,
    c.env.APP_LAUNCH_WORKFLOW,
    tenantId,
    uuidParam(c, 'id'),
    auditActor(c)
  )
  return c.json(result)
})

/**
 * Start tearing an app down, after the caller confirms its slug. Requires `manage App`. 400
 * `confirm_slug_mismatch` for a wrong slug. Audits `app.teardown.requested`.
 */
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
