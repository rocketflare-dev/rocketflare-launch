/**
 * `/api/platform/oidc` (spec/05) — the issuer's signing keys: `GET /keys` lists them with the
 * issuer and its discovery URL, `POST /keys/rotate` rotates (the published `next` key starts
 * signing, the old one stays in the JWKS until every token it signed has expired). Mounted under
 * `/api/platform`, so `platformAdminMiddleware` already applies: the key set is issuer-wide, not
 * an organisation's — a global admin's, or in single mode the one organisation's owner/admin.
 *
 * Never returns key material — only kids, statuses and dates.
 *
 * The audit log is per organisation and the key set is not, so `oidc.key.rotated` is recorded in
 * the admin's current organisation — in a single-tenant deployment (Launch's), the only one.
 */
import { asc } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { tenants } from '../../db/schema'
import { auditActor, recordAudit } from '../services/launch/audit'
import { endpointsOf } from '../services/oidc/discovery'
import { ensureKeys, listKeys, rotateKeys, toSigningKey } from '../services/oidc/keys'
import { withAuth } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const oidcAdminRouter = createRouter()

oidcAdminRouter.get('/keys', async c => {
  const { db, cfg } = withAuth(c)
  await ensureKeys(db, cfg)
  const e = endpointsOf(cfg)
  const now = new Date()
  return c.json({
    issuer: e.issuer,
    discoveryUrl: e.discovery,
    jwksUrl: e.jwks,
    keys: (await listKeys(db)).map(row => toSigningKey(row, now)),
  })
})

/** The organisation an issuer-wide action is recorded against (see the header). */
async function auditTenantId(db: Database, tenantId: string | null): Promise<string | null> {
  if (tenantId) return tenantId
  const [oldest] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .orderBy(asc(tenants.createdAt))
    .limit(1)
  return oldest?.id ?? null
}

oidcAdminRouter.post('/keys/rotate', async c => {
  const { db, cfg, user, tenantId } = withAuth(c)
  const now = new Date()
  const result = await rotateKeys(db, cfg, user.id, now)
  const auditTenant = await auditTenantId(db, tenantId)
  if (auditTenant) {
    await recordAudit(db, {
      tenantId: auditTenant,
      ...auditActor(c),
      action: 'oidc.key.rotated',
      targetType: 'oidc_signing_key',
      targetId: result.active.kid,
      summary: {
        before: { activeKid: result.retiring?.kid ?? null },
        after: { activeKid: result.active.kid, nextKid: result.next.kid },
      },
    })
  }
  return c.json({
    active: toSigningKey(result.active, now),
    retiring: result.retiring ? toSigningKey(result.retiring, now) : null,
    next: toSigningKey(result.next, now),
  })
})
