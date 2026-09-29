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
import {
  BOOT_STEP_LABELS,
  lostTurnMessage,
  SESSION_BOOT_MARKER,
  salvagedCancelMessage,
} from '@/api/services/sessions/steps'
import { CONVERSATION_LOST_MESSAGE, turnKillScript } from '@/api/services/sessions/turn'
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
  commandPollMs: 5,
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
  shipFix: async () => {
    throw new Error('no ship in this suite')
  },
  shipSummary: async () => {
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
  limits: Partial<SessionCallLimits> = FAST,
  hookOverrides: Partial<SessionStepHooks> = {}
): Promise<{ names: string[] }> {
  const fake = createFakeWorkflowStep({ onWait })
  const workflow = new SessionWorkflow(createExecutionContext(), h.env)
  workflow.overrides = { ports: h.ports, hooks: { ...hooks, ...hookOverrides }, limits }
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

  it('an install that never finishes is killed at its deadline, with what it printed', async () => {
    const h = await harness()
    h.sandbox().onBackground(/pnpm install/, { hang: true, log: 'Progress: resolved 812\n' })
    const run = await drive(h, noWait)
    expect(run.names.slice(-3)).toEqual(['bootstrap', 'fail', 'cleanup'])
    expect((await reload(h.row)).error).toBe(
      'pnpm install did not finish within 0.06 s; Launch stopped it:\nProgress: resolved 812'
    )
    const [install] = h.sandbox().backgroundRuns
    expect(install).toMatchObject({ name: 'install', killed: true, exitCode: 143 })
    // The whole process group, by the pid the run recorded.
    expect(h.sandbox().commands).toContainEqual(
      expect.stringMatching(new RegExp(`^kill -TERM -- -${install?.pid} `))
    )
  })
})

describe('a container that died', () => {
  it('under a command: said so, as a restart — not a bare HTTP 500', async () => {
    const h = await harness()
    h.sandbox().onBackground(/pnpm install/, () => {
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
    h.sandbox().onBackground(/pnpm install/, () => {
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
    h.sandbox().onBackground(/pnpm install/, async () => {
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
    h.sandbox().onBackground(/pnpm install/, async () => {
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

describe('reconcile (a Workflow that died under a running turn) and the salvage', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)
  const secondsAgo = (n: number) => new Date(Date.now() - n * 1000)
  const workflowOf = (h: Harness) => stubs(h.env).sessionWorkflow as RecordingWorkflow
  const BOOT_ID = 'boot-before-the-reload'

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
  /** The container outlived the instance: its boot marker is still there. */
  const containerStillUp = (h: Harness) => h.sandbox().files.set(SESSION_BOOT_MARKER, BOOT_ID)
  const turnEvents = async (row: SessionRow) =>
    (await listSessionEvents(db, row.tenantId, row.id)).filter(e => e.type.startsWith('turn.'))
  const messageOf = (event: { data: unknown } | undefined) =>
    (event?.data as { message?: string } | undefined)?.message
  const errorsOf = async (row: SessionRow) =>
    (await listSessionEvents(db, row.tenantId, row.id))
      .filter(e => e.type === 'error')
      .map(e => messageOf(e))

  /** The checkpoint hook, recording each reason and whether the orphaned turn was stopped first. */
  function recordingCheckpoint(h: Harness, fail?: Error) {
    const calls: { reason: string; killedFirst: boolean }[] = []
    const checkpoint: SessionStepHooks['checkpoint'] = async (_ctx, reason) => {
      calls.push({
        reason,
        killedFirst: h.sandbox().execs.some(e => e.command === turnKillScript()),
      })
      if (fail && reason === 'salvage') throw fail
    }
    return { calls, checkpoint }
  }
  /** At the first wait: note the status and the destroys so far, then End. */
  const endOnFirstWait = (h: Harness, seen: { status?: string; destroys?: number }) => async () => {
    seen.status ??= (await reload(h.row)).status
    seen.destroys ??= h.sandbox().destroyCount
    await patch(h.row, { requestedAction: 'end' })
    return WAKE
  }

  it('a turn with a fresh heartbeat costs nothing', async () => {
    const h = await harness()
    const row = await working(h, 1)
    expect(await reconcileSession(db, h.env, row)).toEqual({ outcome: 'skipped' })
    expect(workflowOf(h).statusCalls).toEqual([])
  })

  it('an errored Workflow: the turn is left for a fresh instance, whose salvage stops the process, checkpoints, keeps the container and resumes WARM', async () => {
    const h = await harness()
    const row = await working(h, 4)
    containerStillUp(h)
    const wf = workflowOf(h)
    wf.setStatus(row.id, { status: 'errored' })
    const result = await reconcileSession(db, h.env, row)
    expect(result).toMatchObject({
      outcome: 'settled',
      status: 'working',
      instanceStatus: 'errored',
      restartedAs: `${row.id}-r1`,
    })
    // Nothing closed yet, nothing destroyed: the salvage decides what to say.
    expect(await reload(row)).toMatchObject({ status: 'working', instanceId: `${row.id}-r1` })
    expect((await turnEvents(row)).map(e => e.type)).toEqual(['turn.start'])

    const { calls, checkpoint } = recordingCheckpoint(h)
    const seen: { status?: string; destroys?: number } = {}
    const run = await drive(h, endOnFirstWait(h, seen), FAST, { checkpoint })
    expect(run.names.slice(0, 7)).toEqual([
      'claim',
      'salvage',
      'inspect#0',
      'resume#0',
      'sandbox.start#1',
      'dev#1',
      'inspect#1',
    ])
    expect(run.names).not.toContain('repo#1')
    expect(new Set(run.names).size).toBe(run.names.length)
    // Killed (SIGTERM → SIGKILL by pid) BEFORE the checkpoint, which ran as a salvage.
    expect(calls[0]).toEqual({ reason: 'salvage', killedFirst: true })
    expect(seen).toEqual({ status: 'ready', destroys: 0 })
    const failed = (await turnEvents(row)).filter(e => e.type === 'turn.failed')
    expect(failed).toHaveLength(1)
    expect(messageOf(failed[0])).toBe(lostTurnMessage('saved'))
    expect(messageOf(failed[0])).toMatch(/saved your work/)
  })

  it('a container that is gone: no checkpoint, destroyed, a cold resume — and the conversation it cannot restore is forgotten', async () => {
    const h = await harness()
    const row = await working(h, 4, { claudeSessionId: 'claude-never-checkpointed' })
    workflowOf(h).setStatus(row.id, { status: 'running' })
    const result = await reconcileSession(db, h.env, row)
    expect(result).toMatchObject({ outcome: 'settled', status: 'working' })
    expect(workflowOf(h).terminated).toEqual([row.id])

    const { calls, checkpoint } = recordingCheckpoint(h)
    const seen: { status?: string; destroys?: number } = {}
    const run = await drive(h, endOnFirstWait(h, seen), FAST, { checkpoint })
    expect(run.names.slice(0, 10)).toEqual([
      'claim',
      'salvage',
      'inspect#0',
      'resume#0',
      'sandbox.start#1',
      'restore.check#1',
      'repo#1',
      'bootstrap#1',
      'dev#1',
      'transcript#1',
    ])
    expect(calls.map(c => c.reason)).not.toContain('salvage')
    expect(h.sandbox().execs.some(e => e.command === turnKillScript())).toBe(false)
    expect(seen.status).toBe('ready')
    expect(seen.destroys).toBeGreaterThanOrEqual(1)
    const failed = (await turnEvents(row)).filter(e => e.type === 'turn.failed')
    expect(failed.map(messageOf)).toEqual([lostTurnMessage('lost')])
    expect(messageOf(failed[0])).toMatch(/could not save its work/)
    // No transcript was ever checkpointed: `--resume` would fail every turn, so it is forgotten.
    expect((await reload(row)).claudeSessionId).toBeNull()
    expect(await errorsOf(row)).toContain(CONVERSATION_LOST_MESSAGE)
  })

  it('a checkpoint that fails: the container is KEPT (the workspace is the only copy) and the turn says so', async () => {
    const h = await harness()
    const row = await working(h, 0)
    containerStillUp(h)
    const { calls, checkpoint } = recordingCheckpoint(h, new Error('push rejected'))
    const seen: { status?: string; destroys?: number } = {}
    const run = await drive(h, endOnFirstWait(h, seen), FAST, { checkpoint })
    expect(run.names.slice(0, 6)).toEqual([
      'claim',
      'salvage',
      'inspect#0',
      'resume#0',
      'sandbox.start#1',
      'dev#1',
    ])
    expect(calls[0]?.reason).toBe('salvage')
    expect(seen.destroys).toBe(0)
    const failed = (await turnEvents(row)).filter(e => e.type === 'turn.failed')
    expect(failed.map(messageOf)).toEqual([lostTurnMessage('kept', 'push rejected')])
    expect(messageOf(failed[0])).toMatch(/could not save your work .*push rejected.*still in/)
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

  it('the cron sweep covers a dead turn: a fresh instance is started for its salvage', async () => {
    const h = await harness()
    const row = await working(h, 6)
    workflowOf(h).setStatus(row.id, { status: 'terminated' })
    await reconcileStaleSessions(db, h.env, { tenantIds: [h.f.tenant.id] })
    expect(await reload(row)).toMatchObject({ status: 'working', instanceId: `${row.id}-r1` })
  })

  it('no fresh instance can be started: the turn is closed here, so it does not spin', async () => {
    const h = await harness()
    const row = await working(h, 4)
    const wf = workflowOf(h)
    wf.setStatus(row.id, { status: 'errored' })
    wf.create = async () => {
      throw new Error('the engine is down')
    }
    const result = await reconcileSession(db, h.env, row)
    expect(result).toMatchObject({ outcome: 'settled', status: 'ready', restartedAs: null })
    expect(await reload(row)).toMatchObject({ status: 'ready' })
    const failed = (await turnEvents(row)).filter(e => e.type === 'turn.failed')
    expect(messageOf(failed[0])).toMatch(/could not restart the session to save its work/)
  })

  it('a lost instance found by a fresh claim (a wake that restarted it) salvages too', async () => {
    const h = await harness()
    const row = await working(h, 0)
    containerStillUp(h)
    const { calls, checkpoint } = recordingCheckpoint(h)
    await drive(h, endOnFirstWait(h, {}), FAST, { checkpoint })
    expect(calls[0]).toEqual({ reason: 'salvage', killedFirst: true })
    const failed = (await turnEvents(row)).filter(e => e.type === 'turn.failed')
    expect(failed.map(messageOf)).toEqual([lostTurnMessage('saved')])
  })

  describe('Stop without a live turn step', () => {
    it('a stale heartbeat + a pending Stop is lost at once (30 s), not after 3 minutes', async () => {
      const h = await harness()
      const quiet = await working(h, 0, { lastActivityAt: secondsAgo(40) })
      workflowOf(h).setStatus(quiet.id, { status: 'running' })
      // Without a Stop, 40 s of quiet is nothing.
      expect(await reconcileSession(db, h.env, quiet)).toEqual({ outcome: 'skipped' })
      await patch(h.row, { cancelRequestedAt: new Date() })
      const result = await reconcileSession(db, h.env, await reload(h.row))
      expect(result).toMatchObject({ outcome: 'settled', status: 'working' })
      expect(workflowOf(h).terminated).toEqual([quiet.id])
    })

    it('POST /cancel with a stale heartbeat acts without the turn step: terminated, and the fresh instance stops, saves and settles the turn as cancelled', async () => {
      const h = await harness()
      const row = await working(h, 1)
      containerStillUp(h)
      const wf = workflowOf(h)
      wf.setStatus(row.id, { status: 'running' })
      const res = await request(
        `/api/sessions/${row.id}/cancel`,
        { method: 'POST', headers: h.f.cookie },
        { env: h.env, json: {} }
      )
      expect(res.status).toBe(200)
      expect(wf.terminated).toEqual([row.id])
      expect(wf.created.map(c => c.id)).toEqual([`${row.id}-r1`])
      expect(await reload(row)).toMatchObject({ status: 'working', instanceId: `${row.id}-r1` })

      const { calls, checkpoint } = recordingCheckpoint(h)
      const seen: { status?: string; destroys?: number } = {}
      const run = await drive(h, endOnFirstWait(h, seen), FAST, { checkpoint })
      expect(run.names.slice(0, 2)).toEqual(['claim', 'salvage'])
      expect(calls[0]).toEqual({ reason: 'salvage', killedFirst: true })
      expect(seen).toEqual({ status: 'ready', destroys: 0 })
      const closed = await turnEvents(row)
      expect(closed.map(e => e.type)).toEqual(['turn.start', 'turn.interrupted'])
      expect(closed[1]?.data).toEqual({
        turn: 1,
        reason: 'cancelled',
        message: salvagedCancelMessage('saved'),
      })
      expect((await reload(row)).cancelRequestedAt).toBeNull()
    })

    it('POST /cancel with a fresh heartbeat is unchanged: the live turn step reads it', async () => {
      const h = await harness()
      const row = await working(h, 0, { lastActivityAt: secondsAgo(5) })
      const wf = workflowOf(h)
      wf.setStatus(row.id, { status: 'running' })
      const res = await request(
        `/api/sessions/${row.id}/cancel`,
        { method: 'POST', headers: h.f.cookie },
        { env: h.env, json: {} }
      )
      expect(res.status).toBe(200)
      expect(wf.statusCalls).toEqual([])
      expect(wf.terminated).toEqual([])
      expect(wf.created).toEqual([])
      const after = await reload(row)
      expect(after.status).toBe('working')
      expect(after.cancelRequestedAt).toBeInstanceOf(Date)
    })
  })
})
