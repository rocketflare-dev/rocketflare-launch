/**
 * An app's releases under `/api/apps` (Launch P4, plan §1.8 / §4d), mounted by `routes/apps.ts`
 * with `appsRouter.route('/', appReleasesRouter)` BEFORE its own `/:slug` routes, behind the
 * `/api/apps` mount's `authMiddleware`, over `services/launch/releases/*`:
 *
 * - `GET /:id/releases` → `releaseListResponseSchema`, newest first (members read, `read App`);
 * - `POST /:id/releases` `createReleaseSchema` → 201 `releaseSchema` (the app's owners and
 *   admins, `mayDeployApp`): the version bump, the tag, the PR list, the audits. 409
 *   `release_version_unreadable` / `release_tag_exists`, 502 `release_github_failed`;
 * - `GET /:id/releases/:rid` → `releaseSchema`;
 * - `POST /:id/releases/:rid/promote` `promoteReleaseSchema` → 202 `promoteReleaseResponseSchema`
 *   (owners and admins): opens the `deploy.production` approval. 409 `release_not_on_staging` /
 *   `release_staging_unhealthy` / `release_not_promotable`;
 * - `GET /:id/releases/:rid/chain` → `releaseChainSchema`: PR → merge → tag → staging → approval
 *   → production, from the audit log.
 *
 * Every lookup is tenant-first (`getAppRow`, then the release by app), so another organisation's
 * app or release is a 404. Each answer is parsed through its shared schema on the way out.
 */
import {
  createReleaseSchema,
  type PromoteReleaseResponse,
  promoteReleaseSchema,
  type Release,
  type ReleaseChain,
  type ReleaseListResponse,
  releaseSchema,
} from '@launch/shared/launch-releases'
import type { AppReleaseRow } from '../../db/schema'
import { guardPermission } from '../middleware/permissions'
import { getAppRow } from '../services/launch/apps'
import { auditActor } from '../services/launch/audit'
import { releaseChain } from '../services/launch/releases/chain'
import { promoteRelease } from '../services/launch/releases/promote'
import { createRelease, getRelease, listReleases } from '../services/launch/releases/release'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { deployableApp } from './app-deploys'
import { approvalDepsOf } from './approvals'

export const appReleasesRouter = createRouter()

/** A row as the wire carries it. */
function toRelease(row: AppReleaseRow): Release {
  return releaseSchema.parse(row)
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
  const body: ReleaseListResponse = { items: rows.map(toRelease) }
  return c.json(body)
})

appReleasesRouter.post('/:id/releases', validate('json', createReleaseSchema), async c => {
  const ctx = await deployableApp(c)
  const row = await createRelease(approvalDepsOf(c), {
    tenantId: ctx.tenantId,
    app: ctx.app,
    bump: c.req.valid('json').bump,
    userId: ctx.user.id,
    actor: auditActor(c),
  })
  return c.json(toRelease(row), 201)
})

appReleasesRouter.get('/:id/releases/:rid', async c => {
  const { db, tenantId, app } = await readableApp(c)
  const row = await getRelease({ db }, { tenantId, appId: app.id, releaseId: uuidParam(c, 'rid') })
  return c.json(toRelease(row))
})

appReleasesRouter.post(
  '/:id/releases/:rid/promote',
  validate('json', promoteReleaseSchema),
  async c => {
    const ctx = await deployableApp(c)
    const result = await promoteRelease(approvalDepsOf(c), {
      tenantId: ctx.tenantId,
      app: ctx.app,
      releaseId: uuidParam(c, 'rid'),
      user: { id: ctx.user.id, email: ctx.user.email, role: ctx.auth.tenantUser?.role ?? null },
      reason: c.req.valid('json').reason ?? null,
      actor: auditActor(c),
    })
    const body: PromoteReleaseResponse = {
      release: toRelease(result.release),
      approvalId: result.approvalId,
    }
    return c.json(body, 202)
  }
)

appReleasesRouter.get('/:id/releases/:rid/chain', async c => {
  const { db, tenantId, app } = await readableApp(c)
  const releaseId = uuidParam(c, 'rid')
  const release = await getRelease({ db }, { tenantId, appId: app.id, releaseId })
  const events = await releaseChain(db, { tenantId, appId: app.id, releaseId })
  const body: ReleaseChain = { release: toRelease(release), events }
  return c.json(body)
})
