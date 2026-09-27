/**
 * Launch's shared wiring (P1 slice 1a): every Launch mount exists, sits behind the auth it should,
 * and — until its slice fills it — answers a JSON envelope rather than falling through to the SPA.
 * The prefixes outside `/api` (`/oidc`, `/.well-known`) are the ones that matter most: an app's
 * browser NAVIGATES to them, and a missing prefix would be served `index.html` with a 200.
 */
import { describe, expect, it } from 'vitest'
import { API_PREFIXES, WORKER_FIRST_PATTERNS } from '@/api/utils/routes/api-prefixes'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()

async function expectEnvelope(res: Response, status: number, path: string) {
  expect(res.status, path).toBe(status)
  expect(res.headers.get('content-type'), path).toContain('application/json')
  expect(await json(res), path).toMatchObject({ statusCode: status, error: expect.any(String) })
}

describe('Launch mounts', () => {
  it('owns /oidc and /.well-known as worker-first prefixes', () => {
    expect(API_PREFIXES).toEqual(expect.arrayContaining(['/oidc', '/.well-known']))
    expect(WORKER_FIRST_PATTERNS).toEqual(
      expect.arrayContaining(['/oidc', '/oidc/*', '/.well-known', '/.well-known/*'])
    )
  })

  it.each([
    '/oidc',
    '/oidc/authorize',
    '/oidc/token',
    '/.well-known/openid-configuration',
    '/.well-known/jwks.json',
  ])('%s is public and answers a JSON envelope, never the SPA', async path => {
    await expectEnvelope(await request(path), 404, path)
  })

  it.each(['/api/apps', '/api/app-access', '/api/audit'])(
    '%s requires a session (401 envelope)',
    async path => {
      await expectEnvelope(await request(path), 401, path)
    }
  )

  it('a member reaching an unfilled tenant mount gets a JSON 404', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    for (const path of ['/api/apps', '/api/apps/some-slug', '/api/app-access/requests']) {
      await expectEnvelope(await request(path, { headers: cookie }), 404, path)
    }
  })

  it('/api/admin/setup and /api/admin/oidc are global-admin only', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const owner = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const admin = await createTestGlobalAdmin(db)
    const staff = sessionCookieHeader(await createTestSession(db, admin.id))
    for (const path of ['/api/admin/setup', '/api/admin/oidc/keys']) {
      await expectEnvelope(await request(path), 401, path)
      await expectEnvelope(await request(path, { headers: owner }), 403, path)
    }
    expect((await request('/api/admin/setup', { headers: staff })).status).toBe(200)
    await expectEnvelope(
      await request('/api/admin/oidc/keys', { headers: staff }),
      404,
      '/api/admin/oidc/keys'
    )
  })
})
