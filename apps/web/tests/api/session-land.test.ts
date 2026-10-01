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
 * without a salvage; the squash message and the review's context come from `ship_summary`; and
 * every step name is distinct.
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
import { casLanding, nudgeLandingSessions } from '@/api/services/sessions/land'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import { summarizeShip } from '@/api/services/sessions/ship'
import { sessionSystemNote } from '@/api/services/sessions/turn'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import { appOwners, approvalRequests, auditEvents, type SessionRow, sessions } from '@/db/schema'
import { FakeChatClient } from '../helpers/ai'
import { decideAs, expireNow, testApprovalDeps, viewerFor } from '../helpers/approvals-kinds'
import { createTestUser, linkUserToTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import { json, request } from '../helpers/request'
import {
  createFakeSessionPorts,
  type FakeSessionPorts,
  insertSession,
  type SessionAppFixture,
  scriptKitGate,
  seedSessionApp,
} from '../helpers/sessions'
import { createExecutionContext, createTestEnv, stubs, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep, type RecordedWait } from '../mocks/cloudflare-workers'

vi.mock('@/api/services/sessions/lifecycle', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/sessions/lifecycle')>()
  return { ...actual, sessionsPaused: vi.fn(async () => false) }
})

/** S4 fills `reviewPolicyFor` in parallel: here it answers what the test says. */
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
async function harness(): Promise<Harness> {
  const env = createTestEnv()
  const cfg = loadConfig(env)
  const cloud = createFakeCloud()
  const f = await seedSessionApp(db, cloud, { prepared: true })
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
  } = {}
) {
  let idle = 0
  let lands = 0
  const fake = createFakeWorkflowStep({
    onWait: async wait => {
      if (wait.name.startsWith('land.wait#')) {
        const verdict = (await opts.onLand?.(h, wait, lands++)) ?? 'timeout'
        return verdict === 'wake' ? WAKE : undefined
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
  return { outcome, names: fake.names }
}

const SHIP = [
  'ship.claim#1',
  'ship.save#1',
  'ship.kit#1',
  'ship.gate#1.1.lint',
  'ship.gate#1.1.typecheck',
  'ship.db#1.1',
  'ship.gate#1.1.test',
  'ship.db-clean#1.1',
  'ship.commit#1',
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
      { number: 1, sha: merges[0]?.sha, url: expect.stringContaining('/pull/1'), approvalId: null },
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
    expect((await reload(h.row)).landing).toMatchObject({
      stage: 'live',
      mergeSha: expect.any(String),
    })
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
    expect(run.names.slice(-5)).toEqual([
      'cleanup',
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
