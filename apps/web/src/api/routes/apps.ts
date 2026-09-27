/**
 * `/api/apps` (spec/06) — the registry: the catalogue, one app's detail, import from a repo,
 * health (history + an on-demand check), the operations log and the app's OIDC client. Members
 * read (`read App`); admins and above manage (`manage App`).
 *
 * Reads are by SLUG (`GET /:slug`, the URL the console shows); everything under an app is by ID.
 * Every lookup is tenant-first (`services/launch/apps.ts`), so another tenant's app is a 404.
 *
 * P2 mounts two sub-routers first (`app-pipeline.ts`, `app-deploys.ts`); see below.
 *
 * `POST /:id/health-check` probes inline rather than enqueueing: it is two GETs per environment
 * with a five-second cap, and the person who pressed the button is waiting for the answer.
 */
import {
  appHealthQuerySchema,
  importAppRequestSchema,
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
import { getSetting } from '../services/launch/credentials'
import { checkAppHealth } from '../services/launch/health'
import { importApp } from '../services/launch/import'
import {
  createAppOidcClient,
  getAppOidcClient,
  rotateAppOidcSecret,
  toAppOidcClient,
  updateAppRedirectUris,
} from '../services/launch/oidc-clients'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { appDeploysRouter, appViewer } from './app-deploys'
import { appPipelineRouter } from './app-pipeline'

export const appsRouter = createRouter()

// Launch P2: creating an app (`POST /`, `/:id/pipeline…`, `/:id/teardown`) and its deploys
// (`/:id/deploys…`) live in their own files. Mounted FIRST: Hono matches in registration order,
// and nothing here may be shadowed by `GET /:slug` below.
appsRouter.route('/', appPipelineRouter)
appsRouter.route('/', appDeploysRouter)

appsRouter.get('/', async c => {
  guardPermission(c, 'read', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const [items, appsDomain] = await Promise.all([
    listApps(db, tenantId),
    getSetting<string>(db, 'apps_domain'),
  ])
  return c.json({ items, appsDomain: typeof appsDomain === 'string' ? appsDomain : null })
})

appsRouter.post('/import', validate('json', importAppRequestSchema), async c => {
  guardPermission(c, 'manage', 'App')
  const { db, cfg, tenantId } = withAuthAndDb(c)
  const { app } = await importApp(db, cfg, tenantId, c.req.valid('json'), auditActor(c))
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
