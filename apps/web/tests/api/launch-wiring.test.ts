/**
 * Launch's shared wiring (P1 slice 1a): every Launch mount exists, sits behind the auth it should,
 * and — until its slice fills it — answers a JSON envelope rather than falling through to the SPA.
 * The prefixes outside `/api` (`/oidc`, `/.well-known`) are the ones that matter most: an app's
 * browser NAVIGATES to them, and a missing prefix would be served `index.html` with a 200.
 *
 * P2 adds `/ci` (the GitHub-OIDC surface: `/ci/deploy`, `/ci/scaffold`) with its own body cap, the
 * pipeline and deploys sub-routers under `/api/apps`, and the two Workflow bindings.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isCiUploadPath,
  MAX_CI_UPLOAD_BYTES,
  MAX_JSON_BODY_BYTES,
} from '@/api/middleware/body-limit'
import { API_PREFIXES, WORKER_FIRST_PATTERNS } from '@/api/utils/routes/api-prefixes'
import { AppLaunchWorkflow } from '@/api/workflows/app-launch'
import { AppTeardownWorkflow } from '@/api/workflows/app-teardown'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { WEB_ROOT } from '../helpers/source-files'
import { createTestEnv, stubs } from '../mocks/bindings'
import { WorkflowEntrypoint } from '../mocks/cloudflare-workers'

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

  it.each(['/oidc', '/oidc/token'])(
    '%s is public and answers a JSON envelope, never the SPA',
    async path => {
      await expectEnvelope(await request(path), 404, path)
    }
  )

  it('/oidc/authorize with no parameters is an HTML error page, never the SPA', async () => {
    const res = await request('/oidc/authorize')
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).not.toContain('id="root"')
  })

  it.each(['/.well-known/openid-configuration', '/.well-known/jwks.json'])(
    '%s answers JSON',
    async path => {
      const res = await request(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
    }
  )

  it.each(['/api/apps', '/api/app-access', '/api/audit'])(
    '%s requires a session (401 envelope)',
    async path => {
      await expectEnvelope(await request(path), 401, path)
    }
  )

  it('a member reaching an unfilled tenant mount gets a JSON 404', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    for (const path of ['/api/apps/some-slug', '/api/app-access/requests']) {
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
    for (const path of ['/api/admin/setup', '/api/admin/oidc/keys']) {
      expect((await request(path, { headers: staff })).status, path).toBe(200)
    }
  })

  it('owns /ci as a worker-first prefix', () => {
    expect(API_PREFIXES).toContain('/ci')
    expect(WORKER_FIRST_PATTERNS).toEqual(expect.arrayContaining(['/ci', '/ci/*']))
  })

  it.each(['/ci', '/ci/nope', '/ci/deploy/start', '/ci/scaffold/token'])(
    '%s is public and answers a JSON 404 until its slice fills it, never the SPA',
    async path => {
      await expectEnvelope(await request(path, { method: 'POST', body: '{}' }), 404, path)
    }
  )

  it('/ci caps bodies at 1 MB, except the deployer upload (64 MB)', async () => {
    expect(isCiUploadPath('/ci/deploy/0b7c1b8e-4b8e-4c9b-9a55-1b0e5d7f2a11/upload')).toBe(true)
    expect(isCiUploadPath('/ci/deploy/start')).toBe(false)
    expect(isCiUploadPath('/ci/scaffold/token')).toBe(false)
    expect(MAX_CI_UPLOAD_BYTES).toBe(64 * 1024 * 1024)

    const big = JSON.stringify({ pad: 'x'.repeat(MAX_JSON_BODY_BYTES + 10) })
    const headers = { 'Content-Type': 'application/json' }
    await expectEnvelope(
      await request('/ci/scaffold/token', { method: 'POST', body: big, headers }),
      413,
      '/ci/scaffold/token'
    )
    // The upload path lets the same body through to the router (a 404 until 2d fills it).
    await expectEnvelope(
      await request('/ci/deploy/0b7c1b8e-4b8e-4c9b-9a55-1b0e5d7f2a11/upload', {
        method: 'POST',
        body: big,
        headers,
      }),
      404,
      'upload'
    )
  })

  it('the create-app Workflows are bound, recorded in tests, and WorkflowEntrypoint classes', () => {
    const env = createTestEnv()
    expect(stubs(env).launchWorkflow?.created).toEqual([])
    expect(stubs(env).teardownWorkflow?.created).toEqual([])
    // `src/worker.ts` re-exports both; `worker-configuration.d.ts` types the bindings from those
    // exports, so `pnpm typecheck` is what proves the export — this proves the class shape.
    for (const Workflow of [AppLaunchWorkflow, AppTeardownWorkflow]) {
      expect(new Workflow({} as never, env)).toBeInstanceOf(WorkflowEntrypoint)
    }
    expect(readFileSync(path.join(WEB_ROOT, 'src/worker.ts'), 'utf8')).toMatch(
      /export \{ AppLaunchWorkflow \}[\s\S]*export \{ AppTeardownWorkflow \}/
    )
  })
})
