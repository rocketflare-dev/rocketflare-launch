// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform credential store.
/**
 * The app page's pipeline strip (rocketflare-launch#5 part 8): `GET /api/apps/:id/promotion`.
 * Driven over HTTP against the real release, deploy and approval paths.
 *
 * What it pins:
 * - before any release, an empty candidate;
 * - a release live on staging: the candidate, staging's version and release, and the PRs it ships
 *   with the session that wrote each one (its title, not a SHA);
 * - once promoted, the pending `deploy.production` request and who it waits on — named for any
 *   member, never the promoter or the PR's author;
 * - after production runs a release, the next candidate's changes stop at production's version;
 * - each change's summary (issue #5): the session's stored ship summary body, clipped to
 *   `PROMOTION_SUMMARY_MAX`; null for a PR no session wrote, and never another organisation's;
 * - 401 without a session, 404 for another organisation's app (tenant isolation);
 * - the candidate's tag deploy run (`releases/tag-run.ts`): read from GitHub while the release is
 *   `tagged` (job by job, throttled per release), never once staging is live; a run that failed
 *   before staging moves the release to `failed`, audited `release.failed` (in its chain), and the
 *   failed release keeps naming the job; a GitHub error is a null run, never a failed read; another
 *   organisation's read neither sees nor polls it.
 */
import { appPromotionSchema, PROMOTION_SUMMARY_MAX } from '@launch/shared/launch-promotion'
import { promoteReleaseResponseSchema, releaseChainSchema } from '@launch/shared/launch-releases'
import { and, eq, like } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decide } from '@/api/services/approvals/engine'
import { appEnvironments, appReleases, auditEvents, sessions } from '@/db/schema'
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
  openPullOnBranch,
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

/**
 * An organisation: its owner `admin`; `alice` and `bob`, members who own the app; `carol`, a
 * member who does not. Alice's session shipped "Add the orders page", merged.
 */
async function fixture() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const admin: Person = {
    id: user.id,
    email: user.email,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
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
  return { tenantId: tenant.id, admin, alice, bob, carol, app, shipped }
}

async function cutRelease(app: ReleasableApp, who: Person) {
  const res = await request(
    `/api/apps/${app.app.id}/releases`,
    { method: 'POST', headers: who.cookie },
    { env, json: { bump: 'patch' } }
  )
  expect(res.status, await res.clone().text()).toBe(201)
  return (await res.json()) as { id: string; version: string }
}

/** A whole run of `deploy.yml` on `ref`: start → upload → activate → finish. */
async function ship(app: ReleasableApp, environment: 'staging' | 'production', ref: string) {
  const job = deployJob(env, app, environment, { ref })
  const startRes = await job.call('POST', '/start', { protocol: 1 })
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
}

/** `sessions.ship_summary` as S2's `ship.pr` stores it. */
async function storeSummary(tenantId: string, sessionId: string, body: string) {
  await db
    .update(sessions)
    .set({
      shipSummary: {
        title: 'A change',
        body,
        source: 'model',
        diffStat: ' 1 file changed',
        prNumber: 1,
        gateSha: null,
        at: new Date().toISOString(),
      },
    })
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)))
}

async function promotion(app: ReleasableApp, who: Person | null) {
  return request(`/api/apps/${app.app.id}/promotion`, { headers: who?.cookie ?? {} }, { env })
}

async function read(app: ReleasableApp, who: Person) {
  const res = await promotion(app, who)
  expect(res.status, await res.clone().text()).toBe(200)
  return appPromotionSchema.parse(await res.json())
}

describe('GET /api/apps/:id/promotion', () => {
  it('follows a release from staging, through the approval, to production', async () => {
    const { tenantId, admin, alice, bob, carol, app, shipped } = await fixture()

    // Nothing released yet.
    const empty = await read(app, carol)
    expect(empty).toMatchObject({ candidate: null, changes: [], approval: null })

    const cut = await cutRelease(app, alice)
    await ship(app, 'staging', 'refs/tags/0.1.1')
    const onStaging = await read(app, carol)
    expect(onStaging.candidate).toMatchObject({ id: cut.id, status: 'staging_active' })
    expect(onStaging.staging).toMatchObject({ version: '0.1.1', releaseId: cut.id })
    expect(onStaging.staging?.deployedAt).toBeInstanceOf(Date)
    // The deploy's `finish` probed staging, so its health is about THIS version…
    expect(onStaging.staging?.healthStatus).toBe('up')
    // …and a check from before the deploy says nothing about it: unknown, so Promote waits.
    await db
      .update(appEnvironments)
      .set({ healthCheckedAt: new Date(Date.now() - 7 * 3_600_000) })
      .where(and(eq(appEnvironments.tenantId, tenantId), eq(appEnvironments.appId, app.app.id)))
    expect((await read(app, carol)).staging?.healthStatus).toBe('unknown')
    expect(onStaging.production?.version ?? null).toBeNull()
    expect(onStaging.changes).toEqual([
      expect.objectContaining({
        version: '0.1.1',
        number: shipped.number,
        title: 'Add the orders page',
        sessionId: shipped.session.id,
        sessionTitle: 'Add the orders page',
      }),
    ])
    expect(onStaging.approval).toBeNull()

    // Alice promotes: carol (no part in the request) still reads who it waits on.
    const promoted = await request(
      `/api/apps/${app.app.id}/releases/${cut.id}/promote`,
      { method: 'POST', headers: alice.cookie },
      { env, json: {} }
    )
    expect(promoted.status, await promoted.clone().text()).toBe(202)
    const { approvalId } = promoteReleaseResponseSchema.parse(await promoted.json())
    const waiting = await read(app, carol)
    expect(waiting.candidate).toMatchObject({ status: 'awaiting_approval', approvalId })
    expect(waiting.approval).toMatchObject({ id: approvalId, status: 'pending' })
    const approverIds = waiting.approval?.approvers.map(p => p.id) ?? []
    expect(approverIds).toEqual(expect.arrayContaining([admin.id, bob.id]))
    // The promoter (who also cut it and wrote its PR) is never an approver.
    expect(approverIds).not.toContain(alice.id)

    // Bob approves; production ships it.
    await decide(approvalDeps(db, env), {
      requestId: approvalId,
      viewer: await viewerOf(db, tenantId, bob),
      decision: 'approve',
      actor: actorOf(bob),
    })
    expect((await read(app, carol)).candidate?.status).toBe('promoting')
    await ship(app, 'production', 'refs/tags/0.1.1')
    const live = await read(app, carol)
    expect(live.candidate).toMatchObject({ id: cut.id, status: 'production_active' })
    expect(live.production).toMatchObject({ version: '0.1.1', releaseId: cut.id })
    expect(live.approval).toMatchObject({ id: approvalId, status: 'approved', approvers: [] })
    // Live: what it brought over the production release before it (none — all of it).
    expect(live.changes.map(c => c.number)).toEqual([shipped.number])

    // The next release ships only what came after production's version.
    const next = await shipSessionPr(db, cloud, app, {
      tenantId,
      userId: bob.id,
      title: 'Export to CSV',
    })
    cloud.github.merge(app.owner, app.repo, next.number)
    const second = await cutRelease(app, alice)
    await ship(app, 'staging', `refs/tags/${second.version}`)
    const nextUp = await read(app, carol)
    expect(nextUp.candidate).toMatchObject({ id: second.id, status: 'staging_active' })
    expect(nextUp.production?.version).toBe('0.1.1')
    expect(nextUp.changes).toEqual([
      expect.objectContaining({ number: next.number, sessionTitle: 'Export to CSV' }),
    ])
    expect(nextUp.approval).toBeNull()
  })

  it('carries each session’s ship summary, clipped; null without a session or across tenants', async () => {
    const { tenantId, alice, carol, app, shipped } = await fixture()
    const body = 'Adds the orders page. '.repeat(40).trim()
    expect(body.length).toBeGreaterThan(PROMOTION_SUMMARY_MAX)
    await storeSummary(tenantId, shipped.session.id, body)

    const cut = await cutRelease(app, alice)
    const first = await read(app, carol)
    const ours = first.changes.find(c => c.number === shipped.number)
    expect(ours?.summary?.length).toBeLessThanOrEqual(PROMOTION_SUMMARY_MAX)
    expect(ours?.summary?.length).toBeGreaterThan(PROMOTION_SUMMARY_MAX - 5)
    expect(ours?.summary?.endsWith('…')).toBe(true)
    expect(body.startsWith((ours?.summary ?? '').slice(0, -1))).toBe(true)

    // The next release: a PR a person merged in GitHub (no session, no summary) and a session's
    // short summary, trimmed.
    const byHand = openPullOnBranch(cloud, app, {
      branch: 'typo',
      title: 'Fix a typo',
      author: 'dora',
    })
    cloud.github.merge(app.owner, app.repo, byHand.number)
    const next = await shipSessionPr(db, cloud, app, { tenantId, userId: alice.id, title: 'CSV' })
    cloud.github.merge(app.owner, app.repo, next.number)
    await storeSummary(tenantId, next.session.id, '  Exports orders to CSV.  ')
    await cutRelease(app, alice)
    const second = await read(app, carol)
    expect(second.changes.find(c => c.number === byHand.number)).toMatchObject({
      sessionId: null,
      summary: null,
    })
    expect(second.changes.find(c => c.number === next.number)?.summary).toBe(
      'Exports orders to CSV.'
    )

    // A release row naming ANOTHER organisation's session never reads its title or summary.
    const other = await fixture()
    await storeSummary(other.tenantId, other.shipped.session.id, 'Another organisation’s secret')
    const [release] = await db
      .select()
      .from(appReleases)
      .where(and(eq(appReleases.tenantId, tenantId), eq(appReleases.id, cut.id)))
    await db
      .update(appReleases)
      .set({
        prs: (release?.prs ?? []).map(p => ({ ...p, sessionId: other.shipped.session.id })),
      })
      .where(and(eq(appReleases.tenantId, tenantId), eq(appReleases.id, cut.id)))
    const forged = await read(app, carol)
    const foreign = forged.changes.filter(c => c.sessionId === other.shipped.session.id)
    expect(foreign.length).toBeGreaterThan(0)
    for (const change of foreign)
      expect(change).toMatchObject({ sessionTitle: null, summary: null })
    expect(JSON.stringify(forged)).not.toContain('secret')
  })

  it('is 401 without a session and 404 for another organisation’s app', async () => {
    const { app } = await fixture()
    expect((await promotion(app, null)).status).toBe(401)

    const other = await createTestTenantWithUser(db, 'owner')
    tenantIds.push(other.tenant.id)
    const stranger: Person = {
      id: other.user.id,
      email: other.user.email,
      cookie: sessionCookieHeader(await createTestSession(db, other.user.id, other.tenant.id)),
    }
    const res = await promotion(app, stranger)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toMatchObject({ error: expect.any(String), statusCode: 404 })
    expect(JSON.stringify(body)).not.toContain('0.1')
  })
})

describe('GET /api/apps/:id/promotion — the tag’s deploy run', () => {
  const RUNS = '/actions/workflows/deploy.yml/runs'
  const runReads = () => cloud.callsTo('github').filter(c => c.path.includes(RUNS)).length

  /** Let the next read poll GitHub again (the throttle window has passed). */
  async function expireThrottle(releaseId: string) {
    await db
      .update(appReleases)
      .set({ tagRunPolledAt: new Date(Date.now() - 60_000) })
      .where(eq(appReleases.id, releaseId))
  }

  async function releaseRow(tenantId: string, id: string) {
    const [row] = await db
      .select()
      .from(appReleases)
      .where(and(eq(appReleases.tenantId, tenantId), eq(appReleases.id, id)))
    return row
  }

  it('follows a tagged release’s run job by job, throttled, and fails the release when it fails', async () => {
    const { tenantId, alice, carol, app } = await fixture()
    const cut = await cutRelease(app, alice)

    // No run on GitHub yet: no run, the release untouched.
    const before = await read(app, carol)
    expect(before.candidate).toMatchObject({ id: cut.id, status: 'tagged' })
    expect(before.candidateRun).toBeNull()

    const run = cloud.github.pushTagRun(app.owner, app.repo, cut.version, {
      status: 'in_progress',
      jobs: [
        { name: 'guard', status: 'completed', conclusion: 'success' },
        { name: 'ci / Gate', status: 'in_progress' },
        { name: 'Deploy to staging', status: 'queued' },
      ],
    })
    // Another tag's run of the same workflow is not this release's.
    cloud.github.pushTagRun(app.owner, app.repo, '9.9.9', { status: 'in_progress' })
    await expireThrottle(cut.id)
    const checking = await read(app, carol)
    expect(checking.candidate?.status).toBe('tagged')
    expect(checking.candidateRun).toEqual({
      status: 'in_progress',
      conclusion: null,
      url: `https://github.com/${app.owner}/${app.repo}/actions/runs/${run.id}`,
      currentJob: 'ci / Gate',
      failedJob: null,
    })
    // The token it read with: the one repo, `actions: read` only, revoked after.
    const token = [...cloud.github.tokens.values()].at(-1)
    expect(token).toMatchObject({
      repositories: [app.repo],
      permissions: { actions: 'read' },
      revoked: true,
    })

    // Within the window another reader gets the same answer without a GitHub call.
    const reads = runReads()
    expect((await read(app, alice)).candidateRun?.currentJob).toBe('ci / Gate')
    expect(runReads()).toBe(reads)

    // The gate goes red: the next read moves the release to `failed`, once, audited.
    run.status = 'completed'
    run.conclusion = 'failure'
    run.jobs = [
      { name: 'guard', status: 'completed', conclusion: 'success' },
      { name: 'ci / Gate', status: 'completed', conclusion: 'failure' },
      { name: 'Deploy to staging', status: 'completed', conclusion: 'skipped' },
    ]
    await expireThrottle(cut.id)
    const failed = await read(app, carol)
    const runUrl = `https://github.com/${app.owner}/${app.repo}/actions/runs/${run.id}`
    expect(failed.candidate).toMatchObject({
      id: cut.id,
      status: 'failed',
      error: `staging: the deploy run failed at "ci / Gate" (${runUrl})`,
    })
    expect(failed.candidateRun).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
      failedJob: 'ci / Gate',
      url: runUrl,
    })
    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.targetId, cut.id),
          like(auditEvents.action, 'release.failed')
        )
      )
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actorType: 'system', appId: app.app.id })
    expect(audits[0]?.summary).toMatchObject({
      before: { status: 'tagged' },
      after: { status: 'failed', version: cut.version, failedJob: 'ci / Gate', runUrl },
    })

    // A failed release keeps naming the job — from its last reading, with no GitHub call.
    await expireThrottle(cut.id)
    const callsBefore = runReads()
    const again = await read(app, carol)
    expect(again.candidate?.status).toBe('failed')
    expect(again.candidateRun?.failedJob).toBe('ci / Gate')
    expect(runReads()).toBe(callsBefore)

    // The chain still reads, and carries the failure.
    const chain = await request(
      `/api/apps/${app.app.id}/releases/${cut.id}/chain`,
      { headers: carol.cookie },
      { env }
    )
    expect(chain.status, await chain.clone().text()).toBe(200)
    const events = releaseChainSchema.parse(await chain.json()).events.map(e => e.action)
    expect(events).toEqual(expect.arrayContaining(['release.created', 'release.failed']))
    expect(events.indexOf('release.failed')).toBeGreaterThan(events.indexOf('release.created'))
  })

  it('a GitHub error is a null run, never a failed read', async () => {
    const { alice, carol, app } = await fixture()
    const cut = await cutRelease(app, alice)
    cloud.github.pushTagRun(app.owner, app.repo, cut.version, { status: 'in_progress' })
    await expireThrottle(cut.id)
    cloud.failNext(RUNS, 500)
    const view = await read(app, carol)
    expect(view.candidate).toMatchObject({ id: cut.id, status: 'tagged' })
    expect(view.candidateRun).toBeNull()
  })

  it('never reads GitHub once the release is live on staging', async () => {
    const { tenantId, alice, carol, app } = await fixture()
    const cut = await cutRelease(app, alice)
    cloud.github.pushTagRun(app.owner, app.repo, cut.version, {
      status: 'completed',
      conclusion: 'failure',
      jobs: [{ name: 'smoke', status: 'completed', conclusion: 'failure' }],
    })
    await ship(app, 'staging', `refs/tags/${cut.version}`)
    await expireThrottle(cut.id)
    const reads = runReads()
    const view = await read(app, carol)
    expect(view.candidate).toMatchObject({ id: cut.id, status: 'staging_active' })
    expect(view.candidateRun).toBeNull()
    expect(runReads()).toBe(reads)
    // A run that failed AFTER staging went live never fails the release.
    expect((await releaseRow(tenantId, cut.id))?.status).toBe('staging_active')
  })

  it('another organisation can neither read nor poll the run', async () => {
    const { tenantId, alice, app } = await fixture()
    const cut = await cutRelease(app, alice)
    cloud.github.pushTagRun(app.owner, app.repo, cut.version, {
      status: 'completed',
      conclusion: 'failure',
    })
    await expireThrottle(cut.id)
    const other = await createTestTenantWithUser(db, 'owner')
    tenantIds.push(other.tenant.id)
    const cookie = sessionCookieHeader(await createTestSession(db, other.user.id, other.tenant.id))
    const reads = runReads()
    const res = await request(`/api/apps/${app.app.id}/promotion`, { headers: cookie }, { env })
    expect(res.status).toBe(404)
    expect(runReads()).toBe(reads)
    const row = await releaseRow(tenantId, cut.id)
    expect(row?.status).toBe('tagged')
    expect(row?.tagRun).toBeNull()
  })
})
