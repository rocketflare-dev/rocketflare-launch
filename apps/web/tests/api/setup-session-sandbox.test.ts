// @vitest-isolate
// Mocks the platform credential store: `launch_settings` is global and `setup.test.ts` owns it.
/**
 * Where a session's container runs is a PLATFORM SETTING (`launch_settings.session_sandbox_host`,
 * `services/sessions/sandbox-host.ts`), not the retired `SESSION_SANDBOX_HOST` var:
 *
 * - the overview's `sessionSandbox`: the current host and, per choice, whether this Worker can use
 *   it now and why not (no `SANDBOX_HOST` binding and why `pnpm dev` could not declare it; Docker
 *   down; the local git server; deployed);
 * - `PUT /api/platform/setup/session-sandbox`: platform admins only, audited `setting.changed`,
 *   409 `session_sandbox_unavailable` for a choice that cannot run a session (nothing stored);
 * - the default: `local`, or a leftover `.dev.vars` `SESSION_SANDBOX_HOST=remote` in development;
 *   a stored `remote` is ignored outside development;
 * - a session FREEZES the host at create (`sessions.sandbox_host`) and keeps it when the setting
 *   changes; an unavailable host refuses the create before any row; a sign-in's Workflow params
 *   carry the host it started on.
 */
import { DEFAULT_SESSION_POLICY } from '@launch/shared/launch-sessions'
import { setupOverviewSchema } from '@launch/shared/launch-setup'
import { and, asc, eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { createSession } from '@/api/services/sessions/lifecycle'
import { startLogin } from '@/api/services/sessions/logins/service'
import {
  resolveNewSandboxHost,
  sandboxHostUnavailable,
  sessionSandboxHost,
  sessionSandboxHostOf,
  sessionSandboxOptions,
} from '@/api/services/sessions/sandbox-host'
import { loadConfig } from '@/config'
import { auditEvents } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { json, request } from '../helpers/request'
import { seedSessionApp } from '../helpers/sessions'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()
let admin: { cookie: Record<string, string>; tenantId: string; userId: string }

beforeAll(async () => {
  const user = await createTestGlobalAdmin(db)
  const tenant = await createTestTenant(db)
  await linkUserToTenant(db, user.id, tenant.id, 'owner')
  admin = {
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
    tenantId: tenant.id,
    userId: user.id,
  }
})
beforeEach(() => {
  store.settings.clear()
  store.credentials.clear()
})

/** The remote binding as `pnpm dev` declares it (only its presence is read here). */
const binding = { fetch: async () => new Response('ok') } as unknown as Fetcher

/** A development Worker: with the remote binding (both hosts available) unless told otherwise. */
const devEnv = (overrides: Partial<TestEnv> & Record<string, unknown> = {}): TestEnv =>
  ({ ...createTestEnv({ APP_ENV: 'development' }), SANDBOX_HOST: binding, ...overrides }) as TestEnv

function call(
  method: 'GET' | 'PUT',
  body?: unknown,
  opts: { cookie?: Record<string, string>; env?: TestEnv } = {}
) {
  return request(
    `/api/platform/setup${method === 'GET' ? '' : '/session-sandbox'}`,
    { method, headers: opts.cookie ?? admin.cookie },
    { env: opts.env ?? devEnv(), ...(body === undefined ? {} : { json: body }) }
  )
}

async function sandboxOf(res: Response) {
  return setupOverviewSchema.parse(await json(res)).sessionSandbox
}

async function sandboxAudits() {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, admin.tenantId),
        eq(auditEvents.action, 'setting.changed'),
        eq(auditEvents.targetId, 'session_sandbox_host')
      )
    )
    .orderBy(asc(auditEvents.at))
}

describe('the overview', () => {
  it('nothing stored: this Worker’s containers; both offered under pnpm dev with the binding', async () => {
    const res = await call('GET')
    expect(res.status).toBe(200)
    expect(await sandboxOf(res)).toEqual({
      host: 'local',
      isDefault: true,
      options: [
        { host: 'local', label: "This Worker's containers", available: true, reason: null },
        { host: 'remote', label: 'Remote sandbox host', available: true, reason: null },
      ],
    })
  })

  it('says why each host is unavailable: the binding pnpm dev could not declare, and Docker', async () => {
    const env = devEnv({
      SANDBOX_HOST: undefined,
      DEV_SANDBOX_HOST_STATUS: 'not_logged_in',
      DEV_LOCAL_CONTAINERS: 'off',
    })
    const { options } = await sandboxOf(await call('GET', undefined, { env }))
    expect(options).toEqual([
      expect.objectContaining({
        host: 'local',
        available: false,
        reason: expect.stringMatching(/Docker was not running/),
      }),
      expect.objectContaining({
        host: 'remote',
        available: false,
        reason: expect.stringMatching(/wrangler login/),
      }),
    ])
    const notDeployed = devEnv({ SANDBOX_HOST: undefined, DEV_SANDBOX_HOST_STATUS: 'not_deployed' })
    const [, remote] = (await sandboxOf(await call('GET', undefined, { env: notDeployed }))).options
    expect(remote?.reason).toMatch(/launch-sandbox-dev\) is not deployed/)
  })

  it('a leftover .dev.vars SESSION_SANDBOX_HOST=remote is the starting value, until one is saved', async () => {
    const env = devEnv({ SESSION_SANDBOX_HOST: 'remote' })
    expect(await sandboxOf(await call('GET', undefined, { env }))).toMatchObject({
      host: 'remote',
      isDefault: true,
    })
    expect((await call('PUT', { host: 'local' }, { env })).status).toBe(200)
    expect(await sandboxOf(await call('GET', undefined, { env }))).toMatchObject({
      host: 'local',
      isDefault: false,
    })
  })
})

describe('PUT /session-sandbox', () => {
  it('stores the choice, audits the before and after once, and answers the overview', async () => {
    const earlier = (await sandboxAudits()).length
    const res = await call('PUT', { host: 'remote' })
    expect(res.status).toBe(200)
    expect(await sandboxOf(res)).toMatchObject({ host: 'remote', isDefault: false })
    expect(store.settings.get('session_sandbox_host')).toBe('remote')
    // The same choice again changes nothing and audits nothing.
    expect((await call('PUT', { host: 'remote' })).status).toBe(200)
    const audits = (await sandboxAudits()).slice(earlier)
    expect(audits).toHaveLength(1)
    expect(audits[0]?.summary).toEqual({ before: { host: 'local' }, after: { host: 'remote' } })
    expect(audits[0]?.actorUserId).toBe(admin.userId)
  })

  it('409 session_sandbox_unavailable for a host that cannot run a session now — nothing stored', async () => {
    const earlier = (await sandboxAudits()).length
    for (const [host, env] of [
      ['remote', devEnv({ SANDBOX_HOST: undefined, DEV_SANDBOX_HOST_STATUS: 'not_deployed' })],
      ['remote', devEnv({ SESSION_BACKEND: 'local' })],
      ['local', devEnv({ DEV_LOCAL_CONTAINERS: 'off' })],
    ] as const) {
      const res = await call('PUT', { host }, { env })
      expect(res.status, `${host}`).toBe(409)
      const body = (await json(res)) as { code?: string; statusCode?: number; error?: string }
      expect(body).toMatchObject({ code: 'session_sandbox_unavailable', statusCode: 409 })
      expect(body.error).toBeTruthy()
    }
    expect(store.settings.has('session_sandbox_host')).toBe(false)
    expect(await sandboxAudits()).toHaveLength(earlier)
  })

  it('400 for a host that does not exist', async () => {
    const res = await call('PUT', { host: 'cloud' })
    expect(res.status).toBe(400)
  })

  it('is 401 without a session and 403 for an organisation owner who is not a global admin', async () => {
    const anon = await request(
      '/api/platform/setup/session-sandbox',
      { method: 'PUT' },
      { env: devEnv(), json: { host: 'remote' } }
    )
    expect(anon.status).toBe(401)
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    expect((await call('PUT', { host: 'remote' }, { cookie })).status).toBe(403)
    expect(store.settings.has('session_sandbox_host')).toBe(false)
  })
})

describe('deployed (APP_ENV is not development)', () => {
  const prod = loadConfig(createTestEnv({ APP_ENV: 'production' }))
  const prodEnv = { SANDBOX_HOST: binding }

  it('offers only this Worker’s containers, refuses remote, and ignores a stored remote', async () => {
    expect(sessionSandboxOptions(prodEnv, prod)).toEqual([
      { host: 'local', label: "This Worker's containers", available: true, reason: null },
    ])
    expect(sandboxHostUnavailable('remote', prodEnv, prod)).toMatch(/Development only/)
    // Even with Docker "off" — that var only means something under pnpm dev.
    expect(sandboxHostUnavailable('local', { DEV_LOCAL_CONTAINERS: 'off' }, prod)).toBeNull()
    store.settings.set('session_sandbox_host', 'remote')
    expect(await sessionSandboxHost(db, prodEnv, prod)).toEqual({ host: 'local', isDefault: false })
    expect(await resolveNewSandboxHost(db, prodEnv, prod)).toBe('local')
  })
})

describe('a session freezes its host at create', () => {
  const cfg = loadConfig(createTestEnv({ APP_ENV: 'development' }))

  async function create(env: TestEnv) {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await createSession(db, env, {
      tenantId: f.tenant.id,
      app: f.app,
      userId: f.user.id,
      request: {},
      actor: SYSTEM_ACTOR,
      cfg,
    })
    return { f, row }
  }

  it('records the setting on the row, and keeps it when the setting changes', async () => {
    store.settings.set('session_policy', DEFAULT_SESSION_POLICY)
    store.settings.set('session_sandbox_host', 'remote')
    const env = devEnv()
    const { row } = await create(env)
    expect(row.sandboxHost).toBe('remote')

    store.settings.set('session_sandbox_host', 'local')
    expect(await sessionSandboxHostOf(db, row.tenantId, row.id)).toBe('remote')
    const { row: next } = await create(env)
    expect(next.sandboxHost).toBe('local')
    expect(await sessionSandboxHostOf(db, next.tenantId, next.id)).toBe('local')
    // A row that is gone reads as this Worker's containers.
    expect(await sessionSandboxHostOf(db, row.tenantId, crypto.randomUUID())).toBe('local')
  })

  it('an unavailable host refuses the create before any row or Workflow', async () => {
    store.settings.set('session_sandbox_host', 'remote')
    const env = devEnv({ SANDBOX_HOST: undefined, DEV_SANDBOX_HOST_STATUS: 'not_logged_in' })
    const err = await create(env).catch(e => e as Error & { code?: string })
    expect(err).toMatchObject({ code: 'session_sandbox_unavailable' })
    expect(stubs(env).sessionWorkflow?.created ?? []).toHaveLength(0)
  })

  it('a sign-in carries the host it started on in its Workflow params', async () => {
    const env = devEnv()
    const workflow = stubs(env).agentLoginWorkflow
    if (!workflow) throw new Error('no AGENT_LOGIN_WORKFLOW')
    for (const sandboxHost of ['remote', 'local'] as const) {
      const { user, tenant } = await createTestTenantWithUser(db)
      const login = await startLogin(db, env.AGENT_LOGIN_WORKFLOW as unknown as Workflow, {
        tenantId: tenant.id,
        userId: user.id,
        runtime: 'claude_code',
        actor: SYSTEM_ACTOR,
        sandboxHost,
      })
      const created = workflow.created.find(c => c.id === login.id)
      expect(created?.params).toEqual(
        sandboxHost === 'remote'
          ? { loginId: login.id, tenantId: tenant.id, sandboxHost: 'remote' }
          : { loginId: login.id, tenantId: tenant.id }
      )
    }
  })
})
