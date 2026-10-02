// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform credential store.
/**
 * Rollback and main-ahead (app page P3, plan decisions 3, 5 and 8), driven over HTTP against the
 * real release, deploy-gateway and approval paths and the FakeCloud GitHub.
 *
 * Rollback — what it pins:
 * - an EARLIER release that was live goes through the same `deploy.production` approval as Ship
 *   (subject `rollback`, bound to its tag); approving it dispatches the repo's own `deploy.yml`
 *   at the tag with `environment=production`; the run that dispatch starts claims the
 *   pre-approval (never sent to approval again), and once it is live production runs the old
 *   version (the `X.Y.Z-<sha7>` label a tag dispatch uploads reads `X.Y.Z`), the release rolled
 *   back to records `rolledBackFrom`, the one rolled back from is `rolled_back`, audited
 *   `release.rolled_back`, and the promotion view's Live says so;
 * - the current release, a later one and one never live are 409 `release_not_rollbackable`;
 *   another production deploy waiting is 409 `release_production_busy`; pressing twice returns the
 *   open request;
 * - a member who does not own the app is 403; another organisation's app is 404.
 *
 * Compare — the default branch against the latest release tag: commits ahead (newest first, PR
 * numbers from the messages), cached for the window, recomputed once a release moves the base,
 * a GitHub failure answered as `aheadBy: null` with `error`, and tenant-scoped.
 */
import { appPromotionSchema } from '@launch/shared/launch-promotion'
import {
  promoteReleaseResponseSchema,
  releaseCompareSchema,
  releaseSchema,
  rollbackReleaseResponseSchema,
} from '@launch/shared/launch-releases'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decide } from '@/api/services/approvals/engine'
import { appEnvironments, approvalRequests, apps, auditEvents, deployTickets } from '@/db/schema'
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
  return { tenantId: tenant.id, alice, bob, carol, app }
}

async function mergeChange(tenantId: string, app: ReleasableApp, who: Person, title: string) {
  const shipped = await shipSessionPr(db, cloud, app, { tenantId, userId: who.id, title })
  cloud.github.merge(app.owner, app.repo, shipped.number)
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

/** One whole deploy job that goes live, uploading `version` (default: the tag). */
async function shippingJob(
  app: ReleasableApp,
  environment: 'staging' | 'production',
  ref: string,
  version = ref.replace('refs/tags/', '')
) {
  const job = deployJob(env, app, environment, { ref })
  const startRes = await job.call('POST', '/start', { protocol: 1 })
  expect(startRes.status, await startRes.clone().text()).toBe(200)
  const start = (await startRes.json()) as { id: string; status: string }
  expect(start.status).toBe('approved')
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

/** Cut a release, deploy it to staging, promote it (alice), approve it (bob), deploy production. */
async function shipToLive(tenantId: string, app: ReleasableApp, alice: Person, bob: Person) {
  const cut = await cutRelease(app, alice)
  const ref = `refs/tags/${cut.tag}`
  await shippingJob(app, 'staging', ref)
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
  await shippingJob(app, 'production', ref)
  return cut
}

/** Two releases live one after the other: 0.1.1 then 0.1.2 (Live runs 0.1.2). */
async function twoReleasesLive() {
  const f = await fixture()
  await mergeChange(f.tenantId, f.app, f.alice, 'Add the orders page')
  const first = await shipToLive(f.tenantId, f.app, f.alice, f.bob)
  await mergeChange(f.tenantId, f.app, f.alice, 'Add the invoices page')
  const second = await shipToLive(f.tenantId, f.app, f.alice, f.bob)
  return { ...f, first, second }
}

function rollback(app: ReleasableApp, who: Person | Record<string, string>, id: string) {
  const headers = 'cookie' in who && typeof who.cookie === 'object' ? who.cookie : who
  return request(
    `/api/apps/${app.app.id}/releases/${id}/rollback`,
    { method: 'POST', headers: headers as Record<string, string> },
    { env, json: {} }
  )
}

async function production(tenantId: string, appId: string) {
  const [row] = await db
    .select()
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, tenantId),
        eq(appEnvironments.appId, appId),
        eq(appEnvironments.name, 'production')
      )
    )
  return row
}

async function code(res: Response) {
  return ((await res.json()) as { code?: string }).code
}

describe('POST /api/apps/:id/releases/:rid/rollback', () => {
  it('asks for approval, dispatches deploy.yml at the old tag, and Live goes back', async () => {
    const { tenantId, alice, bob, app, first, second } = await twoReleasesLive()
    expect((await production(tenantId, app.app.id))?.lastDeployVersion).toBe(second.version)

    const res = await rollback(app, alice, first.id)
    expect(res.status, await res.clone().text()).toBe(202)
    const body = rollbackReleaseResponseSchema.parse(await res.json())
    expect(body).toMatchObject({
      from: second.version,
      approvalStatus: 'pending',
      release: { id: first.id, version: first.version, status: 'production_active' },
    })

    // The same production gate as Ship: a `deploy.production` request, bound to the old tag.
    const [requestRow] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, body.approvalId)))
    expect(requestRow).toMatchObject({
      kind: 'deploy.production',
      subjectType: 'rollback',
      subjectId: first.id,
      status: 'pending',
    })
    expect(requestRow?.context).toMatchObject({
      ref: `refs/tags/${first.tag}`,
      version: first.version,
      rollbackFrom: second.version,
    })
    expect(requestRow?.excludedUserIds).toContain(alice.id)

    // Pressed again: the open request, not a second one.
    const again = await rollback(app, alice, first.id)
    expect(again.status).toBe(202)
    expect(rollbackReleaseResponseSchema.parse(await again.json()).approvalId).toBe(body.approvalId)

    // The Live row's waiting line.
    const waiting = appPromotionSchema.parse(
      await (
        await request(`/api/apps/${app.app.id}/promotion`, { headers: alice.cookie }, { env })
      ).json()
    )
    expect(waiting.rollback).toMatchObject({
      releaseId: first.id,
      version: first.version,
      from: second.version,
      approval: { id: body.approvalId, status: 'pending' },
    })

    // Nothing is dispatched before the approval.
    const dispatchedBefore = cloud.github.runs.filter(
      r => r.owner === app.owner && r.repo === app.repo && r.inputs.environment === 'production'
    )
    expect(dispatchedBefore).toHaveLength(0)

    await decide(approvalDeps(db, env), {
      requestId: body.approvalId,
      viewer: await viewerOf(db, tenantId, bob),
      decision: 'approve',
      actor: actorOf(bob),
    })

    // The repo's OWN workflow at the old tag, production — exactly what a person would dispatch.
    const dispatched = cloud.github.runs.filter(
      r => r.owner === app.owner && r.repo === app.repo && r.inputs.environment === 'production'
    )
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({ workflow: 'deploy.yml', ref: first.tag })

    // The run it starts claims the pre-approval (no second request) and uploads the dispatch's
    // `<tag>-<sha7>` label, which is release `first`.
    const requestsBefore = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.appId, app.app.id)))
    const ticketId = await shippingJob(
      app,
      'production',
      `refs/tags/${first.tag}`,
      `${first.tag}-${'a'.repeat(7)}`
    )
    const requestsAfter = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.appId, app.app.id)))
    expect(requestsAfter).toHaveLength(requestsBefore.length)

    const [ticket] = await db
      .select()
      .from(deployTickets)
      .where(and(eq(deployTickets.tenantId, tenantId), eq(deployTickets.id, ticketId)))
    expect(ticket).toMatchObject({
      releaseId: first.id,
      approvalId: body.approvalId,
      version: first.version,
    })
    const live = await production(tenantId, app.app.id)
    expect(live?.lastDeployVersion).toBe(first.version)
    // The Worker's RELEASE_VERSION reads the release too.
    const worker = cloud.cloudflare.activeVersion(app.production.workerName as string)
    expect(worker?.bindings.find(b => b.name === 'RELEASE_VERSION')?.text).toBe(first.version)

    // Release state: the one rolled back to says from what; the one rolled back from says so.
    expect(await readRelease(app, alice, first.id)).toMatchObject({
      status: 'production_active',
      rolledBackFrom: second.version,
      productionTicketId: ticketId,
    })
    expect(await readRelease(app, alice, second.id)).toMatchObject({
      status: 'rolled_back',
      rolledBackFrom: null,
    })

    const audited = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, 'release.rolled_back')))
    expect(audited).toHaveLength(1)
    expect(audited[0]).toMatchObject({ targetId: second.id, approvalId: body.approvalId })
    expect(audited[0]?.summary).toMatchObject({
      before: { live: second.version },
      after: { live: first.version, releaseId: first.id, status: 'rolled_back' },
    })
    const requested = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.action, 'release.rollback_requested')
        )
      )
    expect(requested.map(r => r.targetId)).toEqual([first.id])

    // The Live row: "v0.1.1 (rolled back from v0.1.2)"; no waiting line any more.
    const after = appPromotionSchema.parse(
      await (
        await request(`/api/apps/${app.app.id}/promotion`, { headers: alice.cookie }, { env })
      ).json()
    )
    expect(after.production).toMatchObject({
      version: first.version,
      releaseId: first.id,
      rolledBackFrom: second.version,
    })
    expect(after.rollback).toBeNull()

    // Rolling back again to what Live already runs, or forward to the rolled-back release: 409.
    expect(await code(await rollback(app, alice, first.id))).toBe('release_not_rollbackable')
    expect(await code(await rollback(app, alice, second.id))).toBe('release_not_rollbackable')
  })

  it('refuses a release that is not earlier than Live, or was never live', async () => {
    const { tenantId, alice, app, second } = await twoReleasesLive()
    // The current release.
    const current = await rollback(app, alice, second.id)
    expect(current.status).toBe(409)
    expect(await code(current)).toBe('release_not_rollbackable')
    // A release only on staging.
    await mergeChange(tenantId, app, alice, 'Add the reports page')
    const staged = await cutRelease(app, alice)
    await shippingJob(app, 'staging', `refs/tags/${staged.tag}`)
    const never = await rollback(app, alice, staged.id)
    expect(never.status).toBe(409)
    expect(await code(never)).toBe('release_not_rollbackable')
    const requests = await db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.subjectType, 'rollback'))
      )
    expect(requests).toHaveLength(0)
  })

  it('is 409 while another production deploy waits for approval', async () => {
    const { tenantId, alice, app, first } = await twoReleasesLive()
    await mergeChange(tenantId, app, alice, 'Add the reports page')
    const next = await cutRelease(app, alice)
    await shippingJob(app, 'staging', `refs/tags/${next.tag}`)
    const promoted = await request(
      `/api/apps/${app.app.id}/releases/${next.id}/promote`,
      { method: 'POST', headers: alice.cookie },
      { env, json: {} }
    )
    expect(promoted.status).toBe(202)
    const res = await rollback(app, alice, first.id)
    expect(res.status).toBe(409)
    expect(await code(res)).toBe('release_production_busy')
  })

  it('is 403 for a member who does not own the app and 404 in another organisation', async () => {
    const { tenantId, carol, app, first } = await twoReleasesLive()
    expect((await rollback(app, carol, first.id)).status).toBe(403)

    const { user: stranger, tenant: other } = await createTestTenantWithUser(db, 'owner')
    tenantIds.push(other.id)
    const strangerCookie = sessionCookieHeader(await createTestSession(db, stranger.id, other.id))
    expect((await rollback(app, strangerCookie, first.id)).status).toBe(404)

    const requests = await db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.subjectType, 'rollback'))
      )
    expect(requests).toHaveLength(0)
  })
})

describe('GET /api/apps/:id/releases/compare', () => {
  function compare(app: ReleasableApp, headers: Record<string, string>) {
    return request(`/api/apps/${app.app.id}/releases/compare`, { headers }, { env })
  }

  async function forgetCache(tenantId: string, appId: string) {
    await db
      .update(apps)
      .set({ mainCompareAt: null })
      .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
  }

  it('counts main’s commits since the latest release tag, cached for the window', async () => {
    const { tenantId, alice, carol, app } = await fixture()
    await mergeChange(tenantId, app, alice, 'Add the orders page')
    const cut = await cutRelease(app, alice)
    cloud.github.pushCommit(app.owner, app.repo, { 'src/a.ts': '// a\n' }, 'Fix the header (#41)')
    cloud.github.pushCommit(app.owner, app.repo, { 'src/b.ts': '// b\n' }, 'Tidy the footer')

    // Members read it.
    const res = await compare(app, carol.cookie)
    expect(res.status, await res.clone().text()).toBe(200)
    const body = releaseCompareSchema.parse(await res.json())
    expect(body).toMatchObject({ branch: 'main', base: cut.tag, aheadBy: 2, error: null })
    expect(body.commits.map(c => [c.message, c.prNumber])).toEqual([
      ['Tidy the footer', null],
      ['Fix the header (#41)', 41],
    ])
    expect(body.headSha).toBe(body.commits[0]?.sha)

    // Inside the window GitHub is not asked again: another push is not seen yet.
    cloud.github.pushCommit(app.owner, app.repo, { 'src/c.ts': '// c\n' }, 'Third')
    const cached = releaseCompareSchema.parse(await (await compare(app, alice.cookie)).json())
    expect(cached.aheadBy).toBe(2)

    // A new release moves the base: the reading is stale at once.
    const next = await cutRelease(app, alice)
    const moved = releaseCompareSchema.parse(await (await compare(app, alice.cookie)).json())
    expect(moved).toMatchObject({ base: next.tag, aheadBy: 0, commits: [] })
  })

  it('falls back to the highest X.Y.Z tag when Launch cut no release', async () => {
    const { tenantId, alice, app } = await fixture()
    cloud.github.tag(app.owner, app.repo, '0.1.0')
    cloud.github.tag(app.owner, app.repo, 'not-a-version')
    cloud.github.pushCommit(app.owner, app.repo, { 'src/a.ts': '// a\n' }, 'One')
    const body = releaseCompareSchema.parse(await (await compare(app, alice.cookie)).json())
    expect(body).toMatchObject({ base: '0.1.0', aheadBy: 1 })
    await forgetCache(tenantId, app.app.id)
  })

  it('answers a GitHub failure as aheadBy null with the error, and is tenant-scoped', async () => {
    const { alice, app } = await fixture()
    await mergeChange(app.app.tenantId, app, alice, 'Add the orders page')
    await cutRelease(app, alice)
    cloud.failNext('/compare/', 500, { message: 'Server Error' })
    const res = await compare(app, alice.cookie)
    expect(res.status).toBe(200)
    const body = releaseCompareSchema.parse(await res.json())
    expect(body.aheadBy).toBeNull()
    expect(body.error).toMatch(/GitHub could not compare main/)

    const { user: stranger, tenant: other } = await createTestTenantWithUser(db, 'owner')
    tenantIds.push(other.id)
    const strangerCookie = sessionCookieHeader(await createTestSession(db, stranger.id, other.id))
    expect((await compare(app, strangerCookie)).status).toBe(404)
  })
})
