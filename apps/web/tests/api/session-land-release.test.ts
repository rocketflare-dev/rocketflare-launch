// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform credential store.
/**
 * Issue #5 S3 (`docs/plans/i5-ship-to-staging.md` §1.8–§1.9): Phase B's hook bodies —
 * `landRelease`, `landStaging`, `landHealth` (`services/sessions/land-release.ts`) — driven one
 * call at a time, as the `SessionWorkflow`'s steps would, against the real release, deploy-gateway
 * and health paths. The landing rows are seeded directly (S2 writes them).
 *
 * What it pins:
 * - the first merge cuts a patch release with no person behind it (SYSTEM, `created_by_user_id`
 *   null, `release.created {trigger:'session.merge', sessionId}`, `prs[].sessionId`), records it on
 *   the landing (`releasing → deploying`) and emits `ship.released` once;
 * - two merges before the release share ONE release and one tag; merges far apart get two tags;
 * - the app's release claim: a held claim → `wait`, then the holder's release is shared; a stale
 *   claim is taken over; a claim held past 15 minutes stalls; the manual route answers 409
 *   `release_in_progress`; another tenant can never take an app's claim;
 * - a protected branch Launch cannot bypass → `stalled` `release_failed`, nothing recorded;
 * - the follow: tagged → `wait`; staging activated → `active` → healthy on the version → `live`;
 *   a failed staging run → `deploy_failed`; the tag's run failing before staging (a red gate,
 *   `releases/tag-run.ts`) → the release `failed` and `deploy_failed` at once, not after 45
 *   minutes; tagged 45 minutes → `deploy_timeout`; staging never
 *   healthy after 10 probes → `unhealthy`.
 */

import {
  type SessionLanding,
  type SessionShipReleasedData,
  sessionLandingSchema,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { withReleaseClaim } from '@/api/services/launch/releases/claim'
import { createSessionEmitter } from '@/api/services/sessions/events'
import type { SessionStepContext } from '@/api/services/sessions/hooks'
import {
  LAND_HEALTH_MAX_PROBES,
  LAND_RELEASE_WAIT_SECONDS,
  LAND_STAGING_WAIT_SECONDS,
  landHealth,
  landRelease,
  landStaging,
} from '@/api/services/sessions/land-release'
import { loadConfig } from '@/config'
import {
  appReleases,
  apps,
  auditEvents,
  type SessionRow,
  sessionEvents,
  sessions,
} from '@/db/schema'
import { fakeLogger } from '../helpers/approvals'
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

/** An organisation, alice (a member who owns the app) and a releasable app serving health. */
async function fixture() {
  const { tenant } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenant.id, 'member')
  const alice: Person = {
    id: user.id,
    email: user.email,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
  const app = await seedReleasableApp(db, cloud, tenant.id)
  await addTestAppOwner(db, tenant.id, app.app.id, alice.id)
  return { tenantId: tenant.id, alice, app }
}

const minutesAgo = (n: number, from = new Date()) => new Date(from.getTime() - n * 60_000)

/**
 * A session of alice's whose PR Launch merged: `shipped`, landing at `releasing` (as S2's
 * `land.merge` leaves it), the PR merged in the FakeCloud.
 */
async function mergedSession(
  f: Awaited<ReturnType<typeof fixture>>,
  title: string,
  opts: { stageAt?: Date; merge?: boolean; mainCiAt?: Date } = {}
): Promise<SessionRow> {
  const shipped = await shipSessionPr(db, cloud, f.app, {
    tenantId: f.tenantId,
    userId: f.alice.id,
    title,
  })
  const mergeSha =
    opts.merge === false ? null : cloud.github.merge(f.app.owner, f.app.repo, shipped.number)
  const stageAt = (opts.stageAt ?? new Date()).toISOString()
  const landing: SessionLanding = sessionLandingSchema.parse({
    mode: 'staging',
    stage: 'releasing',
    prNumber: shipped.number,
    gateSha: 'a'.repeat(40),
    startedAt: stageAt,
    stageAt,
    reviewMode: 'none',
    mergeSha,
    mergedAt: stageAt,
    // Issue #11: when `land.main-ci` let the release go (the Workflow's step before this hook).
    mainCi: opts.mainCiAt
      ? { verdict: 'success', sha: mergeSha ?? '', at: opts.mainCiAt.toISOString() }
      : null,
  })
  const [row] = await db
    .update(sessions)
    .set({ landing })
    .where(and(eq(sessions.tenantId, f.tenantId), eq(sessions.id, shipped.session.id)))
    .returning()
  return row as SessionRow
}

/** One Workflow step's context for `session`, at `now`. */
function stepCtx(session: SessionRow, now: () => Date = () => new Date()): SessionStepContext {
  const realtime = { env, defer: (fn: () => Promise<unknown>) => void fn() }
  return {
    db,
    env,
    cfg: loadConfig(env),
    ports: {} as never,
    sandbox: {} as never,
    storage: null,
    ref: { tenantId: session.tenantId, sessionId: session.id },
    session,
    turn: session.turnCount,
    emit: createSessionEmitter(db, session, realtime),
    realtime,
    logger: fakeLogger(),
    now,
  }
}

async function landingOf(session: SessionRow): Promise<SessionLanding | null> {
  const [row] = await db
    .select({ landing: sessions.landing })
    .from(sessions)
    .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, session.id)))
  return row?.landing ?? null
}

async function eventsOf(session: SessionRow, type: string) {
  const rows = await db
    .select()
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, session.tenantId),
        eq(sessionEvents.sessionId, session.id),
        eq(sessionEvents.type, type as never)
      )
    )
  return rows.map(r => r.data)
}

async function claimOf(app: ReleasableApp) {
  const [row] = await db
    .select({ holder: apps.releaseClaimHolder, at: apps.releaseClaimedAt })
    .from(apps)
    .where(and(eq(apps.tenantId, app.app.tenantId), eq(apps.id, app.app.id)))
  return row
}

async function holdClaim(app: ReleasableApp, holder: string, at = new Date()) {
  await db
    .update(apps)
    .set({ releaseClaimHolder: holder, releaseClaimedAt: at })
    .where(and(eq(apps.tenantId, app.app.tenantId), eq(apps.id, app.app.id)))
}

function tagsOf(app: ReleasableApp): string[] {
  const refs = cloud.github.repo(app.owner, app.repo)?.refs ?? new Map()
  return [...refs.keys()].filter(k => k.startsWith('tags/')).sort()
}

/** A whole `deploy.yml` staging run on the release's tag: start → upload → activate → finish. */
async function deployStaging(app: ReleasableApp, version: string) {
  const job = deployJob(env, app, 'staging', { ref: `refs/tags/${version}` })
  const start = (await (await job.call('POST', '/start', { protocol: 1 })).json()) as {
    id: string
    status: string
  }
  expect(start.status).toBe('approved')
  for (const [path, payload] of [
    ['upload', uploadBody(appToml(app, 'staging'), version)],
    ['activate', undefined],
    ['finish', undefined],
  ] as const) {
    const res = await job.call('POST', `/${start.id}/${path}`, payload)
    expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200)
  }
}

describe('landRelease', () => {
  it('cuts a patch release for the first merge — no person behind it — and records it once', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'Add the orders page')

    const result = await landRelease(stepCtx(session))
    expect(result).toMatchObject({
      status: 'released',
      version: '0.1.1',
      tag: '0.1.1',
      shared: false,
    })
    if (result.status !== 'released') throw new Error('not released')

    const [release] = await db
      .select()
      .from(appReleases)
      .where(and(eq(appReleases.tenantId, f.tenantId), eq(appReleases.id, result.releaseId)))
    expect(release).toMatchObject({ createdByUserId: null, status: 'tagged', version: '0.1.1' })
    expect(release?.prs).toEqual([
      expect.objectContaining({ number: session.prNumber, sessionId: session.id }),
    ])
    const [created] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, f.tenantId),
          eq(auditEvents.action, 'release.created'),
          eq(auditEvents.targetId, result.releaseId)
        )
      )
    expect(created?.actorType).toBe('system')
    expect(created?.summary.after).toMatchObject({
      trigger: 'session.merge',
      sessionId: session.id,
      bump: 'patch',
    })

    // The landing moved releasing → deploying with the release on it; one `ship.released`.
    expect(await landingOf(session)).toMatchObject({
      stage: 'deploying',
      releaseId: result.releaseId,
      version: '0.1.1',
      tag: '0.1.1',
    })
    expect(await eventsOf(session, 'ship.released')).toEqual([
      { releaseId: result.releaseId, version: '0.1.1', tag: '0.1.1', shared: false },
    ])
    // The claim is released.
    expect(await claimOf(f.app)).toEqual({ holder: null, at: null })

    // Asked again (a replayed step): the same release, no second tag, no second event.
    expect(await landRelease(stepCtx(session))).toEqual(result)
    expect(tagsOf(f.app)).toEqual(['tags/0.1.1'])
    expect(await eventsOf(session, 'ship.released')).toHaveLength(1)
  })

  it('two merges before the release share one release and one tag', async () => {
    const f = await fixture()
    const first = await mergedSession(f, 'First change')
    const second = await mergedSession(f, 'Second change')

    const a = await landRelease(stepCtx(first))
    const b = await landRelease(stepCtx(second))
    expect(a).toMatchObject({ status: 'released', version: '0.1.1', shared: false })
    expect(b).toMatchObject({ status: 'released', version: '0.1.1', shared: true })
    if (a.status !== 'released' || b.status !== 'released') throw new Error('not released')
    expect(b.releaseId).toBe(a.releaseId)
    expect(tagsOf(f.app)).toEqual(['tags/0.1.1'])
    const shared = (await eventsOf(second, 'ship.released')) as SessionShipReleasedData[]
    expect(shared).toEqual([expect.objectContaining({ releaseId: a.releaseId, shared: true })])
    expect(await landingOf(second)).toMatchObject({ stage: 'deploying', releaseId: a.releaseId })
  })

  it('merges far apart get a release each', async () => {
    const f = await fixture()
    const first = await mergedSession(f, 'Early change')
    expect(await landRelease(stepCtx(first))).toMatchObject({ version: '0.1.1' })
    const later = await mergedSession(f, 'Later change')
    const second = await landRelease(stepCtx(later))
    expect(second).toMatchObject({ status: 'released', version: '0.1.2', shared: false })
    expect(tagsOf(f.app)).toEqual(['tags/0.1.1', 'tags/0.1.2'])
  })

  it('waits while another holder has the claim, then shares the release it cut', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'Waits its turn')
    await holdClaim(f.app, `user:${f.alice.id}`)

    expect(await landRelease(stepCtx(session))).toEqual({
      status: 'wait',
      waitSeconds: LAND_RELEASE_WAIT_SECONDS,
    })
    expect(await landingOf(session)).toMatchObject({ stage: 'releasing', releaseId: null })
    expect(tagsOf(f.app)).toEqual([])
    // A person pressing Release meanwhile is refused too (the route takes the same claim).
    const refused = await request(
      `/api/apps/${f.app.app.id}/releases`,
      { method: 'POST', headers: f.alice.cookie },
      { env, json: { bump: 'patch' } }
    )
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error: expect.any(String),
      statusCode: 409,
      code: 'release_in_progress',
    })

    // The holder finishes: its release carries this merge, and the landing shares it.
    await db
      .update(apps)
      .set({ releaseClaimHolder: null, releaseClaimedAt: null })
      .where(and(eq(apps.tenantId, f.tenantId), eq(apps.id, f.app.app.id)))
    const manual = await request(
      `/api/apps/${f.app.app.id}/releases`,
      { method: 'POST', headers: f.alice.cookie },
      { env, json: { bump: 'patch' } }
    )
    expect(manual.status, await manual.clone().text()).toBe(201)
    const cut = (await manual.json()) as { id: string; createdByUserId: string }
    expect(cut.createdByUserId).toBe(f.alice.id)
    expect(await landRelease(stepCtx(session))).toMatchObject({
      status: 'released',
      releaseId: cut.id,
      shared: true,
    })
    expect(tagsOf(f.app)).toEqual(['tags/0.1.1'])
  })

  it('stalls once the claim has been held against it for 15 minutes', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'Waited too long', { stageAt: minutesAgo(16) })
    await holdClaim(f.app, 'session:00000000-0000-4000-8000-000000000000')
    const result = await landRelease(stepCtx(session))
    expect(result).toMatchObject({ status: 'stalled', reason: 'release_failed' })
    if (result.status === 'stalled') expect(result.error).toMatch(/15 minutes/)
    expect(await landingOf(session)).toMatchObject({ stage: 'releasing' })
  })

  it('the claim’s 15 minutes start when land.main-ci let the release go, not at the merge (issue #11)', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'Waited on main', {
      stageAt: minutesAgo(25),
      mainCiAt: minutesAgo(2),
    })
    await holdClaim(f.app, 'session:00000000-0000-4000-8000-000000000000')
    expect(await landRelease(stepCtx(session))).toEqual({
      status: 'wait',
      waitSeconds: LAND_RELEASE_WAIT_SECONDS,
    })
  })

  it('another merge after the green main Gate: waits for the new head’s Gate, then releases on a tested parent (issue #21)', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'Gated on main', { mainCiAt: minutesAgo(1) })
    // A person merges another PR after `land.main-ci` saw this merge green: main's head moves.
    const other = await shipSessionPr(db, cloud, f.app, {
      tenantId: f.tenantId,
      userId: f.alice.id,
      title: 'Merged meanwhile',
    })
    const head = cloud.github.merge(f.app.owner, f.app.repo, other.number)
    cloud.github.setCheckRuns(f.app.owner, f.app.repo, head, [
      { name: 'Gate', status: 'in_progress', conclusion: null },
    ])
    expect(await landRelease(stepCtx(session))).toEqual({
      status: 'wait',
      waitSeconds: LAND_RELEASE_WAIT_SECONDS,
    })
    expect(tagsOf(f.app)).toEqual([])
    // The claim is not held while it waits.
    expect((await claimOf(f.app))?.holder).toBeNull()

    cloud.github.setCheckRuns(f.app.owner, f.app.repo, head, [
      { name: 'Gate', status: 'completed', conclusion: 'success' },
    ])
    const released = await landRelease(stepCtx(session))
    expect(released).toMatchObject({ status: 'released', version: '0.1.1' })
    const [created] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.appId, f.app.app.id), eq(auditEvents.action, 'release.created')))
    expect((created?.summary as { after?: unknown })?.after).toMatchObject({
      sessionId: session.id,
      parentGate: 'success',
    })
  })

  it('another merge whose Gate never reports: releases after the bound, recorded as timeout (issue #21)', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'Gated long ago', { mainCiAt: minutesAgo(31) })
    const other = await shipSessionPr(db, cloud, f.app, {
      tenantId: f.tenantId,
      userId: f.alice.id,
      title: 'Merged meanwhile, no CI',
    })
    cloud.github.merge(f.app.owner, f.app.repo, other.number)
    expect(await landRelease(stepCtx(session))).toMatchObject({ status: 'released' })
    const [created] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.appId, f.app.app.id), eq(auditEvents.action, 'release.created')))
    expect((created?.summary as { after?: unknown })?.after).toMatchObject({ parentGate: 'timeout' })
  })

  it('takes over a stale claim', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'After a crash')
    await holdClaim(f.app, 'session:00000000-0000-4000-8000-000000000000', minutesAgo(11))
    expect(await landRelease(stepCtx(session))).toMatchObject({
      status: 'released',
      version: '0.1.1',
    })
    expect(await claimOf(f.app)).toEqual({ holder: null, at: null })
  })

  it('stalls release_failed when the default branch is protected and Launch cannot bypass it', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'Blocked by protection')
    cloud.github.protect(f.app.owner, f.app.repo, { requiredChecks: ['Gate'] })

    const result = await landRelease(stepCtx(session))
    expect(result).toMatchObject({ status: 'stalled', reason: 'release_failed' })
    if (result.status === 'stalled') expect(result.error).toMatch(/GitHub refused the release/)
    // Nothing recorded: no release, the landing untouched, the claim released.
    const rows = await db
      .select()
      .from(appReleases)
      .where(and(eq(appReleases.tenantId, f.tenantId), eq(appReleases.appId, f.app.app.id)))
    expect(rows).toEqual([])
    expect(tagsOf(f.app)).toEqual([])
    expect(await landingOf(session)).toMatchObject({ stage: 'releasing', releaseId: null })
    expect(await eventsOf(session, 'ship.released')).toEqual([])
    expect(await claimOf(f.app)).toEqual({ holder: null, at: null })
  })

  it('never takes another tenant’s app claim', async () => {
    const f = await fixture()
    const other = await fixture()
    const ran = vi.fn(async () => 'ran')
    const outcome = await withReleaseClaim(
      db,
      { tenantId: other.tenantId, appId: f.app.app.id, holder: `user:${other.alice.id}` },
      ran
    )
    expect(outcome).toEqual({ claimed: false, holder: null })
    expect(ran).not.toHaveBeenCalled()
    expect(await claimOf(f.app)).toEqual({ holder: null, at: null })
  })
})

describe('landStaging and landHealth', () => {
  it('follows the release from tagged to staging, then to healthy on its version → live', async () => {
    const f = await fixture()
    serveAppHosts(cloud, f.app)
    const session = await mergedSession(f, 'Goes live')
    const released = await landRelease(stepCtx(session))
    expect(released).toMatchObject({ status: 'released', version: '0.1.1' })

    expect(await landStaging(stepCtx(session))).toEqual({
      status: 'wait',
      waitSeconds: LAND_STAGING_WAIT_SECONDS,
    })
    await deployStaging(f.app, '0.1.1')
    expect(await landStaging(stepCtx(session))).toEqual({ status: 'active' })
    expect(await eventsOf(session, 'ship.staging')).toEqual([
      { status: 'active', version: '0.1.1', url: f.app.staging.url },
    ])
    expect(await landHealth(stepCtx(session))).toEqual({
      status: 'live',
      url: f.app.staging.url,
      version: '0.1.1',
    })
  })

  it('stalls deploy_failed when the staging run failed', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'Fails to deploy')
    const released = await landRelease(stepCtx(session))
    if (released.status !== 'released') throw new Error('not released')
    await db
      .update(appReleases)
      .set({ status: 'failed', error: 'staging: the build was refused' })
      .where(and(eq(appReleases.tenantId, f.tenantId), eq(appReleases.id, released.releaseId)))
    const result = await landStaging(stepCtx(session))
    expect(result).toMatchObject({ status: 'stalled', reason: 'deploy_failed' })
    if (result.status === 'stalled') expect(result.error).toMatch(/the build was refused/)
  })

  it('stalls deploy_failed at once when the tag’s run failed before staging (a red gate)', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'Red gate')
    const released = await landRelease(stepCtx(session))
    if (released.status !== 'released') throw new Error('not released')
    const run = cloud.github.pushTagRun(f.app.owner, f.app.repo, released.tag, {
      status: 'in_progress',
      jobs: [
        { name: 'guard', status: 'completed', conclusion: 'success' },
        { name: 'ci / Gate', status: 'in_progress' },
        { name: 'Deploy to staging', status: 'queued' },
      ],
    })
    // Still checking: another round, nothing moved.
    expect(await landStaging(stepCtx(session))).toEqual({
      status: 'wait',
      waitSeconds: LAND_STAGING_WAIT_SECONDS,
    })
    // The gate goes red a few minutes later — long before the 45-minute timeout.
    run.status = 'completed'
    run.conclusion = 'failure'
    run.jobs = [
      { name: 'guard', status: 'completed', conclusion: 'success' },
      { name: 'ci / Gate', status: 'completed', conclusion: 'failure' },
      { name: 'Deploy to staging', status: 'completed', conclusion: 'skipped' },
    ]
    const at3 = () => new Date(Date.now() + 3 * 60_000)
    const result = await landStaging(stepCtx(session, at3))
    expect(result).toMatchObject({ status: 'stalled', reason: 'deploy_failed' })
    if (result.status === 'stalled') {
      expect(result.error).toContain(`The staging deploy of ${released.version} failed`)
      expect(result.error).toContain('"ci / Gate"')
    }
    const [row] = await db
      .select()
      .from(appReleases)
      .where(and(eq(appReleases.tenantId, f.tenantId), eq(appReleases.id, released.releaseId)))
    expect(row?.status).toBe('failed')
    expect(row?.error).toMatch(
      /^staging: the deploy run failed at "ci \/ Gate" \(https:\/\/github\.com\//
    )
    const audits = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, f.tenantId),
          eq(auditEvents.targetId, released.releaseId),
          eq(auditEvents.action, 'release.failed')
        )
      )
    expect(audits).toHaveLength(1)
  })

  it('stalls deploy_timeout when the release is still tagged 45 minutes on', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'Never deployed')
    const released = await landRelease(stepCtx(session))
    if (released.status !== 'released') throw new Error('not released')
    const at44 = () => new Date(Date.now() + 44 * 60_000)
    expect(await landStaging(stepCtx(session, at44))).toMatchObject({ status: 'wait' })
    const at46 = () => new Date(Date.now() + 46 * 60_000)
    expect(await landStaging(stepCtx(session, at46))).toMatchObject({
      status: 'stalled',
      reason: 'deploy_timeout',
    })
  })

  it('stalls unhealthy when staging never answers healthy on the version in 10 probes', async () => {
    const f = await fixture()
    const session = await mergedSession(f, 'Deploys but is sick')
    const released = await landRelease(stepCtx(session))
    if (released.status !== 'released') throw new Error('not released')
    serveAppHosts(cloud, f.app)
    await deployStaging(f.app, '0.1.1')
    expect(await landStaging(stepCtx(session))).toEqual({ status: 'active' })
    // Staging now answers 503.
    cloud.onHost(new URL(f.app.staging.url as string).host, () =>
      Response.json({ status: 'down' }, { status: 503 })
    )

    const start = Date.now()
    const answers = []
    // The deploy's `finish` already probed staging once (`routes/ci-deploy.ts`): that check counts,
    // so the landing's own probes make up the rest of the ten.
    for (let probe = 2; probe <= LAND_HEALTH_MAX_PROBES; probe++) {
      const at = new Date(start + probe * 30_000)
      answers.push(await landHealth(stepCtx(session, () => at)))
    }
    expect(answers.slice(0, -1).every(a => a.status === 'wait')).toBe(true)
    expect(answers.at(-1)).toMatchObject({ status: 'stalled', reason: 'unhealthy' })
    const last = answers.at(-1)
    if (last?.status === 'stalled')
      expect(last.error).toMatch(/0\.1\.1 after 10 checks: last seen down/)
  })
})
