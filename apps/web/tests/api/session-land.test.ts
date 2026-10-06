// @vitest-isolate
// Mocks `sessionsPaused` (a GLOBAL launch setting) and S4's `reviewPolicyFor`, so this file needs its own module registry.
/**
 * Issue #5's landing (`docs/plans/i5-ship-to-staging.md` §1.1–§1.7, `services/sessions/land.ts`)
 * driven through the real `SessionWorkflow`, on the `session-ship-gate.test.ts` harness: a green
 * gate opens the PR in `staging` mode, then the `land` rounds watch CI on the GATE SHA (the
 * FakeCloud's GitHub: check runs, job logs, squash merge, a person's merge or close), open and
 * read the `session.merge` review, squash-merge once, and hand over to Phase B — whose hooks are
 * fakes here (the real ones are S3's, `session-land-release.test.ts`).
 *
 * What it proves: CI green merges ONCE and follows the release to `live`; red reopens with a
 * REDACTED log tail (`ready` while the container is the loop's, `suspended` once it was released);
 * a moved head, a closed PR and a CI that never reports reopen; a retried merge step merges once;
 * a person's merge goes straight to Phase B; End during `ci` abandons the landing and a merge in
 * flight refuses an End; a lost instance in `ci` is restarted by the cron's safety net and resumed
 * without a salvage; the squash message and the review's context come from `ship_summary`; a
 * ship, landing or release whose instance died "running" (a `wrangler dev` reload) is restarted
 * by the reconcile past its window and resumed — merging once, ending on an End, salvaging a gate;
 * and every step name is distinct.
 */
import { generateKeyPairSync } from 'node:crypto'
import {
  SESSION_WAKE_EVENT,
  type SessionLanding,
  sessionBranchName,
  sessionShipCiDataSchema,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decide } from '@/api/services/approvals/engine'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import type { ShipReviewPolicy } from '@/api/services/launch/ship-settings'
import { WORKSPACE_CHANGED_SCRIPT } from '@/api/services/sessions/checkpoint'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import type { SessionStepHooks } from '@/api/services/sessions/hooks'
import {
  casLanding,
  LAND_CI_FAST_SECONDS,
  LAND_CI_SLOW_SECONDS,
  LAND_RETRY_SECONDS,
  nudgeLandingSessions,
} from '@/api/services/sessions/land'
import { retryLanding } from '@/api/services/sessions/land-retry'
import type { RepoHostPort } from '@/api/services/sessions/ports'
import {
  reconcileSession,
  reconcileStaleSessions,
  SESSION_LANDING_STALL_MS,
  SESSION_RELEASE_STALL_MS,
  SESSION_SHIP_GATE_STALL_MS,
} from '@/api/services/sessions/reconcile'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import { sessionRepo, summarizeShip } from '@/api/services/sessions/ship'
import {
  lostShipMessage,
  type StepScope,
  waitDuration,
  withHeartbeat,
} from '@/api/services/sessions/steps'
import { sessionSystemNote } from '@/api/services/sessions/turn'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import {
  appOwners,
  appPrebuilds,
  approvalRequests,
  apps,
  auditEvents,
  type SessionRow,
  sessions,
} from '@/db/schema'
import { FakeChatClient } from '../helpers/ai'
import { decideAs, expireNow, testApprovalDeps, viewerFor } from '../helpers/approvals-kinds'
import { createTestUser, linkUserToTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import {
  checkRunCompleted,
  drainJobs,
  postWebhook,
  uniqueRepoId,
  WEBHOOK_SECRET,
  type WebhookRepo,
} from '../helpers/github-webhooks'
import { json, request } from '../helpers/request'
import {
  createFakeSessionPorts,
  type FakeSessionPorts,
  insertSession,
  type SessionAppFixture,
  scriptKitGate,
  seedSessionApp,
} from '../helpers/sessions'
import {
  createExecutionContext,
  createTestEnv,
  type RecordingWorkflow,
  stubs,
  type TestEnv,
} from '../mocks/bindings'
import {
  createFakeWorkflowStep,
  type FakeWorkflowInbox,
  type RecordedWait,
} from '../mocks/cloudflare-workers'

vi.mock('@/api/services/sessions/lifecycle', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/sessions/lifecycle')>()
  return { ...actual, sessionsPaused: vi.fn(async () => false) }
})

/** `reviewPolicyFor` (S4's) answers what the test says; `session-land-e2e.test.ts` runs the real one. */
const review: { policy: ShipReviewPolicy } = { policy: noReview() }
vi.mock('@/api/services/launch/ship-settings', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/launch/ship-settings')>()
  return { ...actual, reviewPolicyFor: vi.fn(async () => review.policy) }
})

function noReview(): ShipReviewPolicy {
  return { required: false, setBy: 'app', mode: 'none', policy: null }
}
function ownersReview(): ShipReviewPolicy {
  return {
    required: true,
    setBy: 'app',
    mode: 'app_owners',
    policy: {
      approvers: { appOwners: true, admins: false, groupIds: [], userIds: [] },
      minApprovals: 1,
      allowSelfApproval: false,
      expiresAfterMinutes: 48 * 60,
      autoApproveRole: null,
    },
  }
}

const db = setupTestDatabase()
const NEON_KEY = 'neon-test-key-abcdefghijklmnop'
const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const WAKE = { type: SESSION_WAKE_EVENT, payload: {} }
const SUMMARY = '{"title": "Greet people on the home page", "body": "Adds a bold greeting."}'
const LIMITS = { endPollMs: 5, commandPollMs: 1, heartbeatMs: 60_000 }
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const { privateKey: APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

interface Harness {
  env: TestEnv
  cloud: FakeCloud
  f: SessionAppFixture
  row: SessionRow
  ports: FakeSessionPorts
  hooks: SessionStepHooks
  /** The steps' clock (`overrides.now`): a test moves it forward. */
  clock: { ms: number }
  phaseB: string[]
  sandbox: () => FakeSandbox
}

/** A prepared app in `staging` mode, a `requested` session, a green gate, fake Phase B hooks. */
async function harness(envOverrides: Partial<TestEnv> = {}): Promise<Harness> {
  const env = createTestEnv(envOverrides)
  const cfg = loadConfig(env)
  const cloud = createFakeCloud()
  const f = await seedSessionApp(db, cloud, { prepared: true })
  // Issue #11: the default branch's CI is green on every merge commit unless a test says otherwise.
  cloud.github.mergeCommitChecks = [{ name: 'Gate', status: 'completed', conclusion: 'success' }]
  const row = await insertSession(db, f, { status: 'requested', title: null })
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
  const phaseB: string[] = []
  let pushes = 0
  const hooks: SessionStepHooks = {
    runTurn: async () => {
      throw new Error('no chat turn in this suite')
    },
    checkpoint: async ctx => {
      // The push lands the branch on GitHub and moves the session's head, as the real one does.
      const sha = cloud.github.pushCommit(
        f.repo.owner,
        f.repo.repo,
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
    // Phase B (S3's hooks): a release cut on the first call, active on staging, live.
    landRelease: async ctx => {
      phaseB.push('release')
      const releaseId = crypto.randomUUID()
      await casLanding(
        { db: ctx.db, params: ctx.ref, realtime: ctx.realtime },
        { statuses: ['shipped'], stages: ['releasing'] },
        {
          stage: 'deploying',
          stageAt: new Date().toISOString(),
          releaseId,
          version: '1.4.1',
          tag: 'v1.4.1',
        }
      )
      return { status: 'released', releaseId, version: '1.4.1', tag: 'v1.4.1', shared: false }
    },
    landStaging: async () => {
      phaseB.push('staging')
      return { status: 'active' }
    },
    landHealth: async () => {
      phaseB.push('health')
      return { status: 'live', url: 'https://shop-staging.example.com', version: '1.4.1' }
    },
  }
  return {
    env,
    cloud,
    f,
    row,
    ports,
    hooks,
    clock: { ms: Date.now() },
    phaseB,
    sandbox: () => ports.sandbox(row.id) as FakeSandbox,
  }
}

async function patch(row: Pick<SessionRow, 'id'>, set: Partial<typeof sessions.$inferInsert>) {
  await db.update(sessions).set(set).where(eq(sessions.id, row.id))
}

async function reload(row: Pick<SessionRow, 'id' | 'tenantId'>): Promise<SessionRow> {
  const [latest] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
  if (!latest) throw new Error('session vanished')
  return latest
}

/** Issue #19: Phase B's GitHub-facing rounds — `waitForEvent`s, where health keeps a sleep. */
const PHASE_B_WAKE = /^land\.(main-ci|release|staging)-wake#/

/** What a `land.wait#N` does in a test: wake the session, or let the round time out. */
type LandWait = (h: Harness, wait: RecordedWait, n: number) => Promise<'wake' | 'timeout'>

/**
 * Run the Workflow. The first idle wait asks for the ship; each `land.wait#N` is `onLand`'s (the
 * test's CI, reviewer or person); a later idle wait ends the session (and `onIdle` sees the row
 * then — what a reopen left).
 */
async function drive(
  h: Harness,
  opts: {
    onLand?: LandWait
    onIdle?: (row: SessionRow) => Promise<void> | void
    /**
     * Interfere with a step by name (a lost instance); `again` runs its body once more without
     * recording a step — the platform retrying a step whose result it lost.
     */
    wrapDo?: (
      name: string,
      run: () => Promise<unknown>,
      again: () => Promise<unknown>
    ) => Promise<unknown>
    /** A fresh instance's run (the row is already where it is). */
    fresh?: boolean
    /**
     * A Phase B wait by name — a `step.sleep` (`land.health-wait`) or, issue #19, a `…-wake` round
     * of `waitForEvent` (issue #11: the merge commit's CI moving on during `land.main-ci-wake`).
     * A `…-wake` round then times out unless the `inbox` holds a wake for it.
     */
    onSleep?: (h: Harness, name: string) => Promise<void> | void
    /** Issue #19: the session's `SESSION_WORKFLOW` sends, delivered to the waits as the platform does. */
    inbox?: FakeWorkflowInbox
  } = {}
) {
  let idle = 0
  let lands = 0
  const fake = createFakeWorkflowStep({
    inbox: opts.inbox,
    onWait: async wait => {
      if (wait.name.startsWith('land.wait#')) {
        const verdict = (await opts.onLand?.(h, wait, lands++)) ?? 'timeout'
        return verdict === 'wake' ? WAKE : undefined
      }
      if (PHASE_B_WAKE.test(wait.name)) {
        await opts.onSleep?.(h, wait.name)
        return undefined
      }
      if (idle++ === 0 && !opts.fresh) {
        await patch(h.row, { requestedAction: 'ship' })
      } else {
        await opts.onIdle?.(await reload(h.row))
        await patch(h.row, { requestedAction: 'end' })
      }
      return WAKE
    },
  })
  // The fake's `sleep` records nothing; Phase B's waits are steps too, so name them.
  ;(fake.step as { sleep: unknown }).sleep = async (name: string) => {
    fake.names.push(name)
    await opts.onSleep?.(h, name)
  }
  const realDo = fake.step.do.bind(fake.step) as (...args: unknown[]) => Promise<unknown>
  ;(fake.step as { do: unknown }).do = async (...args: unknown[]) => {
    const name = args[0] as string
    const body = args.at(-1) as () => Promise<unknown>
    return opts.wrapDo ? opts.wrapDo(name, () => realDo(...args), body) : realDo(...args)
  }
  const workflow = new SessionWorkflow(createExecutionContext(), h.env)
  workflow.overrides = {
    ports: h.ports,
    hooks: h.hooks,
    limits: LIMITS,
    now: () => new Date(h.clock.ms),
  }
  const outcome = await workflow.run(
    {
      payload: { sessionId: h.row.id, tenantId: h.row.tenantId },
      timestamp: new Date(),
      instanceId: h.row.id,
      workflowName: 'launch-session',
    },
    fake.step as unknown as Parameters<SessionWorkflow['run']>[1]
  )
  // A step name is its identity to the platform: never one twice.
  expect(new Set(fake.names).size).toBe(fake.names.length)
  return { outcome, names: fake.names, waits: fake.waits }
}

const SHIP = [
  'ship.claim#1',
  'ship.save#1',
  'ship.kit#1',
  'ship.tree#1.1',
  'ship.gate#1.1.lint',
  'ship.gate#1.1.typecheck',
  'ship.db#1.1',
  'ship.gate#1.1.test',
  'ship.db-clean#1.1',
  'ship.commit#1',
  'ship.attest#1',
  'ship.summary#1',
  'ship.pr#1',
]
const BOOT = ['claim', 'db', 'sandbox.start', 'repo', 'bootstrap', 'dev', 'inspect#0', 'wait#0']

const eventsOf = (h: Harness) => listSessionEvents(db, h.row.tenantId, h.row.id, 0, 5000)
const eventData = async <T = Record<string, unknown>>(h: Harness, type: string) =>
  (await eventsOf(h)).filter(e => e.type === type).map(e => e.data as T)
const auditOf = async (h: Harness, action: string) =>
  db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, h.row.tenantId), eq(auditEvents.action, action)))

/** The gate SHA the landing reads CI on (the session's head after `ship.commit`). */
const gateShaOf = async (h: Harness) => (await reload(h.row)).headSha ?? ''
function setGate(
  h: Harness,
  sha: string,
  state: 'in_progress' | 'success' | 'failure',
  id?: number
) {
  return h.cloud.github.setCheckRuns(h.f.repo.owner, h.f.repo.repo, sha, [
    {
      name: 'Gate',
      status: state === 'in_progress' ? 'in_progress' : 'completed',
      conclusion: state === 'in_progress' ? null : state,
      ...(id ? { id } : {}),
    },
  ])
}

beforeEach(() => {
  review.policy = noReview()
})

describe('landing: CI green', () => {
  it('waits on CI, merges ONCE on the gate SHA, then follows the release to live', async () => {
    const h = await harness()
    const run = await drive(h, {
      onLand: async (h, _wait, n) => {
        if (n === 0) {
          // CI has not reported yet: the first round waited 30 s.
          const landing = (await reload(h.row)).landing as SessionLanding
          expect(landing).toMatchObject({ mode: 'staging', stage: 'ci', reviewMode: 'none' })
          setGate(h, await gateShaOf(h), 'success')
        }
        return 'wake'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(run.names).toEqual([
      ...BOOT,
      'inspect#1',
      ...SHIP,
      'inspect#2',
      'land.ci#2',
      'land.wait#2',
      'inspect#3',
      'land.ci#3',
      'land.merge#3',
      'cleanup',
      'land.main-ci#3.0',
      'land.release#3.0',
      'land.staging#3.0',
      'land.health#3.0',
      'land.live#3',
    ])
    expect(h.phaseB).toEqual(['release', 'staging', 'health'])

    // One squash, on the gate SHA, titled and described from the stored ship summary.
    const row = await reload(h.row)
    const merges = h.cloud.github.merges.filter(m => m.repo === h.f.repo.repo)
    expect(merges).toHaveLength(1)
    expect(merges[0]).toMatchObject({
      method: 'squash',
      headSha: row.landing?.gateSha,
      title: 'Greet people on the home page (#1)',
    })
    expect(merges[0]?.message).toContain('Adds a bold greeting.')
    expect(merges[0]?.message).toContain(`Merged by Launch from session ${row.shortId}.`)
    expect(merges[0]?.message).not.toContain('Opened by Launch')

    expect(row.status).toBe('shipped')
    expect(row.endedAt).not.toBeNull()
    expect(row.landing).toMatchObject({
      stage: 'live',
      mergeSha: merges[0]?.sha,
      version: '1.4.1',
      stagingUrl: 'https://shop-staging.example.com',
    })
    expect(h.sandbox().destroyed).toBe(true)

    const types = (await eventsOf(h)).map(e => e.type)
    expect(types).toEqual(expect.arrayContaining(['ship.pr', 'ship.ci', 'ship.merged']))
    expect(await eventData(h, 'ship.merged')).toEqual([
      {
        number: 1,
        sha: merges[0]?.sha,
        url: expect.stringContaining('/pull/1'),
        approvalId: null,
        by: 'launch',
      },
    ])
    expect(await eventData(h, 'ship.staging')).toEqual([
      { status: 'live', version: '1.4.1', url: 'https://shop-staging.example.com' },
    ])
    // The chain: pr.merged by the landing, session.merged, session.landed.
    const [prMerged] = await auditOf(h, 'pr.merged')
    expect(prMerged?.summary).toMatchObject({
      after: { number: 1, via: 'session.merge', sessionId: row.id, mergeSha: merges[0]?.sha },
    })
    expect(await auditOf(h, 'session.merged')).toHaveLength(1)
    expect(await auditOf(h, 'session.landed')).toHaveLength(1)
  })

  it('a retried merge step merges once (the second run reads the merge first)', async () => {
    const h = await harness()
    const run = await drive(h, {
      onLand: async h => {
        setGate(h, await gateShaOf(h), 'success')
        return 'wake'
      },
      // The platform re-runs a step whose result it lost: the body runs twice.
      wrapDo: async (name, body, again) => {
        if (!name.startsWith('land.merge#')) return body()
        await again()
        return body()
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(1)
    expect(await eventData(h, 'ship.merged')).toHaveLength(1)
    expect(await auditOf(h, 'pr.merged')).toHaveLength(1)
    expect((await reload(h.row)).landing?.stage).toBe('live')
  })

  it('merged by a person in GitHub meanwhile: no API merge, recorded via sessions.checks, Phase B', async () => {
    const h = await harness()
    const run = await drive(h, {
      onLand: async h => {
        h.cloud.github.merge(h.f.repo.owner, h.f.repo.repo, 1)
        return 'wake'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(run.names).toContain('land.live#3')
    expect(run.names).not.toContain('land.merge#3')
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(0)
    const [prMerged] = await auditOf(h, 'pr.merged')
    expect(prMerged?.summary).toMatchObject({ after: { via: 'sessions.checks', number: 1 } })
    expect(await eventData(h, 'ship.merged')).toEqual([
      expect.objectContaining({ number: 1, approvalId: null, by: 'github' }),
    ])
    expect((await reload(h.row)).landing).toMatchObject({
      stage: 'live',
      mergeSha: expect.any(String),
    })
  })
})

describe('landing: the app prebuild (issue #16)', () => {
  it('a merge asks for a new prebuild of the default branch, then the session cleans up', async () => {
    const h = await harness({ SESSION_PREBUILD: 'on' })
    const prebuildRow = and(
      eq(appPrebuilds.tenantId, h.f.tenant.id),
      eq(appPrebuilds.appId, h.f.app.id)
    )
    const run = await drive(h, {
      onLand: async (h, _wait, n) => {
        if (n === 0) {
          setGate(h, await gateShaOf(h), 'success')
          // The prebuild the boot asked for was built meanwhile, an hour before this clock.
          await db
            .update(appPrebuilds)
            .set({
              buildingSessionId: null,
              buildingSince: null,
              backup: { id: 'before-the-merge', dir: '/workspace/app' },
              builtAt: new Date(h.clock.ms - HOUR),
            })
            .where(prebuildRow)
        }
        return 'wake'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    const merge = run.names.indexOf('land.merge#3')
    expect(run.names.slice(merge, merge + 3)).toEqual([
      'land.merge#3',
      'prebuild.refresh#3',
      'cleanup',
    ])
    const requested = (
      await eventData<{ status: string; reason?: string }>(h, 'workspace.prebuild')
    )
      .filter(e => e.status === 'requested')
      .map(e => e.reason)
    expect(requested).toEqual(['no prebuild yet', 'merged to the default branch'])
    // Two `prebuild` runs: the boot's, and the one that rebuilds from the merge.
    const created = stubs(h.env).sessionWorkflow?.created ?? []
    expect(created).toHaveLength(2)
    const [claim] = await db.select().from(appPrebuilds).where(prebuildRow)
    const second = created[1]?.params as { sessionId: string } | undefined
    expect(claim?.buildingSessionId).toBe(second?.sessionId)
  })
})

describe('landing: Gate decides (issue #9)', () => {
  const runsOn = (
    h: Harness,
    sha: string,
    runs: Parameters<FakeCloud['github']['setCheckRuns']>[3]
  ) => h.cloud.github.setCheckRuns(h.f.repo.owner, h.f.repo.repo, sha, runs)

  it('a green Gate beside a red optional check (evals) still merges; the panel keeps the fold', async () => {
    const h = await harness()
    const run = await drive(h, {
      onLand: async (h, _wait, n) => {
        if (n === 0) {
          runsOn(h, await gateShaOf(h), [
            { name: 'Gate', status: 'completed', conclusion: 'success' },
            { name: 'evals', status: 'completed', conclusion: 'failure' },
          ])
        }
        return 'wake'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(run.names).toContain('land.merge#3')
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(1)
    const ci = (await eventData(h, 'ship.ci')).map(d => sessionShipCiDataSchema.parse(d))
    expect(ci.at(-1)).toMatchObject({ state: 'success', passed: 1, failed: 1 })
    expect(await eventData(h, 'ship.reopened')).toEqual([])
  })

  it('a red Gate beside green optional checks reopens ci_failed, naming Gate', async () => {
    const h = await harness()
    await drive(h, {
      onLand: async h => {
        runsOn(h, await gateShaOf(h), [
          { name: 'evals', status: 'completed', conclusion: 'success' },
          { name: 'Gate', status: 'completed', conclusion: 'failure' },
        ])
        return 'wake'
      },
    })
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(0)
    expect(await eventData(h, 'ship.reopened')).toEqual([
      expect.objectContaining({ reason: 'ci_failed', message: expect.stringContaining('(Gate)') }),
    ])
  })

  it('no Gate at all (an older kit’s CI): the fold over the other checks decides — green merges', async () => {
    const h = await harness()
    const run = await drive(h, {
      onLand: async (h, _wait, n) => {
        if (n === 0) {
          runsOn(h, await gateShaOf(h), [
            { name: 'ci', status: 'completed', conclusion: 'success' },
            { name: 'lint', status: 'completed', conclusion: 'success' },
          ])
        }
        return 'wake'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(run.names).toContain('land.merge#3')
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(1)
  })

  it('no Gate at all: one still running waits; it finishing green merges', async () => {
    const h = await harness()
    const run = await drive(h, {
      onLand: async (h, _wait, n) => {
        const sha = await gateShaOf(h)
        if (n === 0) {
          runsOn(h, sha, [
            { name: 'lint', status: 'completed', conclusion: 'success' },
            { name: 'ci', status: 'in_progress' },
          ])
        }
        if (n === 1) {
          expect((await reload(h.row)).landing?.stage).toBe('ci')
          expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(0)
          runsOn(h, sha, [
            { name: 'lint', status: 'completed', conclusion: 'success' },
            { name: 'ci', status: 'completed', conclusion: 'success' },
          ])
        }
        return 'wake'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(run.names).toEqual(expect.arrayContaining(['land.ci#3', 'land.wait#3', 'land.merge#4']))
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(1)
  })

  it('no Gate at all: a red other check reopens ci_failed', async () => {
    const h = await harness()
    await drive(h, {
      onLand: async h => {
        runsOn(h, await gateShaOf(h), [
          { name: 'lint', status: 'completed', conclusion: 'success' },
          { name: 'ci', status: 'completed', conclusion: 'failure' },
        ])
        return 'wake'
      },
    })
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(0)
    expect(await eventData(h, 'ship.reopened')).toEqual([
      expect.objectContaining({ reason: 'ci_failed' }),
    ])
  })
})

describe('landing: reopen', () => {
  it('CI red: ready again (the container is the loop’s), with the failing check’s REDACTED tail', async () => {
    const h = await harness()
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const dsn = 'postgres://app:hunter2hunter2@db.internal:5432/shop'
    let after: SessionRow | null = null
    const run = await drive(h, {
      onLand: async h => {
        const [check] = setGate(h, await gateShaOf(h), 'failure')
        h.cloud.github.setJobLog(
          h.f.repo.owner,
          h.f.repo.repo,
          check?.id ?? 0,
          [
            '2026-10-01T12:00:00.000Z Run pnpm gate test',
            `2026-10-01T12:00:01.000Z token ${secret}`,
            `2026-10-01T12:00:02.000Z connecting to ${dsn}`,
            '2026-10-01T12:00:03.000Z  FAIL  tests/api/orders.test.ts > lists orders',
            '2026-10-01T12:00:04.000Z AssertionError: expected 2 to be 3',
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
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(0)
    expect(h.sandbox().destroyCount).toBe(1) // only cleanup's, at the end

    const [red] = (await eventData(h, 'ship.ci'))
      .map(d => sessionShipCiDataSchema.parse(d))
      .filter(d => d.state === 'failure')
    expect(red?.failedCheck).toMatchObject({ name: 'Gate', url: expect.any(String) })
    expect(red?.failedCheck?.logTail).toContain('AssertionError: expected 2 to be 3')
    expect(red?.failedCheck?.logTail).not.toContain('2026-10-01T12')
    const everything = JSON.stringify(await eventsOf(h))
    expect(everything).not.toContain(secret)
    expect(everything).not.toContain('hunter2hunter2')
    expect(await eventData(h, 'ship.reopened')).toEqual([
      { reason: 'ci_failed', message: expect.stringContaining('CI failed on GitHub (Gate)') },
    ])
    expect(await auditOf(h, 'session.ship_reopened')).toHaveLength(1)

    // "Fix it" works in a normal turn: the system note carries the failure, until a re-ship.
    const note = await sessionSystemNote(db, await reload(h.row))
    expect(note).toContain('The last ship\'s CI failed on GitHub: the check "Gate"')
    expect(note).toContain('AssertionError: expected 2 to be 3')
    expect(note).not.toContain(secret)
  })

  it('CI red after the container was released: suspended, and the next message resumes', async () => {
    const h = await harness()
    let after: SessionRow | null = null
    const run = await drive(h, {
      onLand: async (h, _wait, n) => {
        const sha = await gateShaOf(h)
        if (n === 0) {
          // Still running past the idle policy (30 min): the next round releases the container.
          setGate(h, sha, 'in_progress')
          h.clock.ms += 31 * MINUTE
        } else {
          expect((await reload(h.row)).landing).toMatchObject({ containerReleased: true })
          setGate(h, sha, 'failure')
        }
        return 'wake'
      },
      onIdle: row => {
        after = row
      },
    })
    expect(run.names).toEqual(
      expect.arrayContaining(['land.ci#3', 'land.wait#3', 'land.ci#4', 'land.reopen#4'])
    )
    expect(after).toMatchObject({ status: 'suspended', landing: null, containerKeptAt: null })
    expect(h.sandbox().destroyCount).toBeGreaterThanOrEqual(2)
  })

  it('the head moved after the gate: head_moved, nothing merged', async () => {
    const h = await harness()
    await drive(h, {
      onLand: async h => {
        const sha = await gateShaOf(h)
        setGate(h, sha, 'success')
        // Someone pushed to the session's branch: the PR's head is not the gate SHA any more.
        h.cloud.github.pushCommit(
          h.f.repo.owner,
          h.f.repo.repo,
          { 'README.md': 'pushed by hand\n' },
          'by hand',
          sessionBranchName(h.row.shortId)
        )
        return 'wake'
      },
    })
    expect(await eventData(h, 'ship.reopened')).toEqual([
      { reason: 'head_moved', message: expect.stringContaining('moved on') },
    ])
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(0)
  })

  it('the PR was closed unmerged: pr_closed', async () => {
    const h = await harness()
    await drive(h, {
      onLand: async h => {
        h.cloud.github.closePull(h.f.repo.owner, h.f.repo.repo, 1)
        return 'wake'
      },
    })
    expect((await eventData(h, 'ship.reopened'))[0]).toMatchObject({ reason: 'pr_closed' })
  })

  it('no check ever reports: refused after the grace, never green', async () => {
    const h = await harness()
    const run = await drive(h, {
      onLand: async h => {
        h.clock.ms += 11 * MINUTE
        return 'timeout'
      },
    })
    expect((await eventData(h, 'ship.reopened'))[0]).toMatchObject({ reason: 'ci_none' })
    // Issue #9: Launch's own `launch/gate` was on the head all along — and is not CI.
    expect(h.cloud.github.createdCheckRuns.map(r => r.name)).toEqual(['launch/gate'])
    expect(run.names).not.toContain('land.merge#3')
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(0)
  })

  it('CI still pending after two hours: ci_timeout', async () => {
    const h = await harness()
    await drive(h, {
      onLand: async h => {
        setGate(h, await gateShaOf(h), 'in_progress')
        h.clock.ms += 121 * MINUTE
        return 'timeout'
      },
    })
    expect((await eventData(h, 'ship.reopened'))[0]).toMatchObject({ reason: 'ci_timeout' })
  })
})

describe('landing: review', () => {
  /** Another member who owns the app — an eligible approver. */
  async function colleague(h: Harness) {
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, h.f.tenant.id, 'member')
    await db
      .insert(appOwners)
      .values({ tenantId: h.f.tenant.id, appId: h.f.app.id, userId: user.id })
    return user
  }

  it('approve → merge: the context comes from ship_summary; the squash names the approver', async () => {
    review.policy = ownersReview()
    const h = await harness()
    const bob = await colleague(h)
    const run = await drive(h, {
      onLand: async (h, _wait, n) => {
        if (n === 0) {
          setGate(h, await gateShaOf(h), 'success')
          return 'wake'
        }
        const row = await reload(h.row)
        expect(row.landing).toMatchObject({ stage: 'approval', approvalId: expect.any(String) })
        const [request] = await db
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.id, row.landing?.approvalId ?? ''))
        expect(request).toMatchObject({
          kind: 'session.merge',
          status: 'pending',
          requestedByUserId: h.f.user.id,
          subjectId: row.id,
        })
        expect(request?.context).toMatchObject({
          kind: 'session.merge',
          sessionId: row.id,
          prNumber: 1,
          prTitle: 'Greet people on the home page',
          summary: 'Adds a bold greeting.',
          diffStat: expect.stringContaining('src/ui/pages/Home.tsx'),
          headSha: row.landing?.gateSha,
          sessionPath: `/apps/${h.f.app.slug}/sessions/${row.id}`,
        })
        expect(request?.excludedUserIds).toContain(h.f.user.id)
        await decideAs(
          testApprovalDeps(db, h.env),
          h.f.tenant.id,
          bob.id,
          request?.id ?? '',
          'approve'
        )
        expect((await reload(h.row)).landing?.stage).toBe('merging')
        return 'wake'
      },
    })
    expect(run.names).toEqual(
      expect.arrayContaining(['land.ci#3', 'land.review#3', 'land.wait#3', 'land.merge#4'])
    )
    const merge = h.cloud.github.merges.find(m => m.repo === h.f.repo.repo)
    expect(merge?.message).toMatch(/Merged by Launch from session \w+, approved by /)
    expect((await eventData(h, 'ship.review')).map(d => d.status)).toEqual([
      'requested',
      'approved',
    ])
    expect((await reload(h.row)).landing?.stage).toBe('live')
    const [merged] = await auditOf(h, 'session.merged')
    expect(merged?.approvalId).toBe((await reload(h.row)).landing?.approvalId)
  })

  it('reject → reopened, the reviewer’s comment as the note', async () => {
    review.policy = ownersReview()
    const h = await harness()
    const bob = await colleague(h)
    let after: SessionRow | null = null
    await drive(h, {
      onLand: async (h, _wait, n) => {
        if (n === 0) {
          setGate(h, await gateShaOf(h), 'success')
          return 'wake'
        }
        const id = (await reload(h.row)).landing?.approvalId ?? ''
        await decide(testApprovalDeps(db, h.env), {
          requestId: id,
          viewer: await viewerFor(db, h.f.tenant.id, bob.id),
          decision: 'reject',
          comment: 'The greeting is too loud',
          actor: { ...SYSTEM_ACTOR, actorType: 'user', actorUserId: bob.id, actorEmail: bob.email },
        })
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
        message: expect.stringContaining('rejected the merge: The greeting is too loud'),
      },
    ])
    expect((await eventData(h, 'ship.review')).map(d => d.status)).toEqual([
      'requested',
      'rejected',
    ])
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(0)
  })

  it('expiry → reopened review_expired', async () => {
    review.policy = ownersReview()
    const h = await harness()
    await drive(h, {
      onLand: async (h, _wait, n) => {
        if (n === 0) {
          setGate(h, await gateShaOf(h), 'success')
          return 'wake'
        }
        const id = (await reload(h.row)).landing?.approvalId ?? ''
        await expireNow(testApprovalDeps(db, h.env), h.f.tenant.id, id)
        return 'wake'
      },
    })
    expect((await eventData(h, 'ship.reopened'))[0]).toMatchObject({ reason: 'review_expired' })
  })
})

describe('landing: End and a lost instance', () => {
  it('End during ci abandons the landing (202); End while merging is a 409 session_merging', async () => {
    const h = await harness()
    const seen: { response?: Response } = {}
    const run = await drive(h, {
      onLand: async h => {
        seen.response = await request(
          `/api/sessions/${h.row.id}/end`,
          { method: 'POST', headers: { ...h.f.cookie, 'X-Requested-With': 'fetch' } },
          { env: h.env }
        )
        return 'wake'
      },
    })
    expect(seen.response?.status).toBe(202)
    expect(run.outcome.status).toBe('ended')
    expect(run.names).toContain('end#3')
    expect((await reload(h.row)).landing).toBeNull()
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(0)

    // A landing in `merging` refuses an End: a merge is never stopped half-way.
    const merging = await insertSession(db, h.f, {
      status: 'shipping',
      prNumber: 9,
      landing: {
        mode: 'staging',
        stage: 'merging',
        prNumber: 9,
        gateSha: 'f'.repeat(40),
        gateTree: null,
        mainCi: null,
        startedAt: new Date().toISOString(),
        stageAt: new Date().toISOString(),
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
    const refused = await request(
      `/api/sessions/${merging.id}/end`,
      { method: 'POST', headers: { ...h.f.cookie, 'X-Requested-With': 'fetch' } },
      { env: h.env }
    )
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ statusCode: 409, code: 'session_merging' })
    expect((await reload(merging)).requestedAction).toBeNull()
  })

  it('a lost instance in ci: the cron restarts it, and the fresh one resumes the landing — no salvage', async () => {
    const h = await harness()
    // Run until the landing has waited on CI once, then lose the instance: its next step never
    // runs (and the run never settles — the platform simply lost it).
    let lose: () => void = () => {}
    const reached = new Promise<void>(resolve => {
      lose = resolve
    })
    void drive(h, {
      wrapDo: (name, body) => {
        if (name !== 'inspect#3') return body()
        lose()
        return new Promise(() => {})
      },
    })
    await reached
    const waiting = await reload(h.row)
    expect(waiting).toMatchObject({ status: 'shipping', landing: { stage: 'ci' } })

    // Quiet for three rounds by the clock the cron reads.
    const old = new Date(Date.now() - 30 * MINUTE)
    await patch(h.row, {
      lastActivityAt: old,
      landing: { ...(waiting.landing as SessionLanding), stageAt: old.toISOString() },
    })
    const workflow = stubs(h.env).sessionWorkflow
    const logger = { info: () => {}, warn: () => {}, error: () => {} } as never
    expect(
      await nudgeLandingSessions(db, h.env, logger, new Date(), { tenantIds: [h.f.tenant.id] })
    ).toBe(1)
    expect(workflow?.created.map(c => c.id)).toEqual([`${h.row.id}-r1`])
    expect((await reload(h.row)).instanceId).toBe(`${h.row.id}-r1`)
    // A fresh landing is not nudged.
    await patch(h.row, { lastActivityAt: new Date() })
    expect(
      await nudgeLandingSessions(db, h.env, logger, new Date(), { tenantIds: [h.f.tenant.id] })
    ).toBe(0)

    // The fresh instance: claim → the loop (never salvage), CI green → merged → live.
    setGate(h, waiting.landing?.gateSha ?? '', 'success')
    const run = await drive(h, { fresh: true })
    expect(run.names.slice(0, 4)).toEqual(['claim', 'inspect#0', 'land.ci#0', 'land.merge#0'])
    expect(run.names).not.toContain('salvage')
    expect(run.names.slice(-6)).toEqual([
      'cleanup',
      'land.main-ci#0.0',
      'land.release#0.0',
      'land.staging#0.0',
      'land.health#0.0',
      'land.live#0',
    ])
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(1)
  })

  it('Phase B under a fresh instance (merged, cleanup not run): cleanup first, then the follow', async () => {
    const h = await harness()
    await drive(h, {
      onLand: async h => {
        setGate(h, await gateShaOf(h), 'success')
        return 'wake'
      },
      // The instance is lost right after the merge: `cleanup` never runs.
      wrapDo: async (name, body) => {
        if (name === 'cleanup') throw new Error('lost after the merge')
        return body()
      },
    }).catch(() => {})
    const merged = await reload(h.row)
    expect(merged).toMatchObject({
      status: 'shipped',
      endedAt: null,
      landing: { stage: 'releasing' },
    })
    h.phaseB.length = 0
    const run = await drive(h, { fresh: true })
    expect(run.names).toEqual([
      'claim',
      'cleanup',
      'land.main-ci#0.0',
      'land.release#0.0',
      'land.staging#0.0',
      'land.health#0.0',
      'land.live#0',
    ])
    expect((await reload(h.row)).landing?.stage).toBe('live')
  })
})

describe('Phase B: a stall never reopens', () => {
  it('the deploy fails: stalled with the reason and a link to the app page; still shipped', async () => {
    const h = await harness()
    h.hooks.landStaging = async () => ({
      status: 'stalled',
      reason: 'deploy_failed',
      error: 'The staging deploy failed',
    })
    const run = await drive(h, {
      onLand: async h => {
        setGate(h, await gateShaOf(h), 'success')
        return 'wake'
      },
    })
    expect(run.names.slice(-3)).toEqual(['land.release#3.0', 'land.staging#3.0', 'land.stalled#3'])
    const row = await reload(h.row)
    expect(row.status).toBe('shipped')
    expect(row.landing).toMatchObject({
      stage: 'stalled',
      stalledReason: 'deploy_failed',
      error: expect.stringContaining(`/apps/${h.f.app.slug}`),
    })
    expect((await eventData(h, 'ship.staging'))[0]).toMatchObject({
      status: 'failed',
      version: '1.4.1',
    })
    expect(await eventData(h, 'ship.reopened')).toEqual([])
    expect(await auditOf(h, 'session.land_stalled')).toHaveLength(1)
  })

  it('a hook that waits sleeps a distinct round each time', async () => {
    const h = await harness()
    let probes = 0
    h.hooks.landHealth = async () =>
      ++probes < 3
        ? { status: 'wait', waitSeconds: 30 }
        : { status: 'live', url: null, version: '1.4.1' }
    const run = await drive(h, {
      onLand: async h => {
        setGate(h, await gateShaOf(h), 'success')
        return 'wake'
      },
    })
    expect(run.names.slice(-6)).toEqual([
      'land.health#3.0',
      'land.health-wait#3.0',
      'land.health#3.1',
      'land.health-wait#3.1',
      'land.health#3.2',
      'land.live#3',
    ])
  })
})

describe('Phase B: the merge commit’s Gate before the release (issue #11)', () => {
  const greenPr = async (h: Harness) => {
    setGate(h, await gateShaOf(h), 'success')
    return 'wake' as const
  }
  /** The squash commit on the default branch (`landing.mergeSha`). */
  const mergeShaOf = async (h: Harness) => (await reload(h.row)).landing?.mergeSha ?? ''
  const mainGate = async (h: Harness, state: 'in_progress' | 'success' | 'failure') =>
    setGate(h, await mergeShaOf(h), state)

  it('pending, then green: waits a round, then cuts the release', async () => {
    const h = await harness()
    h.cloud.github.mergeCommitChecks = [{ name: 'Gate', status: 'in_progress', conclusion: null }]
    let releasedWhileRunning: boolean | null = null
    const cut = h.hooks.landRelease
    h.hooks.landRelease = async ctx => {
      // The release is cut only once the squash commit's Gate is done.
      const runs = h.cloud.github.checkRuns
      const sha = await mergeShaOf(h)
      releasedWhileRunning = [...runs.entries()].some(
        ([key, list]) => key.endsWith(`@${sha}`) && list.some(r => r.status !== 'completed')
      )
      return cut(ctx)
    }
    const run = await drive(h, {
      onLand: async h => greenPr(h),
      onSleep: async (h, name) => {
        if (name === 'land.main-ci-wake#3.0') await mainGate(h, 'success')
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(run.names.slice(run.names.indexOf('cleanup'))).toEqual([
      'cleanup',
      'land.main-ci#3.0',
      'land.main-ci-wake#3.0',
      'land.main-ci#3.1',
      'land.release#3.0',
      'land.staging#3.0',
      'land.health#3.0',
      'land.live#3',
    ])
    expect(releasedWhileRunning).toBe(false)
    expect(h.phaseB).toEqual(['release', 'staging', 'health'])
    const row = await reload(h.row)
    expect(row.landing).toMatchObject({
      stage: 'live',
      mainCi: { verdict: 'success', sha: row.landing?.mergeSha },
    })
  })

  it('red: no release — stalled main_ci_failed, still shipped, never reopened', async () => {
    const h = await harness()
    h.cloud.github.mergeCommitChecks = [
      { name: 'Gate', status: 'completed', conclusion: 'failure' },
    ]
    const run = await drive(h, { onLand: async h => greenPr(h) })
    expect(run.names.slice(run.names.indexOf('cleanup'))).toEqual([
      'cleanup',
      'land.main-ci#3.0',
      'land.stalled#3',
    ])
    expect(h.phaseB).toEqual([])
    const row = await reload(h.row)
    expect(row.status).toBe('shipped')
    expect(row.landing).toMatchObject({
      stage: 'stalled',
      stalledReason: 'main_ci_failed',
      mainCi: null,
      releaseId: null,
      error: expect.stringContaining('CI failed on the default branch'),
    })
    expect(row.landing?.error).toContain(`/apps/${h.f.app.slug}`)
    // Nothing was released: no staging row, no reopen.
    expect(await eventData(h, 'ship.staging')).toEqual([])
    expect(await eventData(h, 'ship.reopened')).toEqual([])
    expect(await auditOf(h, 'session.land_stalled')).toHaveLength(1)
  })

  it('still running past the bound: releases anyway (the deploy re-gates)', async () => {
    const h = await harness()
    h.cloud.github.mergeCommitChecks = [{ name: 'Gate', status: 'in_progress', conclusion: null }]
    const run = await drive(h, {
      onLand: async h => greenPr(h),
      onSleep: (h, name) => {
        if (name.startsWith('land.main-ci-wake#')) h.clock.ms += 31 * MINUTE
      },
    })
    expect(run.names.slice(run.names.indexOf('cleanup'), -3)).toEqual([
      'cleanup',
      'land.main-ci#3.0',
      'land.main-ci-wake#3.0',
      'land.main-ci#3.1',
      'land.release#3.0',
    ])
    expect(h.phaseB).toEqual(['release', 'staging', 'health'])
    expect((await reload(h.row)).landing).toMatchObject({
      stage: 'live',
      mainCi: { verdict: 'timeout' },
    })
  })

  it('no check at all on the merge commit: releases after the grace (CI that never runs on main)', async () => {
    const h = await harness()
    h.cloud.github.mergeCommitChecks = null
    const run = await drive(h, {
      onLand: async h => greenPr(h),
      onSleep: (h, name) => {
        if (name.startsWith('land.main-ci-wake#')) h.clock.ms += 2 * MINUTE
      },
    })
    // 2 minutes in, still inside the 3-minute grace: one more round; at 4, the release.
    expect(run.names.slice(run.names.indexOf('cleanup'), -3)).toEqual([
      'cleanup',
      'land.main-ci#3.0',
      'land.main-ci-wake#3.0',
      'land.main-ci#3.1',
      'land.main-ci-wake#3.1',
      'land.main-ci#3.2',
      'land.release#3.0',
    ])
    expect((await reload(h.row)).landing).toMatchObject({
      stage: 'live',
      mainCi: { verdict: 'none' },
    })
  })

  it('a red optional check beside a green Gate on main still releases', async () => {
    const h = await harness()
    h.cloud.github.mergeCommitChecks = [
      { name: 'Gate', status: 'completed', conclusion: 'success' },
      { name: 'evals', status: 'completed', conclusion: 'failure' },
    ]
    await drive(h, { onLand: async h => greenPr(h) })
    expect((await reload(h.row)).landing).toMatchObject({
      stage: 'live',
      mainCi: { verdict: 'success' },
    })
  })
})

describe('Phase B: retrying a stall from the session (issue #21)', () => {
  const greenPr = async (h: Harness) => {
    setGate(h, await gateShaOf(h), 'success')
    return 'wake' as const
  }
  const mergeShaOf = async (h: Harness) => (await reload(h.row)).landing?.mergeSha ?? ''
  const workflowOf = (h: Harness) => stubs(h.env).sessionWorkflow as RecordingWorkflow
  const NO_RUNNER = 'The job was not acquired by Runner of type hosted even after multiple attempts'
  const retryRoute = (h: Harness, body: unknown) =>
    request(
      `/api/sessions/${h.row.id}/landing/retry`,
      {
        method: 'POST',
        headers: { ...h.f.cookie, 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      { env: h.env }
    )

  /** A landing stalled `main_ci_failed`, with the merge commit's CI run on record as failed. */
  async function stalledOnMainCi(h: Harness, annotations?: string) {
    h.cloud.github.mergeCommitChecks = [
      {
        name: 'Gate',
        status: 'completed',
        conclusion: 'failure',
        ...(annotations
          ? {
              annotations: [
                {
                  path: '.github',
                  start_line: 1,
                  annotation_level: 'failure' as const,
                  message: annotations,
                },
              ],
            }
          : {}),
      },
    ]
    await drive(h, { onLand: async h => greenPr(h) })
    const sha = await mergeShaOf(h)
    const run = h.cloud.github.pushRun(h.f.repo.owner, h.f.repo.repo, 'refs/heads/main', {
      workflow: 'ci.yml',
      status: 'completed',
      conclusion: 'failure',
      jobs: [{ id: 501, name: 'Gate', status: 'completed', conclusion: 'failure' }],
    })
    run.head_sha = sha
    return { sha, run }
  }

  it('a job no runner picked up says so, and points at Retry', async () => {
    const h = await harness()
    await stalledOnMainCi(h, NO_RUNNER)
    const row = await reload(h.row)
    expect(row.landing).toMatchObject({ stage: 'stalled', stalledReason: 'main_ci_failed' })
    expect(row.landing?.error).toContain('GitHub did not run the default branch')
    expect(row.landing?.error).toContain('Retry from the session')
    expect(row.landing?.error).not.toContain('CI failed on the default branch')
  })

  it('retry: re-runs the merge commit’s failed CI, waits for it again, then releases — a second press retries nothing', async () => {
    const h = await harness()
    const { sha, run } = await stalledOnMainCi(h, NO_RUNNER)
    // The route's repo host is the deployment's (no GitHub App in this suite's store): the service
    // it calls, with the suite's port onto the fake GitHub.
    const logger = { warn: () => {} }
    const first = await retryLanding({
      db,
      workflow: workflowOf(h) as unknown as Workflow,
      repoHost: h.ports.repoHost(db),
      row: await reload(h.row),
      action: 'retry',
      actor: SYSTEM_ACTOR,
      logger,
    })
    expect(first.retried).toBe(true)
    expect(h.cloud.github.reruns.filter(r => r.runId === run.id)).toHaveLength(1)
    expect(first.row.landing).toMatchObject({
      stage: 'releasing',
      stalledReason: null,
      error: null,
      mainCi: null,
      mergeSha: sha,
    })
    expect(workflowOf(h).created.map(c => c.id)).toContain(`${h.row.id}-r1`)
    const [audit] = await auditOf(h, 'session.land_retried')
    expect(audit?.summary).toMatchObject({
      before: { stalledReason: 'main_ci_failed' },
      after: { action: 'retry', rerunRuns: [run.id] },
    })

    // A second press: the landing is already moving — nothing re-run, nothing restarted.
    const again = await retryLanding({
      db,
      workflow: workflowOf(h) as unknown as Workflow,
      repoHost: h.ports.repoHost(db),
      row: await reload(h.row),
      action: 'retry',
      actor: SYSTEM_ACTOR,
      logger,
    })
    expect(again.retried).toBe(false)
    expect(h.cloud.github.reruns.filter(r => r.runId === run.id)).toHaveLength(1)

    // The fresh instance: `land.main-ci` waits on the re-run, which goes green → release → live.
    setGate(h, sha, 'in_progress')
    const fresh = await drive(h, {
      fresh: true,
      onSleep: async (h, name) => {
        if (name === 'land.main-ci-wake#0.0') setGate(h, sha, 'success')
      },
    })
    expect(fresh.names).toEqual([
      'claim',
      'land.main-ci#0.0',
      'land.main-ci-wake#0.0',
      'land.main-ci#0.1',
      'land.release#0.0',
      'land.staging#0.0',
      'land.health#0.0',
      'land.live#0',
    ])
    expect((await reload(h.row)).landing).toMatchObject({
      stage: 'live',
      mainCi: { verdict: 'success', sha },
    })
  })

  it('retry with nothing left to re-run (re-run by hand, now green): goes round and releases', async () => {
    const h = await harness()
    h.cloud.github.mergeCommitChecks = [
      { name: 'Gate', status: 'completed', conclusion: 'failure' },
    ]
    await drive(h, { onLand: async h => greenPr(h) })
    const sha = (await reload(h.row)).landing?.mergeSha as string
    setGate(h, sha, 'success')
    const res = await retryLanding({
      db,
      workflow: workflowOf(h) as unknown as Workflow,
      repoHost: h.ports.repoHost(db),
      row: await reload(h.row),
      action: 'retry',
      actor: SYSTEM_ACTOR,
      logger: { warn: () => {} },
    })
    expect(res.retried).toBe(true)
    expect(h.cloud.github.reruns).toHaveLength(0)
    expect(res.row.landing).toMatchObject({ stage: 'releasing', stalledReason: null, mainCi: null })
    await drive(h, { fresh: true })
    expect((await reload(h.row)).landing).toMatchObject({
      stage: 'live',
      mainCi: { verdict: 'success', sha },
    })
  })

  it('Release anyway (the route): cuts the release past the red Gate, recorded as `override`', async () => {
    const h = await harness()
    await stalledOnMainCi(h)
    const res = await retryRoute(h, { action: 'release_anyway' })
    expect(res.status).toBe(202)
    const body = await json<{ session: { landing: SessionLanding } }>(res)
    expect(body.session.landing).toMatchObject({
      stage: 'releasing',
      mainCi: { verdict: 'override' },
    })
    // Nothing was re-run on GitHub.
    expect(h.cloud.github.reruns).toEqual([])
    const fresh = await drive(h, { fresh: true })
    expect(fresh.names.slice(0, 3)).toEqual(['claim', 'land.main-ci#0.0', 'land.release#0.0'])
    expect((await reload(h.row)).landing).toMatchObject({
      stage: 'live',
      mainCi: { verdict: 'override' },
    })
  })

  it('refuses a landing that is not a retryable stall (409), and Release anyway on a failed release', async () => {
    const h = await harness()
    await drive(h, { onLand: async h => greenPr(h) })
    expect((await reload(h.row)).landing?.stage).toBe('live')
    const live = await retryRoute(h, {})
    expect(live.status).toBe(409)
    expect(await json(live)).toMatchObject({ code: 'landing_not_retryable' })
    await patch(h.row, {
      landing: {
        ...((await reload(h.row)).landing as SessionLanding),
        stage: 'stalled',
        stalledReason: 'release_failed',
      },
    })
    const anyway = await retryRoute(h, { action: 'release_anyway' })
    expect(anyway.status).toBe(409)
    expect(await json(anyway)).toMatchObject({ code: 'landing_not_retryable' })
    const bad = await retryRoute(h, { action: 'deploy' })
    expect(bad.status).toBe(400)
  })

  it('release_failed: retry goes back to `land.release`', async () => {
    const h = await harness()
    await drive(h, { onLand: async h => greenPr(h) })
    await patch(h.row, {
      landing: {
        ...((await reload(h.row)).landing as SessionLanding),
        stage: 'stalled',
        stalledReason: 'release_failed',
        releaseId: null,
        version: null,
        tag: null,
      },
    })
    const res = await retryRoute(h, {})
    expect(res.status).toBe(202)
    const row = await reload(h.row)
    expect(row.landing).toMatchObject({ stage: 'releasing', stalledReason: null })
    // `mainCi` stays: the merge commit's CI was already decided.
    expect(row.landing?.mainCi).toMatchObject({ verdict: 'success' })
    h.phaseB.length = 0
    const fresh = await drive(h, { fresh: true })
    expect(fresh.names.slice(0, 3)).toEqual(['claim', 'land.main-ci#0.0', 'land.release#0.0'])
    expect(h.phaseB).toEqual(['release', 'staging', 'health'])
  })
})

describe('reconcile: a ship or landing whose Workflow died (a `wrangler dev` reload)', () => {
  const workflowOf = (h: Harness) => stubs(h.env).sessionWorkflow as RecordingWorkflow
  const msAgo = (ms: number) => new Date(Date.now() - ms)

  /**
   * Run until the step named `at` is about to start, then lose the instance there: that step never
   * runs and the run never settles — as a reload leaves it — while the local engine still says
   * `running`. `before` runs first (GitHub moving on under the dying step).
   */
  async function dieAt(h: Harness, at: string, before?: () => Promise<void>): Promise<SessionRow> {
    let lose: () => void = () => {}
    const reached = new Promise<void>(resolve => {
      lose = resolve
    })
    void drive(h, {
      onLand: async (h, _wait, n) => {
        if (n === 0) setGate(h, await gateShaOf(h), 'success')
        return 'wake'
      },
      wrapDo: async (name, body) => {
        if (name !== at) return body()
        await before?.()
        lose()
        return new Promise(() => {})
      },
    })
    await reached
    workflowOf(h).setStatus(h.row.id, { status: 'running' })
    return reload(h.row)
  }

  /** The row, quiet for `ms` by the clock the reconcile reads. */
  async function quietFor(h: Harness, ms: number): Promise<SessionRow> {
    await patch(h.row, { lastActivityAt: msAgo(ms) })
    return reload(h.row)
  }

  it('shipping in ci, quiet past its window under a "running" instance: terminated and restarted; the fresh one merges once CI is green', async () => {
    const h = await harness()
    const stuck = await dieAt(h, 'inspect#3')
    expect(stuck).toMatchObject({ status: 'shipping', landing: { stage: 'ci' } })
    const row = await quietFor(h, SESSION_LANDING_STALL_MS.ci + MINUTE)

    const result = await reconcileSession(db, h.env, row)
    expect(result).toEqual({
      outcome: 'settled',
      status: 'shipping',
      instanceStatus: 'running',
      restartedAs: `${row.id}-r1`,
    })
    const wf = workflowOf(h)
    expect(wf.terminated).toEqual([row.id])
    expect(wf.created.map(c => c.id)).toEqual([`${row.id}-r1`])
    // Nothing settled: the status and the landing are where they were.
    const after = await reload(row)
    expect(after).toMatchObject({ status: 'shipping', instanceId: `${row.id}-r1`, error: null })
    expect(after.landing).toEqual(stuck.landing)
    const [audit] = await auditOf(h, 'session.reconciled')
    expect(audit?.summary).toMatchObject({
      after: { status: 'shipping', phase: 'landing', stage: 'ci', instanceStatus: 'running' },
    })

    // The fresh instance: claim → the loop (no salvage), CI green → ONE merge → Phase B → live.
    const run = await drive(h, { fresh: true })
    expect(run.names.slice(0, 4)).toEqual(['claim', 'inspect#0', 'land.ci#0', 'land.merge#0'])
    expect(run.names).not.toContain('salvage')
    expect(run.names.at(-1)).toBe('land.live#0')
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(1)
    expect(await reload(row)).toMatchObject({ status: 'shipped', landing: { stage: 'live' } })
  })

  it('inside the window — a healthy landing between rounds — is left alone', async () => {
    const h = await harness()
    await dieAt(h, 'inspect#3')
    const row = await quietFor(h, SESSION_LANDING_STALL_MS.ci - MINUTE)
    expect(await reconcileSession(db, h.env, row)).toEqual({ outcome: 'skipped' })
    // The window is the longest healthy gap (a 2-minute CI round, or the retry wait) and then some.
    expect(SESSION_LANDING_STALL_MS.ci).toBeGreaterThan(
      (LAND_CI_SLOW_SECONDS + LAND_RETRY_SECONDS) * 1000
    )
    // An `approval` landing waits 30-minute rounds: quiet for 20 minutes is healthy.
    await patch(h.row, { landing: { ...(row.landing as SessionLanding), stage: 'approval' } })
    expect(await reconcileSession(db, h.env, await quietFor(h, 20 * MINUTE))).toEqual({
      outcome: 'skipped',
    })
    expect(workflowOf(h).statusCalls).toEqual([])
  })

  it('a queued (fresh) instance is left alone', async () => {
    const h = await harness()
    await dieAt(h, 'inspect#3')
    workflowOf(h).setStatus(h.row.id, { status: 'queued' })
    const row = await quietFor(h, 10 * MINUTE)
    expect(await reconcileSession(db, h.env, row)).toEqual({
      outcome: 'alive',
      instanceStatus: 'queued',
    })
    expect(workflowOf(h).terminated).toEqual([])
    expect(workflowOf(h).created).toEqual([])
  })

  it('the cron sweep selects it, and not a landing inside its window', async () => {
    const h = await harness()
    await dieAt(h, 'inspect#3')
    await quietFor(h, 10 * MINUTE)
    const fresh = await insertSession(db, h.f, {
      status: 'shipping',
      landing: { ...((await reload(h.row)).landing as SessionLanding), prNumber: 2 },
      lastActivityAt: msAgo(MINUTE),
    })
    const settled = await reconcileStaleSessions(db, h.env, { tenantIds: [h.f.tenant.id] })
    expect(settled).toBe(1)
    expect(workflowOf(h).created.map(c => c.id)).toEqual([`${h.row.id}-r1`])
    expect((await reload(fresh)).instanceId).toBe(fresh.instanceId)
  })

  it('GET /api/sessions/:id and GET /:id/pr unstick it: viewing the session is enough', async () => {
    const h = await harness()
    await dieAt(h, 'inspect#3')
    await quietFor(h, 10 * MINUTE)
    const res = await request(`/api/sessions/${h.row.id}`, { headers: h.f.cookie }, { env: h.env })
    expect(res.status).toBe(200)
    expect(workflowOf(h).terminated).toEqual([h.row.id])
    expect((await reload(h.row)).instanceId).toBe(`${h.row.id}-r1`)

    // The fresh instance died too: the ship panel's PR poll reaches it.
    workflowOf(h).setStatus(`${h.row.id}-r1`, { status: 'errored' })
    await quietFor(h, 10 * MINUTE)
    const pr = await request(
      `/api/sessions/${h.row.id}/pr`,
      { headers: h.f.cookie },
      { env: h.env }
    )
    expect(pr.status).toBe(200)
    expect((await reload(h.row)).instanceId).toBe(`${h.row.id}-r2`)
  })

  it('End asked of a dead landing: judged from the request (75 s), and the fresh instance ends it', async () => {
    const h = await harness()
    await dieAt(h, 'inspect#3')
    await quietFor(h, 10 * MINUTE)
    // A reload just now: the End's wake reaches nothing; its immediate reconcile must not kill
    // the instance it woke, so it is judged from the request.
    workflowOf(h).setStatus(h.row.id, { status: 'running' })
    await patch(h.row, { lastActivityAt: new Date() })
    const res = await request(
      `/api/sessions/${h.row.id}/end`,
      { method: 'POST', headers: { ...h.f.cookie, 'X-Requested-With': 'fetch' } },
      { env: h.env }
    )
    expect(res.status).toBe(202)
    expect(workflowOf(h).terminated).toEqual([])
    // 90 s later nobody has acted on it.
    await patch(h.row, { cancelRequestedAt: msAgo(90_000), lastActivityAt: msAgo(90_000) })
    const result = await reconcileSession(db, h.env, await reload(h.row))
    expect(result).toMatchObject({ outcome: 'settled', status: 'shipping' })
    expect(workflowOf(h).terminated).toEqual([h.row.id])
    const run = await drive(h, { fresh: true })
    expect(run.names.slice(0, 3)).toEqual(['claim', 'inspect#0', 'end#0'])
    expect(await reload(h.row)).toMatchObject({ status: 'ended', landing: null })
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(0)
  })

  it('merging, the squash taken by GitHub before the instance died: the re-run records it — no second merge', async () => {
    const h = await harness()
    const stuck = await dieAt(h, 'land.merge#3', async () => {
      // The dying step's squash reached GitHub; its compare-and-set never ran.
      const row = await reload(h.row)
      const host = h.ports.repoHost(db)
      const merged = await host.mergePullRequest(await sessionRepo(db, row), {
        prNumber: 1,
        sha: row.landing?.gateSha ?? '',
        commitTitle: 'Greet people on the home page (#1)',
        commitMessage: 'Adds a bold greeting.',
      })
      expect(merged.merged).toBe(true)
    })
    expect(stuck).toMatchObject({ status: 'shipping', landing: { stage: 'merging' } })
    const row = await quietFor(h, SESSION_LANDING_STALL_MS.merging + MINUTE)
    expect(await reconcileSession(db, h.env, row)).toMatchObject({ outcome: 'settled' })

    const run = await drive(h, { fresh: true })
    expect(run.names.slice(0, 3)).toEqual(['claim', 'inspect#0', 'land.merge#0'])
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(1)
    expect(await eventData(h, 'ship.merged')).toHaveLength(1)
    expect(await auditOf(h, 'pr.merged')).toHaveLength(1)
    expect(await reload(row)).toMatchObject({ status: 'shipped', landing: { stage: 'live' } })
  })

  it('a squash refused because it had just landed (read open, then "not mergeable"): recorded, not reopened', async () => {
    const h = await harness()
    // The round reads the PR open; by the time its squash arrives an earlier one (a dead
    // instance's) has landed, so GitHub refuses it as "not mergeable".
    const real = h.ports.repoHost
    h.ports.repoHost = d => {
      const host = real(d)
      // A class instance: keep its prototype, replace one method.
      const wrapped: RepoHostPort = Object.create(host)
      wrapped.mergePullRequest = async (repo, input) => {
        h.cloud.github.merge(h.f.repo.owner, h.f.repo.repo, input.prNumber)
        const answer = await host.mergePullRequest(repo, input)
        expect(answer.merged).toBe(false)
        return answer
      }
      return wrapped
    }
    const run = await drive(h, {
      onLand: async h => {
        setGate(h, await gateShaOf(h), 'success')
        return 'wake'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(await eventData(h, 'ship.reopened')).toEqual([])
    expect(await auditOf(h, 'session.merge_refused')).toHaveLength(0)
    expect(await reload(h.row)).toMatchObject({ status: 'shipped', landing: { stage: 'live' } })
  })

  it('a ship that died mid-gate: restarted past its window; the fresh instance salvages and says to ship again', async () => {
    const h = await harness()
    const stuck = await dieAt(h, 'ship.gate#1.1.test')
    expect(stuck).toMatchObject({ status: 'shipping', landing: null })
    expect(await reconcileSession(db, h.env, await quietFor(h, 4 * MINUTE))).toEqual({
      outcome: 'skipped',
    })
    const row = await quietFor(h, SESSION_SHIP_GATE_STALL_MS + MINUTE)
    expect(await reconcileSession(db, h.env, row)).toMatchObject({
      outcome: 'settled',
      status: 'shipping',
      restartedAs: `${row.id}-r1`,
    })
    const run = await drive(h, { fresh: true })
    expect(run.names.slice(0, 3)).toEqual(['claim', 'salvage', 'inspect#0'])
    const errors = await eventData<{ message: string }>(h, 'error')
    expect(errors.map(e => e.message)).toContain(lostShipMessage('saved'))
    expect(h.cloud.github.mergeCount(h.f.repo.owner, h.f.repo.repo)).toBe(0)
  })

  it('a merged landing whose release died (Phase B, `shipped`): restarted past its window', async () => {
    const h = await harness()
    const stuck = await dieAt(h, 'land.staging#3.0')
    expect(stuck).toMatchObject({ status: 'shipped', landing: { stage: 'deploying' } })
    expect(await reconcileSession(db, h.env, await quietFor(h, 2 * MINUTE))).toEqual({
      outcome: 'skipped',
    })
    const row = await quietFor(h, SESSION_RELEASE_STALL_MS + MINUTE)
    expect(await reconcileSession(db, h.env, row)).toMatchObject({
      outcome: 'settled',
      status: 'shipped',
      instanceStatus: 'running',
    })
    expect(workflowOf(h).terminated).toEqual([row.id])
    h.phaseB.length = 0
    const run = await drive(h, { fresh: true })
    expect(run.names).toEqual([
      'claim',
      // A landing already `deploying`: the merge commit's CI is not read again.
      'land.main-ci#0.0',
      'land.release#0.0',
      'land.staging#0.0',
      'land.health#0.0',
      'land.live#0',
    ])
    expect((await reload(row)).landing?.stage).toBe('live')
  })

  it('a ship step beats while it runs, and only while the row is shipping', async () => {
    const h = await harness()
    await patch(h.row, { status: 'shipping', lastActivityAt: msAgo(HOUR) })
    const clock = { ms: Date.now() - HOUR }
    const scope = {
      db,
      params: { tenantId: h.row.tenantId, sessionId: h.row.id },
      now: () => {
        clock.ms += 1000
        return new Date(clock.ms)
      },
      limits: { heartbeatMs: 5 },
    } as unknown as StepScope
    const seen: number[] = []
    await withHeartbeat(['shipping'], async () => {
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 15))
        seen.push((await reload(h.row)).lastActivityAt?.getTime() ?? 0)
      }
    })(scope)
    expect(new Set(seen).size).toBeGreaterThan(1)
    await patch(h.row, { status: 'ready', lastActivityAt: msAgo(HOUR) })
    await withHeartbeat(['shipping'], async () => {
      await new Promise(r => setTimeout(r, 15))
    })(scope)
    expect((await reload(h.row)).lastActivityAt?.getTime()).toBeLessThan(Date.now() - 30 * MINUTE)
  })
})

describe('tenant isolation', () => {
  it('the landing cron only ever touches the tenants it is given', async () => {
    const h = await harness()
    const other = await harness()
    const old = new Date(Date.now() - 30 * MINUTE)
    const landing = (gateSha: string): SessionLanding => ({
      mode: 'staging',
      stage: 'ci',
      prNumber: 1,
      gateSha,
      gateTree: null,
      mainCi: null,
      startedAt: old.toISOString(),
      stageAt: old.toISOString(),
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
    })
    await patch(h.row, {
      status: 'shipping',
      landing: landing('a'.repeat(40)),
      lastActivityAt: old,
    })
    await patch(other.row, {
      status: 'shipping',
      landing: landing('b'.repeat(40)),
      lastActivityAt: old,
    })
    const logger = { info: () => {}, warn: () => {}, error: () => {} } as never
    await nudgeLandingSessions(db, h.env, logger, new Date(), { tenantIds: [h.f.tenant.id] })
    expect(stubs(h.env).sessionWorkflow?.created.map(c => c.id)).toEqual([`${h.row.id}-r1`])
    expect((await reload(other.row)).instanceId).toBeNull()
  })
})

describe('landing: GitHub webhooks wake the waits (issue #19)', () => {
  /**
   * The harness wired for webhooks (built with the secret set): the app's repository id recorded, the
   * session's instance "waiting" so a wake reaches it, and that instance's sends as the fake
   * step's inbox — route → queue → handler → `sendEvent` → the wait, all real.
   */
  async function webhooked(h: Harness) {
    const repo: WebhookRepo = { id: uniqueRepoId(), owner: h.f.repo.owner, name: h.f.repo.repo }
    await db
      .update(apps)
      .set({ githubRepoId: String(repo.id) })
      .where(eq(apps.id, h.f.app.id))
    const workflow = stubs(h.env).sessionWorkflow as RecordingWorkflow
    workflow.setStatus(h.row.id, { status: 'waiting' })
    const deliver = async (body: unknown) => {
      const res = await postWebhook(h.env, 'check_run', body)
      expect(res.status, await res.clone().text()).toBe(202)
      expect(await drainJobs(h.env, db)).toEqual({ acked: 1, retried: 0 })
    }
    return { repo, inbox: workflow.inbox(h.row.id), deliver }
  }
  const mergeShaOf = async (h: Harness) => (await reload(h.row)).landing?.mergeSha ?? ''

  it('a check_run completed webhook wakes land.ci before its timeout, then it merges', async () => {
    const h = await harness({ GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET })
    const hook = await webhooked(h)
    const run = await drive(h, {
      inbox: hook.inbox,
      onLand: async (h, _wait, n) => {
        if (n === 0) {
          // CI goes green on GitHub, and GitHub says so: the round does NOT run out.
          const gateSha = await gateShaOf(h)
          setGate(h, gateSha, 'success')
          await hook.deliver(checkRunCompleted(hook.repo, { sha: gateSha, prs: [1] }))
        }
        return 'timeout'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    const landWait = run.waits.find(w => w.name === 'land.wait#2')
    expect(landWait).toMatchObject({ type: SESSION_WAKE_EVENT, outcome: 'event' })
    expect(run.names).toEqual(
      expect.arrayContaining([
        'land.ci#2',
        'land.wait#2',
        'land.ci#3',
        'land.merge#3',
        'land.live#3',
      ])
    )
    expect(h.cloud.github.merges.filter(m => m.repo === h.f.repo.repo)).toHaveLength(1)
  })

  it('with no webhook the round times out and the landing still completes by polling', async () => {
    const h = await harness({ GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET })
    const hook = await webhooked(h)
    const run = await drive(h, {
      inbox: hook.inbox,
      onLand: async (h, _wait, n) => {
        if (n === 0) setGate(h, await gateShaOf(h), 'success')
        return 'timeout'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(run.waits.find(w => w.name === 'land.wait#2')).toMatchObject({
      outcome: 'timeout',
      timeout: waitDuration(LAND_CI_FAST_SECONDS),
    })
    expect(run.names).toEqual(expect.arrayContaining(['land.merge#3', 'land.live#3']))
    expect(stubs(h.env).sessionWorkflow?.events ?? []).toHaveLength(0)
  })

  it('Phase B: the merge commit’s Gate completing wakes land.main-ci-wake before its timeout', async () => {
    const h = await harness({ GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET })
    const hook = await webhooked(h)
    h.cloud.github.mergeCommitChecks = [{ name: 'Gate', status: 'in_progress', conclusion: null }]
    const run = await drive(h, {
      inbox: hook.inbox,
      onLand: async h => {
        setGate(h, await gateShaOf(h), 'success')
        return 'wake'
      },
      onSleep: async (h, name) => {
        if (name !== 'land.main-ci-wake#3.0') return
        const mergeSha = await mergeShaOf(h)
        setGate(h, mergeSha, 'success')
        await hook.deliver(checkRunCompleted(hook.repo, { sha: mergeSha, branch: 'main' }))
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(run.waits.find(w => w.name === 'land.main-ci-wake#3.0')).toMatchObject({
      type: SESSION_WAKE_EVENT,
      outcome: 'event',
    })
    expect(run.names.slice(run.names.indexOf('cleanup'))).toEqual([
      'cleanup',
      'land.main-ci#3.0',
      'land.main-ci-wake#3.0',
      'land.main-ci#3.1',
      'land.release#3.0',
      'land.staging#3.0',
      'land.health#3.0',
      'land.live#3',
    ])
  })

  it('a webhook for another app’s repository never wakes this landing', async () => {
    const h = await harness({ GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET })
    const hook = await webhooked(h)
    const other = await seedSessionApp(db, h.cloud)
    const otherRepo: WebhookRepo = {
      id: uniqueRepoId(),
      owner: other.repo.owner,
      name: other.repo.repo,
    }
    await db
      .update(apps)
      .set({ githubRepoId: String(otherRepo.id) })
      .where(eq(apps.id, other.app.id))
    const run = await drive(h, {
      inbox: hook.inbox,
      onLand: async (h, _wait, n) => {
        if (n === 0) {
          const gateSha = await gateShaOf(h)
          setGate(h, gateSha, 'success')
          // The same SHA and PR number — on a different repository, in a different tenant.
          await hook.deliver(checkRunCompleted(otherRepo, { sha: gateSha, prs: [1] }))
        }
        return 'timeout'
      },
    })
    expect(run.outcome.status).toBe('shipped')
    expect(run.waits.find(w => w.name === 'land.wait#2')?.outcome).toBe('timeout')
    expect(stubs(h.env).sessionWorkflow?.events ?? []).toHaveLength(0)
  })
})
