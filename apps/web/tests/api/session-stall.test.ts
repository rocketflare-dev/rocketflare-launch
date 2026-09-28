// @vitest-isolate
// Mocks `sessionsPaused` (a GLOBAL launch setting another file may be flipping), as the Workflow suite does.
/**
 * "Never hang silently" — the hola-world stall (docs/plans/README.md, "Next fixes"). The real
 * `SessionWorkflow` and step bodies over a `FakeSandbox` and the FakeCloud's Neon:
 *
 * - a sandbox call that never answers (`setAllowedHosts`, an exec) fails the step with a sentence
 *   that names the step and the call, and cleanup runs;
 * - a container that died and came back EMPTY is said so (the boot marker), never worked on;
 * - a dev server that exits fails the boot at once, with what it printed;
 * - End during a boot step stops it within a poll and ENDS the session;
 * - the app's `dev` prepare claim: a stale `preparing` is claimed again, a live one is left, a
 *   session that fails holding it gives it back;
 * - a settled session never cleaned up (a07e371e, failed by hand) is cleaned up by a fresh instance;
 * - the reconcile (`services/sessions/reconcile.ts`) settles a boot whose Workflow died, throttled,
 *   on read — and a TURN whose Workflow died: the turn fails, the session goes back to `ready`, and
 *   a fresh instance boots it again from its branch.
 */
import { SESSION_WAKE_EVENT } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { encryptToken } from '@/api/auth/oauth-encryption'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import type { SessionCallLimits } from '@/api/services/sessions/deadline'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import type { SessionStepHooks } from '@/api/services/sessions/hooks'
import { reconcileSession, reconcileStaleSessions } from '@/api/services/sessions/reconcile'
import { DEV_LOG_FILE } from '@/api/services/sessions/rocketflare-dev'
import { BOOT_STEP_LABELS, LOST_TURN_MESSAGE } from '@/api/services/sessions/steps'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import { apps, auditEvents, type SessionRow, sessionEvents, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import { json, request } from '../helpers/request'
import {
  createFakeSessionPorts,
  type FakeSessionPorts,
  insertSession,
  type SessionAppFixture,
  seedSessionApp,
  sessionAppRef,
} from '../helpers/sessions'
import {
  createExecutionContext,
  createTestEnv,
  type RecordingWorkflow,
  stubs,
  type TestEnv,
} from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

vi.mock('@/api/services/sessions/lifecycle', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/sessions/lifecycle')>()
  return { ...actual, sessionsPaused: vi.fn(async () => false) }
})

const db = setupTestDatabase()
const NEON_KEY = 'neon-test-key-abcdefghijklmnop'
const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const WAKE = { type: SESSION_WAKE_EVENT, payload: {} }

const FAST: Partial<SessionCallLimits> = {
  controlMs: 30,
  execGraceMs: 30,
  execMaxMs: 60,
  endPollMs: 5,
  heartbeatMs: 5,
}

interface Harness {
  env: TestEnv
  cloud: FakeCloud
  f: SessionAppFixture
  row: SessionRow
  ports: FakeSessionPorts
  sandbox: () => FakeSandbox
}

const hooks: SessionStepHooks = {
  runTurn: async () => {
    throw new Error('no turn in this suite')
  },
  checkpoint: async () => {},
  ship: async () => {
    throw new Error('no ship in this suite')
  },
}

/** A prepared app and a `requested` session; the sandbox scripted like a kit app EXCEPT the dev server. */
async function harness(opts: { devServer?: 'up' | 'exits' } = {}): Promise<Harness> {
  const env = createTestEnv()
  const cfg = loadConfig(env)
  const cloud = createFakeCloud()
  const f = await seedSessionApp(db, cloud, { prepared: true })
  const row = await insertSession(db, f, { status: 'requested' })
  const ports = createFakeSessionPorts({
    sessionDb: d =>
      new NeonSessionDb(d, cfg, { fetch: cloud.fetch, sleep: async () => {}, apiKey: NEON_KEY }),
  }).script(sandbox =>
    sandbox
      .onExec(/git init/, { stdout: `base=${BASE_SHA}\nhead=${BASE_SHA}\n` })
      .onProcess(
        /exec pnpm dev /,
        opts.devServer === 'exits'
          ? { lines: [], exitCode: 1 }
          : { lines: ['ready'], ports: [5173, 8787], hang: true }
      )
  )
  return { env, cloud, f, row, ports, sandbox: () => ports.sandbox(row.id) as FakeSandbox }
}

async function reload(row: Pick<SessionRow, 'id' | 'tenantId'>): Promise<SessionRow> {
  const [latest] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
  if (!latest) throw new Error('session vanished')
  return latest
}

async function patch(row: SessionRow, set: Partial<SessionRow>) {
  await db
    .update(sessions)
    .set(set)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
}

const noWait = () => {
  throw new Error('the boot should not have reached a wait')
}
const endOnWait = (h: Harness) => async () => {
  await patch(h.row, { requestedAction: 'end' })
  return WAKE
}

async function drive(
  h: Harness,
  onWait: () => unknown,
  limits: Partial<SessionCallLimits> = FAST
): Promise<{ names: string[] }> {
  const fake = createFakeWorkflowStep({ onWait })
  const workflow = new SessionWorkflow(createExecutionContext(), h.env)
  workflow.overrides = { ports: h.ports, hooks, limits }
  await workflow.run(
    {
      payload: { sessionId: h.row.id, tenantId: h.row.tenantId },
      timestamp: new Date(),
      instanceId: h.row.id,
      workflowName: 'launch-session',
    },
    fake.step as unknown as Parameters<SessionWorkflow['run']>[1]
  )
  return { names: fake.names }
}

async function stepErrors(row: SessionRow) {
  return (await listSessionEvents(db, row.tenantId, row.id))
    .filter(e => e.type === 'step')
    .map(e => e.data as { key: string; status: string; detail?: string })
    .filter(s => s.status === 'error')
}

const branchOf = (h: Harness) =>
  h.cloud.neon.branchNamed(h.f.neonProjectId, `session-${h.row.shortId}`)

describe('bounded sandbox calls', () => {
  it('a setAllowedHosts that never answers fails the session, naming the step, and cleans up', async () => {
    const h = await harness()
    h.sandbox().hangNext('setAllowedHosts')
    const run = await drive(h, noWait)
    expect(run.names).toEqual([
      'claim',
      'db',
      'sandbox.start',
      'repo',
      'bootstrap',
      'fail',
      'cleanup',
    ])
    const after = await reload(h.row)
    expect(after.status).toBe('failed')
    expect(after.error).toBe(
      `${BOOT_STEP_LABELS.bootstrap}: the sandbox (setAllowedHosts) did not answer within 0.03 s`
    )
    expect(after.endedAt).toBeInstanceOf(Date)
    expect((await stepErrors(h.row)).map(s => [s.key, s.detail])).toEqual([
      ['bootstrap', after.error],
    ])
    expect(h.sandbox().destroyed).toBe(true)
    expect(branchOf(h)).toBeUndefined()
  })

  it('an install that never answers is bounded too', async () => {
    const h = await harness()
    h.sandbox().onExec(/pnpm install/, () => new Promise(() => {}))
    const run = await drive(h, noWait)
    expect(run.names.slice(-3)).toEqual(['bootstrap', 'fail', 'cleanup'])
    expect((await reload(h.row)).error).toBe(
      `${BOOT_STEP_LABELS.bootstrap}: the sandbox (exec pnpm install) did not answer within 0.06 s`
    )
  })
})

describe('a container that died', () => {
  it('under a command: said so, as a restart — not a bare HTTP 500', async () => {
    const h = await harness()
    h.sandbox().onExec(/pnpm install/, () => {
      // Docker's OOM killer took the sandbox's control server; the SDK answers a bare 500.
      h.sandbox().recreate()
      throw new Error('SandboxError: HTTP error! status: 500')
    })
    const run = await drive(h, noWait)
    expect(run.names.slice(-3)).toEqual(['bootstrap', 'fail', 'cleanup'])
    const after = await reload(h.row)
    expect(after.status).toBe('failed')
    expect(after.error).toMatch(
      /^The session container stopped while installing and seeding and came back empty — on a laptop this is usually Docker running out of memory/
    )
  })

  it('between steps: the next step refuses up front, and never clones into nothing', async () => {
    const h = await harness()
    const sandbox = h.sandbox()
    const write = sandbox.writeFile.bind(sandbox)
    sandbox.writeFile = async (path, content) => {
      await write(path, content)
      if (path.endsWith('/boot-id')) sandbox.recreate()
    }
    const run = await drive(h, noWait)
    expect(run.names.slice(-3)).toEqual(['repo', 'fail', 'cleanup'])
    expect(sandbox.execs).toHaveLength(0)
    expect((await reload(h.row)).error).toMatch(/stopped while cloning repo and came back empty/)
  })
})

describe('the dev server', () => {
  it('exits: the boot fails at once, with what it printed', async () => {
    const h = await harness({ devServer: 'exits' })
    h.sandbox().onExec(/pnpm install/, () => {
      h.sandbox().files.set(DEV_LOG_FILE, 'wrangler 4.127\nError: The service was stopped\n')
      return {}
    })
    const started = Date.now()
    const run = await drive(h, noWait)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(run.names.slice(-3)).toEqual(['dev', 'fail', 'cleanup'])
    const after = await reload(h.row)
    expect(after.error).toContain('the dev server exited before its ports answered')
    expect(after.error).toContain('Error: The service was stopped')
  })
})

describe('End during a boot step', () => {
  it('stops it within a poll and ENDS the session (not failed)', async () => {
    const h = await harness()
    let release: () => void = () => {}
    h.sandbox().onExec(/pnpm install/, async () => {
      await patch(h.row, { requestedAction: 'end' })
      await new Promise<void>(resolve => {
        release = resolve
      })
      return {}
    })
    const run = await drive(h, noWait, { ...FAST, execMaxMs: 60_000 })
    release()
    expect(run.names.slice(-3)).toEqual(['bootstrap', 'fail', 'cleanup'])
    const after = await reload(h.row)
    expect(after.status).toBe('ended')
    expect(after.error).toBeNull()
    expect((await stepErrors(h.row)).map(s => s.detail)).toEqual([
      'Stopped: the session is being ended',
    ])
    expect(branchOf(h)).toBeUndefined()
  })

  it('a boot step writes the heartbeat the reconcile reads', async () => {
    const h = await harness()
    const before = new Date(Date.now() - 60 * 60_000)
    await patch(h.row, { lastActivityAt: before })
    let seen: Date | null = null
    h.sandbox().onExec(/pnpm install/, async () => {
      await new Promise(resolve => setTimeout(resolve, 40))
      seen = (await reload(h.row)).lastActivityAt
      return {}
    })
    await drive(h, endOnWait(h))
    expect(seen).toBeInstanceOf(Date)
    expect((seen as Date | null)?.getTime() ?? 0).toBeGreaterThan(before.getTime())
  })
})

describe('the app’s prepare claim', () => {
  async function sessionDbOf(h: Harness) {
    const [app] = await db.select().from(apps).where(eq(apps.id, h.f.app.id))
    return app?.sessionDb ?? null
  }
  async function setSessionDb(h: Harness, set: Record<string, unknown>) {
    const current = (await sessionDbOf(h)) as object
    await db
      .update(apps)
      .set({ sessionDb: { ...current, ...set } as never })
      .where(eq(apps.id, h.f.app.id))
  }

  it('a `preparing` left behind by a session that died is claimed again', async () => {
    const h = await harness()
    // hola-world's app: `preparing`, and no claimant recorded (the claim predates the fields).
    await setSessionDb(h, { status: 'preparing' })
    const run = await drive(h, endOnWait(h))
    expect(run.names.slice(0, 6)).toEqual([
      'claim',
      'db',
      'sandbox.start',
      'repo',
      'prepare',
      'branch',
    ])
    const after = await sessionDbOf(h)
    expect(after).toMatchObject({ status: 'ready' })
    expect(after).not.toHaveProperty('preparingSessionId')
  })

  it('a live claim is left alone: the session branches from the unprepared dev', async () => {
    const h = await harness()
    const other = await insertSession(db, h.f, { status: 'booting' })
    await setSessionDb(h, {
      status: 'preparing',
      preparingSessionId: other.id,
      preparingSince: new Date().toISOString(),
    })
    const run = await drive(h, endOnWait(h))
    expect(run.names).not.toContain('prepare')
    expect(await sessionDbOf(h)).toMatchObject({
      status: 'preparing',
      preparingSessionId: other.id,
    })
  })

  it('a claim older than 30 minutes is taken over even if its session still looks active', async () => {
    const h = await harness()
    const other = await insertSession(db, h.f, { status: 'booting' })
    await setSessionDb(h, {
      status: 'preparing',
      preparingSessionId: other.id,
      preparingSince: new Date(Date.now() - 31 * 60_000).toISOString(),
    })
    const run = await drive(h, endOnWait(h))
    expect(run.names).toContain('prepare')
  })

  it('a session that fails holding the claim gives it back: failed, not preparing', async () => {
    const h = await harness()
    await setSessionDb(h, { status: 'none' })
    h.sandbox().failNext('exec', new Error('clone failed'))
    const run = await drive(h, noWait)
    expect(run.names).toEqual(['claim', 'db', 'sandbox.start', 'repo', 'fail', 'cleanup'])
    const after = await sessionDbOf(h)
    expect(after).toMatchObject({ status: 'failed' })
    expect(after).not.toHaveProperty('preparingSessionId')
  })
})

describe('a settled session never cleaned up', () => {
  it('(failed by hand, its branch still there) — a fresh instance destroys and deletes', async () => {
    const h = await harness()
    const cfg = loadConfig(h.env)
    const neon = new NeonSessionDb(db, cfg, {
      fetch: h.cloud.fetch,
      sleep: async () => {},
      apiKey: NEON_KEY,
    })
    const branch = await neon.createBranch(sessionAppRef(h.f), h.row)
    expect(branchOf(h)).toBeDefined()
    await patch(h.row, { status: 'failed', error: 'recovered by hand', db: branch.db })
    const run = await drive(h, noWait)
    expect(run.names).toEqual(['claim', 'cleanup'])
    const after = await reload(h.row)
    expect(after).toMatchObject({ status: 'failed', error: 'recovered by hand' })
    expect(after.endedAt).toBeInstanceOf(Date)
    expect(branchOf(h)).toBeUndefined()
  })
})

describe('reconcile (a Workflow that died under a quiet session)', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)

  async function booting(h: Harness, quietFor: number) {
    await patch(h.row, {
      status: 'booting',
      instanceId: h.row.id,
      lastActivityAt: minutesAgo(quietFor),
    })
    await db.insert(sessionEvents).values({
      sessionId: h.row.id,
      tenantId: h.row.tenantId,
      seq: 1,
      type: 'step',
      data: { key: 'prepare', label: BOOT_STEP_LABELS.prepare, status: 'running' },
    })
    return reload(h.row)
  }
  const workflowOf = (h: Harness) => stubs(h.env).sessionWorkflow as RecordingWorkflow

  it('a fresh boot costs nothing', async () => {
    const h = await harness()
    const row = await booting(h, 1)
    expect(await reconcileSession(db, h.env, row)).toEqual({ outcome: 'skipped' })
    expect(workflowOf(h).statusCalls).toEqual([])
  })

  it('a boot quiet for 3 minutes under a "running" instance: terminated, failed naming the step, cleaned up by a fresh instance', async () => {
    const h = await harness()
    const row = await booting(h, 4)
    const wf = workflowOf(h)
    wf.setStatus(row.id, { status: 'running' })
    const result = await reconcileSession(db, h.env, row)
    expect(result).toMatchObject({
      outcome: 'settled',
      status: 'failed',
      restartedAs: `${row.id}-r1`,
    })
    expect(wf.terminated).toEqual([row.id])
    expect(wf.created.map(c => c.id)).toEqual([`${row.id}-r1`])
    const after = await reload(row)
    expect(after.status).toBe('failed')
    expect(after.instanceId).toBe(`${row.id}-r1`)
    expect(after.error).toBe(
      `The session stopped while ${BOOT_STEP_LABELS.prepare} was running (its Workflow was running, but its step had not moved for 3 minutes). Start a new session.`
    )
    expect((await stepErrors(row)).map(s => s.key)).toEqual(['prepare'])
    const audit = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, row.tenantId), eq(auditEvents.targetId, row.id)))
    expect(audit.map(a => a.action)).toContain('session.reconciled')

    // The fresh instance's claim sends it to cleanup (the app's prepare claim included).
    const run = await drive(h, noWait)
    expect(run.names).toEqual(['claim', 'cleanup'])
    expect((await reload(row)).endedAt).toBeInstanceOf(Date)
  })

  it('is throttled: a second read inside the window asks nothing', async () => {
    const h = await harness()
    const row = await booting(h, 4)
    workflowOf(h).setStatus(row.id, { status: 'errored' })
    await reconcileSession(db, h.env, row)
    const calls = workflowOf(h).statusCalls.length
    expect(await reconcileSession(db, h.env, row)).toEqual({ outcome: 'skipped' })
    expect(workflowOf(h).statusCalls.length).toBe(calls)
  })

  it('an end the person asked for becomes an end, not a failure', async () => {
    const h = await harness()
    await booting(h, 2)
    await patch(h.row, { requestedAction: 'end' })
    // No instance at all (a `wrangler dev` restart lost it); the end route's short window.
    const result = await reconcileSession(db, h.env, await reload(h.row), { stallMs: 75_000 })
    expect(result).toMatchObject({
      outcome: 'settled',
      status: 'ending',
      instanceStatus: 'not found',
    })
    const after = await reload(h.row)
    expect(after).toMatchObject({ status: 'ending', requestedAction: null, error: null })
  })

  it('a live `requested` instance is only queued: left alone', async () => {
    const h = await harness()
    await patch(h.row, { instanceId: h.row.id, lastActivityAt: minutesAgo(10) })
    workflowOf(h).setStatus(h.row.id, { status: 'queued' })
    const result = await reconcileSession(db, h.env, await reload(h.row))
    expect(result).toEqual({ outcome: 'alive', instanceStatus: 'queued' })
    expect((await reload(h.row)).status).toBe('requested')
  })

  it('GET /api/sessions/:id reconciles on read and answers the settled row', async () => {
    const h = await harness()
    const row = await booting(h, 5)
    workflowOf(h).setStatus(row.id, { status: 'terminated' })
    const res = await request(`/api/sessions/${row.id}`, { headers: h.f.cookie }, { env: h.env })
    expect(res.status).toBe(200)
    const body = (await json(res)) as { session: { status: string; error: string } }
    expect(body.session.status).toBe('failed')
    expect(body.session.error).toMatch(/its Workflow ended terminated/)
  })

  it('the cron sweep settles a quiet boot and a settled session never cleaned up', async () => {
    const h = await harness()
    const quiet = await booting(h, 6)
    workflowOf(h).setStatus(quiet.id, { status: 'errored' })
    const leftover = await insertSession(db, h.f, {
      status: 'failed',
      lastActivityAt: minutesAgo(10),
      updatedAt: minutesAgo(10),
    })
    const settled = await reconcileStaleSessions(db, h.env, { tenantIds: [h.f.tenant.id] })
    expect(settled).toBeGreaterThanOrEqual(2)
    expect((await reload(quiet)).status).toBe('failed')
    expect(workflowOf(h).created.map(c => c.id)).toEqual(
      expect.arrayContaining([`${quiet.id}-r1`, `${leftover.id}-r1`])
    )
  })
})

describe('reconcile (a Workflow that died under a running turn)', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)
  const workflowOf = (h: Harness) => stubs(h.env).sessionWorkflow as RecordingWorkflow

  /** A booted session in the middle of turn 1, its heartbeat `quietFor` minutes old. */
  async function working(h: Harness, quietFor: number, set: Partial<SessionRow> = {}) {
    const cfg = loadConfig(h.env)
    await patch(h.row, {
      status: 'working',
      instanceId: h.row.id,
      turnCount: 1,
      baseSha: BASE_SHA,
      sandboxId: h.sandbox().id,
      dbUriSealed: await encryptToken(
        cfg,
        'postgresql://session_owner:pw@ep-x.us-east-2.aws.neon.tech/session_app'
      ),
      lastActivityAt: minutesAgo(quietFor),
      ...set,
    })
    await db.insert(sessionEvents).values([
      {
        sessionId: h.row.id,
        tenantId: h.row.tenantId,
        seq: 1,
        turn: 1,
        type: 'turn.start',
        data: { turn: 1 },
      },
    ])
    return reload(h.row)
  }
  const turnEvents = async (row: SessionRow) =>
    (await listSessionEvents(db, row.tenantId, row.id)).filter(e => e.type.startsWith('turn.'))

  it('a turn with a fresh heartbeat costs nothing', async () => {
    const h = await harness()
    const row = await working(h, 1)
    expect(await reconcileSession(db, h.env, row)).toEqual({ outcome: 'skipped' })
    expect(workflowOf(h).statusCalls).toEqual([])
  })

  it('an errored Workflow: the TURN fails with a sentence, the session is ready again, and a fresh instance boots it from its branch', async () => {
    const h = await harness()
    const row = await working(h, 4, { cancelRequestedAt: minutesAgo(5) })
    const wf = workflowOf(h)
    wf.setStatus(row.id, { status: 'errored' })
    const result = await reconcileSession(db, h.env, row)
    expect(result).toMatchObject({
      outcome: 'settled',
      status: 'ready',
      instanceStatus: 'errored',
      restartedAs: `${row.id}-r1`,
    })
    const after = await reload(row)
    expect(after).toMatchObject({
      status: 'ready',
      error: null,
      cancelRequestedAt: null,
      instanceId: `${row.id}-r1`,
    })
    const closed = (await turnEvents(row)).at(-1)
    expect(closed).toMatchObject({ type: 'turn.failed', turn: 1 })
    expect((closed?.data as { message?: string } | undefined)?.message).toBe(
      'This turn stopped (its Workflow ended errored). Launch is restarting the session from its last checkpoint; send your message again.'
    )

    // The fresh instance's claim finds a live row: the old container goes, the session boots again.
    let statusAtWait: string | undefined
    const run = await drive(h, async () => {
      statusAtWait ??= (await reload(row)).status
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names.slice(0, 8)).toEqual([
      'claim',
      'inspect#0',
      'resume#0',
      'sandbox.start#1',
      'repo#1',
      'bootstrap#1',
      'dev#1',
      'transcript#1',
    ])
    expect(statusAtWait).toBe('ready')
    expect(h.sandbox().destroyCount).toBeGreaterThanOrEqual(2)
    // Closed once: the claim found `ready`, not `working`, so it wrote no second turn.failed.
    expect((await turnEvents(row)).filter(e => e.type === 'turn.failed')).toHaveLength(1)
  })

  it('a turn quiet for 3 minutes under a "running" instance is dead too: terminated first', async () => {
    const h = await harness()
    const row = await working(h, 4)
    const wf = workflowOf(h)
    wf.setStatus(row.id, { status: 'running' })
    const result = await reconcileSession(db, h.env, row)
    expect(result).toMatchObject({ outcome: 'settled', status: 'ready' })
    expect(wf.terminated).toEqual([row.id])
    const closed = (await turnEvents(row)).at(-1)
    expect((closed?.data as { message?: string } | undefined)?.message).toMatch(
      /its Workflow was running, but its turn had not moved for 3 minutes/
    )
  })

  it('End asked during a dead turn ends the session', async () => {
    const h = await harness()
    await working(h, 2, { requestedAction: 'end', cancelRequestedAt: minutesAgo(1) })
    const result = await reconcileSession(db, h.env, await reload(h.row), { stallMs: 75_000 })
    expect(result).toMatchObject({
      outcome: 'settled',
      status: 'ending',
      instanceStatus: 'not found',
    })
    expect(await reload(h.row)).toMatchObject({ status: 'ending', requestedAction: null })
  })

  it('the cron sweep covers a dead turn', async () => {
    const h = await harness()
    const row = await working(h, 6)
    workflowOf(h).setStatus(row.id, { status: 'terminated' })
    await reconcileStaleSessions(db, h.env, { tenantIds: [h.f.tenant.id] })
    expect((await reload(row)).status).toBe('ready')
  })

  it('a lost instance found by a fresh claim (a wake that restarted it) closes the turn too', async () => {
    const h = await harness()
    const row = await working(h, 0)
    await drive(h, async () => {
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    const failed = (await turnEvents(row)).filter(e => e.type === 'turn.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.data).toEqual({ turn: 1, message: LOST_TURN_MESSAGE })
  })
})
