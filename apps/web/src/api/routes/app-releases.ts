/**
 * An app's releases under `/api/apps` (Launch P4, plan §1.8 / §4d), mounted by `routes/apps.ts`
 * with `appsRouter.route('/', appReleasesRouter)` BEFORE its own `/:slug` routes, behind the
 * `/api/apps` mount's `authMiddleware`, over `services/launch/releases/*`:
 *
 * - `GET /:id/releases` → `releaseListResponseSchema`, newest first (members read, `read App`);
 * - `POST /:id/releases` `createReleaseSchema` → 201 `releaseSchema` (the app's owners and
 *   admins, `mayDeployApp`): the version bump, the tag, the PR list, the audits, under the app's
 *   release claim (`releases/claim.ts`, issue #5). 409 `release_in_progress` (a session's landing
 *   or another person holds the claim) / `release_version_unreadable` / `release_tag_exists`, 502
 *   `release_github_failed`;
 * - `GET /:id/releases/:rid` → `releaseSchema`;
 * - `POST /:id/releases/:rid/promote` `promoteReleaseSchema` → 202 `promoteReleaseResponseSchema`
 *   (owners and admins): opens the `deploy.production` approval. 409 `release_not_on_staging` /
 *   `release_staging_unhealthy` / `release_not_promotable`;
 * - `GET /:id/releases/:rid/chain` → `releaseChainSchema`: PR → merge → tag → staging → approval
 *   → production, from the audit log;
 * - `POST /:id/releases/:rid/retry` `retryReleaseSchema` → 202 `retryReleaseResponseSchema` (owners
 *   and admins, app page P2): the stage-aware Retry (`releases/retry.ts`) — re-run the failed
 *   GitHub run, re-push a lost tag, probe health now or request approval again. 409
 *   `release_not_retryable` / `release_stage_changed` / `release_run_in_progress`, 502
 *   `release_github_failed`;
 * - `POST /:id/releases/:rid/cancel` → 202 `cancelReleaseResponseSchema` (owners and admins): cancel
 *   the release's deploy run in flight on GitHub (`releases/cancel.ts`). 409
 *   `release_not_cancellable`;
 * - `GET /:id/promotion` → `appPromotionSchema` (members read): the app page's pipeline strip —
 *   the newest release, what each environment runs, the PRs between with their sessions' titles,
 *   the pending `deploy.production` request with who it waits on, and — while the candidate is
 *   `tagged`/`staging` — its tag's deploy run on GitHub (`releases/promotion.ts`, `tag-run.ts`).
 *
 * Every lookup is tenant-first (`getAppRow`, then the release by app), so another organisation's
 * app or release is a 404. Each answer is parsed through its shared schema on the way out, with
 * the release's `failedStage` stamped (`releases/failed-stage.ts`).
 */
import { type AppPromotion, appPromotionSchema } from '@launch/shared/launch-promotion'
import {
  type CancelReleaseResponse,
  createReleaseSchema,
  type PromoteReleaseResponse,
  promoteReleaseSchema,
  RELEASE_ERROR_CODES,
  type Release,
  type ReleaseChain,
  type ReleaseListResponse,
  type RetryReleaseResponse,
  retryReleaseSchema,
} from '@launch/shared/launch-releases'
import type { Database } from '../../db/client'
import type { AppReleaseRow } from '../../db/schema'
import { guardPermission } from '../middleware/permissions'
import { getAppRow } from '../services/launch/apps'
import { auditActor } from '../services/launch/audit'
import { cancelRelease } from '../services/launch/releases/cancel'
import { releaseChain } from '../services/launch/releases/chain'
import { withReleaseClaim } from '../services/launch/releases/claim'
import {
  releaseViews,
  stageEnvironments,
  toReleaseView,
} from '../services/launch/releases/failed-stage'
import { promoteRelease } from '../services/launch/releases/promote'
import { appPromotion } from '../services/launch/releases/promotion'
import { createRelease, getRelease, listReleases } from '../services/launch/releases/release'
import { retryRelease } from '../services/launch/releases/retry'
import { ConflictError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { deployableApp } from './app-deploys'
import { approvalDepsOf } from './approvals'

export const appReleasesRouter = createRouter()

/** A row as the wire carries it, its `failedStage` stamped. */
async function toRelease(db: Database, row: AppReleaseRow): Promise<Release> {
  return toReleaseView(row, await stageEnvironments(db, row.tenantId, row.appId))
}

/** The app, for any member who may read it. */
async function readableApp(c: Parameters<typeof withAuthAndDb>[0]) {
  guardPermission(c, 'read', 'App')
  const ctx = withAuthAndDb(c)
  const app = await getAppRow(ctx.db, ctx.tenantId, uuidParam(c, 'id'))
  return { ...ctx, app }
}

appReleasesRouter.get('/:id/releases', async c => {
  const { db, tenantId, app } = await readableApp(c)
  const rows = await listReleases({ db }, { tenantId, appId: app.id })
  const body: ReleaseListResponse = { items: await releaseViews(db, tenantId, app.id, rows) }
  return c.json(body)
})

appReleasesRouter.post('/:id/releases', validate('json', createReleaseSchema), async c => {
  const ctx = await deployableApp(c)
  const deps = approvalDepsOf(c)
  // The app's release claim (issue #5, plan §1.8): a session's landing — or another person — may
  // be cutting one right now. Never wait in a request: answer 409 and let the person retry.
  const outcome = await withReleaseClaim(
    deps.db,
    { tenantId: ctx.tenantId, appId: ctx.app.id, holder: `user:${ctx.user.id}` },
    () =>
      createRelease(deps, {
        tenantId: ctx.tenantId,
        app: ctx.app,
        bump: c.req.valid('json').bump,
        userId: ctx.user.id,
        actor: auditActor(c),
      })
  )
  if (!outcome.claimed) {
    throw new ConflictError(
      'Another release of this app is being cut right now; try again in a minute',
      RELEASE_ERROR_CODES.inProgress
    )
  }
  return c.json(await toRelease(deps.db, outcome.value), 201)
})

appReleasesRouter.get('/:id/releases/:rid', async c => {
  const { db, tenantId, app } = await readableApp(c)
  const row = await getRelease({ db }, { tenantId, appId: app.id, releaseId: uuidParam(c, 'rid') })
  return c.json(await toRelease(db, row))
})

appReleasesRouter.post(
  '/:id/releases/:rid/promote',
  validate('json', promoteReleaseSchema),
  async c => {
    const ctx = await deployableApp(c)
    const deps = approvalDepsOf(c)
    const result = await promoteRelease(deps, {
      tenantId: ctx.tenantId,
      app: ctx.app,
      releaseId: uuidParam(c, 'rid'),
      user: { id: ctx.user.id, email: ctx.user.email, role: ctx.auth.tenantUser?.role ?? null },
      reason: c.req.valid('json').reason ?? null,
      actor: auditActor(c),
    })
    const body: PromoteReleaseResponse = {
      release: await toRelease(deps.db, result.release),
      approvalId: result.approvalId,
    }
    return c.json(body, 202)
  }
)

appReleasesRouter.post(
  '/:id/releases/:rid/retry',
  validate('json', retryReleaseSchema),
  async c => {
    const ctx = await deployableApp(c)
    const deps = approvalDepsOf(c)
    const body = c.req.valid('json')
    const outcome = await retryRelease(deps, {
      tenantId: ctx.tenantId,
      app: ctx.app,
      releaseId: uuidParam(c, 'rid'),
      expectedStage: body.stage,
      user: { id: ctx.user.id, email: ctx.user.email, role: ctx.auth.tenantUser?.role ?? null },
      reason: body.reason ?? null,
      actor: auditActor(c),
    })
    const answer: RetryReleaseResponse = {
      release: await toRelease(deps.db, outcome.release),
      stage: outcome.stage,
      action: outcome.action,
      attempt: outcome.attempt,
      runUrl: outcome.runUrl,
      approvalId: outcome.approvalId,
      health: outcome.health,
    }
    return c.json(answer, 202)
  }
)

appReleasesRouter.post('/:id/releases/:rid/cancel', async c => {
  const ctx = await deployableApp(c)
  const deps = approvalDepsOf(c)
  const result = await cancelRelease(deps, {
    tenantId: ctx.tenantId,
    app: ctx.app,
    releaseId: uuidParam(c, 'rid'),
    user: { id: ctx.user.id, email: ctx.user.email },
    actor: auditActor(c),
  })
  const answer: CancelReleaseResponse = {
    release: await toRelease(deps.db, result.release),
    runUrl: result.runUrl,
  }
  return c.json(answer, 202)
})

appReleasesRouter.get('/:id/releases/:rid/chain', async c => {
  const { db, tenantId, app } = await readableApp(c)
  const releaseId = uuidParam(c, 'rid')
  const release = await getRelease({ db }, { tenantId, appId: app.id, releaseId })
  const events = await releaseChain(db, { tenantId, appId: app.id, releaseId })
  const body: ReleaseChain = { release: await toRelease(db, release), events }
  return c.json(body)
})

appReleasesRouter.get('/:id/promotion', async c => {
  const { db, cfg, tenantId, logger, app } = await readableApp(c)
  const body: AppPromotion = appPromotionSchema.parse(
    await appPromotion(db, cfg, { tenantId, app }, { logger })
  )
  return c.json(body)
})
