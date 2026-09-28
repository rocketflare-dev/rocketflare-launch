/**
 * One admin in single mode: `canAdministerPlatform` and `/api/platform/*`.
 *
 * `TENANCY_MODE=single` collapses the two admin layers — the organisation's owner/admin IS the
 * platform admin — while multi mode keeps `/api/platform/*` exactly as global-admin-only as
 * `/api/admin/*` was. Covers the predicate in both modes, the middleware on the setup, issuer-key
 * and access-request mounts (read-only calls here; the setup WRITE path and its audit actor are
 * `setup.test.ts`, which owns `launch_settings`), the access-request guard rails for a reviewer
 * who is not a global admin, the operator surface staying global-only, and the bootstrap admin
 * becoming the organisation's OWNER.
 */
import { canAdministerPlatform as sharedPredicate } from '@launch/shared/permissions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { admitBootstrapAdmin, admitUser, ensureAccessRequest } from '@/api/services/auth'
import { getSingleTenant } from '@/api/utils/db/tenant-helpers'
import { loadConfig } from '@/config'
import { tenantUsers, users } from '@/db/schema'
import { canAdministerPlatform } from '@/permissions'
import {
  createTestApiKey,
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const singleEnv = createTestEnv({ TENANCY_MODE: 'single' })
const multiEnv = createTestEnv({ TENANCY_MODE: 'multi' })

const SINGLE = { TENANCY_MODE: 'single' } as const
const MULTI = { TENANCY_MODE: 'multi' } as const
const as = (role: 'owner' | 'admin' | 'member' | 'support' | null, isGlobalAdmin = false) => ({
  isGlobalAdmin,
  tenantUser: role ? { role } : null,
})

/** GET-only probes: nothing here writes a deployment-wide row. */
const READS = ['/api/platform/setup', '/api/platform/oidc/keys', '/api/platform/access-requests']

async function cookieFor(role: 'owner' | 'admin' | 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

describe('canAdministerPlatform', () => {
  it('single mode: owner and admin yes, member and no membership no, global admin always', () => {
    expect(canAdministerPlatform(as('owner'), SINGLE)).toBe(true)
    expect(canAdministerPlatform(as('admin'), SINGLE)).toBe(true)
    expect(canAdministerPlatform(as('member'), SINGLE)).toBe(false)
    // `support` is a global admin visiting — they pass on the flag, never on the role.
    expect(canAdministerPlatform(as('support'), SINGLE)).toBe(false)
    expect(canAdministerPlatform(as(null), SINGLE)).toBe(false)
    expect(canAdministerPlatform(as(null, true), SINGLE)).toBe(true)
    expect(canAdministerPlatform(as('member', true), SINGLE)).toBe(true)
  })

  it('multi mode: exactly isGlobalAdmin — a tenant owner or admin is refused', () => {
    expect(canAdministerPlatform(as('owner'), MULTI)).toBe(false)
    expect(canAdministerPlatform(as('admin'), MULTI)).toBe(false)
    expect(canAdministerPlatform(as('member'), MULTI)).toBe(false)
    expect(canAdministerPlatform(as(null, true), MULTI)).toBe(true)
    expect(canAdministerPlatform(as('owner', true), MULTI)).toBe(true)
  })

  it('the server wrapper and the shared function (the UI nav guard) agree on every input', () => {
    for (const tenancyMode of ['single', 'multi'] as const) {
      for (const role of ['owner', 'admin', 'member', 'support', null] as const) {
        for (const isGlobalAdmin of [true, false]) {
          expect(
            canAdministerPlatform(as(role, isGlobalAdmin), { TENANCY_MODE: tenancyMode }),
            `${tenancyMode} ${role} ${isGlobalAdmin}`
          ).toBe(sharedPredicate({ isGlobalAdmin, role, tenancyMode }))
        }
      }
    }
  })
})

describe('/api/platform/* — single mode', () => {
  it('an owner and an admin reach setup, the issuer keys and the access requests', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const { cookie } = await cookieFor(role)
      for (const path of READS) {
        const res = await request(path, { headers: cookie }, { env: singleEnv })
        expect(res.status, `${role} ${path}`).toBe(200)
      }
    }
  })

  it('a member is 403 forbidden, anonymous is 401, and a tenant API key never passes', async () => {
    const { user, tenant, cookie } = await cookieFor('member')
    for (const path of READS) {
      expect((await request(path, {}, { env: singleEnv })).status, path).toBe(401)
      const res = await request(path, { headers: cookie }, { env: singleEnv })
      expect(res.status, path).toBe(403)
      expect(await json(res)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    }
    // An OWNER's key: the role qualifies, the credential does not (cookie only, like /api/admin).
    await db
      .update(tenantUsers)
      .set({ role: 'owner' })
      .where(and(eq(tenantUsers.tenantId, tenant.id), eq(tenantUsers.userId, user.id)))
    const { key } = await createTestApiKey(db, tenant.id, user.id)
    const bearer = { Authorization: `Bearer ${key}` }
    for (const path of READS) {
      expect((await request(path, { headers: bearer }, { env: singleEnv })).status, path).toBe(401)
    }
  })

  it('the operator surface (/api/admin/*) stays global-admin only', async () => {
    const { cookie } = await cookieFor('owner')
    for (const path of ['/api/admin/users', '/api/admin/feature-flags', '/api/admin/sessions']) {
      const res = await request(path, { headers: cookie }, { env: singleEnv })
      expect(res.status, path).toBe(403)
    }
  })
})

describe('/api/platform/* — multi mode (unchanged)', () => {
  it('a tenant owner and admin are 403; a global admin with no membership is 200', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const { cookie } = await cookieFor(role)
      for (const path of READS) {
        const res = await request(path, { headers: cookie }, { env: multiEnv })
        expect(res.status, `${role} ${path}`).toBe(403)
      }
    }
    const staff = await createTestGlobalAdmin(db)
    const cookie = sessionCookieHeader(await createTestSession(db, staff.id))
    for (const path of READS) {
      expect((await request(path, { headers: cookie }, { env: multiEnv })).status, path).toBe(200)
    }
  })
})

describe('access requests decided by a single-mode owner/admin', () => {
  async function pendingRequest() {
    const requester = await createTestUser(db)
    const req = await ensureAccessRequest(db, { email: requester.email, userId: requester.id })
    return { requester, req }
  }

  function decide(id: string, cookie: Record<string, string>, body: unknown) {
    return request(
      `/api/platform/access-requests/${id}/decide`,
      { method: 'POST', headers: cookie },
      { env: singleEnv, json: body }
    )
  }

  it('an admin approves into their own organisation, recorded as the decider', async () => {
    const { user, tenant, cookie } = await cookieFor('admin')
    const { requester, req } = await pendingRequest()
    const res = await decide(req.id, cookie, {
      decision: 'approve',
      approve: { mode: 'join', tenantId: tenant.id, role: 'member' },
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ status: 'approved', decidedByUserId: user.id })
    const [m] = await db
      .select()
      .from(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, tenant.id), eq(tenantUsers.userId, requester.id)))
    expect(m?.role).toBe('member')
  })

  it('refuses another organisation, `owner` from a non-owner, and a new organisation', async () => {
    const { tenant, cookie } = await cookieFor('admin')
    const elsewhere = await createTestTenantWithUser(db, 'owner')
    const { req } = await pendingRequest()
    const other = await decide(req.id, cookie, {
      decision: 'approve',
      approve: { mode: 'join', tenantId: elsewhere.tenant.id, role: 'member' },
    })
    expect(other.status).toBe(403)
    const owner = await decide(req.id, cookie, {
      decision: 'approve',
      approve: { mode: 'join', tenantId: tenant.id, role: 'owner' },
    })
    expect(owner.status).toBe(403)
    const newOrg = await decide(req.id, cookie, {
      decision: 'approve',
      approve: { mode: 'new_org', name: 'Somewhere Else' },
    })
    expect(newOrg.status).toBe(404)
    expect(await json(newOrg)).toMatchObject({ code: 'tenancy_mode_single' })
    // Nothing above decided it: a reject still lands.
    const reject = await decide(req.id, cookie, { decision: 'reject' })
    expect(reject.status).toBe(200)
    expect(await json(reject)).toMatchObject({ status: 'rejected' })
  })

  it('an owner may hand out `owner`', async () => {
    const { tenant, cookie } = await cookieFor('owner')
    const { requester, req } = await pendingRequest()
    const res = await decide(req.id, cookie, {
      decision: 'approve',
      approve: { mode: 'join', tenantId: tenant.id, role: 'owner' },
    })
    expect(res.status).toBe(200)
    const [m] = await db
      .select()
      .from(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, tenant.id), eq(tenantUsers.userId, requester.id)))
    expect(m?.role).toBe('owner')
  })
})

describe('bootstrap admin — single mode makes them the organisation OWNER', () => {
  const logger = { info: () => {}, warn: () => {} }

  async function roleIn(tenantId: string, userId: string) {
    const [m] = await db
      .select({ role: tenantUsers.role })
      .from(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)))
    return m?.role ?? null
  }

  it('a first verified login joins the existing organisation as owner, with the global flag', async () => {
    // The organisation already exists (the seed, or another bootstrap address got there first):
    // before this change the bootstrap admin auto-joined it as a `member`.
    await createTestTenantWithUser(db, 'owner')
    const single = await getSingleTenant(db)
    if (!single) throw new Error('no tenant')
    const email = `boot_${uniqueId().toLowerCase()}@example.test`
    const cfg = loadConfig(createTestEnv({ TENANCY_MODE: 'single', BOOTSTRAP_ADMIN_EMAILS: email }))
    const admitted = await admitUser(db, cfg, { email, verified: true }, logger)
    if (!admitted.ok) throw new Error(admitted.reason)
    expect(admitted.user.isGlobalAdmin).toBe(true)
    expect(await roleIn(single.id, admitted.user.id)).toBe('owner')

    // …and the session it gets reaches Setup on the role as well as the flag.
    const cookie = sessionCookieHeader(await createTestSession(db, admitted.user.id, single.id))
    const session = await json<{ tenant: { role: string } }>(
      await request('/auth/session', { headers: cookie }, { env: singleEnv })
    )
    expect(session.tenant.role).toBe('owner')
    expect(
      canAdministerPlatform({ isGlobalAdmin: false, tenantUser: { role: 'owner' } }, SINGLE)
    ).toBe(true)
  })

  it('an existing member named in BOOTSTRAP_ADMIN_EMAILS is promoted to owner; an owner stays', async () => {
    const single = await getSingleTenant(db)
    if (!single) throw new Error('no tenant')
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, single.id, 'member')
    const cfg = loadConfig(
      createTestEnv({ TENANCY_MODE: 'single', BOOTSTRAP_ADMIN_EMAILS: user.email })
    )
    const admitted = await admitUser(db, cfg, { email: user.email, verified: true }, logger)
    expect(admitted.ok).toBe(true)
    expect(await roleIn(single.id, user.id)).toBe('owner')
    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row?.isGlobalAdmin).toBe(true)
    // Idempotent: a second login changes nothing.
    await admitBootstrapAdmin(db, cfg, { ...user, isGlobalAdmin: true }, logger)
    expect(await roleIn(single.id, user.id)).toBe('owner')
  })

  it('an UNVERIFIED login is not a bootstrap login', async () => {
    const single = await getSingleTenant(db)
    if (!single) throw new Error('no tenant')
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, single.id, 'member')
    const cfg = loadConfig(
      createTestEnv({ TENANCY_MODE: 'single', BOOTSTRAP_ADMIN_EMAILS: user.email })
    )
    await admitUser(db, cfg, { email: user.email, verified: false }, logger)
    expect(await roleIn(single.id, user.id)).toBe('member')
  })

  it('multi mode is unchanged: a member-less bootstrap admin gets nothing forced on them', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cfg = loadConfig(
      createTestEnv({ TENANCY_MODE: 'multi', BOOTSTRAP_ADMIN_EMAILS: user.email })
    )
    await admitUser(db, cfg, { email: user.email, verified: true }, logger)
    expect(await roleIn(tenant.id, user.id)).toBe('member')
  })
})
