// @vitest-isolate
// Installs the FakeCloud as the global fetch and mocks the platform credential store.
/**
 * Issue #5 END TO END (`docs/plans/i5-ship-to-staging.md` S6): "Ship means live on staging", with
 * every slice's real code in one run — S4's settings route and review rule, S2's landing in the
 * real `SessionWorkflow` (CI on the gate SHA, the `session.merge` review through the real
 * approvals route, ONE squash merge), S3's Phase B hooks (`defaultSessionStepHooks`' `landRelease`
 * / `landStaging` / `landHealth`: a patch release under the app's claim, the tag, the staging
 * deploy through `/ci/deploy`, the health probe), and part 8's read model (`GET …/promotion`) and
 * the release's audit chain (`GET …/:rid/chain`).
 *
 * The FakeCloud is the global fetch (GitHub, Neon, Cloudflare and the app's own hosts); the
 * container is a `FakeSandbox` with a green kit gate, the chat turn and the checkpoint are the
 * `session-land.test.ts` stand-ins (a push to the session's branch), and the ship summary is the
 * real `summarizeShip` over a fake chat client. The `deploy.yml` run the tag starts is played by
 * the test inside the `land.staging-wake` round: start → upload → activate → finish.
 *
 * Cases: the main path with `app_owners` review (alice, the session's creator, is refused 403
 * `self_approval`; bob, an owner, approves); CI red (a redacted log tail, reopened `ready`); a
 * rejected review (reopened with the note); `pr` mode (today's behaviour); the default settings
 * (`staging`, no review: straight to live, no approval).
 */
import { generateKeyPairSync } from 'node:crypto'
import { type AppPromotion, appPromotionSchema } from '@launch/shared/launch-promotion'
import { releaseChainSchema } from '@launch/shared/launch-releases'
import {
  SESSION_WAKE_EVENT,
  type SessionEvent,
  type SessionLanding,
  sessionBranchName,
  sessionShipCiDataSchema,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NeonClient } from '@/api/services/launch/neon'
import { WORKSPACE_CHANGED_SCRIPT } from '@/api/services/sessions/checkpoint'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import { defaultSessionStepHooks, type SessionStepHooks } from '@/api/services/sessions/hooks'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import { summarizeShip } from '@/api/services/sessions/ship'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import {
  appEnvironments,
  appReleases,
  approvalRequests,
  apps,
  type SessionRow,
  sessions,
} from '@/db/schema'
import { promotionState } from '@/ui/pages/apps/components/promotionModel'
import { landingTimeline } from '@/ui/pages/sessions/sessionChatModel'
import { FakeChatClient } from '../helpers/ai'
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
import type { FakeSandbox } from '../helpers/fake-sandbox'
import { forgetApps } from '../helpers/launch-apps'
import { addTestAppOwner } from '../helpers/oidc'
import {
  deployJob,
  type ReleasableApp,
  seedReleasableApp,
  serveAppHosts,
} from '../helpers/releases'
import { json, request } from '../helpers/request'
import {
  createFakeSessionPorts,
  type FakeSessionPorts,
  insertSession,
  scriptKitGate,
} from '../helpers/sessions'
import { createExecutionContext, createTestEnv, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep, type RecordedWait } from '../mocks/cloudflare-workers'

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

beforeAll(() => {
  restore = cloud.install()
  // Issue #11: the default branch's CI is green on every merge commit (`land.main-ci` reads it).
  cloud.github.mergeCommitChecks = [{ name: 'Gate', status: 'completed', conclusion: 'success' }]
})
afterAll(async () => {
  restore()
  await forgetApps(db, tenantIds)
})

const NEON_KEY = 'neon-test-key-abcdefghijklmnop'
const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const WAKE = { type: SESSION_WAKE_EVENT, payload: {} }
const TITLE = 'Greet people on the home page'
const SUMMARY_BODY = 'Adds a bold greeting to the home page, so visitors feel welcome.'
const SUMMARY = JSON.stringify({ title: TITLE, body: SUMMARY_BODY })
const LIMITS = { endPollMs: 5, commandPollMs: 1, heartbeatMs: 60_000 }
const { privateKey: APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

interface Person {
  id: string
  email: string
  cookie: Record<string, string>
}

interface Harness {
  env: TestEnv
  tenantId: string
  /** The organisation's owner: sets approval policies. */
  admin: Person
  /** The session's creator — an owner of the app, so the review's exclusion is what refuses her. */
  alice: Person
  /** Another owner of the app: the eligible reviewer. */
  bob: Person
  app: ReleasableApp
  row: SessionRow
  ports: FakeSessionPorts
  hooks: SessionStepHooks
  sandbox: () => FakeSandbox
}

async function person(tenantId: string): Promise<Person> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, 'member')
  return {
    id: user.id,
    email: user.email,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)),
  }
}

/**
 * An organisation; alice and bob, members who both own the app; a releasable app at 0.1.0 whose
 * production already runs 0.1.0 and whose hosts answer health from the live Worker; a PREPARED
 * `dev` branch on its Neon project; and a `requested` session of alice's.
 */
async function harness(): Promise<Harness> {
  const env = createTestEnv()
  const cfg = loadConfig(env)
  fillDeployCredentials(store, cloud)
  const { tenant, user: owner } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const admin: Person = {
    id: owner.id,
    email: owner.email,
    cookie: sessionCookieHeader(await createTestSession(db, owner.id, tenant.id)),
  }
  const alice = await person(tenant.id)
  const bob = await person(tenant.id)
  const app = await seedReleasableApp(db, cloud, tenant.id, '0.1.0')
  await addTestAppOwner(db, tenant.id, app.app.id, alice.id)
  await addTestAppOwner(db, tenant.id, app.app.id, bob.id)
  serveAppHosts(cloud, app)

  // The session database: a `dev` branch of the app's project, as `prepareSessionDb` leaves it.
  const neon = new NeonClient(NEON_KEY, { fetch: cloud.fetch, sleep: async () => {} })
  const dev = await neon.createBranch(app.projectId, {
    name: 'dev',
    parentId: app.mainBranchId,
    initSource: 'schema-only',
  })
  cloud.neon.sqlRole(app.projectId, dev.branch.id, 'session_owner', { canCreateRole: true })
  await neon.createDatabase(app.projectId, dev.branch.id, {
    name: 'session_app',
    ownerName: 'session_owner',
  })
  cloud.neon.projects
    .get(app.projectId)
    ?.branches.get(dev.branch.id)
    ?.extensions.set('session_app', new Set(['vector']))
  const [updated] = await db
    .update(apps)
    .set({
      sessionDb: {
        devBranchId: dev.branch.id,
        database: 'session_app',
        preparedCommit: cloud.github.repo(app.owner, app.repo)?.refs.get('heads/main') ?? null,
        preparedAt: new Date(),
        status: 'ready',
      },
    })
    .where(and(eq(apps.tenantId, tenant.id), eq(apps.id, app.app.id)))
    .returning()
  if (updated) app.app = updated
  // Production already runs the version before this change.
  await db
    .update(appEnvironments)
    .set({ lastDeployVersion: '0.1.0', lastDeployAt: new Date(), healthStatus: 'up' })
    .where(
      and(
        eq(appEnvironments.tenantId, tenant.id),
        eq(appEnvironments.appId, app.app.id),
        eq(appEnvironments.name, 'production')
      )
    )

  const fixture = {
    tenant: { id: tenant.id } as never,
    user: { id: alice.id } as never,
    app: app.app,
  }
  const row = await insertSession(db, fixture, { status: 'requested', title: TITLE })
  const branch = sessionBranchName(row.shortId)
  const ports = createFakeSessionPorts({
    sessionDb: d =>
      new NeonSessionDb(d, cfg, { fetch: cloud.fetch, sleep: async () => {}, apiKey: NEON_KEY }),
    repoHost: d =>
      new GitHubRepoHost(d, cfg, {
        fetch: cloud.fetch,
        github: {
          auth: { appId: String(cloud.opts.appId), privateKey: APP_PEM },
          installationId: cloud.opts.installationId,
          org: cloud.opts.org,
        },
      }),
  })
  ports.script(sandbox =>
    scriptKitGate(sandbox, 'gate')
      .onExec(/git init/, { stdout: `base=${BASE_SHA}\nhead=${BASE_SHA}\n` })
      .onExec(/sha256sum/, { stdout: `migrations=${'a'.repeat(64)}\n` })
      .onExec(WORKSPACE_CHANGED_SCRIPT, { stdout: `${BASE_SHA}\nclean\n` })
      .onExec(/git -C \/workspace\/app diff --stat/, {
        stdout:
          ' src/ui/pages/Home.tsx | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)\n',
      })
      .onProcess(/exec pnpm dev /, { lines: ['ready'], ports: [5173, 8787], hang: true })
      .onBackground(/pnpm gate (lint|typecheck|test)/, { exitCode: 0, log: 'ok\n' })
  )
  const summary = new FakeChatClient([
    { text: SUMMARY, usage: { inputTokens: 800, outputTokens: 40 } },
  ])
  let pushes = 0
  const hooks: SessionStepHooks = {
    // Phase B is the REAL code (S3): the release, the staging follow, the health probe.
    ...defaultSessionStepHooks,
    runTurn: async () => {
      throw new Error('no chat turn in this suite')
    },
    checkpoint: async ctx => {
      // The push lands the branch on GitHub and moves the session's head, as the real one does.
      const sha = cloud.github.pushCommit(
        app.owner,
        app.repo,
        { 'src/ui/pages/Home.tsx': `export default () => <b>Hello ${++pushes}</b>\n` },
        `Launch session ${row.shortId}`,
        branch
      )
      await db.update(sessions).set({ headSha: sha }).where(eq(sessions.id, ctx.session.id))
    },
    shipFix: async () => {
      throw new Error('no fix turn: the gate is green')
    },
    shipSummary: (ctx, input) =>
      summarizeShip(ctx.db, ctx.cfg, ctx.env, ctx.session, input, {
        client: { client: summary, provider: 'anthropic', model: 'claude-haiku-4-5' },
      }),
  }
  return {
    env,
    tenantId: tenant.id,
    admin,
    alice,
    bob,
    app,
    row,
    ports,
    hooks,
    sandbox: () => ports.sandbox(row.id) as FakeSandbox,
  }
}

async function reload(h: Harness): Promise<SessionRow> {
  const [latest] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, h.tenantId), eq(sessions.id, h.row.id)))
  if (!latest) throw new Error('session vanished')
  return latest
}

const asUser = (p: Person) => ({ ...p.cookie, 'X-Requested-With': 'fetch' })

/** `PUT /api/apps/:id/ship-settings` as bob (an owner — `mayDeployApp`). */
async function shipSettings(
  h: Harness,
  body: { sessionShip: 'staging' | 'pr'; review: { mode: 'none' | 'app_owners'; groupIds: [] } }
) {
  const res = await request(
    `/api/apps/${h.app.app.id}/ship-settings`,
    { method: 'PUT', headers: asUser(h.bob) },
    { env: h.env, json: body }
  )
  expect(res.status, await res.clone().text()).toBe(200)
}

function decideAs(
  h: Harness,
  who: Person,
  id: string,
  decision: 'approve' | 'reject',
  comment?: string
) {
  return request(
    `/api/approvals/${id}/decide`,
    { method: 'POST', headers: asUser(who) },
    { env: h.env, json: { decision, ...(comment ? { comment } : {}) } }
  )
}

/** The gate SHA the landing reads CI on (the session's head after `ship.commit`). */
const gateShaOf = async (h: Harness) => (await reload(h)).headSha ?? ''

function setGate(h: Harness, sha: string, state: 'success' | 'failure') {
  return cloud.github.setCheckRuns(h.app.owner, h.app.repo, sha, [
    { name: 'Gate', status: 'completed', conclusion: state },
  ])
}

/** The `deploy.yml` run the release's tag starts: start → upload → activate → finish on staging. */
async function deployStaging(h: Harness, version: string) {
  const job = deployJob(h.env, h.app, 'staging', { ref: `refs/tags/${version}` })
  const start = await json<{ id: string; status: string }>(
    await job.call('POST', '/start', { protocol: 1 })
  )
  expect(start.status).toBe('approved')
  for (const [path, payload] of [
    ['upload', uploadBody(appToml(h.app, 'staging'), version)],
    ['activate', undefined],
    ['finish', undefined],
  ] as const) {
    const res = await job.call('POST', `/${start.id}/${path}`, payload)
    expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200)
  }
}

/**
 * Run the Workflow to its end. The first idle wait is alice pressing Ship (the real route); each
 * `land.wait#N` is `onLand`'s (the repository's CI, a reviewer); a `land.staging-wake` round is
 * the deploy the tag started; a later idle wait ends the session (`onIdle` sees the row first).
 */
async function drive(
  h: Harness,
  opts: {
    onLand?: (wait: RecordedWait, n: number) => Promise<'wake' | 'timeout'>
    onIdle?: (row: SessionRow) => Promise<void> | void
  } = {}
) {
  let idle = 0
  let lands = 0
  let deployed = false
  /** The staging deploy, played once inside the first `land.staging-wake` round. */
  const playDeploy = async () => {
    if (deployed) return
    deployed = true
    const landing = (await reload(h)).landing as SessionLanding
    await deployStaging(h, landing.version ?? '')
  }
  const fake = createFakeWorkflowStep({
    onWait: async wait => {
      if (wait.name.startsWith('land.wait#')) {
        return (await opts.onLand?.(wait, lands++)) === 'wake' ? WAKE : undefined
      }
      // Issue #19: Phase B's GitHub-facing rounds are `waitForEvent`s; nobody wakes them here.
      if (/^land\.(main-ci|release|staging)-wake#/.test(wait.name)) {
        if (wait.name.startsWith('land.staging-wake#')) await playDeploy()
        return undefined
      }
      if (idle++ === 0) {
        const res = await request(
          `/api/sessions/${h.row.id}/ship`,
          { method: 'POST', headers: asUser(h.alice) },
          { env: h.env }
        )
        expect(res.status, await res.clone().text()).toBe(202)
      } else {
        await opts.onIdle?.(await reload(h))
        await db
          .update(sessions)
          .set({ requestedAction: 'end' })
          .where(and(eq(sessions.tenantId, h.tenantId), eq(sessions.id, h.row.id)))
      }
      return WAKE
    },
  })
  ;(fake.step as { sleep: unknown }).sleep = async (name: string) => {
    fake.names.push(name)
  }
  const workflow = new SessionWorkflow(createExecutionContext(), h.env)
  workflow.overrides = { ports: h.ports, hooks: h.hooks, limits: LIMITS }
  const outcome = await workflow.run(
    {
      payload: { sessionId: h.row.id, tenantId: h.tenantId },
      timestamp: new Date(),
      instanceId: h.row.id,
      workflowName: 'launch-session',
    },
    fake.step as unknown as Parameters<SessionWorkflow['run']>[1]
  )
  // A step name is its identity to the platform: never one twice.
  expect(new Set(fake.names).size).toBe(fake.names.length)
  return { outcome, names: fake.names }
}

const eventsOf = (h: Harness) => listSessionEvents(db, h.tenantId, h.row.id, 0, 5000)

/** The ship panel's walk (S5's `landingTimeline`) over the rows and the row the server wrote. */
async function panelOf(h: Harness) {
  const row = await reload(h)
  const events = (await eventsOf(h)) as unknown as SessionEvent[]
  return landingTimeline(events, row.landing, row.status)
}
const stepsOf = (view: Awaited<ReturnType<typeof panelOf>>) =>
  Object.fromEntries((view?.steps ?? []).map(step => [step.key, step.status]))
const eventData = async (h: Harness, type: string) =>
  (await eventsOf(h)).filter(e => e.type === type).map(e => e.data as Record<string, unknown>)

async function releasesOf(h: Harness) {
  return db
    .select()
    .from(appReleases)
    .where(and(eq(appReleases.tenantId, h.tenantId), eq(appReleases.appId, h.app.app.id)))
}

function tagsOf(h: Harness): string[] {
  const refs = cloud.github.repo(h.app.owner, h.app.repo)?.refs ?? new Map()
  return [...refs.keys()].filter(k => k.startsWith('tags/')).sort()
}

async function mergeApprovals(h: Harness) {
  return db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, h.tenantId),
        eq(approvalRequests.kind, 'session.merge'),
        eq(approvalRequests.subjectId, h.row.id)
      )
    )
}

/** Is `wanted` a subsequence of `actions`, in order? The index of each, or -1. */
function positions(actions: string[], wanted: string[]): number[] {
  let from = 0
  return wanted.map(action => {
    const at = actions.indexOf(action, from)
    if (at >= 0) from = at + 1
    return at
  })
}

beforeEach(() => {
  fillDeployCredentials(store, cloud)
})

describe('Ship means live on staging, end to end', () => {
  it('app_owners review: CI green → bob approves (alice refused) → one squash → patch release → staging → live', async () => {
    const h = await harness()
    await shipSettings(h, { sessionShip: 'staging', review: { mode: 'app_owners', groupIds: [] } })
    const refusals: Response[] = []

    const run = await drive(h, {
      onLand: async (_wait, n) => {
        const row = await reload(h)
        if (n === 0) {
          // The PR is open and the landing waits on CI: the repository's `Gate` check goes green.
          expect(row).toMatchObject({
            status: 'shipping',
            landing: { mode: 'staging', stage: 'ci', reviewMode: 'app_owners' },
          })
          expect(cloud.github.mergeCount(h.app.owner, h.app.repo)).toBe(0)
          setGate(h, await gateShaOf(h), 'success')
          return 'wake'
        }
        // CI is green and the review is open: nothing has merged yet.
        expect(row.landing).toMatchObject({ stage: 'approval', approvalId: expect.any(String) })
        expect(cloud.github.mergeCount(h.app.owner, h.app.repo)).toBe(0)
        const id = row.landing?.approvalId ?? ''
        // Bob sees the change in Launch: the summary, the diff stat and the session.
        const detail = await request(
          `/api/approvals/${id}`,
          { headers: h.bob.cookie },
          { env: h.env }
        )
        expect(detail.status).toBe(200)
        expect(await json(detail)).toMatchObject({
          kind: 'session.merge',
          context: {
            prTitle: TITLE,
            summary: SUMMARY_BODY,
            diffStat: expect.stringContaining('src/ui/pages/Home.tsx'),
            sessionPath: `/apps/${h.app.app.slug}/sessions/${h.row.id}`,
          },
        })
        // Alice made the change: she can never approve it.
        refusals.push(await decideAs(h, h.alice, id, 'approve'))
        const approved = await decideAs(h, h.bob, id, 'approve')
        expect(approved.status, await approved.clone().text()).toBe(200)
        return 'wake'
      },
    })

    expect(refusals[0]?.status).toBe(403)
    expect(await json(refusals[0] as Response)).toMatchObject({
      statusCode: 403,
      code: 'self_approval',
    })

    // ---- the Workflow: ship → land (CI, review, merge) → cleanup → release → staging → live.
    expect(run.outcome.status).toBe('shipped')
    expect(run.names).toEqual(
      expect.arrayContaining([
        'ship.pr#1',
        'land.ci#2',
        'land.wait#2',
        'land.ci#3',
        'land.review#3',
        'land.wait#3',
        'land.merge#4',
        'cleanup',
        'land.main-ci#4.0',
        'land.release#4.0',
        'land.staging#4.0',
        'land.staging-wake#4.0',
        'land.staging#4.1',
        'land.health#4.0',
        'land.live#4',
      ])
    )

    // ---- exactly one squash merge, on the gate SHA, carrying the summary.
    const row = await reload(h)
    expect(cloud.github.mergeCount(h.app.owner, h.app.repo)).toBe(1)
    const merge = cloud.github.merges.find(m => m.repo === h.app.repo)
    expect(merge).toMatchObject({
      method: 'squash',
      headSha: row.landing?.gateSha,
      title: `${TITLE} (#1)`,
    })
    expect(merge?.message).toContain(SUMMARY_BODY)
    expect(merge?.message).toMatch(
      new RegExp(`Merged by Launch from session ${row.shortId}, approved by `)
    )

    // ---- a patch release, tagged, on staging.
    const [release, ...others] = await releasesOf(h)
    expect(others).toEqual([])
    expect(release).toMatchObject({
      version: '0.1.1',
      tag: '0.1.1',
      status: 'staging_active',
      createdByUserId: null,
    })
    expect(release?.prs).toEqual([expect.objectContaining({ number: 1, sessionId: h.row.id })])
    expect(tagsOf(h)).toEqual(['tags/0.1.1'])

    // ---- the session: shipped, live on staging at the version, with the link.
    expect(row.status).toBe('shipped')
    expect(row.landing).toMatchObject({
      stage: 'live',
      version: '0.1.1',
      tag: '0.1.1',
      stagingUrl: h.app.staging.url,
      mergeSha: merge?.sha,
      releaseId: release?.id,
    })
    expect((await eventData(h, 'ship.review')).map(d => d.status)).toEqual([
      'requested',
      'approved',
    ])
    expect(await eventData(h, 'ship.released')).toEqual([
      { releaseId: release?.id, version: '0.1.1', tag: '0.1.1', shared: false },
    ])
    expect((await eventData(h, 'ship.staging')).map(d => d.status)).toEqual(['active', 'live'])
    expect(await eventData(h, 'ship.reopened')).toEqual([])
    // The ship panel walks every step to "Live on staging", with the link.
    const panel = await panelOf(h)
    expect(panel).toMatchObject({
      outcome: 'live',
      version: '0.1.1',
      stagingUrl: h.app.staging.url,
    })
    expect(stepsOf(panel)).toEqual({
      gate: 'done',
      pr: 'done',
      ci: 'done',
      approval: 'done',
      merged: 'done',
      released: 'done',
      staging: 'done',
    })

    // ---- the chain reads the whole story, in order.
    const chainRes = await request(
      `/api/apps/${h.app.app.id}/releases/${release?.id}/chain`,
      { headers: h.alice.cookie },
      { env: h.env }
    )
    expect(chainRes.status).toBe(200)
    const { events: items } = releaseChainSchema.parse(await json(chainRes))
    const actions = items.map(e => e.action)
    const story = [
      'session.shipped',
      'approval.requested',
      'approval.approved',
      'pr.merged', // recorded by the merge, then the session's own row
      'session.merged',
      'release.created',
      'release.staging_active',
      'session.landed',
    ]
    expect(positions(actions, story), actions.join(' → ')).not.toContain(-1)
    // The staging deploy sits between the release and its activation.
    const deploys = actions
      .map((a, i) => ({ a, i }))
      .filter(x => x.a.startsWith('deploy.'))
      .map(x => x.i)
    expect(deploys.length, actions.join(' → ')).toBeGreaterThan(0)
    expect(Math.min(...deploys)).toBeGreaterThan(actions.indexOf('release.created'))
    expect(Math.min(...deploys)).toBeLessThan(actions.indexOf('session.landed'))
    // The approval rows in the chain are the session.merge review.
    const approvalId = row.landing?.approvalId
    expect(items.find(e => e.action === 'approval.approved')?.approvalId).toBe(approvalId)

    // ---- the Promote strip: the change in plain words, Promote enabled.
    const promoRes = await request(
      `/api/apps/${h.app.app.id}/promotion`,
      { headers: h.alice.cookie },
      { env: h.env }
    )
    expect(promoRes.status).toBe(200)
    const promotion: AppPromotion = appPromotionSchema.parse(await json(promoRes))
    expect(promotion.candidate).toMatchObject({ version: '0.1.1', status: 'staging_active' })
    expect(promotion.staging).toMatchObject({ version: '0.1.1', healthStatus: 'up' })
    expect(promotion.production).toMatchObject({ version: '0.1.0' })
    expect(promotion.changes).toEqual([
      expect.objectContaining({
        number: 1,
        sessionId: h.row.id,
        sessionTitle: TITLE,
        summary: SUMMARY_BODY,
      }),
    ])
    expect(promotionState(promotion)).toMatchObject({ kind: 'ready' })
  })

  it('CI red: back to ready with the failing check and a REDACTED log tail; nothing merged', async () => {
    const h = await harness()
    await shipSettings(h, { sessionShip: 'staging', review: { mode: 'app_owners', groupIds: [] } })
    const secret = 'ghp_e2eSECRETabcdefghijklmnopqrstuvwxyz0123'
    let after: SessionRow | null = null
    const run = await drive(h, {
      onLand: async () => {
        const [check] = setGate(h, await gateShaOf(h), 'failure')
        cloud.github.setJobLog(
          h.app.owner,
          h.app.repo,
          check?.id ?? 0,
          [
            '2026-10-01T12:00:00.000Z Run pnpm gate test',
            `2026-10-01T12:00:01.000Z export GITHUB_TOKEN=${secret}`,
            '2026-10-01T12:00:02.000Z  FAIL  tests/api/greeting.test.ts > greets',
            '2026-10-01T12:00:03.000Z AssertionError: expected "Hi" to be "Hello"',
          ].join('\n')
        )
        return 'wake'
      },
      onIdle: row => {
        after = row
      },
    })
    expect(run.names).toContain('land.reopen#3')
    expect(after).toMatchObject({ status: 'ready', landing: null })
    expect(cloud.github.mergeCount(h.app.owner, h.app.repo)).toBe(0)
    expect(await releasesOf(h)).toEqual([])
    expect(await mergeApprovals(h)).toEqual([])

    const [red] = (await eventData(h, 'ship.ci'))
      .map(d => sessionShipCiDataSchema.parse(d))
      .filter(d => d.state === 'failure')
    expect(red?.failedCheck).toMatchObject({ name: 'Gate' })
    expect(red?.failedCheck?.logTail).toContain('AssertionError: expected "Hi" to be "Hello"')
    expect(JSON.stringify(await eventsOf(h))).not.toContain(secret)
    expect(await eventData(h, 'ship.reopened')).toEqual([
      { reason: 'ci_failed', message: expect.stringContaining('CI failed on GitHub (Gate)') },
    ])
    // The panel: reopened at CI, with the failing check and its (redacted) tail.
    const panel = await panelOf(h)
    expect(panel).toMatchObject({ outcome: 'reopened', reopen: { reason: 'ci_failed' } })
    expect(stepsOf(panel)).toMatchObject({ pr: 'done', ci: 'failed', merged: 'pending' })
    expect(panel?.failedCheck?.logTail).toContain('AssertionError')
    expect(panel?.failedCheck?.logTail).not.toContain(secret)
  })

  it('review rejected: back to ready with the reviewer’s note; nothing merged', async () => {
    const h = await harness()
    await shipSettings(h, { sessionShip: 'staging', review: { mode: 'app_owners', groupIds: [] } })
    let after: SessionRow | null = null
    await drive(h, {
      onLand: async (_wait, n) => {
        if (n === 0) {
          setGate(h, await gateShaOf(h), 'success')
          return 'wake'
        }
        const id = (await reload(h)).landing?.approvalId ?? ''
        const res = await decideAs(h, h.bob, id, 'reject', 'Make the greeting friendlier')
        expect(res.status, await res.clone().text()).toBe(200)
        return 'wake'
      },
      onIdle: row => {
        after = row
      },
    })
    expect(after).toMatchObject({ status: 'ready', landing: null })
    expect(await eventData(h, 'ship.reopened')).toEqual([
      {
        reason: 'review_rejected',
        message: expect.stringContaining('rejected the merge: Make the greeting friendlier'),
      },
    ])
    expect(cloud.github.mergeCount(h.app.owner, h.app.repo)).toBe(0)
    expect(await releasesOf(h)).toEqual([])
    const panel = await panelOf(h)
    expect(panel).toMatchObject({
      outcome: 'reopened',
      reopen: { reason: 'review_rejected', note: 'Make the greeting friendlier' },
    })
    expect(stepsOf(panel)).toMatchObject({ ci: 'done', approval: 'failed', merged: 'pending' })
  })

  it('`pr` mode: today’s behaviour — shipped at the open PR, no merge, no release', async () => {
    const h = await harness()
    await shipSettings(h, { sessionShip: 'pr', review: { mode: 'none', groupIds: [] } })
    const run = await drive(h)
    expect(run.outcome.status).toBe('shipped')
    expect(run.names).toContain('ship.pr#1')
    expect(run.names.filter(n => n.startsWith('land.'))).toEqual([])
    const row = await reload(h)
    expect(row).toMatchObject({ status: 'shipped', prNumber: 1, landing: { stage: 'pr' } })
    expect(cloud.github.mergeCount(h.app.owner, h.app.repo)).toBe(0)
    expect(await releasesOf(h)).toEqual([])
    expect(tagsOf(h)).toEqual([])
    expect((await panelOf(h))?.outcome).toBe('pr')
  })

  it('the default settings (staging, no review): CI green goes straight to live, no approval', async () => {
    const h = await harness()
    const run = await drive(h, {
      onLand: async () => {
        setGate(h, await gateShaOf(h), 'success')
        return 'wake'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(run.names).not.toContain('land.review#3')
    expect(await mergeApprovals(h)).toEqual([])
    expect(cloud.github.mergeCount(h.app.owner, h.app.repo)).toBe(1)
    const row = await reload(h)
    expect(row.landing).toMatchObject({
      reviewMode: 'none',
      approvalId: null,
      stage: 'live',
      version: '0.1.1',
      stagingUrl: h.app.staging.url,
    })
    expect(cloud.github.merges.find(m => m.repo === h.app.repo)?.message).toContain(
      `Merged by Launch from session ${row.shortId}.`
    )
  })

  it('End while the review waits: the request is cancelled, nothing merges, the panel stops walking', async () => {
    const h = await harness()
    await shipSettings(h, { sessionShip: 'staging', review: { mode: 'app_owners', groupIds: [] } })
    const run = await drive(h, {
      onLand: async (_wait, n) => {
        if (n === 0) {
          setGate(h, await gateShaOf(h), 'success')
          return 'wake'
        }
        const res = await request(
          `/api/sessions/${h.row.id}/end`,
          { method: 'POST', headers: asUser(h.alice) },
          { env: h.env }
        )
        expect(res.status, await res.clone().text()).toBe(202)
        return 'wake'
      },
    })
    expect(run.outcome.status).toBe('ended')
    expect(cloud.github.mergeCount(h.app.owner, h.app.repo)).toBe(0)
    const [review] = await mergeApprovals(h)
    expect(review?.status).toBe('cancelled')
    expect((await reload(h)).landing).toBeNull()
    // No reopen row and no landing: the panel falls back to the open PR, not "Waiting for CI".
    expect(await eventData(h, 'ship.reopened')).toEqual([])
    expect(await panelOf(h)).toBeNull()
  })

  it('an admin session.merge policy forces a review the app setting does not ask for', async () => {
    const h = await harness()
    // The app says "no review"; the organisation's admin says bob reviews every merge of it.
    const policy = await request(
      '/api/approval-policies',
      { method: 'PUT', headers: asUser(h.admin) },
      {
        env: h.env,
        json: {
          kind: 'session.merge',
          scopeType: 'app',
          scopeId: h.app.app.id,
          approvers: { userIds: [h.bob.id] },
          expiresAfterMinutes: 48 * 60,
        },
      }
    )
    expect(policy.status, await policy.clone().text()).toBe(200)
    // The app page shows the review read-only, and an owner cannot loosen it.
    const detail = await request(
      `/api/apps/${h.app.app.slug}`,
      { headers: h.bob.cookie },
      { env: h.env }
    )
    expect(await json(detail)).toMatchObject({
      shipSettings: { sessionShip: 'staging', review: { mode: 'none' } },
      shipReviewSetBy: 'policy',
    })
    const loosen = await request(
      `/api/apps/${h.app.app.id}/ship-settings`,
      { method: 'PUT', headers: asUser(h.bob) },
      { env: h.env, json: { sessionShip: 'staging', review: { mode: 'app_owners', groupIds: [] } } }
    )
    expect(loosen.status).toBe(409)
    expect(await json(loosen)).toMatchObject({ code: 'ship_review_set_by_policy' })

    const run = await drive(h, {
      onLand: async (_wait, n) => {
        if (n === 0) {
          expect((await reload(h)).landing).toMatchObject({ reviewMode: 'policy' })
          setGate(h, await gateShaOf(h), 'success')
          return 'wake'
        }
        const id = (await reload(h)).landing?.approvalId ?? ''
        const [request] = await mergeApprovals(h)
        expect(request).toMatchObject({ id, status: 'pending' })
        expect(request?.policy.approvers.userIds).toEqual([h.bob.id])
        expect(cloud.github.mergeCount(h.app.owner, h.app.repo)).toBe(0)
        const res = await decideAs(h, h.bob, id, 'approve')
        expect(res.status, await res.clone().text()).toBe(200)
        return 'wake'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(cloud.github.mergeCount(h.app.owner, h.app.repo)).toBe(1)
    expect((await reload(h)).landing).toMatchObject({ stage: 'live', version: '0.1.1' })
  })
})
