// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform credential store.
/**
 * Stage-aware Retry, Cancel and "Fix in a session" (app page P2, plan decision 7), driven over
 * HTTP against the real release, deploy-gateway and approval paths and the FakeCloud GitHub.
 *
 * What it pins, per stage (`failedStage` on the release):
 * - `staging_deploy` — a refused staging build fails the release; Retry re-runs THAT run's failed
 *   jobs on GitHub (attempt 2), the release goes back to `staging`, attempt 2's deploy job opens
 *   a ticket of its own and goes live, and both attempts stay on the release; a late failure of
 *   attempt 1's ticket no longer fails the release. A red gate (no staging ticket yet) re-runs the
 *   tag's run and the release waits `tagged` again;
 * - `production_deploy` — a failed production run re-runs under its first attempt's approval:
 *   attempt 2 claims the pre-approval Retry left and is never sent to approval again;
 * - `tag` — a stalled release whose tag GitHub no longer has gets it pushed again; one whose tag
 *   exists is 409 (nothing Launch can redo);
 * - `staging_health` — probed now; `approval_rejected` — a new `deploy.production` request;
 * - 409 `release_not_retryable` with nothing failing, 409 `release_stage_changed` for a stale
 *   stage, a member who does not own the app is 403 and another organisation's app is 404;
 * - every retry audited `release.retried { stage, action, attempt }`;
 * - Cancel: cancels the run in flight on GitHub and fails the release (then Retry re-runs it);
 *   409 with no run going;
 * - Fix in a session: the session's first (pending) message names the stage, the run and the tail
 *   of the failed job's log; 409 for a release that is not failing.
 */
import {
  cancelReleaseResponseSchema,
  promoteReleaseResponseSchema,
  releaseSchema,
  retryReleaseResponseSchema,
} from '@launch/shared/launch-releases'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decide } from '@/api/services/approvals/engine'
import { releaseRunFailed } from '@/api/services/launch/releases/lifecycle'
import {
  appEnvironments,
  appReleases,
  approvalRequests,
  auditEvents,
  deployTickets,
  sessions,
} from '@/db/schema'
import { actorOf, approvalDeps, viewerOf } from '../helpers/approvals'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { appToml, fillDeployCredentials, uploadBody } from '../helpers/deploy-gateway'
import { createFakeCloud } from '../helpers/fake-cloud'
import { forgetApps } from '../helpers/launch-apps'
import { addTestAppOwner } from '../helpers/oidc'
import {
  deployJob,
  type ReleasableApp,
  seedReleasableApp,
  serveAppHosts,
  shipSessionPr,
} from '../helpers/releases'
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

interface Person {
  id: string
  email: string
  cookie: Record<string, string>
}

async function person(tenantId: string, role: 'owner' | 'admin' | 'member'): Promise<Person> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenantId))
  return { id: user.id, email: user.email, cookie }
}

/** `alice` and `bob` own the app; `carol` is a member who does not. */
async function fixture() {
  const { tenant } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const alice = await person(tenant.id, 'member')
  const bob = await person(tenant.id, 'member')
  const carol = await person(tenant.id, 'member')
  const app = await seedReleasableApp(db, cloud, tenant.id)
  await addTestAppOwner(db, tenant.id, app.app.id, alice.id)
  await addTestAppOwner(db, tenant.id, app.app.id, bob.id)
  serveAppHosts(cloud, app)
  const shipped = await shipSessionPr(db, cloud, app, {
    tenantId: tenant.id,
    userId: alice.id,
    title: 'Add the orders page',
  })
  cloud.github.merge(app.owner, app.repo, shipped.number)
  return { tenantId: tenant.id, alice, bob, carol, app }
}

async function cutRelease(app: ReleasableApp, who: Person) {
  const res = await request(
    `/api/apps/${app.app.id}/releases`,
    { method: 'POST', headers: who.cookie },
    { env, json: { bump: 'patch' } }
  )
  expect(res.status, await res.clone().text()).toBe(201)
  return releaseSchema.parse(await res.json())
}

async function readRelease(app: ReleasableApp, who: Person, id: string) {
  const res = await request(
    `/api/apps/${app.app.id}/releases/${id}`,
    { headers: who.cookie },
    { env }
  )
  expect(res.status, await res.clone().text()).toBe(200)
  return releaseSchema.parse(await res.json())
}

function retry(app: ReleasableApp, who: Person, id: string, body: Record<string, unknown> = {}) {
  return request(
    `/api/apps/${app.app.id}/releases/${id}/retry`,
    { method: 'POST', headers: who.cookie },
    { env, json: body }
  )
}

/** A build the binding check refuses: a KV namespace that is not the app's. */
function refusedToml(app: ReleasableApp, environment: 'staging' | 'production') {
  return appToml(
    app,
    environment,
    `
[[kv_namespaces]]
binding = "STRANGER_KV"
id = "0123456789abcdef0123456789abcdef"
`
  )
}

/** One deploy job of run `runId` attempt `attempt`: start, then a refused upload. */
async function failingJob(
  app: ReleasableApp,
  environment: 'staging' | 'production',
  ref: string,
  runId: number,
  attempt = 1
) {
  const job = deployJob(env, app, environment, { ref, runId: String(runId), runAttempt: attempt })
  const start = await job.call('POST', '/start', { protocol: 1 })
  expect(start.status, await start.clone().text()).toBe(200)
  const { id, status } = (await start.json()) as { id: string; status: string }
  expect(status).toBe('approved')
  const upload = await job.call('POST', `/${id}/upload`, uploadBody(refusedToml(app, environment)))
  expect(upload.status, await upload.clone().text()).toBe(403)
  await job.call('POST', `/${id}/finish`)
  return id
}

/** One whole deploy job of run `runId` attempt `attempt` that goes live. */
async function shippingJob(
  app: ReleasableApp,
  environment: 'staging' | 'production',
  ref: string,
  runId: number,
  attempt = 1
) {
  const job = deployJob(env, app, environment, { ref, runId: String(runId), runAttempt: attempt })
  const startRes = await job.call('POST', '/start', { protocol: 1 })
  expect(startRes.status, await startRes.clone().text()).toBe(200)
  const start = (await startRes.json()) as { id: string; status: string }
  expect(start.status).toBe('approved')
  const version = ref.replace('refs/tags/', '')
  for (const [path, payload] of [
    ['upload', uploadBody(appToml(app, environment), version)],
    ['activate', undefined],
    ['finish', undefined],
  ] as const) {
    const res = await job.call('POST', `/${start.id}/${path}`, payload)
    expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200)
  }
  return start.id
}

async function actions(tenantId: string, targetId: string) {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.targetId, targetId)))
  return rows.sort((a, b) => a.at.getTime() - b.at.getTime())
}

describe('POST /api/apps/:id/releases/:rid/retry — deploy runs', () => {
  it('re-runs a failed staging run, keeps both attempts and goes live on attempt 2', async () => {
    const { tenantId, alice, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const ref = `refs/tags/${cut.tag}`
    const run = cloud.github.pushRun(app.owner, app.repo, ref, {
      status: 'in_progress',
      jobs: [
        { name: 'Gate', status: 'completed', conclusion: 'success' },
        { name: 'Deploy to staging', status: 'in_progress' },
      ],
    })
    const attempt1 = await failingJob(app, 'staging', ref, run.id)
    run.status = 'completed'
    run.conclusion = 'failure'
    if (run.jobs?.[1]) {
      run.jobs[1].status = 'completed'
      run.jobs[1].conclusion = 'failure'
    }

    const failed = await readRelease(app, alice, cut.id)
    expect(failed).toMatchObject({ status: 'failed', failedStage: 'staging_deploy' })
    expect(failed.error).toMatch(/^staging: /)

    const res = await retry(app, alice, cut.id, { stage: 'staging_deploy' })
    expect(res.status, await res.clone().text()).toBe(202)
    const body = retryReleaseResponseSchema.parse(await res.json())
    expect(body).toMatchObject({
      stage: 'staging_deploy',
      action: 'rerun',
      attempt: 2,
      runUrl: `https://github.com/${app.owner}/${app.repo}/actions/runs/${run.id}`,
      release: { status: 'staging', error: null, failedStage: null },
    })
    expect(cloud.github.reruns).toContainEqual({ runId: run.id, attempt: 2 })

    // Pressed again while the re-run is going: nothing to retry.
    const again = await retry(app, alice, cut.id)
    expect(again.status).toBe(409)
    expect(((await again.json()) as { code: string }).code).toBe('release_not_retryable')

    // Attempt 2's deploy job is not a stranger: its own ticket, and the release goes live.
    const attempt2 = await shippingJob(app, 'staging', ref, run.id, 2)
    expect(attempt2).not.toBe(attempt1)
    const live = await readRelease(app, alice, cut.id)
    expect(live).toMatchObject({ status: 'staging_active', stagingTicketId: attempt2 })
    const tickets = await db
      .select()
      .from(deployTickets)
      .where(and(eq(deployTickets.tenantId, tenantId), eq(deployTickets.releaseId, cut.id)))
    expect(tickets.map(t => [t.runId, t.runAttempt]).sort()).toEqual([
      [String(run.id), 1],
      [String(run.id), 2],
    ])

    // Audited once, on the release.
    const retried = (await actions(tenantId, cut.id)).filter(a => a.action === 'release.retried')
    expect(retried).toHaveLength(1)
    expect(retried[0]?.summary.after).toMatchObject({
      stage: 'staging_deploy',
      action: 'rerun',
      attempt: 2,
    })
  })

  it('a late failure of a superseded attempt leaves the retried release alone', async () => {
    const { tenantId, alice, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const ref = `refs/tags/${cut.tag}`
    const run = cloud.github.pushRun(app.owner, app.repo, ref, {
      status: 'completed',
      conclusion: 'failure',
    })
    const attempt1 = await failingJob(app, 'staging', ref, run.id)
    expect((await retry(app, alice, cut.id)).status).toBe(202)
    // Attempt 2 starts (the release now names its ticket)…
    const job = deployJob(env, app, 'staging', { ref, runId: String(run.id), runAttempt: 2 })
    expect((await job.call('POST', '/start', { protocol: 1 })).status).toBe(200)
    // …and attempt 1's ticket failing again (a late poll) does not fail the release.
    const [old] = await db
      .select()
      .from(deployTickets)
      .where(and(eq(deployTickets.tenantId, tenantId), eq(deployTickets.id, attempt1)))
    if (!old) throw new Error('no attempt 1 ticket')
    await releaseRunFailed(db, old, 'staging', 'the run ended')
    expect((await readRelease(app, alice, cut.id)).status).toBe('staging')
  })

  it('a red gate (no staging job yet) re-runs the tag’s run and waits on it again', async () => {
    const { alice, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const run = cloud.github.pushTagRun(app.owner, app.repo, cut.tag, {
      status: 'completed',
      conclusion: 'failure',
      jobs: [{ name: 'Gate', status: 'completed', conclusion: 'failure' }],
    })
    // The pipeline strip's read follows the run and fails the release.
    const strip = await request(
      `/api/apps/${app.app.id}/promotion`,
      { headers: alice.cookie },
      { env }
    )
    expect(strip.status).toBe(200)
    const failed = await readRelease(app, alice, cut.id)
    expect(failed).toMatchObject({ status: 'failed', failedStage: 'staging_deploy' })

    const res = await retry(app, alice, cut.id)
    expect(res.status, await res.clone().text()).toBe(202)
    const body = retryReleaseResponseSchema.parse(await res.json())
    expect(body).toMatchObject({ action: 'rerun', attempt: 2, release: { status: 'tagged' } })
    expect(run).toMatchObject({ run_attempt: 2, status: 'queued' })
    // The next read sees the re-run going, not the failure it replaced.
    await request(`/api/apps/${app.app.id}/promotion`, { headers: alice.cookie }, { env })
    expect((await readRelease(app, alice, cut.id)).status).toBe('tagged')
  })

  it('a run still going is 409 release_run_in_progress', async () => {
    const { tenantId, alice, app } = await fixture()
    const cut = await cutRelease(app, alice)
    cloud.github.pushTagRun(app.owner, app.repo, cut.tag, { status: 'in_progress' })
    await db
      .update(appReleases)
      .set({ status: 'failed', error: 'staging: the deploy run failed at "Gate"' })
      .where(and(eq(appReleases.tenantId, tenantId), eq(appReleases.id, cut.id)))
    const res = await retry(app, alice, cut.id)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('release_run_in_progress')
    expect((await readRelease(app, alice, cut.id)).status).toBe('failed')
  })

  it('re-runs a failed production run under its first approval — never asks again', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const ref = `refs/tags/${cut.tag}`
    const stagingRun = cloud.github.pushRun(app.owner, app.repo, ref, {
      status: 'completed',
      conclusion: 'success',
    })
    await shippingJob(app, 'staging', ref, stagingRun.id)
    const promoted = await request(
      `/api/apps/${app.app.id}/releases/${cut.id}/promote`,
      { method: 'POST', headers: alice.cookie },
      { env, json: {} }
    )
    expect(promoted.status, await promoted.clone().text()).toBe(202)
    const { approvalId } = promoteReleaseResponseSchema.parse(await promoted.json())
    await decide(approvalDeps(db, env), {
      requestId: approvalId,
      viewer: await viewerOf(db, tenantId, bob),
      decision: 'approve',
      actor: actorOf(bob),
    })
    expect((await readRelease(app, alice, cut.id)).status).toBe('promoting')

    const prodRun = cloud.github.pushRun(app.owner, app.repo, ref, {
      event: 'release',
      status: 'in_progress',
    })
    await failingJob(app, 'production', ref, prodRun.id)
    prodRun.status = 'completed'
    prodRun.conclusion = 'failure'
    const failed = await readRelease(app, alice, cut.id)
    expect(failed).toMatchObject({ status: 'failed', failedStage: 'production_deploy' })

    const res = await retry(app, alice, cut.id, { stage: 'production_deploy' })
    expect(res.status, await res.clone().text()).toBe(202)
    expect(retryReleaseResponseSchema.parse(await res.json())).toMatchObject({
      action: 'rerun',
      attempt: 2,
      approvalId,
      release: { status: 'promoting' },
    })
    const requestsBefore = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.appId, app.app.id)))

    // Attempt 2 claims the pre-approval: approved at start, live at the end, no new request.
    await shippingJob(app, 'production', ref, prodRun.id, 2)
    expect((await readRelease(app, alice, cut.id)).status).toBe('production_active')
    const requestsAfter = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.appId, app.app.id)))
    expect(requestsAfter).toHaveLength(requestsBefore.length)
  })
})

describe('POST /api/apps/:id/releases/:rid/retry — tag, health, approval', () => {
  it('pushes a lost tag again on the release’s commit; a present tag is 409', async () => {
    const { tenantId, alice, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const stall = new Date(Date.now() - 60 * 60_000)
    await db
      .update(appReleases)
      .set({ updatedAt: stall })
      .where(and(eq(appReleases.tenantId, tenantId), eq(appReleases.id, cut.id)))
    expect((await readRelease(app, alice, cut.id)).failedStage).toBe('tag')

    // GitHub has the tag but ran nothing for it: nothing Launch can redo.
    const present = await retry(app, alice, cut.id)
    expect(present.status).toBe(409)
    expect(((await present.json()) as { code: string }).code).toBe('release_not_retryable')

    const repo = cloud.github.repo(app.owner, app.repo)
    repo?.refs.delete(`tags/${cut.tag}`)
    const res = await retry(app, alice, cut.id, { stage: 'tag' })
    expect(res.status, await res.clone().text()).toBe(202)
    expect(retryReleaseResponseSchema.parse(await res.json())).toMatchObject({
      stage: 'tag',
      action: 'retag',
      release: { status: 'tagged', failedStage: null },
    })
    expect(repo?.refs.get(`tags/${cut.tag}`)).toBe(cut.sha)
  })

  it('checks staging health now', async () => {
    const { tenantId, alice, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const ref = `refs/tags/${cut.tag}`
    const run = cloud.github.pushRun(app.owner, app.repo, ref, {
      status: 'completed',
      conclusion: 'success',
    })
    await shippingJob(app, 'staging', ref, run.id)
    await db
      .update(appEnvironments)
      .set({ healthStatus: 'down' })
      .where(
        and(
          eq(appEnvironments.tenantId, tenantId),
          eq(appEnvironments.appId, app.app.id),
          eq(appEnvironments.name, 'staging')
        )
      )
    expect((await readRelease(app, alice, cut.id)).failedStage).toBe('staging_health')

    const res = await retry(app, alice, cut.id)
    expect(res.status, await res.clone().text()).toBe(202)
    expect(retryReleaseResponseSchema.parse(await res.json())).toMatchObject({
      stage: 'staging_health',
      action: 'health_check',
      health: 'up',
      release: { failedStage: null },
    })
    const audited = (await actions(tenantId, cut.id)).find(a => a.action === 'release.retried')
    expect(audited?.summary.after).toMatchObject({ stage: 'staging_health', health: 'up' })
  })

  it('requests a rejected release’s approval again', async () => {
    const { tenantId, alice, bob, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const ref = `refs/tags/${cut.tag}`
    const run = cloud.github.pushRun(app.owner, app.repo, ref, {
      status: 'completed',
      conclusion: 'success',
    })
    await shippingJob(app, 'staging', ref, run.id)
    const promoted = await request(
      `/api/apps/${app.app.id}/releases/${cut.id}/promote`,
      { method: 'POST', headers: alice.cookie },
      { env, json: {} }
    )
    const first = promoteReleaseResponseSchema.parse(await promoted.json())
    await decide(approvalDeps(db, env), {
      requestId: first.approvalId,
      viewer: await viewerOf(db, tenantId, bob),
      decision: 'reject',
      actor: actorOf(bob),
    })
    expect(await readRelease(app, alice, cut.id)).toMatchObject({
      status: 'rejected',
      failedStage: 'approval_rejected',
    })

    const res = await retry(app, alice, cut.id, {
      stage: 'approval_rejected',
      reason: 'Fixed the copy',
    })
    expect(res.status, await res.clone().text()).toBe(202)
    const body = retryReleaseResponseSchema.parse(await res.json())
    expect(body).toMatchObject({
      action: 'approval',
      release: { status: 'awaiting_approval', failedStage: null },
    })
    expect(body.approvalId).not.toBe(first.approvalId)
  })
})

describe('POST /api/apps/:id/releases/:rid/retry — refusals', () => {
  it('is 409 with nothing failing, 409 for a stale stage, 403 for a non-owner, 404 elsewhere', async () => {
    const { tenantId, alice, carol, app } = await fixture()
    const cut = await cutRelease(app, alice)

    const nothing = await retry(app, alice, cut.id)
    expect(nothing.status).toBe(409)
    expect(((await nothing.json()) as { code: string }).code).toBe('release_not_retryable')

    await db
      .update(appReleases)
      .set({ status: 'failed', error: 'staging: refused' })
      .where(and(eq(appReleases.tenantId, tenantId), eq(appReleases.id, cut.id)))
    const stale = await retry(app, alice, cut.id, { stage: 'production_deploy' })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { code: string }).code).toBe('release_stage_changed')

    // Members who do not own the app may read it but not retry its releases.
    expect((await readRelease(app, carol, cut.id)).failedStage).toBe('staging_deploy')
    expect((await retry(app, carol, cut.id)).status).toBe(403)

    // Another organisation's owner: the app does not exist for them.
    const { user: stranger, tenant: other } = await createTestTenantWithUser(db, 'owner')
    tenantIds.push(other.id)
    const strangerCookie = sessionCookieHeader(await createTestSession(db, stranger.id, other.id))
    const foreign = await request(
      `/api/apps/${app.app.id}/releases/${cut.id}/retry`,
      { method: 'POST', headers: strangerCookie },
      { env, json: {} }
    )
    expect(foreign.status).toBe(404)
    expect((await actions(tenantId, cut.id)).some(a => a.action === 'release.retried')).toBe(false)
  })
})

describe('POST /api/apps/:id/releases/:rid/cancel', () => {
  it('cancels the run in flight and fails the release; Retry then re-runs it', async () => {
    const { tenantId, alice, carol, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const run = cloud.github.pushTagRun(app.owner, app.repo, cut.tag, {
      status: 'in_progress',
      jobs: [{ name: 'Gate', status: 'in_progress' }],
    })
    const cancelPath = `/api/apps/${app.app.id}/releases/${cut.id}/cancel`
    expect(
      (await request(cancelPath, { method: 'POST', headers: carol.cookie }, { env })).status
    ).toBe(403)

    const res = await request(cancelPath, { method: 'POST', headers: alice.cookie }, { env })
    expect(res.status, await res.clone().text()).toBe(202)
    const body = cancelReleaseResponseSchema.parse(await res.json())
    expect(body.release).toMatchObject({ status: 'failed', failedStage: 'staging_deploy' })
    expect(body.release.error).toMatch(/^staging: cancelled in Launch by /)
    expect(cloud.github.cancels).toContain(run.id)
    expect(run).toMatchObject({ status: 'completed', conclusion: 'cancelled' })
    expect((await actions(tenantId, cut.id)).some(a => a.action === 'release.cancelled')).toBe(true)

    // Nothing in flight any more.
    const again = await request(cancelPath, { method: 'POST', headers: alice.cookie }, { env })
    expect(again.status).toBe(409)
    expect(((await again.json()) as { code: string }).code).toBe('release_not_cancellable')

    const retried = await retry(app, alice, cut.id)
    expect(retried.status, await retried.clone().text()).toBe(202)
    expect(run.run_attempt).toBe(2)
  })
})

describe('POST /api/apps/:id/sessions { fixRelease }', () => {
  it('seeds the session with the stage, the run and the failed job’s log', async () => {
    const { tenantId, alice, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const run = cloud.github.pushTagRun(app.owner, app.repo, cut.tag, {
      status: 'completed',
      conclusion: 'failure',
      jobs: [
        { name: 'Gate', status: 'completed', conclusion: 'failure' },
        { name: 'Deploy to staging', status: 'completed', conclusion: 'skipped' },
      ],
    })
    const gate = run.jobs?.[0]
    if (!gate?.id) throw new Error('no gate job')
    cloud.github.setJobLog(
      app.owner,
      app.repo,
      gate.id,
      '2026-10-02T10:00:00.000Z Running tests\n2026-10-02T10:00:01.000Z FAIL src/orders.test.ts\n'
    )
    await request(`/api/apps/${app.app.id}/promotion`, { headers: alice.cookie }, { env })
    expect((await readRelease(app, alice, cut.id)).failedStage).toBe('staging_deploy')

    const res = await request(
      `/api/apps/${app.app.id}/sessions`,
      { method: 'POST', headers: alice.cookie },
      { env, json: { fixRelease: { releaseId: cut.id } } }
    )
    expect(res.status, await res.clone().text()).toBe(202)
    const { session } = (await res.json()) as { session: { id: string; title: string } }
    expect(session.title).toBe(`Fix ${cut.version}: staging deploy failed`)
    const [row] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, session.id)))
    expect(row?.pendingMessage).toContain(
      `Release ${cut.version} of this app failed at: Staging deploy`
    )
    expect(row?.pendingMessage).toContain(`/actions/runs/${run.id}`)
    expect(row?.pendingMessage).toContain('Failed job: Gate')
    expect(row?.pendingMessage).toContain('FAIL src/orders.test.ts')
    expect(row?.pendingMessage).not.toContain('2026-10-02T10:00:01')
  })

  it('is 409 for a release that is not failing, 404 for another app’s', async () => {
    const { alice, app } = await fixture()
    const cut = await cutRelease(app, alice)
    const res = await request(
      `/api/apps/${app.app.id}/sessions`,
      { method: 'POST', headers: alice.cookie },
      { env, json: { fixRelease: { releaseId: cut.id } } }
    )
    expect(res.status).toBe(409)
    const other = await fixture()
    const foreign = await request(
      `/api/apps/${other.app.app.id}/sessions`,
      { method: 'POST', headers: other.alice.cookie },
      { env, json: { fixRelease: { releaseId: cut.id } } }
    )
    expect(foreign.status).toBe(404)
  })
})
