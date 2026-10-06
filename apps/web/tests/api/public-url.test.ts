// @vitest-isolate
// Mocks the credentials module (`launch_settings` is global) and stubs the global fetch (the probe).
/**
 * Launch's public URL (`services/launch/public-url.ts`): is `APP_URL` reachable from the internet,
 * so that the GitHub jobs a launch dispatches can call Launch back? The static half (localhost,
 * private addresses, http), the live probe through `GET /ci/ping` — here routed IN-PROCESS to the
 * app, so the proof is the real endpoint's — the cache, the 409 `launch_not_reachable` gate on the
 * routes that dispatch CI, the wizard's step and "Check now", and "Stop" for a stuck launch.
 * No test reaches the network: every `fetch` is the app itself or a stub.
 */

import { apiErrorSchema } from '@launch/shared/errors'
import {
  cancelPipelineResponseSchema,
  type PipelineRunStatus,
} from '@launch/shared/launch-pipeline'
import {
  LAUNCH_NOT_REACHABLE,
  launchNotReachableDetailsSchema,
  publicUrlCheckSchema,
  publicUrlPingResponseSchema,
  setupOverviewSchema,
} from '@launch/shared/launch-setup'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '@/api/index'
import { deriveRunStatus } from '@/api/services/launch/pipeline/runs'
import {
  checkPublicUrl,
  FAILED_TTL_MS,
  OK_TTL_MS,
  pingProof,
  publicUrlProblem,
  requirePublicUrl,
} from '@/api/services/launch/public-url'
import { loadConfig } from '@/config'
import { appOperations, apps, auditEvents } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenantWithUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, seedApp, uniqueSlug } from '../helpers/launch-apps'
import { request } from '../helpers/request'
import { createExecutionContext, createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))
beforeEach(() => store.settings.clear())
afterEach(() => vi.unstubAllGlobals())

const PUBLIC = 'https://launch.example.test'
const NONCE = 'n0nce-n0nce-n0nce-n0nce'

/** A `fetch` that answers `<PUBLIC>/…` from the app itself, with `env` — the probe's round trip. */
function viaApp(env: TestEnv) {
  const calls: string[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(url.toString())
    return app.request(`${url.pathname}${url.search}`, init, env, createExecutionContext())
  }) as typeof fetch
  return { fetch: fetchFn, calls }
}

const publicEnv = (overrides: Partial<TestEnv> = {}) =>
  createTestEnv({ APP_URL: PUBLIC, ...overrides } as Partial<TestEnv>)

async function signedIn(role: 'owner' | 'admin' | 'member' = 'admin') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  tenantIds.push(tenant.id)
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return { user, tenant, headers: { ...cookie, 'X-Requested-With': 'fetch' } }
}

async function globalAdmin() {
  const { tenant } = await signedIn('owner')
  const user = await createTestGlobalAdmin(db)
  await linkUserToTenant(db, user.id, tenant.id, 'owner')
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return { user, tenant, headers: { ...cookie, 'X-Requested-With': 'fetch' } }
}

describe('publicUrlProblem — the static half', () => {
  it.each([
    'http://localhost:3000',
    'https://localhost',
    'https://launch.localhost',
    'https://my-mac.local',
    'https://launch.internal',
    'https://127.0.0.1',
    'https://10.1.2.3',
    'https://172.20.0.5',
    'https://192.168.1.10',
    'https://169.254.169.254',
    'https://100.64.0.1',
    'https://0.0.0.0',
    'https://[::1]',
    'https://[fe80::1]',
    'https://[fd00::1]',
    'https://intranet',
    'http://launch.example.com',
  ])('refuses %s', url => {
    expect(publicUrlProblem(url)).toEqual(expect.any(String))
  })

  it.each(['https://launch.example.com', 'https://abc-123.trycloudflare.com', 'https://8.8.8.8'])(
    'accepts %s',
    url => {
      expect(publicUrlProblem(url)).toBeNull()
    }
  )

  it('names the fix for a local URL', () => {
    expect(publicUrlProblem('http://localhost:3000')).toMatch(/pnpm dev:tunnel/)
  })
})

describe('GET /ci/ping', () => {
  it('answers the nonce and this deployment’s proof of it, uncached', async () => {
    const env = createTestEnv()
    const res = await request(`/ci/ping?nonce=${NONCE}`, {}, { env })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = publicUrlPingResponseSchema.parse(await res.json())
    expect(body).toEqual({ nonce: NONCE, proof: await pingProof(loadConfig(env), NONCE) })
    // The proof is keyed: another deployment's differs.
    const other = loadConfig(createTestEnv({ OAUTH_ENCRYPTION_KEY: 'x'.repeat(64) }))
    expect(await pingProof(other, NONCE)).not.toBe(body.proof)
  })

  it('refuses a malformed nonce with the error envelope', async () => {
    const res = await request('/ci/ping?nonce=short')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ statusCode: 400, error: expect.any(String) })
  })
})

describe('checkPublicUrl', () => {
  it('is ok when the URL routes back to this Launch', async () => {
    const env = publicEnv()
    const { fetch, calls } = viaApp(env)
    const result = await checkPublicUrl(loadConfig(env), { fetch, nonce: NONCE })
    expect(result).toMatchObject({ url: PUBLIC, status: 'ok' })
    expect(result.checks.map(c => [c.id, c.status])).toEqual([
      ['url', 'ok'],
      ['probe', 'ok'],
    ])
    expect(calls).toEqual([`${PUBLIC}/ci/ping?nonce=${NONCE}`])
  })

  it('fails when a different Launch, or something else, answers', async () => {
    const env = publicEnv()
    const elsewhere = viaApp(publicEnv({ OAUTH_ENCRYPTION_KEY: 'y'.repeat(64) }))
    const other = await checkPublicUrl(loadConfig(env), { fetch: elsewhere.fetch })
    expect(other.status).toBe('failed')
    expect(other.checks[1]?.detail).toMatch(/different Launch/)

    const html = (async () =>
      new Response('<html>a parked domain</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch
    const parked = await checkPublicUrl(loadConfig(env), { fetch: html })
    expect(parked.status).toBe('failed')
    expect(parked.checks[1]?.detail).toMatch(/routes somewhere else/)
  })

  it('an unreachable URL fails in development and warns in a deployment', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND')
    }) as typeof fetch
    const dev = await checkPublicUrl(loadConfig(publicEnv()), { fetch: down })
    expect(dev.status).toBe('failed')
    expect(dev.checks[1]?.detail).toMatch(/could not reach itself.*ENOTFOUND/)
    const staging = await checkPublicUrl(
      loadConfig(publicEnv({ APP_ENV: 'staging' } as Partial<TestEnv>)),
      { fetch: down }
    )
    expect(staging.status).toBe('warning')
  })

  it('never probes a local URL', async () => {
    const probe = vi.fn()
    const result = await checkPublicUrl(loadConfig(createTestEnv()), {
      fetch: probe as unknown as typeof fetch,
    })
    expect(result.status).toBe('failed')
    expect(result.checks).toEqual([
      expect.objectContaining({
        id: 'url',
        status: 'failed',
        detail: expect.stringMatching(/localhost:3001/),
      }),
    ])
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('requirePublicUrl — the gate and its cache', () => {
  it('refuses a local URL with 409 launch_not_reachable, without a probe', async () => {
    const probe = vi.fn()
    const err = await requirePublicUrl(db, loadConfig(createTestEnv()), {
      fetch: probe as unknown as typeof fetch,
    }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 409, code: LAUNCH_NOT_REACHABLE })
    const details = launchNotReachableDetailsSchema.parse(err.details)
    expect(details.url).toBe('http://localhost:3001')
    expect(details.checks[0]).toMatchObject({ id: 'url', status: 'failed' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('probes once, reuses a pass for OK_TTL_MS, then probes again', async () => {
    const env = publicEnv()
    const { fetch, calls } = viaApp(env)
    const cfg = loadConfig(env)
    const t0 = new Date('2026-09-28T10:00:00Z')
    await requirePublicUrl(db, cfg, { fetch, now: () => t0 })
    await requirePublicUrl(db, cfg, { fetch, now: () => new Date(t0.getTime() + OK_TTL_MS - 1) })
    expect(calls).toHaveLength(1)
    expect(publicUrlCheckSchema.parse(store.settings.get('public_url_check'))).toMatchObject({
      url: PUBLIC,
      status: 'ok',
    })
    await requirePublicUrl(db, cfg, { fetch, now: () => new Date(t0.getTime() + OK_TTL_MS + 1) })
    expect(calls).toHaveLength(2)
  })

  it('remembers a failure only briefly, so a fixed URL is noticed', async () => {
    const env = publicEnv()
    const cfg = loadConfig(env)
    const t0 = new Date('2026-09-28T10:00:00Z')
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const refused = await requirePublicUrl(db, cfg, {
      fetch: down as unknown as typeof fetch,
      now: () => t0,
    }).catch(e => e)
    expect(refused).toMatchObject({ statusCode: 409, code: LAUNCH_NOT_REACHABLE })
    // Within the window: the cached failure, no second probe.
    await expect(
      requirePublicUrl(db, cfg, {
        fetch: down as unknown as typeof fetch,
        now: () => new Date(t0.getTime() + FAILED_TTL_MS - 1),
      })
    ).rejects.toMatchObject({ code: LAUNCH_NOT_REACHABLE })
    expect(down).toHaveBeenCalledTimes(1)
    // The tunnel is up now.
    const { fetch } = viaApp(env)
    await expect(
      requirePublicUrl(db, cfg, { fetch, now: () => new Date(t0.getTime() + FAILED_TTL_MS + 1) })
    ).resolves.toMatchObject({ status: 'ok' })
  })

  it('ignores a stored result for another URL', async () => {
    store.settings.set('public_url_check', {
      url: 'https://old.example.test',
      status: 'ok',
      checks: [],
      checkedAt: new Date().toISOString(),
    })
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    await expect(
      requirePublicUrl(db, loadConfig(publicEnv()), { fetch: down })
    ).rejects.toMatchObject({ code: LAUNCH_NOT_REACHABLE })
  })
})

describe('the routes that dispatch CI refuse while Launch is unreachable', () => {
  it('POST /api/apps is 409 launch_not_reachable before any write', async () => {
    const { headers } = await signedIn('admin')
    const env = createTestEnv()
    const slug = uniqueSlug('shop')
    const res = await request(
      '/api/apps',
      { method: 'POST', headers },
      { json: { slug, displayName: 'Shop' }, env }
    )
    expect(res.status).toBe(409)
    const body = apiErrorSchema.parse(await res.json())
    expect(body).toMatchObject({
      statusCode: 409,
      code: LAUNCH_NOT_REACHABLE,
      error: expect.stringMatching(/not reachable from the internet at http:\/\/localhost:3001/),
    })
    expect(launchNotReachableDetailsSchema.parse(body.details).url).toBe('http://localhost:3001')
    expect(await db.select().from(apps).where(eq(apps.slug, slug))).toEqual([])
    expect(stubs(env).launchWorkflow?.created).toEqual([])
  })

  it('POST /api/apps passes the gate on a reachable URL (and meets the next refusal)', async () => {
    const env = publicEnv()
    vi.stubGlobal('fetch', viaApp(env).fetch)
    const { headers } = await signedIn('admin')
    const res = await request(
      '/api/apps',
      { method: 'POST', headers },
      { json: { slug: uniqueSlug('shop'), displayName: 'Shop' }, env }
    )
    // Setup is empty in this file's store: past the gate, the pipeline's own check refuses.
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'launch_not_set_up' })
  })

  it('a create retry is refused too; a teardown retry is not gated', async () => {
    const { headers, tenant } = await signedIn('admin')
    const { app: row } = await seedApp(db, tenant.id)
    const create = await request(
      `/api/apps/${row.id}/pipeline/retry`,
      { method: 'POST', headers },
      { json: { kind: 'create' } }
    )
    expect(create.status).toBe(409)
    expect(await create.json()).toMatchObject({ code: LAUNCH_NOT_REACHABLE })
    const teardown = await request(
      `/api/apps/${row.id}/pipeline/retry`,
      { method: 'POST', headers },
      { json: { kind: 'teardown' } }
    )
    expect(teardown.status).toBe(409)
    expect(await teardown.json()).toMatchObject({ code: 'no_run' })
  })

  it('"Deploy to production" is refused', async () => {
    const { headers, tenant } = await signedIn('admin')
    const { app: row } = await seedApp(db, tenant.id)
    const res = await request(`/api/apps/${row.id}/deploys/production`, {
      method: 'POST',
      headers,
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: LAUNCH_NOT_REACHABLE })
  })
})

describe('Settings › Public URL', () => {
  it('is 401 without a session and 403 for a tenant admin', async () => {
    expect((await request('/api/platform/setup/public-url/check', { method: 'POST' })).status).toBe(
      401
    )
    const { headers } = await signedIn('admin')
    const res = await request('/api/platform/setup/public-url/check', { method: 'POST', headers })
    expect(res.status).toBe(403)
  })

  it('the overview reports the static failure without probing; Check now probes, stores and audits', async () => {
    const { headers, tenant } = await globalAdmin()
    const probe = vi.fn()
    vi.stubGlobal('fetch', probe)
    const overview = setupOverviewSchema.parse(
      await (await request('/api/platform/setup', { headers })).json()
    )
    expect(overview.publicUrl).toMatchObject({
      url: 'http://localhost:3001',
      status: 'failed',
      checkedAt: null,
    })
    expect(overview.steps.find(s => s.id === 'public_url')?.status).toBe('failed')
    expect(probe).not.toHaveBeenCalled()

    const env = publicEnv()
    vi.stubGlobal('fetch', viaApp(env).fetch)
    const res = await request(
      '/api/platform/setup/public-url/check',
      { method: 'POST', headers },
      { env }
    )
    expect(res.status).toBe(200)
    const result = publicUrlCheckSchema.parse(await res.json())
    expect(result).toMatchObject({ url: PUBLIC, status: 'ok' })
    expect(store.settings.get('public_url_check')).toMatchObject({ url: PUBLIC, status: 'ok' })
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenant.id), eq(auditEvents.action, 'public_url.checked')))
    expect(audit?.summary.after).toMatchObject({ url: PUBLIC, checkStatus: 'ok', failed: [] })

    const after = setupOverviewSchema.parse(
      await (await request('/api/platform/setup', { headers }, { env })).json()
    )
    expect(after.publicUrl).toMatchObject({ url: PUBLIC, status: 'ok' })
    expect(after.publicUrl.checkedAt).not.toBeNull()
    expect(after.steps.find(s => s.id === 'public_url')?.status).toBe('ok')
  })
})

describe('POST /api/apps/:id/pipeline/cancel', () => {
  /** A created app whose launch is in its scaffold wait. */
  async function stuckLaunch(tenantId: string) {
    const { app: row } = await seedApp(db, tenantId, { status: 'provisioning' })
    const runId = crypto.randomUUID()
    await db
      .update(apps)
      .set({ source: 'created', launchRunId: runId, launchInstanceId: `${runId}-r1` })
      .where(eq(apps.id, row.id))
    const base = { tenantId, appId: row.id, runId, kind: 'create', attempt: 1 }
    await db.insert(appOperations).values([
      { ...base, step: 'reserve', status: 'succeeded', startedAt: new Date() },
      { ...base, step: 'repo', status: 'succeeded', startedAt: new Date() },
      { ...base, step: 'scaffold.start', status: 'succeeded', startedAt: new Date() },
      {
        ...base,
        step: 'scaffold.wait',
        status: 'running',
        startedAt: new Date(),
        externalIds: { runId: '4242', runUrl: 'https://github.com/acme/x/actions/runs/4242' },
      },
    ])
    return { app: row, runId }
  }

  async function status(tenantId: string, runId: string): Promise<PipelineRunStatus> {
    const rows = await db
      .select()
      .from(appOperations)
      .where(and(eq(appOperations.tenantId, tenantId), eq(appOperations.runId, runId)))
    return deriveRunStatus('create', rows)
  }

  it('stops the running step, terminates the live instance, fails the app and audits it', async () => {
    const { headers, tenant, user } = await signedIn('admin')
    const { app: row, runId } = await stuckLaunch(tenant.id)
    const env = createTestEnv()
    stubs(env).launchWorkflow?.setStatus(`${runId}-r1`, { status: 'waiting' })
    const res = await request(
      `/api/apps/${row.id}/pipeline/cancel`,
      { method: 'POST', headers },
      { env }
    )
    expect(res.status).toBe(200)
    expect(cancelPipelineResponseSchema.parse(await res.json())).toEqual({
      runId,
      step: 'scaffold.wait',
      terminated: true,
    })
    expect(stubs(env).launchWorkflow?.terminated).toEqual([`${runId}-r1`])
    expect(await status(tenant.id, runId)).toBe('failed')
    const [wait] = await db
      .select()
      .from(appOperations)
      .where(and(eq(appOperations.runId, runId), eq(appOperations.step, 'scaffold.wait')))
    expect(wait).toMatchObject({ status: 'failed', error: `Stopped by ${user.email}` })
    // The run's page is kept.
    expect(wait?.externalIds.runUrl).toBe('https://github.com/acme/x/actions/runs/4242')
    const [appRow] = await db.select().from(apps).where(eq(apps.id, row.id))
    expect(appRow?.status).toBe('failed')
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, tenant.id), eq(auditEvents.action, 'app.pipeline.cancelled'))
      )
    expect(audit?.summary.after).toMatchObject({
      runId,
      steps: ['scaffold.wait'],
      terminated: true,
    })

    // Stopped: a second stop is 409, with the envelope.
    const again = await request(`/api/apps/${row.id}/pipeline/cancel`, { method: 'POST', headers })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ statusCode: 409, code: 'run_not_running' })
  })

  it('is 409 for an app with no running launch, 403 for a member, 404 across tenants, 401 anonymous', async () => {
    const admin = await signedIn('admin')
    const { app: idle } = await seedApp(db, admin.tenant.id)
    const none = await request(`/api/apps/${idle.id}/pipeline/cancel`, {
      method: 'POST',
      headers: admin.headers,
    })
    expect(none.status).toBe(409)
    expect(await none.json()).toMatchObject({ code: 'run_not_running' })

    const { app: row } = await stuckLaunch(admin.tenant.id)
    const member = await signedIn('member')
    await linkUserToTenant(db, member.user.id, admin.tenant.id, 'member')
    const memberHeaders = {
      ...sessionCookieHeader(await createTestSession(db, member.user.id, admin.tenant.id)),
      'X-Requested-With': 'fetch',
    }
    const forbidden = await request(`/api/apps/${row.id}/pipeline/cancel`, {
      method: 'POST',
      headers: memberHeaders,
    })
    expect(forbidden.status).toBe(403)

    const other = await signedIn('admin')
    const hidden = await request(`/api/apps/${row.id}/pipeline/cancel`, {
      method: 'POST',
      headers: other.headers,
    })
    expect(hidden.status).toBe(404)
    expect((await request(`/api/apps/${row.id}/pipeline/cancel`, { method: 'POST' })).status).toBe(
      401
    )
  })
})
