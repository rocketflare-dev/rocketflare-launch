/**
 * `/api/platform/kits` (D36 K1, `docs/plans/multi-kit.md`) — the kit catalogue. Mounted under
 * `/api/platform`, so `platformAdminMiddleware` already applies: 401 without a session, 403 unless
 * `canAdministerPlatform`, never a Bearer key that is not admin-scoped.
 *
 *   GET    /                 every kit, the default first (the built-in Rocketflare row created
 *                            when the catalogue is empty)
 *   GET    /:id              one kit (uuid or slug) with its manifest snapshot
 *   POST   /                 register: repo + tag|commit|latest → resolved, manifest read,
 *                            conformance checked, stored (failed kits too) → kit.added
 *   POST   /:id/check        re-read and re-check at the current pin → kit.checked
 *   PUT    /:id/pin          re-pin (resolved, checked at the new pin) → kit.pinned
 *   PUT    /:id/default      make it the kit new apps are cut from → kit.default_set
 *   DELETE /:id              409 for the default and for a kit with apps → kit.removed
 *
 * GitHub failures are 502 `github_lookup_failed`; a ref the repo does not have is 422
 * `kit_ref_not_found`; no GitHub App is 409 `github_app_not_configured`. Audit rows go to the
 * admin's session tenant, else the deployment's one (`setup.ts` "Audit tenant"); with neither,
 * the change is refused (409 `no_audit_tenant`) before anything is written.
 */
import { kitAddRequestSchema, kitIdParamSchema, kitPinRequestSchema } from '@launch/shared/kits'
import type { Database } from '../../db/client'
import { auditActor } from '../services/launch/audit'
import {
  addKit,
  checkKit,
  type KitActionContext,
  listCatalogue,
  makeDefaultKit,
  pinKit,
  removeKit,
  showKit,
} from '../services/launch/kits/service'
import type { AppContext } from '../types'
import { ConflictError } from '../utils/core/errors'
import { getSingleTenant } from '../utils/db/tenant-helpers'
import { withAuth } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const kitsRouter = createRouter()

/** The tenant an audit row for a platform action goes to — see the header. */
async function auditTenant(db: Database, sessionTenantId: string | null): Promise<string> {
  if (sessionTenantId) return sessionTenantId
  const single = await getSingleTenant(db)
  if (!single) {
    throw new ConflictError(
      'There is no organisation to record this in yet. Create one first.',
      'no_audit_tenant'
    )
  }
  return single.id
}

async function actionContext(c: AppContext): Promise<KitActionContext> {
  const { db, cfg, tenantId } = withAuth(c)
  return { db, cfg, actor: auditActor(c), auditTenantId: await auditTenant(db, tenantId) }
}

/** List every registered kit, the default first, with its pin, check status and app count. */
kitsRouter.get('/', async c => {
  const { db } = withAuth(c)
  return c.json({ kits: await listCatalogue(db) })
})

/** Show one kit (by id or slug) with the manifest snapshot read at its pin. */
kitsRouter.get('/:id', validate('param', kitIdParamSchema), async c => {
  const { db } = withAuth(c)
  return c.json(await showKit(db, c.req.valid('param').id))
})

/** Register a kit: resolve its pin, read its manifest, check conformance. Audits `kit.added`. */
kitsRouter.post('/', validate('json', kitAddRequestSchema), async c => {
  const ctx = await actionContext(c)
  return c.json(await addKit(ctx, c.req.valid('json')), 201)
})

/** Re-read a kit's manifest and re-run the conformance check at its pin. Audits `kit.checked`. */
kitsRouter.post('/:id/check', validate('param', kitIdParamSchema), async c => {
  const ctx = await actionContext(c)
  return c.json(await checkKit(ctx, c.req.valid('param').id))
})

/** Re-pin a kit to a tag, a commit or Follow latest, checked at the new pin. Audits `kit.pinned`. */
kitsRouter.put(
  '/:id/pin',
  validate('param', kitIdParamSchema),
  validate('json', kitPinRequestSchema),
  async c => {
    const ctx = await actionContext(c)
    return c.json(await pinKit(ctx, c.req.valid('param').id, c.req.valid('json')))
  }
)

/** Make a kit the default new apps are cut from. Audits `kit.default_set`. */
kitsRouter.put('/:id/default', validate('param', kitIdParamSchema), async c => {
  const ctx = await actionContext(c)
  return c.json(await makeDefaultKit(ctx, c.req.valid('param').id))
})

/** Remove a kit that is not the default and has no apps. Audits `kit.removed`. */
kitsRouter.delete('/:id', validate('param', kitIdParamSchema), async c => {
  const ctx = await actionContext(c)
  await removeKit(ctx, c.req.valid('param').id)
  return c.json({ removed: true as const })
})
