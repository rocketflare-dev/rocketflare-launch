/**
 * Admin-scoped API keys (issue #6): the one Bearer credential `/api/admin/*` and
 * `/api/platform/*` accept. Minted only by `GET /auth/cli?scope=admin` for a platform
 * administrator; checked against the creator's CURRENT standing on every request. A tenant key on
 * those mounts is 403 `admin_key_required`; an admin key still works on the tenant routes. (Drain
 * through an admin key is in `sessions-routes.test.ts`, the one file that owns `sessions_paused`.)
 */
import { ADMIN_API_KEY_TTL_DAYS, apiKeysListResponseSchema } from '@launch/shared/api-keys'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { API_KEY_PREFIX_LENGTH } from '@/api/utils/core/hash'
import { apiKeys, auditEvents, users } from '@/db/schema'
import {
  bearerHeader,
  createTestApiKey,
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const CALLBACK = 'http://127.0.0.1:53999/callback'

/** A global admin who belongs to an organisation (the handoff mints keys in a tenant). */
async function globalAdminInTenant() {
  const { tenant } = await createTestTenantWithUser(db, 'owner')
  const admin = await createTestGlobalAdmin(db)
  await linkUserToTenant(db, admin.id, tenant.id, 'admin')
  const cookie = sessionCookieHeader(await createTestSession(db, admin.id, tenant.id))
  return { admin, tenant, cookie }
}

/** Run the CLI handoff with `scope=admin` and return the redirect target. */
async function handoff(
  cookie: Record<string, string>,
  extra = '&scope=admin',
  env = createTestEnv()
) {
  const res = await request(
    `/auth/cli?redirect_uri=${encodeURIComponent(CALLBACK)}&hostname=ops-box${extra}`,
    { headers: cookie },
    { env }
  )
  expect(res.status).toBe(302)
  return new URL(res.headers.get('location') as string, 'http://localhost:3001')
}

async function rowFor(key: string) {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyPrefix, key.slice(0, API_KEY_PREFIX_LENGTH)))
  return row
}

describe('GET /auth/cli?scope=admin', () => {
  it('a global admin gets a cli-admin:<host> key, scope admin, expiring in 30 days, audited', async () => {
    const { admin, tenant, cookie } = await globalAdminInTenant()
    const target = await handoff(cookie)
    expect(`${target.origin}${target.pathname}`).toBe(CALLBACK)
    const key = target.searchParams.get('key') as string
    expect(key).toMatch(/^launch_/)
    const row = await rowFor(key)
    expect(row).toMatchObject({
      name: 'cli-admin:ops-box',
      scope: 'admin',
      scopes: ['*'],
      tenantId: tenant.id,
      createdByUserId: admin.id,
    })
    const days = ((row?.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(ADMIN_API_KEY_TTL_DAYS - 1)
    expect(days).toBeLessThanOrEqual(ADMIN_API_KEY_TTL_DAYS)

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenant.id), eq(auditEvents.targetId, row?.id ?? '')))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      action: 'api_key.created',
      actorUserId: admin.id,
      summary: { after: expect.objectContaining({ scope: 'admin', name: 'cli-admin:ops-box' }) },
    })
    expect(JSON.stringify(audit[0]?.summary)).not.toContain(key)
  })

  it('anyone who is not a platform administrator is sent back with ?error= and nothing is minted', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const before = await db.select().from(apiKeys).where(eq(apiKeys.createdByUserId, user.id))
    // Multi mode: a tenant owner is not a platform administrator.
    const target = await handoff(cookie)
    expect(`${target.origin}${target.pathname}`).toBe(CALLBACK)
    expect(target.searchParams.get('error')).toBe('admin_key_forbidden')
    expect(target.searchParams.get('key')).toBeNull()
    const after = await db.select().from(apiKeys).where(eq(apiKeys.createdByUserId, user.id))
    expect(after).toHaveLength(before.length)
  })

  it('an unknown scope is 400; the login round trip keeps scope and hostname', async () => {
    const bad = await request(`/auth/cli?redirect_uri=${encodeURIComponent(CALLBACK)}&scope=root`)
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ code: 'invalid_scope' })

    const res = await request(
      `/auth/cli?redirect_uri=${encodeURIComponent(CALLBACK)}&hostname=ops-box&scope=admin`
    )
    expect(res.status).toBe(302)
    const login = new URL(res.headers.get('location') as string, 'http://localhost:3001')
    const back = new URL(login.searchParams.get('returnUrl') as string, 'http://localhost:3001')
    expect(back.pathname).toBe('/auth/cli')
    expect(back.searchParams.get('scope')).toBe('admin')
    expect(back.searchParams.get('hostname')).toBe('ops-box')
    expect(back.searchParams.get('redirect_uri')).toBe(CALLBACK)
  })

  it('the keys list carries the scope, so an organisation admin can see and revoke it', async () => {
    const { cookie } = await globalAdminInTenant()
    const key = (await handoff(cookie)).searchParams.get('key') as string
    const list = apiKeysListResponseSchema.parse(
      await json(await request('/api/keys', { headers: cookie }))
    )
    const listed = list.items.find(k => key.startsWith(k.keyPrefix))
    expect(listed).toMatchObject({ scope: 'admin', name: 'cli-admin:ops-box' })
    const revoke = await request(`/api/keys/${listed?.id}`, { method: 'DELETE', headers: cookie })
    expect(revoke.status).toBe(204)
    const after = await request('/api/admin/sessions', { headers: bearerHeader(key) })
    expect(after.status).toBe(401)
  })
})

describe('admin keys on /api/admin/* and /api/platform/*', () => {
  it('a tenant key is 403 admin_key_required, even a global admin’s', async () => {
    const { admin, tenant } = await globalAdminInTenant()
    const { key } = await createTestApiKey(db, tenant.id, admin.id)
    for (const path of ['/api/admin/sessions', '/api/admin/users', '/api/platform/setup']) {
      const res = await request(path, { headers: bearerHeader(key) })
      expect(res.status, path).toBe(403)
      expect(await json(res)).toMatchObject({ statusCode: 403, code: 'admin_key_required' })
    }
  })

  it('a global admin’s admin key reaches both mounts and still works on the tenant routes', async () => {
    const { admin, tenant } = await globalAdminInTenant()
    const { key } = await createTestApiKey(db, tenant.id, admin.id, { scope: 'admin' })
    for (const path of ['/api/admin/sessions', '/api/admin/users', '/api/platform/setup']) {
      expect((await request(path, { headers: bearerHeader(key) })).status, path).toBe(200)
    }
    const me = await request('/api/tenant', { headers: bearerHeader(key) })
    expect(me.status).toBe(200)
    expect(await json(me)).toMatchObject({ id: tenant.id })
  })

  it('demoting the creator disables the key on the next request, with nothing to revoke', async () => {
    const { admin, tenant } = await globalAdminInTenant()
    const { key } = await createTestApiKey(db, tenant.id, admin.id, { scope: 'admin' })
    expect((await request('/api/admin/sessions', { headers: bearerHeader(key) })).status).toBe(200)
    await db.update(users).set({ isGlobalAdmin: false }).where(eq(users.id, admin.id))
    const res = await request('/api/admin/sessions', { headers: bearerHeader(key) })
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ code: 'forbidden' })
    // Multi mode: an organisation admin is not a platform administrator either.
    expect((await request('/api/platform/setup', { headers: bearerHeader(key) })).status).toBe(403)
  })

  it('single mode: an organisation owner’s admin key passes /api/platform, not /api/admin', async () => {
    const env = createTestEnv({ TENANCY_MODE: 'single' })
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const { key } = await createTestApiKey(db, tenant.id, user.id, { scope: 'admin' })
    const platform = await request('/api/platform/setup', { headers: bearerHeader(key) }, { env })
    expect(platform.status).toBe(200)
    const operator = await request('/api/admin/sessions', { headers: bearerHeader(key) }, { env })
    expect(operator.status).toBe(403)
  })

  it('support mode needs the browser session: an admin key gets 400 support_needs_session', async () => {
    const { admin, tenant } = await globalAdminInTenant()
    const { key } = await createTestApiKey(db, tenant.id, admin.id, { scope: 'admin' })
    const res = await request(`/api/admin/tenants/${tenant.id}/support/enter`, {
      method: 'POST',
      headers: bearerHeader(key),
    })
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ code: 'support_needs_session' })
  })
})
