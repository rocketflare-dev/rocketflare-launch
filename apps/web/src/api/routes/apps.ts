/**
 * `/api/apps` (spec/06) — the registry: the catalogue, one app's detail, import from a repo,
 * health (history + an on-demand check), the operations log and the app's OIDC client. Members
 * read (`read App`); admins and above manage (`manage App`).
 *
 * Reads are by SLUG (`GET /:slug`, the URL the console shows); everything under an app is by ID.
 * Every lookup is tenant-first (`services/launch/apps.ts`), so another tenant's app is a 404.
 *
 * P2 mounts two sub-routers first (`app-pipeline.ts`, `app-deploys.ts`), P3 a third
 * (`app-sessions.ts`, an app's coding sessions), P4 a fourth (`app-releases.ts`) and P5 two more
 * (`app-config.ts`, `app-config-scan.ts` — shared config and grants); see below.
 *
 * App thumbnails add a seventh (`app-thumbnail.ts`): the picture and "Refresh thumbnail". P6 6c
 * an eighth (`app-upgrades.ts`): `POST /:id/upgrade` — a kit upgrade session — and its history.
 *
 * Issue #5 adds `PUT /:id/ship-settings` (the app's owners and admins) and
 * `GET|POST /:id/branch-protection` (members read; admins apply Launch's ruleset).
 *
 * `POST /:id/health-check` probes inline rather than enqueueing: it is two GETs per environment
 * with a five-second cap, and the person who pressed the button is waiting for the answer.
 */
import {
  type AppListResponse,
  appHealthQuerySchema,
  importAppRequestSchema,
  putAppShipSettingsRequestSchema,
  updateAppRedirectUrisRequestSchema,
  updateAppRequestSchema,
} from '@launch/shared/launch-apps'
import { guardPermission } from '../middleware/permissions'
import {
  byEnvironmentOrder,
  getAppDetail,
  getAppRow,
  listApps,
  listHealthHistory,
  listOperations,
  toEnvironmentSummary,
  updateApp,
} from '../services/launch/apps'
import { auditActor } from '../services/launch/audit'
import {
  applyAppBranchProtection,
  getAppBranchProtection,
} from '../services/launch/branch-protection'
import { getSetting } from '../services/launch/credentials'
import { withLatestDeploys } from '../services/launch/deploy/progress'
import { checkAppHealth } from '../services/launch/health'
import { importApp } from '../services/launch/import'
import {
  createAppOidcClient,
  getAppOidcClient,
  rotateAppOidcSecret,
  toAppOidcClient,
  updateAppRedirectUris,
} from '../services/launch/oidc-clients'
import { updateShipSettings } from '../services/launch/ship-settings'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { appConfigRouter } from './app-config'
import { appConfigScanRouter } from './app-config-scan'
import { appDeploysRouter, appViewer, deployableApp } from './app-deploys'
import { appPipelineRouter } from './app-pipeline'
import { appReleasesRouter } from './app-releases'
import { appSessionsRouter } from './app-sessions'
import { appThumbnailRouter } from './app-thumbnail'
import { appUpgradesRouter } from './app-upgrades'

export const appsRouter = createRouter()

// Launch P2: creating an app (`POST /`, `/:id/pipeline…`, `/:id/teardown`) and its deploys
// (`/:id/deploys…`) live in their own files. Mounted FIRST: Hono matches in registration order,
// and nothing here may be shadowed by `GET /:slug` below.
appsRouter.route('/', appPipelineRouter)
appsRouter.route('/', appDeploysRouter)
// Launch P3: `POST|GET /:id/sessions` — starting and listing an app's coding sessions.
appsRouter.route('/', appSessionsRouter)
// Launch P4: `GET|POST /:id/releases`, `…/:rid`, `…/:rid/promote`, `…/:rid/chain`.
appsRouter.route('/', appReleasesRouter)
// Launch P5: `GET /:id/config`, `POST /:id/grants`, `DELETE /:id/grants/:gid`, `…/:gid/repush`
// (5d), and `POST /:id/config/scan` (5e).
appsRouter.route('/', appConfigRouter)
appsRouter.route('/', appConfigScanRouter)
// App thumbnails: `GET /:id/thumbnail`, `POST /:id/thumbnail/refresh`.
appsRouter.route('/', appThumbnailRouter)
// P6 6c: `POST /:id/upgrade` (a kit upgrade session) and `GET /:id/upgrades`.
appsRouter.route('/', appUpgradesRouter)

appsRouter.get('/', async c => {
  guardPermission(c, 'read', 'App')
  const { db, cfg, tenantId, logger } = withAuthAndDb(c)
  const [summaries, appsDomain] = await Promise.all([
    listApps(db, tenantId),
    getSetting<string>(db, 'apps_domain'),
  ])
  // Each row's latest deploy (in progress first), after polling the run of any in progress.
  const items = await withLatestDeploys(db, cfg, tenantId, summaries, { logger })
  const body: AppListResponse = {
    items,
    appsDomain: typeof appsDomain === 'string' ? appsDomain : null,
  }
  return c.json(body)
})

appsRouter.post('/import', validate('json', importAppRequestSchema), async c => {
  guardPermission(c, 'manage', 'App')
  const { db, cfg, tenantId, realtime } = withAuthAndDb(c)
  // The post-import config scan's `grant_needed` notification nudges the bell live (P5).
  const { app } = await importApp(db, cfg, tenantId, c.req.valid('json'), auditActor(c), {
    realtime,
  })
  return c.json(await getAppDetail(db, tenantId, app.slug, appViewer(c)), 201)
})

appsRouter.get('/:slug', async c => {
  guardPermission(c, 'read', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  return c.json(await getAppDetail(db, tenantId, c.req.param('slug'), appViewer(c)))
})

appsRouter.patch('/:id', validate('json', updateAppRequestSchema), async c => {
  guardPermission(c, 'manage', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const app = await updateApp(db, tenantId, uuidParam(c, 'id'), c.req.valid('json'), auditActor(c))
  return c.json(await getAppDetail(db, tenantId, app.slug, appViewer(c)))
})

// Issue #5 (plan §1.10): where a session's Ship ends and who reviews its merge — the app's owners
// and admins (`mayDeployApp`, the same rule as its deploys). Answers the app detail.
appsRouter.put('/:id/ship-settings', validate('json', putAppShipSettingsRequestSchema), async c => {
  const { db, tenantId, app } = await deployableApp(c)
  const updated = await updateShipSettings(db, tenantId, app, c.req.valid('json'), auditActor(c))
  return c.json(await getAppDetail(db, tenantId, updated.slug, appViewer(c)))
})

// Issue #5 (plan §1.13): how GitHub protects the default branch (`appBranchProtectionSchema`),
// read by any member; applying Launch's `launch` ruleset is the admins' (`manage App`).
appsRouter.get('/:id/branch-protection', async c => {
  guardPermission(c, 'read', 'App')
  const { db, cfg, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  return c.json(await getAppBranchProtection(db, cfg, app))
})

appsRouter.post('/:id/branch-protection', async c => {
  guardPermission(c, 'manage', 'App')
  const { db, cfg, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  return c.json(await applyAppBranchProtection(db, cfg, tenantId, app, auditActor(c)))
})

appsRouter.get('/:id/health', validate('query', appHealthQuerySchema), async c => {
  guardPermission(c, 'read', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  return c.json(await listHealthHistory(db, tenantId, app.id, c.req.valid('query').hours))
})

appsRouter.post('/:id/health-check', async c => {
  guardPermission(c, 'manage', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  const rows = await checkAppHealth(db, tenantId, app.id)
  return c.json({ environments: rows.sort(byEnvironmentOrder).map(toEnvironmentSummary) })
})

appsRouter.get('/:id/operations', async c => {
  guardPermission(c, 'read', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  return c.json({ items: await listOperations(db, tenantId, app.id) })
})

appsRouter.get('/:id/oidc-client', async c => {
  guardPermission(c, 'read', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  const row = await getAppOidcClient(db, tenantId, app.id)
  return c.json({ client: row ? toAppOidcClient(row) : null })
})

appsRouter.post('/:id/oidc-client', async c => {
  guardPermission(c, 'manage', 'App')
  const { db, cfg, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  return c.json(await createAppOidcClient(db, cfg, tenantId, app, auditActor(c)), 201)
})

appsRouter.post('/:id/oidc-client/rotate-secret', async c => {
  guardPermission(c, 'manage', 'App')
  const { db, cfg, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  return c.json(await rotateAppOidcSecret(db, cfg, tenantId, app, auditActor(c)))
})

appsRouter.patch(
  '/:id/oidc-client/redirect-uris',
  validate('json', updateAppRedirectUrisRequestSchema),
  async c => {
    guardPermission(c, 'manage', 'App')
    const { db, tenantId } = withAuthAndDb(c)
    const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
    const client = await updateAppRedirectUris(
      db,
      tenantId,
      app,
      c.req.valid('json'),
      auditActor(c)
    )
    return c.json({ client })
  }
)
