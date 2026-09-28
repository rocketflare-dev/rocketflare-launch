// @vitest-isolate
// Mocks the pipeline's ports (slice 2b's adapter) and its settings/credential reads, so this file needs its own module registry.
/**
 * The create-an-app routes (Launch P2, slice 2c, `routes/app-pipeline.ts`): `POST /api/apps`,
 * `GET /:id/pipeline`, `POST /:id/pipeline/retry`, `POST /:id/teardown`. The routes only START
 * Workflows — `stubs(env).launchWorkflow` / `teardownWorkflow` record what they were asked — so
 * no vendor is reached. The settings and the "is Setup finished" check are mocked: both read
 * `launch_settings` / `admin_credentials`, which are global and owned by the setup suite.
 */
import {
  createAppResponseSchema,
  pipelineViewSchema,
  retryPipelineResponseSchema,
} from '@launch/shared/launch-pipeline'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineSettings } from '@/api/services/launch/pipeline/context'
import { appOperations, appOwners, approvalRequests, apps, auditEvents } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, uniqueSlug } from '../helpers/launch-apps'
import { request } from '../helpers/request'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const state: { settings: PipelineSettings; missing: string[] } = {
  settings: {
    appsDomain: 'clewro.com',
    notificationsDomain: 'notifications.clewro.com',
    templatePin: { repo: 'rocketflare-dev/rocketflare', tag: '0.15.0', commit: 'a'.repeat(40) },
    appCreateRole: 'admin',
    githubOrg: 'acme',
  },
  missing: [],
}

// The test Launch is at http://localhost:3001, which the public-URL gate refuses by design; the
// gate has its own suite (`public-url.test.ts`), so here it is waved through.
vi.mock('@/api/services/launch/public-url', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/services/launch/public-url')>()),
  requirePublicUrl: async () => undefined,
}))

vi.mock('@/api/services/launch/pipeline/context', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/launch/pipeline/context')>()
  return {
    ...actual,
    loadPipelineSettings: vi.fn(async () => state.settings),
    missingSetup: vi.fn(async () => state.missing),
  }
})

vi.mock('@/api/services/launch/pipeline/ports', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/launch/pipeline/ports')>()
  return {
    ...actual,
    defaultPorts: () => ({
      names: (slug: string, env: 'staging' | 'production', domain: string) => {
        const host = `${slug}${env === 'staging' ? '-staging' : ''}.${domain}`
        return { workerName: host.split('.')[0], host, url: `https://${host}` }
      },
    }),
  }
})

const db = setupTestDatabase()
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

beforeEach(() => {
  state.settings = { ...state.settings, appCreateRole: 'admin' }
  state.missing = []
})

async function signedIn(role: 'owner' | 'admin' | 'member' = 'admin') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  tenantIds.push(tenant.id)
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return { user, tenant, headers: { ...cookie, 'X-Requested-With': 'fetch' } }
}

async function post(path: string, headers: Record<string, string>, body: unknown, env?: TestEnv) {
  return request(path, { method: 'POST', headers }, { json: body, env })
}

async function create(headers: Record<string, string>, env = createTestEnv(), slug = uniqueSlug()) {
  const res = await post('/api/apps', headers, { slug, displayName: 'Shop' }, env)
  return { res, env, slug }
}

describe('POST /api/apps', () => {
  it('is 401 without a session; a member ASKS (P4): 202 with an approval, nothing started', async () => {
    const anonymous = await request(
      '/api/apps',
      { method: 'POST' },
      { json: { slug: uniqueSlug(), displayName: 'Shop' } }
    )
    expect(anonymous.status).toBe(401)
    const { headers, user, tenant } = await signedIn('member')
    const { res, env, slug } = await create(headers)
    expect(res.status).toBe(202)
    const body = createAppResponseSchema.parse(await res.json())
    expect(body.app).toMatchObject({ slug, status: 'requested' })
    expect(body.approvalId).toEqual(expect.any(String))
    expect(stubs(env).launchWorkflow?.created).toEqual([])
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, body.approvalId ?? ''))
    expect(approval).toMatchObject({
      tenantId: tenant.id,
      kind: 'app.create',
      status: 'pending',
      appId: body.app.id,
      subjectType: 'app',
      subjectId: body.app.id,
      requestedByUserId: user.id,
      context: { kind: 'app.create', slug, displayName: 'Shop', ownerGroupId: null },
    })
    // The run id is reserved on the row for when it is approved.
    const [app] = await db.select().from(apps).where(eq(apps.id, body.app.id))
    expect(app?.launchRunId).toBe(body.runId)
  })

  it('below launch_settings.app_create_role an admin asks too; at it, the launch starts at once', async () => {
    state.settings = { ...state.settings, appCreateRole: 'owner' }
    const admin = await signedIn('admin')
    const asked = await create(admin.headers)
    expect(asked.res.status).toBe(202)
    expect(createAppResponseSchema.parse(await asked.res.json()).approvalId).toEqual(
      expect.any(String)
    )
    expect(stubs(asked.env).launchWorkflow?.created).toEqual([])

    state.settings = { ...state.settings, appCreateRole: 'member' }
    const member = await signedIn('member')
    const started = await create(member.headers)
    expect(started.res.status).toBe(202)
    const body = createAppResponseSchema.parse(await started.res.json())
    expect(body.approvalId).toBeNull()
    expect(stubs(started.env).launchWorkflow?.created.map(c => c.id)).toEqual([body.runId])
  })

  it('writes the requested app, both environments, the owner and the audit row, then starts the run', async () => {
    const { headers, user, tenant } = await signedIn('admin')
    const { res, env, slug } = await create(headers)
    expect(res.status).toBe(202)
    const body = createAppResponseSchema.parse(await res.json())
    expect(body.app).toMatchObject({ slug, status: 'requested', source: 'created' })
    expect(body.app.environments.map(e => [e.name, e.url])).toEqual([
      ['staging', `https://${slug}-staging.clewro.com`],
      ['production', `https://${slug}.clewro.com`],
    ])
    expect(stubs(env).launchWorkflow?.created).toEqual([
      {
        id: body.runId,
        params: {
          tenantId: tenant.id,
          appId: body.app.id,
          runId: body.runId,
          userId: user.id,
          options: { deployStaging: true },
        },
      },
    ])
    const [app] = await db.select().from(apps).where(eq(apps.id, body.app.id))
    expect(app?.launchRunId).toBe(body.runId)
    const owners = await db
      .select()
      .from(appOwners)
      .where(and(eq(appOwners.tenantId, tenant.id), eq(appOwners.appId, body.app.id)))
    expect(owners.map(o => o.userId)).toEqual([user.id])
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, tenant.id), eq(auditEvents.action, 'app.create.requested'))
      )
    expect(audit?.summary.after).toMatchObject({ slug, runId: body.runId, deployStaging: true })
    // Auto-approved: still an `app.create` request, decided by the system and applied.
    expect(body.approvalId).toBeNull()
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, tenant.id), eq(approvalRequests.appId, body.app.id)))
    expect(approval).toMatchObject({ kind: 'app.create', status: 'approved' })
    expect(approval?.appliedAt).not.toBeNull()
  })

  it.each([
    ['a reserved slug', 'admin'],
    ['a launch- slug', 'launch-thing'],
    ['a malformed slug', 'Not A Slug'],
  ])('refuses %s with the 400 envelope and writes nothing', async (_label, slug) => {
    const { headers } = await signedIn('admin')
    const { res, env } = await create(headers, createTestEnv(), slug)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ statusCode: 400, error: expect.any(String) })
    expect(stubs(env).launchWorkflow?.created).toEqual([])
    const [row] = await db.select().from(apps).where(eq(apps.slug, slug))
    expect(row).toBeUndefined()
  })

  it('is 409 slug_taken for a slug any tenant already uses', async () => {
    const { headers } = await signedIn('admin')
    const { res: first, slug } = await create(headers)
    expect(first.status).toBe(202)
    const other = await signedIn('owner')
    const { res, env } = await create(other.headers, createTestEnv(), slug)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ statusCode: 409, code: 'slug_taken' })
    expect(stubs(env).launchWorkflow?.created).toEqual([])
  })

  it('is 503 when the Worker has no APP_LAUNCH_WORKFLOW, or Setup is unfinished', async () => {
    const { headers } = await signedIn('admin')
    const unbound = await create(headers, createTestEnv({ APP_LAUNCH_WORKFLOW: undefined }))
    expect(unbound.res.status).toBe(503)
    expect(await unbound.res.json()).toMatchObject({ code: 'app_pipeline_not_configured' })
    const [none] = await db.select().from(apps).where(eq(apps.slug, unbound.slug))
    expect(none).toBeUndefined()

    state.missing = ['Neon (key and region)']
    const unset = await create(headers)
    expect(unset.res.status).toBe(503)
    expect(await unset.res.json()).toMatchObject({
      code: 'launch_not_set_up',
      error: expect.stringContaining('Neon'),
    })
  })
})

describe('GET /api/apps/:id/pipeline', () => {
  it('lists every launch step in order, pending before the run writes a row', async () => {
    const { headers } = await signedIn('admin')
    const { res } = await create(headers)
    const { app, runId } = createAppResponseSchema.parse(await res.json())
    const view = await request(`/api/apps/${app.id}/pipeline`, { headers })
    expect(view.status).toBe(200)
    const body = pipelineViewSchema.parse(await view.json())
    expect(body).toMatchObject({ appId: app.id, runId, kind: 'create', status: 'running' })
    expect(body.steps[0]).toMatchObject({ step: 'reserve', status: 'pending', attempt: 0 })
    expect(body.steps.at(-1)?.step).toBe('live')

    const teardownView = await request(`/api/apps/${app.id}/pipeline?kind=teardown`, { headers })
    expect(pipelineViewSchema.parse(await teardownView.json())).toMatchObject({
      runId: null,
      status: 'none',
    })
  })

  it("is 404 for another tenant's app and 401 without a session", async () => {
    const a = await signedIn('admin')
    const { res } = await create(a.headers)
    const { app } = createAppResponseSchema.parse(await res.json())
    const b = await signedIn('admin')
    const foreign = await request(`/api/apps/${app.id}/pipeline`, { headers: b.headers })
    expect(foreign.status).toBe(404)
    const anonymous = await request(`/api/apps/${app.id}/pipeline`)
    expect(anonymous.status).toBe(401)
  })
})

describe('POST /api/apps/:id/pipeline/retry', () => {
  it('retries only a failed run, as <runId>-rN with the same run id', async () => {
    const { headers, tenant } = await signedIn('admin')
    const env = createTestEnv()
    const { res } = await create(headers, env)
    const { app, runId } = createAppResponseSchema.parse(await res.json())

    const early = await post(`/api/apps/${app.id}/pipeline/retry`, headers, { kind: 'create' }, env)
    expect(early.status).toBe(409)
    expect(await early.json()).toMatchObject({ code: 'run_not_failed' })

    await db.insert(appOperations).values({
      tenantId: tenant.id,
      appId: app.id,
      runId,
      kind: 'create',
      step: 'cloudflare',
      status: 'failed',
      attempt: 1,
      error: 'R2 said no',
    })
    await db.update(apps).set({ status: 'failed' }).where(eq(apps.id, app.id))

    const retried = await post(
      `/api/apps/${app.id}/pipeline/retry`,
      headers,
      { kind: 'create' },
      env
    )
    expect(retried.status).toBe(202)
    expect(retryPipelineResponseSchema.parse(await retried.json())).toEqual({
      runId,
      instanceId: `${runId}-r1`,
    })
    const again = await post(`/api/apps/${app.id}/pipeline/retry`, headers, {}, env)
    expect(await again.json()).toMatchObject({ instanceId: `${runId}-r2` })
    const created = stubs(env).launchWorkflow?.created ?? []
    expect(created.map(c => c.id)).toEqual([runId, `${runId}-r1`, `${runId}-r2`])
    expect(created[1]?.params).toMatchObject({ runId, options: { deployStaging: true } })
    const [row] = await db.select().from(apps).where(eq(apps.id, app.id))
    expect(row?.status).toBe('provisioning')
    // The job events now go to the newest instance.
    expect(row).toMatchObject({ launchRunId: runId, launchInstanceId: `${runId}-r2` })
  })

  it('starts a new instance on every retry where wrangler hands back an existing id', async () => {
    const { headers, tenant } = await signedIn('admin')
    const env = createTestEnv()
    const workflow = stubs(env).launchWorkflow
    if (workflow) workflow.acceptDuplicateIds = true
    const { res } = await create(headers, env)
    const { app, runId } = createAppResponseSchema.parse(await res.json())
    await db.insert(appOperations).values({
      tenantId: tenant.id,
      appId: app.id,
      runId,
      kind: 'create',
      step: 'cloudflare',
      status: 'failed',
      attempt: 1,
      error: 'R2 said no',
    })
    await db.update(apps).set({ status: 'failed' }).where(eq(apps.id, app.id))

    for (const n of [1, 2, 3]) {
      const retried = await post(`/api/apps/${app.id}/pipeline/retry`, headers, {}, env)
      expect(await retried.json()).toMatchObject({ instanceId: `${runId}-r${n}` })
    }
    expect(workflow?.created.map(c => c.id)).toEqual([
      runId,
      `${runId}-r1`,
      `${runId}-r2`,
      `${runId}-r3`,
    ])
  })

  it('is 403 for a member of the same tenant', async () => {
    const admin = await signedIn('admin')
    const { res } = await create(admin.headers)
    const { app } = createAppResponseSchema.parse(await res.json())
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, admin.tenant.id, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, admin.tenant.id))
    const member = await post(
      `/api/apps/${app.id}/pipeline/retry`,
      { ...cookie, 'X-Requested-With': 'fetch' },
      { kind: 'create' }
    )
    expect(member.status).toBe(403)
  })
})

describe('POST /api/apps/:id/teardown', () => {
  it('checks the typed slug (400), then starts the teardown (202)', async () => {
    const { headers } = await signedIn('admin')
    const env = createTestEnv()
    const { res, slug } = await create(headers, env)
    const { app } = createAppResponseSchema.parse(await res.json())
    await db.update(apps).set({ status: 'live' }).where(eq(apps.id, app.id))

    const wrong = await post(`/api/apps/${app.id}/teardown`, headers, { confirmSlug: 'nope' }, env)
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({
      statusCode: 400,
      code: 'confirm_slug_mismatch',
      error: expect.any(String),
    })
    expect(stubs(env).teardownWorkflow?.created).toEqual([])

    const ok = await post(
      `/api/apps/${app.id}/teardown`,
      headers,
      { confirmSlug: slug, deleteRepo: true },
      env
    )
    expect(ok.status).toBe(202)
    const { runId } = (await ok.json()) as { runId: string }
    expect(stubs(env).teardownWorkflow?.created).toEqual([
      {
        id: runId,
        params: expect.objectContaining({ appId: app.id, runId, deleteRepo: true }),
      },
    ])
  })

  it("is 403 for a member and 404 for another tenant's app", async () => {
    const admin = await signedIn('admin')
    const { res, slug } = await create(admin.headers)
    const { app } = createAppResponseSchema.parse(await res.json())
    const member = await signedIn('member')
    const refused = await post(`/api/apps/${app.id}/teardown`, member.headers, {
      confirmSlug: slug,
    })
    expect(refused.status).toBe(403)
    const other = await signedIn('admin')
    const foreign = await post(`/api/apps/${app.id}/teardown`, other.headers, { confirmSlug: slug })
    expect(foreign.status).toBe(404)
  })
})
