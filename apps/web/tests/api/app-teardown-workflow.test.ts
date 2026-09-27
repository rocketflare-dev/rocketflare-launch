// @vitest-isolate
// Installs the FakeCloud as the GLOBAL fetch (the Workflow's vendor clients use the default), so this file needs its own module registry.
/**
 * `AppTeardownWorkflow` (Launch P2, slice 2c): archiving removes exactly what the launch created,
 * by recorded id, in reverse order — and a 404 counts as done. Driven after a real launch
 * (`LaunchHarness`) against the same FakeCloud, so `cloud.resourcesFor(slug)` is the invariant:
 * nothing named for the app is left once it is archived.
 */
import { APP_TEARDOWN_STEPS, type AppTeardownParams } from '@launch/shared/launch-pipeline'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { startTeardown } from '@/api/services/launch/pipeline/create'
import { gatherLaunchIds } from '@/api/services/launch/pipeline/teardown-steps'
import { AppTeardownWorkflow } from '@/api/workflows/app-teardown'
import { appOperations, apps, auditEvents, oidcClients } from '@/db/schema'
import { createTestTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { forgetApps, seedApp } from '../helpers/launch-apps'
import { fakeVendors, type Launch, LaunchHarness } from '../helpers/launch-pipeline'
import { createExecutionContext, createTestEnv, stubs } from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

const db = setupTestDatabase()
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

let cloud: FakeCloud
let restore: () => void
let h: LaunchHarness
beforeEach(() => {
  cloud = createFakeCloud()
  restore = cloud.install()
  h = new LaunchHarness(db, cloud, tenantIds)
})
afterEach(() => restore())

/** `POST /:id/teardown`'s service half, then one instance of the Workflow. */
async function teardown(
  target: { tenantId: string; appId: string; slug: string },
  opts: { deleteRepo?: boolean; params?: AppTeardownParams } = {}
) {
  let params = opts.params
  if (!params) {
    const env = createTestEnv()
    const { runId } = await startTeardown(
      db,
      stubs(env).teardownWorkflow,
      target.tenantId,
      target.appId,
      { confirmSlug: target.slug, deleteRepo: opts.deleteRepo ?? false },
      SYSTEM_ACTOR
    )
    const created = stubs(env).teardownWorkflow?.created.at(-1)
    expect(created?.id).toBe(runId)
    params = created?.params as AppTeardownParams
  }
  const wf = new AppTeardownWorkflow(createExecutionContext(), createTestEnv())
  wf.overrides = { vendors: fakeVendors(cloud), sleep: async () => {} }
  const fake = createFakeWorkflowStep()
  const outcome = await wf.run(
    {
      payload: params,
      timestamp: new Date(),
      instanceId: params.runId,
      workflowName: 'launch-app-teardown',
    },
    fake.step as unknown as Parameters<AppTeardownWorkflow['run']>[1]
  )
  return { outcome, fake, params }
}

async function teardownRows(tenantId: string, runId: string) {
  const list = await db
    .select()
    .from(appOperations)
    .where(and(eq(appOperations.tenantId, tenantId), eq(appOperations.runId, runId)))
  return Object.fromEntries(list.map(r => [r.step, r]))
}

async function appOf(launch: Launch) {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, launch.tenantId), eq(apps.id, launch.params.appId)))
  return row
}

const target = (launch: Launch) => ({
  tenantId: launch.tenantId,
  appId: launch.params.appId,
  slug: launch.slug,
})

describe('AppTeardownWorkflow', () => {
  it('removes everything a full launch created, in reverse order, and archives the app', async () => {
    const launch = await h.request()
    expect((await h.run(launch)).outcome.status).toBe('live')
    expect(cloud.resourcesFor(launch.slug).length).toBeGreaterThan(10)

    const { outcome, fake, params } = await teardown(target(launch))
    expect(outcome).toEqual({ runId: params.runId, status: 'archived' })
    expect(fake.names).toEqual(APP_TEARDOWN_STEPS.map(s => s.step))

    expect(cloud.resourcesFor(launch.slug)).toEqual([])
    expect(cloud.github.repo(cloud.opts.org, launch.slug)?.archived).toBe(true)
    expect(cloud.resend.apiKeys.size).toBe(0)

    const byStep = await teardownRows(launch.tenantId, params.runId)
    for (const def of APP_TEARDOWN_STEPS) expect(byStep[def.step]?.status).toBe('succeeded')
    expect(byStep.kv?.externalIds).toMatchObject({ deleted: '2' })
    expect(byStep.repo?.externalIds).toMatchObject({ action: 'archived' })

    const app = await appOf(launch)
    expect(app?.status).toBe('archived')
    expect(app?.archivedAt).toBeInstanceOf(Date)
    const [client] = await db
      .select()
      .from(oidcClients)
      .where(
        and(eq(oidcClients.tenantId, launch.tenantId), eq(oidcClients.appId, launch.params.appId))
      )
    expect(client?.disabledAt).toBeInstanceOf(Date)
    const actions = (
      await db.select().from(auditEvents).where(eq(auditEvents.tenantId, launch.tenantId))
    ).map(a => a.action)
    expect(actions).toEqual(
      expect.arrayContaining(['app.teardown.requested', 'oidc_client.disabled', 'app.archived'])
    )
  })

  it('tears down a half-created app (the launch failed at R2) and can delete the repo', async () => {
    const launch = await h.request()
    cloud.failNext(({ method, url }) => method === 'POST' && url.endsWith('/r2/buckets'), 500)
    expect((await h.run(launch)).outcome.status).toBe('failed')
    expect(cloud.resourcesFor(launch.slug).length).toBeGreaterThan(0)

    const inv = await gatherLaunchIds(db, launch.tenantId, launch.params.appId)
    expect(inv.kv).toHaveLength(1)
    expect(inv.queues).toHaveLength(1)
    expect(inv.r2).toEqual([])
    expect(inv.scripts).toEqual([])
    expect(inv.neonProjects).toHaveLength(1)

    const { outcome, params } = await teardown(target(launch), { deleteRepo: true })
    expect(outcome.status).toBe('archived')
    expect(cloud.resourcesFor(launch.slug)).toEqual([])
    expect(cloud.github.repo(cloud.opts.org, launch.slug)).toBeUndefined()
    const byStep = await teardownRows(launch.tenantId, params.runId)
    expect(byStep.workers?.externalIds).toMatchObject({ deleted: '0' })
    expect(byStep.repo?.externalIds).toMatchObject({ action: 'deleted' })
  })

  it('counts a resource that is already gone as done, and a retry skips what succeeded', async () => {
    const launch = await h.request()
    expect((await h.run(launch)).outcome.status).toBe('live')
    // Somebody deleted a KV namespace by hand, and Neon is failing.
    const kv = [...cloud.cloudflare.kv.values()].find(k => k.title.startsWith(`${launch.slug}-`))
    cloud.cloudflare.kv.delete(kv?.id ?? '')
    cloud.failNext(({ method, url }) => method === 'DELETE' && url.includes('/projects/'), 500)

    const first = await teardown(target(launch))
    expect(first.outcome.status).toBe('failed')
    let byStep = await teardownRows(launch.tenantId, first.params.runId)
    expect(byStep.kv?.externalIds).toMatchObject({ deleted: '1', alreadyGone: '1' })
    expect(byStep.neon?.status).toBe('failed')
    expect((await appOf(launch))?.status).toBe('live')

    // The retry instance: same run id, so the finished deletions are not repeated.
    const deletesBefore = cloud.calls.filter(c => c.method === 'DELETE').length
    const second = await teardown(target(launch), { params: first.params })
    expect(second.outcome.status).toBe('archived')
    byStep = await teardownRows(launch.tenantId, first.params.runId)
    expect(byStep.kv?.attempt).toBe(1)
    expect(byStep.neon).toMatchObject({ status: 'succeeded', attempt: 2 })
    const newDeletes = cloud.calls.filter(c => c.method === 'DELETE').slice(deletesBefore)
    expect(newDeletes.map(c => c.vendor)).toEqual(['neon'])
    expect(cloud.resourcesFor(launch.slug)).toEqual([])
  })

  it('archives an IMPORTED app without touching any vendor', async () => {
    const tenant = await createTestTenant(db)
    tenantIds.push(tenant.id)
    const { app } = await seedApp(db, tenant.id)
    const { outcome, params } = await teardown({
      tenantId: tenant.id,
      appId: app.id,
      slug: app.slug,
    })
    expect(outcome.status).toBe('archived')
    expect(cloud.calls).toEqual([])
    const byStep = await teardownRows(tenant.id, params.runId)
    expect(byStep.routes?.status).toBe('skipped')
    expect(byStep.repo?.status).toBe('skipped')
    expect(byStep.oidc_client?.status).toBe('succeeded')
    expect(byStep.archived?.status).toBe('succeeded')
  })
})
