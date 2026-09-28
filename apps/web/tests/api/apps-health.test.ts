// @vitest-isolate
// Stubs the global fetch (the cron task and the health-check route both use it).
/**
 * App health (`services/launch/health.ts`, spec/06): the `*\/5` cron through the real dispatcher
 * with `fetch` faked per host — up, degraded, down and a timeout — the history row per probe, an
 * `app.health.changed` audit row only on a transition, the seven-day prune, and the on-demand
 * `POST /api/apps/:id/health-check`.
 *
 * The poller walks every tenant in the shared test database, so the fake answers every host it
 * does not know with a 503: other suites' environments are polled too, harmlessly, and nothing
 * here asserts a global count.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchScheduled } from '@/api/scheduled'
import { healthPoll, runHealthPoll, verdictOf } from '@/api/services/launch/health'
import { appEnvironments, appHealthChecks, auditEvents } from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, seedApp, uniqueSlug } from '../helpers/launch-apps'
import { json, request } from '../helpers/request'
import { createExecutionContext, createTestEnv, waitOnExecutionContext } from '../mocks/bindings'

const db = setupTestDatabase()

type Behaviour = 'up' | 'degraded' | 'down' | 'timeout' | 'hang'

/** Host → how it answers. Anything unlisted answers 503. */
const hosts = new Map<string, Behaviour>()
const seen: string[] = []

function respond(url: URL, behaviour: Behaviour | undefined, signal?: AbortSignal | null) {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  const isHealth = url.pathname === '/api/health'
  switch (behaviour) {
    case 'up':
      return Promise.resolve(
        isHealth ? ok({ status: 'ok', version: '1.4.0' }) : ok({ status: 'ready' })
      )
    case 'degraded':
      return Promise.resolve(
        isHealth
          ? ok({ status: 'ok', version: '1.4.0' })
          : new Response(JSON.stringify({ code: 'database_unavailable' }), { status: 503 })
      )
    case 'down':
      return Promise.resolve(new Response('boom', { status: 500 }))
    case 'timeout':
      return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))
    case 'hang':
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
    default:
      return Promise.resolve(new Response('unknown host', { status: 503 }))
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      seen.push(url.toString())
      return respond(url, hosts.get(url.hostname), init?.signal)
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Every tenant this file registered apps in; their apps go afterwards (`forgetApps`). */
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

async function newTenant() {
  const { tenant } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  return tenant
}

async function runCron() {
  const ctx = createExecutionContext()
  // Only the health poll: the session tasks on the same cron scan every tenant's sessions, which
  // belong to other suites in the shared test database.
  const reports = await dispatchScheduled('*/5 * * * *', createTestEnv(), ctx, {
    '*/5 * * * *': [healthPoll],
  })
  await waitOnExecutionContext(ctx)
  expect(reports).toEqual([expect.objectContaining({ task: 'healthPoll', status: 'ok' })])
}

/** Seed an app whose production answers `behaviour`, with no staging. */
async function appAnswering(
  tenantId: string,
  behaviour: Behaviour,
  status: 'live' | 'archived' = 'live'
) {
  const slug = uniqueSlug(behaviour)
  const host = `${slug}.apps.test`
  hosts.set(host, behaviour)
  const { app, environments } = await seedApp(db, tenantId, {
    slug,
    status,
    environments: { production: `https://${host}` },
  })
  return { app, env: environments[0] as NonNullable<(typeof environments)[0]>, host }
}

async function envRow(id: string) {
  const [row] = await db.select().from(appEnvironments).where(eq(appEnvironments.id, id))
  return row
}

async function checksOf(tenantId: string, environmentId: string) {
  return db
    .select()
    .from(appHealthChecks)
    .where(
      and(eq(appHealthChecks.tenantId, tenantId), eq(appHealthChecks.environmentId, environmentId))
    )
}

async function healthAudits(tenantId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, 'app.health.changed')))
}

describe('verdictOf', () => {
  const probe = (status: number | null, body: unknown = null, error: string | null = null) => ({
    status,
    body,
    error,
    ms: 12,
  })
  it('up needs both 200; degraded is health without ready; anything else is down', () => {
    expect(verdictOf(probe(200, { version: 'v1' }), probe(200))).toMatchObject({
      status: 'up',
      version: 'v1',
      error: null,
      latencyMs: 12,
    })
    expect(verdictOf(probe(200), probe(503))).toMatchObject({
      status: 'degraded',
      error: 'ready: HTTP 503',
    })
    expect(verdictOf(probe(500), probe(200)).status).toBe('down')
    expect(
      verdictOf(probe(null, null, 'timed out after 5000 ms'), probe(null, null, 'x'))
    ).toMatchObject({
      status: 'down',
      httpStatus: null,
      error: 'health: timed out after 5000 ms; ready: x',
    })
  })
})

describe('the */5 health poll', () => {
  it('records up, degraded, down and a timeout, one history row each, and audits no first sighting', async () => {
    const tenant = await newTenant()
    const up = await appAnswering(tenant.id, 'up')
    const degraded = await appAnswering(tenant.id, 'degraded')
    const down = await appAnswering(tenant.id, 'down')
    const timeout = await appAnswering(tenant.id, 'timeout')

    await runCron()

    expect(await envRow(up.env.id)).toMatchObject({
      healthStatus: 'up',
      healthVersion: '1.4.0',
      healthError: null,
    })
    expect((await envRow(up.env.id))?.healthCheckedAt).toBeInstanceOf(Date)
    expect(await envRow(degraded.env.id)).toMatchObject({
      healthStatus: 'degraded',
      healthError: 'ready: HTTP 503',
    })
    expect(await envRow(down.env.id)).toMatchObject({ healthStatus: 'down' })
    expect(await envRow(timeout.env.id)).toMatchObject({
      healthStatus: 'down',
      healthError: 'health: timed out after 5000 ms; ready: timed out after 5000 ms',
    })

    const [check] = await checksOf(tenant.id, degraded.env.id)
    expect(check).toMatchObject({ status: 'degraded', httpStatus: 200, readyStatus: 503 })
    expect(await checksOf(tenant.id, timeout.env.id)).toEqual([
      expect.objectContaining({ status: 'down', httpStatus: null, readyStatus: null }),
    ])
    expect(seen).toContain(`https://${up.host}/api/health`)
    expect(seen).toContain(`https://${up.host}/api/ready`)
    // unknown → x is the baseline, not a change anybody made.
    expect(await healthAudits(tenant.id)).toEqual([])
  })

  it('audits a transition once, and a steady state never', async () => {
    const tenant = await newTenant()
    const target = await appAnswering(tenant.id, 'up')
    await runCron()
    const firstChange = (await envRow(target.env.id))?.healthChangedAt

    await runCron() // up → up
    expect(await healthAudits(tenant.id)).toEqual([])
    expect((await envRow(target.env.id))?.healthChangedAt).toEqual(firstChange)

    hosts.set(target.host, 'down')
    await runCron() // up → down
    const audits = await healthAudits(tenant.id)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      appId: target.app.id,
      targetType: 'AppEnvironment',
      targetId: target.env.id,
    })
    expect(audits[0]?.summary).toMatchObject({
      before: { status: 'up' },
      after: { status: 'down', environment: 'production', app: target.app.slug },
    })
    expect((await envRow(target.env.id))?.healthChangedAt?.getTime()).toBeGreaterThan(
      firstChange?.getTime() ?? 0
    )
    expect(await checksOf(tenant.id, target.env.id)).toHaveLength(3)

    await runCron() // down → down
    expect(await healthAudits(tenant.id)).toHaveLength(1)
  })

  it('skips archived apps and environments without a URL', async () => {
    const tenant = await newTenant()
    const archived = await appAnswering(tenant.id, 'up', 'archived')
    const { environments } = await seedApp(db, tenant.id, { environments: { staging: null } })
    await runCron()
    expect(await envRow(archived.env.id)).toMatchObject({ healthStatus: 'unknown' })
    expect(await envRow(environments[0]?.id ?? '')).toMatchObject({ healthStatus: 'unknown' })
    expect(seen.some(u => u.includes(archived.host))).toBe(false)
  })

  it('prunes checks older than seven days, per tenant, and keeps the rest', async () => {
    const tenant = await newTenant()
    const target = await appAnswering(tenant.id, 'up')
    const day = 24 * 60 * 60 * 1000
    await db.insert(appHealthChecks).values([
      {
        tenantId: tenant.id,
        environmentId: target.env.id,
        checkedAt: new Date(Date.now() - 8 * day),
        status: 'up',
      },
      {
        tenantId: tenant.id,
        environmentId: target.env.id,
        checkedAt: new Date(Date.now() - 6 * day),
        status: 'up',
      },
    ])
    await runCron()
    const remaining = await checksOf(tenant.id, target.env.id)
    expect(remaining).toHaveLength(2) // the six-day-old row and this run's
    expect(remaining.every(r => r.checkedAt.getTime() > Date.now() - 7 * day)).toBe(true)
  })

  it('aborts a probe that hangs at the timeout', async () => {
    const tenant = await newTenant()
    const target = await appAnswering(tenant.id, 'hang')
    const result = await runHealthPoll(db, { timeoutMs: 50 })
    expect(result.environments).toBeGreaterThan(0)
    expect(await envRow(target.env.id)).toMatchObject({
      healthStatus: 'down',
      healthError: 'health: timed out after 50 ms; ready: timed out after 50 ms',
    })
  })
})

describe('POST /api/apps/:id/health-check and GET /api/apps/:id/health', () => {
  async function session(role: 'admin' | 'member') {
    const { user, tenant } = await createTestTenantWithUser(db, role)
    tenantIds.push(tenant.id)
    return { tenant, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)) }
  }

  it('probes every environment now and returns them, staging first; the history follows', async () => {
    const { tenant, cookie } = await session('admin')
    const slug = uniqueSlug('manual')
    hosts.set(`${slug}.apps.test`, 'up')
    hosts.set(`${slug}-staging.apps.test`, 'degraded')
    const { app } = await seedApp(db, tenant.id, { slug })

    const res = await request(`/api/apps/${app.id}/health-check`, {
      method: 'POST',
      headers: cookie,
    })
    expect(res.status).toBe(200)
    const body = await json<{ environments: Array<{ name: string; healthStatus: string }> }>(res)
    expect(body.environments.map(e => [e.name, e.healthStatus])).toEqual([
      ['staging', 'degraded'],
      ['production', 'up'],
    ])

    const history = await json<{ items: Array<{ environmentName: string; status: string }> }>(
      await request(`/api/apps/${app.id}/health`, { headers: cookie })
    )
    expect(history.items.map(i => [i.environmentName, i.status]).sort()).toEqual([
      ['production', 'up'],
      ['staging', 'degraded'],
    ])
  })

  it('is 403 for a member and 404 for another organisation’s app', async () => {
    const member = await session('member')
    const { app } = await seedApp(db, member.tenant.id)
    expect(
      (
        await request(`/api/apps/${app.id}/health-check`, {
          method: 'POST',
          headers: member.cookie,
        })
      ).status
    ).toBe(403)

    const admin = await session('admin')
    const res = await request(`/api/apps/${app.id}/health-check`, {
      method: 'POST',
      headers: admin.cookie,
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ statusCode: 404, code: 'app_not_found' })
  })
})
