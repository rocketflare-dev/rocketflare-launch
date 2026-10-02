/**
 * `/ci/deploy` (Launch P2, slice 2d) — the external deployer protocol v1, exactly as the kit's
 * `docs/DEPLOYER.md` states it and `scripts/deployer.mjs` calls it (`DEPLOYER_URL` = `${APP_URL}/ci`,
 * `DEPLOYER_AUDIENCE` = `APP_URL`):
 *
 * | Route                    | Answers                                                           |
 * |--------------------------|-------------------------------------------------------------------|
 * | `POST /start`            | 200 `{ id, status }`; 400 `{ error, supported: [1] }` for another protocol |
 * | `GET /:id`               | 200 `{ id, status, … }` — the job polls it until `approved` / `rejected` |
 * | `POST /:id/upload`       | 200 `{ id, status: 'uploaded', versionId, migratorUrl }`; 409 unless `approved`; 403 `{ error, refused }` |
 * | `POST /:id/activate`     | 200 `{ id, status: 'active' }`; 409 unless `uploaded`             |
 * | `POST /:id/finish`       | 200 `{ id, status, error? }`, idempotent, on any ticket this run owns; `error: 'finished before activate'` when it closed an unactivated deploy |
 *
 * Every call: `verifyGitHubOidc(bearer, { audience: APP_URL })` (401) → `resolveCaller(…, {
 * workflowFile: 'deploy.yml' })` (403) → for a ticket, the run attempt and environment that opened
 * it (403) — see `services/launch/deploy/gateway.ts`. Non-2xx bodies are the shared envelope,
 * whose `error` is what the job prints. Mounted by `routes/ci.ts`; public by design.
 *
 * The call that closes a DEPLOYED ticket also probes the app's health and queues its thumbnail
 * (`app.thumbnail`, `services/launch/thumbnails`) — neither can fail the deploy.
 *
 * `migratorUrl` is a credential. It is in the upload response and nowhere else — no log line, no
 * row, no audit summary.
 */
import { deployStartSchema, deployUploadSchema } from '@launch/shared/launch-pipeline'
import { auditActor } from '../services/launch/audit'
import { resolveCaller } from '../services/launch/ci/caller'
import { bearerToken, verifyGitHubOidc } from '../services/launch/ci/github-oidc'
import { DEPLOY_WORKFLOW_FILE } from '../services/launch/deploy/decisions'
import {
  activateDeploy,
  assertRunOwnsTicket,
  finishDeploy,
  type GatewayContext,
  getDeploy,
  loadDeployVendors,
  startDeploy,
  ticketState,
  uploadDeploy,
} from '../services/launch/deploy/gateway'
import { getTicketById, isDeployed } from '../services/launch/deploy/tickets'
import { checkAppHealth } from '../services/launch/health'
import { enqueueThumbnailAfterDeploy } from '../services/launch/thumbnails/thumbnails'
import type { AppContext } from '../types'
import { loggerFor } from '../utils/core/logger'
import { makeDefer, uuidParam } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const ciDeployRouter = createRouter()

/**
 * The proven caller of each request, keyed by the raw Request: the proof runs as the router's
 * first middleware, so a job without a valid token gets its 401/403 before any body validation.
 */
const proven = new WeakMap<Request, GatewayContext>()

ciDeployRouter.use('*', async (c, next) => {
  proven.set(c.req.raw, await proveJob(c))
  await next()
})

function gatewayFor(c: AppContext): GatewayContext {
  const ctx = proven.get(c.req.raw)
  if (!ctx) throw new Error('ci-deploy: the job was not proven before its handler ran')
  return ctx
}

/** Prove the job (401/403) and build the gateway's context around it. */
async function proveJob(c: AppContext): Promise<GatewayContext> {
  const cfg = c.get('config')
  const db = c.get('db')
  const claims = await verifyGitHubOidc(bearerToken(c.req.header('authorization')), {
    audience: cfg.APP_URL,
  })
  const caller = await resolveCaller(db, claims, { workflowFile: DEPLOY_WORKFLOW_FILE })
  const logger = c.get('logger')
  return {
    db,
    caller,
    // A CI job is not a person: the app acts, and the run is named in every summary.
    actor: { ...auditActor(c), actorType: 'app', actorUserId: null, actorEmail: null },
    vendors: () => loadDeployVendors(db, cfg),
    launchWorkflow: c.env.APP_LAUNCH_WORKFLOW,
    logger,
    // P4: a production run with nothing to claim opens a `deploy.production` approval.
    // (`approvalDepsOf` in `approvals.ts` needs a session; a CI job has none, so built here.)
    approvals: {
      db,
      env: c.env,
      cfg,
      logger: loggerFor(cfg, { component: 'approvals' }),
      realtime: { defer: makeDefer(c), env: c.env },
    },
  }
}

/** The gateway context plus the ticket named by `:id`, which this run must own. */
async function ticketFor(c: AppContext) {
  const ctx = gatewayFor(c)
  const id = uuidParam(c, 'id')
  const ticket = assertRunOwnsTicket(ctx.caller, await getTicketById(ctx.db, id))
  return { ctx, ticket }
}

ciDeployRouter.post('/start', validate('json', deployStartSchema), async c => {
  const ctx = gatewayFor(c)
  const ticket = await startDeploy(ctx, c.req.valid('json'))
  return c.json(ticketState(ticket, ctx.caller.environment.name))
})

ciDeployRouter.get('/:id', async c => {
  const { ctx, ticket } = await ticketFor(c)
  return c.json(ticketState(await getDeploy(ctx, ticket), ctx.caller.environment.name))
})

ciDeployRouter.post('/:id/upload', validate('json', deployUploadSchema), async c => {
  const { ctx, ticket } = await ticketFor(c)
  const { ticket: uploaded, migratorUrl } = await uploadDeploy(ctx, ticket, c.req.valid('json'))
  return c.json({
    ...ticketState(uploaded, ctx.caller.environment.name),
    status: 'uploaded' as const,
    versionId: uploaded.cfVersionId,
    migratorUrl,
  })
})

ciDeployRouter.post('/:id/activate', async c => {
  const { ctx, ticket } = await ticketFor(c)
  return c.json(ticketState(await activateDeploy(ctx, ticket), ctx.caller.environment.name))
})

ciDeployRouter.post('/:id/finish', async c => {
  const { ctx, ticket } = await ticketFor(c)
  const closed = await finishDeploy(ctx, ticket)
  // The new version is serving: read its health now rather than at the next poll, so the app page
  // (and Promote) judge THIS version. The job is waiting on this answer anyway; a probe that fails
  // is logged, never the deploy's failure.
  if (isDeployed(closed)) {
    try {
      await checkAppHealth(ctx.db, ctx.caller.tenantId, ctx.caller.app.id)
    } catch (err) {
      ctx.logger?.warn(
        { ticketId: closed.id, err: err instanceof Error ? err.message : String(err) },
        'deploy: the post-deploy health check failed'
      )
    }
  }
  // The app's thumbnail follows the version now serving: queued on the call that CLOSED a deployed
  // ticket (a repeated `finish` queues nothing), and skipped when that version is already pictured.
  // Only enqueued — never awaited work, and never the deploy's failure.
  if (isDeployed(closed) && !ticket.finishedAt) {
    await enqueueThumbnailAfterDeploy(
      ctx.db,
      c.env.JOBS_QUEUE,
      {
        tenantId: ctx.caller.tenantId,
        appId: ctx.caller.app.id,
        environment: ctx.caller.environment.name,
        version: closed.version,
      },
      ctx.logger
    )
  }
  return c.json(ticketState(closed, ctx.caller.environment.name))
})
