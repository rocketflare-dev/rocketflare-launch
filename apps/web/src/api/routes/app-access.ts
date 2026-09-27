/**
 * `/api/app-access` (spec/05) — who may sign in to an app through Launch, the P1 stand-in for the
 * P4 approvals. Mounted behind `authMiddleware`; every query is scoped to the session's tenant.
 *
 * For anyone signed in (the request-access page):
 * - `GET /request-context?clientId=` — which app, and where they stand with it
 * - `POST /requests { clientId, message? }` — ask the app's owners (`app.access.requested`)
 *
 * For the app's OWNERS and the organisation's admins (`manage App`), where `:app` is the app's id
 * or slug — anyone else gets the same 404 as a missing app:
 * - `GET|PUT /:app/policy` — `company` or `restricted` (`app.access.policy_changed`)
 * - `GET|POST /:app/grants`, `DELETE /:app/grants/:grantId` — group and person grants (also
 *   `app.access.policy_changed`: a grant changes who may sign in exactly as the policy does)
 * - `GET /:app/requests?status=`, `POST /:app/requests/:id/decide` — approve (adds a user grant)
 *   or reject (`app.access.decided`); a compare-and-set, so a second decider gets 409
 *
 * The policy, grants and requests hang off the app's OIDC client; an app without one yet answers
 * 409 `oidc_client_missing` for everything but the policy read.
 */
import {
  appAccessRequestContextQuerySchema,
  appAccessRequestListQuerySchema,
  createAppAccessGrantSchema,
  createAppAccessRequestSchema,
  decideAppAccessRequestSchema,
  updateAppAccessPolicySchema,
} from '@launch/shared/launch-oidc'
import { can } from '../middleware/permissions'
import { auditActor, recordAudit } from '../services/launch/audit'
import {
  addGrant,
  clientForApp,
  decideRequest,
  findAppByRef,
  findClientAppInTenant,
  isAppOwner,
  listGrants,
  listRequests,
  removeGrant,
  requestAccess,
  requireClient,
  setAccessPolicy,
  standingOf,
} from '../services/oidc/policy'
import type { AppContext } from '../types'
import { NotFoundError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const appAccessRouter = createRouter()

const toApp = (app: { id: string; slug: string; displayName: string }) => ({
  id: app.id,
  slug: app.slug,
  displayName: app.displayName,
})

/** The app named by `:app`, if the caller may manage its access; the same 404 otherwise. */
async function managedApp(c: AppContext) {
  const ctx = withAuthAndDb(c)
  const app = await findAppByRef(ctx.db, ctx.tenantId, c.req.param('app') ?? '')
  const admin = can(c, 'manage', 'App')
  const owner =
    admin ||
    (await isAppOwner(
      ctx.db,
      ctx.tenantId,
      app,
      ctx.user.id,
      ctx.auth.groups.map(g => g.id)
    ))
  if (!owner) throw new NotFoundError('App not found')
  const client = await clientForApp(ctx.db, ctx.tenantId, app.id)
  return { ...ctx, app, client }
}

// ---- The requester's side ------------------------------------------------------------------

appAccessRouter.get(
  '/request-context',
  validate('query', appAccessRequestContextQuerySchema),
  async c => {
    const { db, tenantId, user } = withAuthAndDb(c)
    const { clientId } = c.req.valid('query')
    const { client, app } = await findClientAppInTenant(db, tenantId, clientId)
    return c.json({ app: toApp(app), standing: await standingOf(db, client, user.id) })
  }
)

appAccessRouter.post('/requests', validate('json', createAppAccessRequestSchema), async c => {
  const { db, tenantId, user } = withAuthAndDb(c)
  const body = c.req.valid('json')
  const { client, app } = await findClientAppInTenant(db, tenantId, body.clientId)
  const result = await requestAccess(db, { client, userId: user.id, message: body.message })
  if (result.created && result.request) {
    await recordAudit(db, {
      tenantId,
      ...auditActor(c),
      action: 'app.access.requested',
      targetType: 'app_access_request',
      targetId: result.request.id,
      appId: app.id,
      summary: { after: { status: 'pending' } },
    })
  }
  return c.json({ standing: result.standing, request: result.request }, result.created ? 201 : 200)
})

// ---- The owner's side ----------------------------------------------------------------------

appAccessRouter.get('/:app/policy', async c => {
  const { app, client } = await managedApp(c)
  return c.json({
    app: toApp(app),
    hasClient: Boolean(client),
    clientId: client?.clientId ?? null,
    accessPolicy: client?.accessPolicy ?? null,
  })
})

appAccessRouter.put('/:app/policy', validate('json', updateAppAccessPolicySchema), async c => {
  const ctx = await managedApp(c)
  const client = requireClient(ctx.client)
  const { accessPolicy } = c.req.valid('json')
  const before = await setAccessPolicy(ctx.db, client, accessPolicy)
  if (before !== accessPolicy) {
    await recordAudit(ctx.db, {
      tenantId: ctx.tenantId,
      ...auditActor(c),
      action: 'app.access.policy_changed',
      targetType: 'oidc_client',
      targetId: client.clientId,
      appId: ctx.app.id,
      summary: { before: { accessPolicy: before }, after: { accessPolicy } },
    })
  }
  return c.json({
    app: toApp(ctx.app),
    hasClient: true,
    clientId: client.clientId,
    accessPolicy,
  })
})

appAccessRouter.get('/:app/grants', async c => {
  const ctx = await managedApp(c)
  return c.json({ items: await listGrants(ctx.db, requireClient(ctx.client)) })
})

appAccessRouter.post('/:app/grants', validate('json', createAppAccessGrantSchema), async c => {
  const ctx = await managedApp(c)
  const client = requireClient(ctx.client)
  const grantee = await addGrant(ctx.db, client, c.req.valid('json'), ctx.user.id)
  await recordAudit(ctx.db, {
    tenantId: ctx.tenantId,
    ...auditActor(c),
    action: 'app.access.policy_changed',
    targetType: 'oidc_client',
    targetId: client.clientId,
    appId: ctx.app.id,
    summary: {
      after: grantee.groupId
        ? { grantAdded: 'group', groupId: grantee.groupId, name: grantee.label }
        : { grantAdded: 'user', userId: grantee.userId, email: grantee.label },
    },
  })
  return c.json({ items: await listGrants(ctx.db, client) }, 201)
})

appAccessRouter.delete('/:app/grants/:grantId', async c => {
  const ctx = await managedApp(c)
  const client = requireClient(ctx.client)
  const removed = await removeGrant(ctx.db, client, uuidParam(c, 'grantId'))
  await recordAudit(ctx.db, {
    tenantId: ctx.tenantId,
    ...auditActor(c),
    action: 'app.access.policy_changed',
    targetType: 'oidc_client',
    targetId: client.clientId,
    appId: ctx.app.id,
    summary: {
      before: removed.groupId
        ? { grantRemoved: 'group', groupId: removed.groupId }
        : { grantRemoved: 'user', userId: removed.userId },
    },
  })
  return c.body(null, 204)
})

appAccessRouter.get(
  '/:app/requests',
  validate('query', appAccessRequestListQuerySchema),
  async c => {
    const ctx = await managedApp(c)
    const { status } = c.req.valid('query')
    return c.json({ items: await listRequests(ctx.db, ctx.tenantId, ctx.app.id, status) })
  }
)

appAccessRouter.post(
  '/:app/requests/:id/decide',
  validate('json', decideAppAccessRequestSchema),
  async c => {
    const ctx = await managedApp(c)
    const client = requireClient(ctx.client)
    const { decision } = c.req.valid('json')
    const request = await decideRequest(ctx.db, {
      client,
      requestId: uuidParam(c, 'id'),
      decision,
      decidedByUserId: ctx.user.id,
    })
    await recordAudit(ctx.db, {
      tenantId: ctx.tenantId,
      ...auditActor(c),
      action: 'app.access.decided',
      targetType: 'app_access_request',
      targetId: request.id,
      appId: ctx.app.id,
      summary: {
        before: { status: 'pending' },
        after: { status: request.status, userId: request.userId },
      },
    })
    return c.json(request)
  }
)
