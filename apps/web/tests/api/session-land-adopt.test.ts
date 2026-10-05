// @vitest-isolate
// Installs the FakeCloud as the global fetch and mocks the platform credential store.
/**
 * Adopting a hand merge (`services/sessions/land-adopt.ts`, CONCEPTS §18.13): a session shipped
 * before issue #5 (no landing) — or one left at stage `pr` — whose PR a person merged on GitHub is
 * picked up by `sessions.checks` in a `staging`-mode app, given a `releasing` landing, and its
 * Workflow restarted into Phase B, which runs the REAL S3 hooks: a patch release listing the PR and
 * the session, the staging deploy (`/ci/deploy`, played inside `land.staging-wait`), the health
 * probe, `live`.
 *
 * Also: a `pr`-mode app only records `pr.merged`; a merge older than `LAND_ADOPT_MAX_AGE_HOURS` is
 * left alone; a second pass writes nothing and starts nothing; the cron scoped to one tenant never
 * adopts another's session, and the CAS names the tenant.
 */
import type { SessionEvent, SessionLanding } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { githubPullReader, sessionsChecksTask } from '@/api/services/sessions/checks-cron'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import { createSessionEmitter } from '@/api/services/sessions/events'
import { defaultSessionStepHooks } from '@/api/services/sessions/hooks'
import { adoptHandMerge, LAND_ADOPT_MAX_AGE_HOURS } from '@/api/services/sessions/land-adopt'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import { appReleases, apps, auditEvents, type SessionRow, sessions } from '@/db/schema'
import { landingTimeline } from '@/ui/pages/sessions/sessionChatModel'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { appToml, fillDeployCredentials, uploadBody } from '../helpers/deploy-gateway'
import { createFakeCloud } from '../helpers/fake-cloud'
import { forgetApps } from '../helpers/launch-apps'
import {
  deployJob,
  type ReleasableApp,
  seedReleasableApp,
  serveAppHosts,
  shipSessionPr,
} from '../helpers/releases'
import { json } from '../helpers/request'
import { createFakeSessionPorts } from '../helpers/sessions'
import { createExecutionContext, createTestEnv, stubs, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()
const cloud = createFakeCloud()
let restore: () => void = () => {}
const tenantIds: string[] = []
const HOUR = 3_600_000
const LIMITS = { endPollMs: 5, commandPollMs: 1, heartbeatMs: 60_000 }

beforeAll(() => {
  restore = cloud.install()
})
afterAll(async () => {
  restore()
  await forgetApps(db, tenantIds)
})
beforeEach(() => {
  fillDeployCredentials(store, cloud)
})

interface Harness {
  env: TestEnv
  tenantId: string
  app: ReleasableApp
  /** A session shipped before issue #5: `shipped`, its PR open, no landing, ended. */
  row: SessionRow
  number: number
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} } as never

/** An organisation, a releasable app at 0.1.0 serving health, and a pre-#5 shipped session. */
async function harness(shipSession: 'staging' | 'pr' = 'staging'): Promise<Harness> {
  const env = createTestEnv()
  const { tenant, user } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const app = await seedReleasableApp(db, cloud, tenant.id, '0.1.0')
  serveAppHosts(cloud, app)
  await db
    .update(apps)
    .set({ shipSettings: { sessionShip: shipSession, review: { mode: 'none', groupIds: [] } } })
    .where(and(eq(apps.tenantId, tenant.id), eq(apps.id, app.app.id)))
  const { session, number } = await shipSessionPr(db, cloud, app, {
    tenantId: tenant.id,
    userId: user.id,
    title: 'Say hola',
  })
  // What the ship before issue #5 left in the log: the gate and the PR.
  await createSessionEmitter(db, { id: session.id, tenantId: tenant.id })([
    { type: 'ship.gate', turn: 1, data: { step: 'test', passed: true, attempt: 1 } },
    { type: 'ship.pr', turn: 1, data: { number, url: session.prUrl ?? '' } },
  ])
  return { env, tenantId: tenant.id, app, row: session, number }
}

async function reload(h: Pick<Harness, 'tenantId' | 'row'>): Promise<SessionRow> {
  const [latest] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, h.tenantId), eq(sessions.id, h.row.id)))
  if (!latest) throw new Error('session vanished')
  return latest
}

/** One `sessions.checks` pass, scoped to `tenants` (the cron's body is cross-tenant). */
async function cron(env: TestEnv, tenants: string[]) {
  const ports = createFakeSessionPorts()
  const task = sessionsChecksTask(
    d => ports.repoHost(d),
    cfg => githubPullReader(cfg),
    { tenantIds: tenants }
  )
  await task.run({ env, config: loadConfig(env), db, logger: quiet, waitUntil: () => {} })
}

const auditOf = async (h: Harness, action: string) =>
  db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, h.tenantId),
        eq(auditEvents.appId, h.app.app.id),
        eq(auditEvents.action, action)
      )
    )
const eventsOf = (h: Harness) => listSessionEvents(db, h.tenantId, h.row.id, 0, 5000)
const eventData = async (h: Harness, type: string) =>
  (await eventsOf(h)).filter(e => e.type === type).map(e => e.data as Record<string, unknown>)

/** The staging `deploy.yml` run the release's tag starts: start → upload → activate → finish. */
async function deployStaging(h: Harness, version: string) {
  const job = deployJob(h.env, h.app, 'staging', { ref: `refs/tags/${version}` })
  const start = await json<{ id: string; status: string }>(
    await job.call('POST', '/start', { protocol: 1 })
  )
  for (const [path, payload] of [
    ['upload', uploadBody(appToml(h.app, 'staging'), version)],
    ['activate', undefined],
    ['finish', undefined],
  ] as const) {
    const res = await job.call('POST', `/${start.id}/${path}`, payload)
    expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200)
  }
}

/** Run the instance the cron started (`instanceId`), playing the staging deploy in its wait. */
async function runInstance(h: Harness, instanceId: string) {
  let deployed = false
  const fake = createFakeWorkflowStep({
    onWait: async () => {
      throw new Error('Phase B never waits for an event')
    },
  })
  ;(fake.step as { sleep: unknown }).sleep = async (name: string) => {
    fake.names.push(name)
    if (name.startsWith('land.staging-wait#') && !deployed) {
      deployed = true
      await deployStaging(h, ((await reload(h)).landing as SessionLanding).version ?? '')
    }
  }
  const workflow = new SessionWorkflow(createExecutionContext(), h.env)
  workflow.overrides = {
    ports: createFakeSessionPorts(),
    hooks: {
      ...defaultSessionStepHooks,
      runTurn: async () => {
        throw new Error('no turn in Phase B')
      },
    },
    limits: LIMITS,
  }
  const outcome = await workflow.run(
    {
      payload: { sessionId: h.row.id, tenantId: h.tenantId },
      timestamp: new Date(),
      instanceId,
      workflowName: 'launch-session',
    },
    fake.step as unknown as Parameters<SessionWorkflow['run']>[1]
  )
  expect(new Set(fake.names).size).toBe(fake.names.length)
  return { outcome, names: fake.names }
}

describe('sessions.checks adopts a hand merge in a staging-mode app', () => {
  it('a session shipped before #5: landing → Phase B → patch release with the PR → staging → live', async () => {
    const h = await harness()
    const workflow = stubs(h.env).sessionWorkflow
    // Its own instance finished when the session was shipped.
    workflow?.setStatus(h.row.id, { status: 'complete' })
    const mergeSha = cloud.github.merge(h.app.owner, h.app.repo, h.number)

    await cron(h.env, [h.tenantId])

    // ---- adopted: a releasing landing, still shipped, recorded and narrated once.
    const adopted = await reload(h)
    expect(adopted.status).toBe('shipped')
    expect(adopted.landing).toMatchObject({
      mode: 'staging',
      stage: 'releasing',
      prNumber: h.number,
      reviewMode: 'none',
      approvalId: null,
      mergeSha,
      mergedAt: expect.any(String),
      releaseId: null,
    })
    expect(await eventData(h, 'ship.merged')).toEqual([
      { number: h.number, sha: mergeSha, url: expect.any(String), approvalId: null, by: 'github' },
    ])
    const [merged] = await auditOf(h, 'session.merged')
    expect(merged?.summary).toMatchObject({
      after: { prNumber: h.number, mergeSha, by: 'github', adopted: true, approvalId: null },
    })
    const prMerged = await auditOf(h, 'pr.merged')
    expect(prMerged).toHaveLength(1)
    expect(prMerged[0]?.summary).toMatchObject({
      after: { via: 'sessions.checks', sessionId: h.row.id, mergeSha },
    })
    // A fresh instance: the old one is finished, so a wake could never reach it.
    expect(workflow?.created).toEqual([
      { id: `${h.row.id}-r1`, params: { sessionId: h.row.id, tenantId: h.tenantId } },
    ])
    expect(adopted.instanceId).toBe(`${h.row.id}-r1`)

    // ---- a second pass: nothing new (the PR is recorded; the CAS would refuse anyway).
    await cron(h.env, [h.tenantId])
    expect(workflow?.created).toHaveLength(1)
    expect(await eventData(h, 'ship.merged')).toHaveLength(1)
    expect(await auditOf(h, 'session.merged')).toHaveLength(1)

    // ---- the fresh instance: claim → Phase B (no cleanup: the session ended long ago) → live.
    const run = await runInstance(h, `${h.row.id}-r1`)
    expect(run.outcome.status).toBe('shipped')
    expect(run.names[0]).toBe('claim')
    expect(run.names).not.toContain('cleanup')
    expect(run.names).toEqual(
      expect.arrayContaining(['land.release#0.0', 'land.staging#0.0', 'land.live#0'])
    )

    const [release, ...others] = await db
      .select()
      .from(appReleases)
      .where(and(eq(appReleases.tenantId, h.tenantId), eq(appReleases.appId, h.app.app.id)))
    expect(others).toEqual([])
    expect(release).toMatchObject({
      version: '0.1.1',
      tag: '0.1.1',
      status: 'staging_active',
      createdByUserId: null,
    })
    expect(release?.prs).toEqual([
      expect.objectContaining({ number: h.number, sessionId: h.row.id }),
    ])

    const row = await reload(h)
    expect(row.status).toBe('shipped')
    expect(row.landing).toMatchObject({
      stage: 'live',
      version: '0.1.1',
      tag: '0.1.1',
      releaseId: release?.id,
      stagingUrl: h.app.staging.url,
      mergeSha,
    })
    expect(await auditOf(h, 'session.landed')).toHaveLength(1)

    // ---- the ship panel: Merged on GitHub → released → live, no CI it never read.
    const view = landingTimeline(
      (await eventsOf(h)) as unknown as SessionEvent[],
      row.landing,
      row.status
    )
    expect(view?.outcome).toBe('live')
    expect(view?.steps.map(s => [s.key, s.status])).toEqual([
      ['gate', 'done'],
      ['pr', 'done'],
      ['merged', 'done'],
      ['released', 'done'],
      ['staging', 'done'],
    ])
    expect(view?.steps.find(s => s.key === 'merged')?.label).toBe('Merged on GitHub')
  })

  it('a landing left at stage `pr` (the app switched to staging since) is adopted', async () => {
    const h = await harness()
    const gateSha = 'd'.repeat(40)
    const started = new Date(Date.now() - 2 * HOUR).toISOString()
    await db
      .update(sessions)
      .set({
        landing: {
          mode: 'pr',
          stage: 'pr',
          prNumber: h.number,
          gateSha,
          gateTree: null,
          startedAt: started,
          stageAt: started,
          reviewMode: 'none',
          approvalId: null,
          mergeSha: null,
          mergedAt: null,
          releaseId: null,
          version: null,
          tag: null,
          stagingUrl: null,
          containerReleased: false,
          stalledReason: null,
          error: null,
        },
      })
      .where(and(eq(sessions.tenantId, h.tenantId), eq(sessions.id, h.row.id)))
    cloud.github.merge(h.app.owner, h.app.repo, h.number)

    await cron(h.env, [h.tenantId])

    expect((await reload(h)).landing).toMatchObject({
      mode: 'staging',
      stage: 'releasing',
      gateSha,
      startedAt: started,
    })
    expect(stubs(h.env).sessionWorkflow?.created.map(c => c.id)).toEqual([`${h.row.id}-r1`])
  })
})

describe('what is never adopted', () => {
  it('a `pr`-mode app: pr.merged only — reviewers merging on GitHub release by hand', async () => {
    const h = await harness('pr')
    cloud.github.merge(h.app.owner, h.app.repo, h.number)
    await cron(h.env, [h.tenantId])
    expect((await reload(h)).landing).toBeNull()
    expect(await auditOf(h, 'pr.merged')).toHaveLength(1)
    expect(await auditOf(h, 'session.merged')).toEqual([])
    expect(await eventData(h, 'ship.merged')).toEqual([])
    expect(stubs(h.env).sessionWorkflow?.created).toEqual([])
  })

  it(`a merge older than ${LAND_ADOPT_MAX_AGE_HOURS} h: recorded, not released`, async () => {
    const h = await harness()
    cloud.github.merge(
      h.app.owner,
      h.app.repo,
      h.number,
      new Date(Date.now() - (LAND_ADOPT_MAX_AGE_HOURS + 1) * HOUR)
    )
    await cron(h.env, [h.tenantId])
    expect((await reload(h)).landing).toBeNull()
    expect(await auditOf(h, 'pr.merged')).toHaveLength(1)
    expect(stubs(h.env).sessionWorkflow?.created).toEqual([])
  })

  it('another tenant’s session: the cron scoped to one tenant never touches it, and the CAS names the tenant', async () => {
    const h = await harness()
    const other = await harness()
    cloud.github.merge(h.app.owner, h.app.repo, h.number)
    cloud.github.merge(other.app.owner, other.app.repo, other.number)

    await cron(h.env, [h.tenantId])
    expect((await reload(h)).landing).toMatchObject({ stage: 'releasing' })
    expect((await reload(other)).landing).toBeNull()
    expect(stubs(h.env).sessionWorkflow?.created.map(c => c.id)).toEqual([`${h.row.id}-r1`])

    // The adoption itself, asked under the wrong tenant, writes nothing.
    const wrong = await adoptHandMerge(db, {
      tenantId: h.tenantId,
      sessionId: other.row.id,
      appId: other.app.app.id,
      shipSettings: null,
      landing: null,
      merge: {
        number: other.number,
        mergeSha: 'e'.repeat(40),
        mergedAt: new Date().toISOString(),
        headSha: 'f'.repeat(40),
        url: 'https://github.com/x/y/pull/1',
      },
      now: new Date(),
    })
    expect(wrong).toBeNull()
    expect((await reload(other)).landing).toBeNull()
  })
})
