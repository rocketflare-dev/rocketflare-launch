/**
 * `/api/admin/*` (D10, D25, D30) behind `globalAdminMiddleware` — the only cross-tenant surface:
 * organisations (list, detail, suspend, enter/leave as support), users (the global-admin flag,
 * blocking) and feature flags. Thin: every operation lives in services/admin.ts. `GET /tenants`
 * (the list) is 404 `tenancy_mode_single` in single mode; detail, suspend and support enter/leave
 * still work. The access-request queue moved to `/api/platform/access-requests`
 * (`platform-access-requests.ts`), which a single-mode owner/admin may also reach.
 */
import {
  adminTenantListQuerySchema,
  adminUserListQuerySchema,
  blockUserRequestSchema,
  setGlobalAdminRequestSchema,
  suspendTenantRequestSchema,
} from '@launch/shared/admin'
import {
  isFeatureName,
  setTenantOverrideRequestSchema,
  updateFeatureFlagRequestSchema,
} from '@launch/shared/features'
import type { FeatureName } from '@launch/shared/permissions'
import { resolveCookieAuth } from '../middleware/auth'
import {
  enterSupport,
  getAdminTenant,
  getAdminUser,
  leaveSupport,
  listAdminTenants,
  listAdminUsers,
  setGlobalAdmin,
  setTenantSuspended,
  setUserBlocked,
} from '../services/admin'
import { buildSessionResponse } from '../services/auth'
import {
  clearTenantOverride,
  listFeatureFlags,
  listFlagOverrides,
  setTenantOverride,
  updateFeatureFlag,
} from '../services/features'
import { nudge, realtimeEvent } from '../services/realtime'
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../utils/core/errors'
import { paginated } from '../utils/routes/pagination'
import { requireMultiTenant, uuidParam, withAuth } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const adminRouter = createRouter()

// ---- Tenants --------------------------------------------------------------------------------

adminRouter.get('/tenants', validate('query', adminTenantListQuerySchema), async c => {
  const { db, cfg } = withAuth(c)
  requireMultiTenant(cfg)
  const query = c.req.valid('query')
  const { items, total } = await listAdminTenants(db, query)
  return c.json(paginated(items, total, query))
})

adminRouter.get('/tenants/:id', async c => {
  const { db, user } = withAuth(c)
  return c.json(await getAdminTenant(db, uuidParam(c, 'id'), user.id))
})

adminRouter.post('/tenants/:id/suspend', validate('json', suspendTenantRequestSchema), async c => {
  const { db, user } = withAuth(c)
  const row = await setTenantSuspended(db, uuidParam(c, 'id'), c.req.valid('json').suspended, user)
  return c.json({ id: row.id, status: row.status })
})

adminRouter.post('/tenants/:id/support/enter', async c => {
  const { db, cfg, user, auth } = withAuth(c)
  await enterSupport(db, uuidParam(c, 'id'), user, auth.session.id)
  const refreshed = await resolveCookieAuth(c)
  if (!refreshed) throw new UnauthorizedError()
  return c.json(await buildSessionResponse(db, cfg, refreshed))
})

adminRouter.post('/tenants/:id/support/leave', async c => {
  const { db, cfg, user, auth } = withAuth(c)
  await leaveSupport(db, uuidParam(c, 'id'), user, auth.session.id)
  const refreshed = await resolveCookieAuth(c)
  if (!refreshed) throw new UnauthorizedError()
  return c.json(await buildSessionResponse(db, cfg, refreshed))
})

// ---- Users ----------------------------------------------------------------------------------

adminRouter.get('/users', validate('query', adminUserListQuerySchema), async c => {
  const { db } = withAuth(c)
  const query = c.req.valid('query')
  const { items, total } = await listAdminUsers(db, query)
  return c.json(paginated(items, total, query))
})

adminRouter.get('/users/:id', async c => {
  const { db } = withAuth(c)
  return c.json(await getAdminUser(db, uuidParam(c, 'id')))
})

adminRouter.post(
  '/users/:id/global-admin',
  validate('json', setGlobalAdminRequestSchema),
  async c => {
    const { db, user } = withAuth(c)
    const updated = await setGlobalAdmin(db, {
      userId: uuidParam(c, 'id'),
      isGlobalAdmin: c.req.valid('json').isGlobalAdmin,
      actor: user,
    })
    return c.json({ id: updated.id, isGlobalAdmin: updated.isGlobalAdmin })
  }
)

adminRouter.post('/users/:id/block', validate('json', blockUserRequestSchema), async c => {
  const { db, user } = withAuth(c)
  const id = uuidParam(c, 'id')
  if (id === user.id) throw new ForbiddenError('You cannot block yourself')
  const updated = await setUserBlocked(db, { userId: id, blocked: c.req.valid('json').blocked })
  return c.json({ id: updated.id, blockedAt: updated.blockedAt })
})

// ---- Feature flags (D30) ----------------------------------------------------------------------

/**
 * Keys come from the shared registry, never from the request: a flag that no code reads does
 * nothing, so there is no "create" here and an unknown key is simply not found.
 */
function featureParam(c: Parameters<typeof withAuth>[0]): FeatureName {
  const key = c.req.param('key')
  if (!key || !isFeatureName(key)) throw new NotFoundError(`Not found: ${key ?? 'feature'}`)
  return key
}

adminRouter.get('/feature-flags', async c => {
  const { db, cfg } = withAuth(c)
  return c.json({ items: await listFeatureFlags(db, cfg) })
})

adminRouter.patch(
  '/feature-flags/:key',
  validate('json', updateFeatureFlagRequestSchema),
  async c => {
    const { db, cfg, user } = withAuth(c)
    const key = featureParam(c)
    const patch = c.req.valid('json')
    // A percentage over ONE organisation is all-or-nothing decided by an opaque hash, which reads
    // as a bug rather than a rollout. Fail loud instead of degrading quietly.
    if (cfg.TENANCY_MODE === 'single') {
      const unit = patch.rolloutUnit
      if (patch.state === 'rollout' && unit !== 'user') {
        throw new ValidationError(
          { rolloutUnit: 'Must be "user" in single-tenant mode.' },
          'There is only one organisation, so a rollout counted in organisations is all-or-nothing. Count people instead.'
        )
      }
    }
    return c.json(await updateFeatureFlag(db, cfg, key, patch, user.id))
  }
)

adminRouter.get('/feature-flags/:key/overrides', async c => {
  const { db, cfg } = withAuth(c)
  // One organisation means the platform state already IS that organisation's answer.
  requireMultiTenant(cfg)
  return c.json({ items: await listFlagOverrides(db, featureParam(c)) })
})

adminRouter.put(
  '/feature-flags/:key/overrides/:tenantId',
  validate('json', setTenantOverrideRequestSchema),
  async c => {
    const { db, cfg, user, realtime } = withAuth(c)
    requireMultiTenant(cfg)
    const key = featureParam(c)
    const tenantId = uuidParam(c, 'tenantId')
    await setTenantOverride(db, key, tenantId, c.req.valid('json').enabled, user.id)
    // What EXISTS for this organisation just moved, and features ride the session — so the nudge
    // has to invalidate auth, not just a list. Only the affected tenant is touched: a platform
    // change would mean one RPC per tenant, which is why it is left to the next session fetch.
    nudge(realtime, realtimeEvent('features.changed', tenantId))
    return c.body(null, 204)
  }
)

adminRouter.delete('/feature-flags/:key/overrides/:tenantId', async c => {
  const { db, cfg, realtime } = withAuth(c)
  requireMultiTenant(cfg)
  const key = featureParam(c)
  const tenantId = uuidParam(c, 'tenantId')
  await clearTenantOverride(db, key, tenantId)
  nudge(realtime, realtimeEvent('features.changed', tenantId))
  return c.body(null, 204)
})
