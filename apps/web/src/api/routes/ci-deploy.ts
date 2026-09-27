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
 * | `POST /:id/finish`       | 200 `{ id, status }`, idempotent, on any ticket this run owns     |
 *
 * Every call: `verifyGitHubOidc(bearer, { audience: APP_URL })` (401) → `resolveCaller(…, {
 * workflowFile: 'deploy.yml' })` (403) → for a ticket, the run attempt and environment that opened
 * it (403) — see `services/launch/deploy/gateway.ts`. Non-2xx bodies are the shared envelope,
 * whose `error` is what the job prints. Mounted by `routes/ci.ts`; public by design.
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
import { getTicketById } from '../services/launch/deploy/tickets'
import type { AppContext } from '../types'
import { uuidParam } from '../utils/routes/route-helpers'
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
  return {
    db,
    caller,
    // A CI job is not a person: the app acts, and the run is named in every summary.
    actor: { ...auditActor(c), actorType: 'app', actorUserId: null, actorEmail: null },
    vendors: () => loadDeployVendors(db, cfg),
    launchWorkflow: c.env.APP_LAUNCH_WORKFLOW,
    logger: c.get('logger'),
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
  return c.json(ticketState(await finishDeploy(ctx, ticket), ctx.caller.environment.name))
})
