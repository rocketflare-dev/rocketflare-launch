// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform credential store.
/**
 * Deploy progress (`GET /api/apps/:id/deploys/latest`, and the catalogue's `latestDeploy`):
 * a deploy shows as it runs — dispatched → approved → uploaded → migrating → activating → done,
 * or failed — derived from its ticket, and a deploy whose GitHub run died is failed ON READ.
 *
 * What it pins:
 * - each phase from a real `/ci/deploy` run (start → upload → activate), `activating` from
 *   `activation_started_at`, and an unclaimed pre-approval as `dispatched` (failed once it lapses);
 * - the run poll: a cancelled run fails its `uploaded` ticket once — audited `deploy.failed`, the
 *   migrator credential revoked — and a second read inside the window asks GitHub nothing;
 * - a run still in progress changes nothing;
 * - the catalogue row carries the in-progress deploy before a newer settled one;
 * - 401 without a session, and another organisation's app is a 404 in the shared envelope.
 */
import { appDeployProgressResponseSchema, appListResponseSchema } from '@launch/shared/launch-apps'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertIntent } from '@/api/services/launch/deploy/tickets'
import { auditEvents, deployTickets } from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  appToml,
  type DeployableApp,
  fillDeployCredentials,
  seedDeployableApp,
  uploadBody,
} from '../helpers/deploy-gateway'
import { createFakeCloud } from '../helpers/fake-cloud'
import { forgetApps } from '../helpers/launch-apps'
import { deployJob } from '../helpers/releases'
import { request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()
const cloud = createFakeCloud()
let restore: () => void
let env: TestEnv
const tenantIds: string[] = []

beforeAll(() => {
  restore = cloud.install()
})
afterAll(async () => {
  restore()
  await forgetApps(db, tenantIds)
})
beforeEach(() => {
  env = createTestEnv()
  fillDeployCredentials(store, cloud)
})

async function fixture() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  const seeded = await seedDeployableApp(db, cloud, tenant.id)
  return { tenantId: tenant.id, cookie, seeded }
}

async function latest(seeded: DeployableApp, cookie: Record<string, string>) {
  const res = await request(
    `/api/apps/${seeded.app.id}/deploys/latest`,
    { headers: cookie },
    { env }
  )
  expect(res.status, await res.clone().text()).toBe(200)
  return appDeployProgressResponseSchema.parse(await res.json()).items
}

/** A GitHub Actions run of `deploy.yml` in the fake, for a job to carry as its `run_id`. */
function fakeRun(seeded: DeployableApp, status: 'in_progress' | 'completed' = 'in_progress') {
  const run = {
    id: 70_000_000 + Math.floor(Math.random() * 1_000_000),
    owner: seeded.app.repoOwner as string,
    repo: seeded.app.repoName as string,
    workflow: 'deploy.yml',
    ref: 'refs/heads/main',
    inputs: { environment: 'staging' },
    status,
    conclusion: null as string | null,
    head_sha: 'a'.repeat(40),
    run_attempt: 1,
    created_at: new Date().toISOString(),
  }
  cloud.github.runs.push(run)
  return run
}

const runCalls = (runId: number) =>
  cloud.callsTo('github').filter(c => c.path.endsWith(`/actions/runs/${runId}`))

describe('GET /api/apps/:id/deploys/latest', () => {
  it('follows a staging deploy from start to live', async () => {
    const { cookie, seeded } = await fixture()
    expect(await latest(seeded, cookie)).toEqual([])

    const run = fakeRun(seeded)
    const job = deployJob(env, seeded, 'staging', { runId: String(run.id) })
    const start = (await (await job.call('POST', '/start', { protocol: 1 })).json()) as {
      id: string
    }
    let [deploy] = await latest(seeded, cookie)
    expect(deploy).toMatchObject({
      ticketId: start.id,
      environment: 'staging',
      phase: 'approved',
      reached: 'approved',
      inProgress: true,
      runUrl: `https://github.com/${seeded.repository}/actions/runs/${run.id}`,
    })

    const upload = await job.call(
      'POST',
      `/${start.id}/upload`,
      uploadBody(appToml(seeded, 'staging'), '1.2.0')
    )
    expect(upload.status, await upload.clone().text()).toBe(200)
    ;[deploy] = await latest(seeded, cookie)
    expect(deploy).toMatchObject({ phase: 'migrating', reached: 'migrating', version: '1.2.0' })

    // `activate` stamps `activation_started_at` before its vendor calls: "activating".
    await db
      .update(deployTickets)
      .set({ activationStartedAt: new Date() })
      .where(eq(deployTickets.id, start.id))
    ;[deploy] = await latest(seeded, cookie)
    expect(deploy).toMatchObject({ phase: 'activating', inProgress: true })

    expect((await job.call('POST', `/${start.id}/activate`)).status).toBe(200)
    ;[deploy] = await latest(seeded, cookie)
    expect(deploy).toMatchObject({ phase: 'done', reached: 'done', inProgress: false })
    expect(deploy?.activatedAt).toBeInstanceOf(Date)
    const [row] = await db.select().from(deployTickets).where(eq(deployTickets.id, start.id))
    expect(row?.activationStartedAt).toBeInstanceOf(Date)
  })

  it('fails a deploy whose GitHub run died, once, and revokes its migrator', async () => {
    const { tenantId, cookie, seeded } = await fixture()
    const run = fakeRun(seeded)
    const job = deployJob(env, seeded, 'staging', { runId: String(run.id) })
    const start = (await (await job.call('POST', '/start', { protocol: 1 })).json()) as {
      id: string
    }
    await job.call('POST', `/${start.id}/upload`, uploadBody(appToml(seeded, 'staging'), '1.3.0'))

    // Still running on GitHub: nothing changes.
    let [deploy] = await latest(seeded, cookie)
    expect(deploy?.phase).toBe('migrating')
    expect(runCalls(run.id)).toHaveLength(1)

    // The runner is lost mid-migration: the run is cancelled and `finish` never comes. Let the
    // read window pass (the claim is a timestamp in the row).
    run.status = 'completed'
    run.conclusion = 'cancelled'
    await db
      .update(deployTickets)
      .set({ runPolledAt: new Date(Date.now() - 60_000) })
      .where(eq(deployTickets.id, start.id))
    ;[deploy] = await latest(seeded, cookie)
    expect(deploy).toMatchObject({ phase: 'failed', reached: 'migrating', inProgress: false })
    expect(deploy?.error).toContain('cancelled')

    const [row] = await db.select().from(deployTickets).where(eq(deployTickets.id, start.id))
    expect(row?.status).toBe('failed')
    expect(row?.finishedAt).toBeInstanceOf(Date)
    expect(row?.credentialsRevokedAt).toBeInstanceOf(Date)
    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.targetId, start.id),
          eq(auditEvents.action, 'deploy.failed')
        )
      )
    expect(audits).toHaveLength(1)
    expect(audits[0]?.actorType).toBe('system')

    // Failed is settled: another read polls nothing.
    const before = runCalls(run.id).length
    await latest(seeded, cookie)
    expect(runCalls(run.id)).toHaveLength(before)
  })

  it('asks GitHub at most once per window, however many reads', async () => {
    const { cookie, seeded } = await fixture()
    const run = fakeRun(seeded)
    const job = deployJob(env, seeded, 'staging', { runId: String(run.id) })
    await job.call('POST', '/start', { protocol: 1 })
    await Promise.all([latest(seeded, cookie), latest(seeded, cookie), latest(seeded, cookie)])
    expect(runCalls(run.id)).toHaveLength(1)
  })

  it('shows an unclaimed production pre-approval as dispatched, and failed once it lapses', async () => {
    const { tenantId, cookie, seeded } = await fixture()
    const scope = { tenantId, appId: seeded.app.id, environmentId: seeded.production.id }
    const intent = await insertIntent(db, scope, {
      userId: null,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      ref: 'refs/tags/2.0.0',
      source: 'approval',
    })
    let [deploy] = await latest(seeded, cookie)
    expect(deploy).toMatchObject({
      ticketId: intent.id,
      environment: 'production',
      phase: 'dispatched',
      reached: 'dispatched',
      inProgress: true,
      runUrl: null,
    })

    await db
      .update(deployTickets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deployTickets.id, intent.id))
    ;[deploy] = await latest(seeded, cookie)
    expect(deploy).toMatchObject({ phase: 'failed', inProgress: false })
    expect(deploy?.error).toMatch(/lapsed/)
  })

  it('refuses without a session, and answers 404 for another organisation’s app', async () => {
    const { seeded } = await fixture()
    const other = await fixture()
    const anon = await request(`/api/apps/${seeded.app.id}/deploys/latest`, {}, { env })
    expect(anon.status).toBe(401)
    const res = await request(
      `/api/apps/${seeded.app.id}/deploys/latest`,
      { headers: other.cookie },
      { env }
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ statusCode: 404, code: 'app_not_found' })
  })
})

describe('GET /api/apps — latestDeploy', () => {
  it('carries the in-progress deploy before a newer settled one, and null for none', async () => {
    const { tenantId, cookie, seeded } = await fixture()
    const idle = await seedDeployableApp(db, cloud, tenantId)
    const run = fakeRun(seeded)
    const job = deployJob(env, seeded, 'production', { runId: String(run.id) })
    // A production run with nothing to claim waits on an approval.
    const start = (await (await job.call('POST', '/start', { protocol: 1 })).json()) as {
      id: string
      status: string
    }
    expect(start.status).toBe('pending')
    // …and a newer staging deploy that already went live.
    const staging = deployJob(env, seeded, 'staging')
    const s = (await (await staging.call('POST', '/start', { protocol: 1 })).json()) as {
      id: string
    }
    await staging.call('POST', `/${s.id}/upload`, uploadBody(appToml(seeded, 'staging'), '1.0.0'))
    await staging.call('POST', `/${s.id}/activate`)

    const res = await request('/api/apps', { headers: cookie }, { env })
    expect(res.status).toBe(200)
    const { items } = appListResponseSchema.parse(await res.json())
    const row = items.find(a => a.id === seeded.app.id)
    expect(row?.latestDeploy).toMatchObject({
      ticketId: start.id,
      environment: 'production',
      phase: 'awaiting_approval',
      inProgress: true,
    })
    expect(items.find(a => a.id === idle.app.id)?.latestDeploy).toBeNull()
  })
})
