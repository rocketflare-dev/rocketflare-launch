// @vitest-isolate
// Mocks `sessionsPaused` (a GLOBAL launch setting another file may be flipping), so this file needs
// its own module registry.
/**
 * `SessionWorkflow` (Launch P3, slice 3b) driven end to end under Node: the real Workflow class and
 * step bodies, the real Neon adapter over the FakeCloud, a `FakeSandbox` per session, 3c's REAL
 * `runTurn` (with fast timers) as the turn hook, and recording fakes for 3d's checkpoint and ship.
 * `createFakeWorkflowStep({ onWait })` plays the person: each `wait#N` is where a route would have
 * written the row and woken the instance.
 */
import {
  type AppSessionDb,
  SESSION_WAKE_EVENT,
  type SessionEventType,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptToken } from '@/api/auth/oauth-encryption'
import {
  CheckpointError,
  SESSION_CHECKPOINT_DEBOUNCE_MS,
  SESSION_CHECKPOINT_MAX_DEFER_MS,
  WORKSPACE_CHANGED_SCRIPT,
  WORKSPACE_CHANGED_TIMEOUT_MS,
  workspaceChanged,
} from '@/api/services/sessions/checkpoint'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import { SESSION_CALL_LIMITS, type SessionCallLimits } from '@/api/services/sessions/deadline'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import type { SessionStepHooks } from '@/api/services/sessions/hooks'
import {
  BOOTSTRAP_PROGRESS,
  claudeTranscriptPath,
  DEV_START_COMMAND,
  DEV_STOP_COMMAND,
  INSTALL_PROGRESS,
  SESSION_HOME,
  SESSION_IMAGE_VERSION,
  SESSION_WORKSPACE,
} from '@/api/services/sessions/rocketflare-dev'
import {
  BOOT_STEP_LABELS,
  checkpointDueInMs,
  dirtyAfterTurn,
  SESSION_BOOT_MARKER,
  type TurnStepResult,
  waitDuration,
} from '@/api/services/sessions/steps'
import { runTurn, turnKillScript } from '@/api/services/sessions/turn'
import { SESSION_WARM_KEEP_MINUTES } from '@/api/services/sessions/warm'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import { apps, auditEvents, type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { claudeStreamJson } from '../helpers/fake-anthropic'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { FakeSandbox } from '../helpers/fake-sandbox'
import {
  createFakeSessionPorts,
  type FakeSessionPorts,
  insertSession,
  type SessionAppFixture,
  seedSessionApp,
} from '../helpers/sessions'
import { createExecutionContext, createTestEnv, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep, type RecordedWait } from '../mocks/cloudflare-workers'

const paused = vi.hoisted(() => ({ value: false }))
vi.mock('@/api/services/sessions/lifecycle', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/sessions/lifecycle')>()
  return { ...actual, sessionsPaused: vi.fn(async () => paused.value) }
})

const db = setupTestDatabase()
const NEON_KEY = 'neon-test-key-abcdefghijklmnop'
const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1))

/** What the checkout's `apps/web/migrations` hashes to now (a turn may add a migration). */
const migrations = { hash: 'a'.repeat(64) }

beforeEach(() => {
  paused.value = false
  migrations.hash = 'a'.repeat(64)
})

/** The parts of the kit bootstrap each `scripts/bootstrap.mjs` run left out, in order. */
const bootstrapSkips = (sandbox: FakeSandbox) =>
  sandbox.backgroundRuns
    .filter(r => r.command.includes('scripts/bootstrap.mjs'))
    .map(r => r.opts?.env?.LAUNCH_BOOTSTRAP_SKIP ?? '')

interface Harness {
  env: TestEnv
  cloud: FakeCloud
  f: SessionAppFixture
  row: SessionRow
  ports: FakeSessionPorts
  hooks: SessionStepHooks
  checkpoints: string[]
  /**
   * The checkout as the dirty check (`workspaceChanged`) sees it: a turn leaves it `changed`
   * (unless the harness says the turns change nothing), a checkpoint makes it clean again, and
   * `broken` makes the check itself fail.
   */
  workspace: { changed: boolean; turnsChange: boolean; broken: boolean }
  sandbox: () => FakeSandbox
}

/** A prepared app, a `requested` session, the ports and hooks, the sandbox scripted like a kit app. */
async function harness(
  opts: {
    prepared?: boolean
    hooks?: Partial<SessionStepHooks>
    env?: Parameters<typeof createTestEnv>[0]
    /** Whether a turn leaves the workspace changed (default: it does). */
    turnsChange?: boolean
  } = {}
): Promise<Harness> {
  const workspace = { changed: false, turnsChange: opts.turnsChange ?? true, broken: false }
  const env = createTestEnv(opts.env)
  const cfg = loadConfig(env)
  const cloud = createFakeCloud()
  const f = await seedSessionApp(db, cloud, { prepared: opts.prepared ?? true })
  const row = await insertSession(db, f, { status: 'requested', instanceId: undefined })
  const ports = createFakeSessionPorts({
    sessionDb: d =>
      new NeonSessionDb(d, cfg, { fetch: cloud.fetch, sleep: async () => {}, apiKey: NEON_KEY }),
  }).script(sandbox =>
    sandbox
      .onExec(/git init/, { stdout: `base=${BASE_SHA}\nhead=${BASE_SHA}\n` })
      .onExec(/sha256sum/, () => ({ stdout: `migrations=${migrations.hash}\n` }))
      .onExec(WORKSPACE_CHANGED_SCRIPT, () =>
        workspace.broken
          ? { exitCode: 128, stderr: 'fatal: not a git repository' }
          : { stdout: `${BASE_SHA}\n${workspace.changed ? 'dirty' : 'clean'}\n` }
      )
      .onProcess(/exec pnpm dev /, { lines: ['ready'], ports: [5173, 8787], hang: true })
      .onProcess(/claude -p/, claudeStreamJson({ text: 'Changed the heading.' }))
  )
  const checkpoints: string[] = []
  const hooks: SessionStepHooks = {
    runTurn: async ctx => {
      const outcome = await runTurn(ctx.db, ctx.ports, ctx.session, {
        realtime: ctx.realtime,
        logger: ctx.logger,
        sleep: tick,
        cancelPollMs: 5,
        flushMs: 5,
      })
      if (workspace.turnsChange) workspace.changed = true
      return outcome
    },
    checkpoint: async (_ctx, reason) => {
      checkpoints.push(reason)
      workspace.changed = false
    },
    ship: async () => {
      throw new Error('ship was not expected in this test')
    },
    ...opts.hooks,
  }
  return {
    env,
    cloud,
    f,
    row,
    ports,
    hooks,
    checkpoints,
    workspace,
    sandbox: () => ports.sandbox(row.id) as FakeSandbox,
  }
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

/** Run the Workflow with `onWait` playing the routes; every step's RESULT is kept too. */
async function drive(
  h: Harness,
  onWait: (wait: RecordedWait, n: number) => unknown,
  limits?: Partial<SessionCallLimits>,
  now?: () => Date
) {
  let waits = 0
  const fake = createFakeWorkflowStep({ onWait: wait => onWait(wait, waits++) })
  const results: unknown[] = []
  const realDo = fake.step.do.bind(fake.step) as (...args: unknown[]) => Promise<unknown>
  ;(fake.step as { do: unknown }).do = async (...args: unknown[]) => {
    const result = await realDo(...args)
    results.push(result)
    return result
  }
  const workflow = new SessionWorkflow(createExecutionContext(), h.env)
  workflow.overrides = { ports: h.ports, hooks: h.hooks, limits, now }
  const outcome = await workflow.run(
    {
      payload: { sessionId: h.row.id, tenantId: h.row.tenantId },
      timestamp: new Date(),
      instanceId: h.row.id,
      workflowName: 'launch-session',
    },
    fake.step as unknown as Parameters<SessionWorkflow['run']>[1]
  )
  return { outcome, names: fake.names, waits: fake.waits, results }
}

const WAKE = { type: SESSION_WAKE_EVENT, payload: {} }
const typesOf = async (row: SessionRow): Promise<SessionEventType[]> =>
  (await listSessionEvents(db, row.tenantId, row.id)).map(e => e.type)

describe('SessionWorkflow: boot', () => {
  it('boots in order with distinct step names, goes ready with preview.ready, and cleans up on end', async () => {
    const h = await harness()
    let settings: string | null | undefined
    const run = await drive(h, async () => {
      // While it is live (cleanup wipes the container's files).
      settings = h.sandbox().files.get('/workspace/app/.claude/settings.local.json')
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })

    expect(run.names).toEqual([
      'claim',
      'db',
      'sandbox.start',
      'repo',
      'bootstrap',
      'dev',
      'inspect#0',
      'wait#0',
      'inspect#1',
      'end#1',
      'cleanup',
    ])
    expect(new Set(run.names).size).toBe(run.names.length)
    expect(run.outcome).toEqual({ sessionId: h.row.id, status: 'ended' })

    const sandbox = h.sandbox()
    // The clone, the kit bootstrap and the dev server, in that order; never port 3000.
    const commands = sandbox.commands
    const clone = commands.findIndex(c => c.includes('git init'))
    const install = commands.findIndex(c => c.includes('pnpm install'))
    const bootstrap = commands.findIndex(c => c.includes('scripts/bootstrap.mjs'))
    expect(clone).toBeGreaterThanOrEqual(0)
    expect(install).toBeGreaterThan(clone)
    expect(bootstrap).toBeGreaterThan(install)
    expect(commands[clone]).toContain(`https://github.com/${h.f.repo.owner}/${h.f.repo.repo}.git`)
    expect(commands[clone]).toContain(`session/${h.row.shortId}`)
    expect(sandbox.processes.map(p => p.command)).toEqual([DEV_START_COMMAND])
    expect(JSON.stringify(sandbox.execs.map(e => e.opts?.env))).not.toContain('3000')
    expect(settings).toContain('Bash(git push:*)')

    // Cleanup: the container is gone and the branch deleted.
    expect(sandbox.destroyed).toBe(true)
    expect(h.cloud.neon.branchNamed(h.f.neonProjectId, `session-${h.row.shortId}`)).toBeUndefined()

    const after = await reload(h.row)
    expect(after).toMatchObject({
      status: 'ended',
      sandboxId: sandbox.id,
      baseSha: BASE_SHA,
      dbUriSealed: null,
      requestedAction: null,
    })
    expect(after.readyAt).toBeInstanceOf(Date)
    expect(after.endedAt).toBeInstanceOf(Date)
    expect(after.db).toMatchObject({
      provider: 'neon',
      role: 'session_owner',
      database: 'session_app',
    })

    const events = await listSessionEvents(db, h.row.tenantId, h.row.id)
    expect(events.find(e => e.type === 'preview.ready')?.data).toEqual({ port: 5173 })
    // The boot checklist, in readable words, each step running → done.
    const steps = events
      .filter(e => e.type === 'step')
      .map(e => e.data as { key: string; status: string; label: string })
    expect(steps.filter(s => s.status === 'done').map(s => s.label)).toEqual([
      BOOT_STEP_LABELS.db,
      BOOT_STEP_LABELS.sandbox,
      BOOT_STEP_LABELS.repo,
      BOOT_STEP_LABELS.bootstrap,
      BOOT_STEP_LABELS.dev,
    ])

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, h.row.tenantId), eq(auditEvents.targetId, h.row.id)))
    expect(audit.map(a => a.action)).toContain('session.ended')
  })

  it('puts no secret in any step result or event', async () => {
    const h = await harness()
    const run = await drive(h, async () => {
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    // The database URI the bootstrap got is the one secret the container holds.
    const bootstrap = h
      .sandbox()
      .backgroundRuns.find(r => r.command.includes('scripts/bootstrap.mjs'))
    const uri = bootstrap?.opts?.env?.LAUNCH_DB_URL ?? ''
    expect(uri).toMatch(/^postgresql:\/\/session_owner:.+@/)
    const password = decodeURIComponent(new URL(uri).password)
    expect(password.length).toBeGreaterThan(4)
    // Not in the command line either — only in the command's environment.
    expect(bootstrap?.command).not.toContain(password)

    const everything = JSON.stringify({
      results: run.results,
      events: await listSessionEvents(db, h.row.tenantId, h.row.id),
    })
    expect(everything).not.toContain(password)
    expect(everything).not.toContain(uri)
    expect(everything).not.toMatch(/sk-ant-|x-access-token/)
  })

  it('the running bootstrap step shows the kit’s latest ✔ n/10 line — one event per change', async () => {
    const h = await harness()
    h.ports.script(sandbox =>
      sandbox.onBackground(/scripts\/bootstrap\.mjs/, {
        log: ['✔ 1/10 toolchain  ok\n', '  a note\n', '✔ 4/10 database   ok\n', 'child output\n'],
      })
    )
    await drive(
      h,
      async () => {
        await patch(h.row, { requestedAction: 'end' })
        return WAKE
      },
      { commandPollMs: 1 }
    )
    const bootstrap = (await listSessionEvents(db, h.row.tenantId, h.row.id))
      .filter(e => e.type === 'step')
      .map(e => e.data as { key: string; status: string; detail?: string })
      .filter(d => d.key === 'bootstrap')
    expect(bootstrap.map(d => [d.status, d.detail])).toEqual([
      ['running', undefined],
      ['running', INSTALL_PROGRESS],
      ['running', BOOTSTRAP_PROGRESS],
      ['running', '✔ 1/10 toolchain'],
      ['running', '✔ 4/10 database'],
      ['done', undefined],
    ])
  })

  it('a failure at bootstrap marks the session failed, destroys the sandbox and deletes the branch', async () => {
    const h = await harness()
    h.ports.script(sandbox =>
      sandbox.onBackground(/scripts\/bootstrap\.mjs/, {
        exitCode: 1,
        log: '✖ 5/10 migrate   relation "users" already exists',
      })
    )
    const sandbox = h.sandbox()
    const run = await drive(h, () => {
      throw new Error('the loop must not be reached')
    })

    expect(run.names).toEqual([
      'claim',
      'db',
      'sandbox.start',
      'repo',
      'bootstrap',
      'fail',
      'cleanup',
    ])
    expect(sandbox.destroyed).toBe(true)
    expect(h.cloud.neon.branchNamed(h.f.neonProjectId, `session-${h.row.shortId}`)).toBeUndefined()
    const after = await reload(h.row)
    expect(after.status).toBe('failed')
    expect(after.error).toContain("The app's bootstrap failed")
    expect(after.dbUriSealed).toBeNull()
    const events = await listSessionEvents(db, h.row.tenantId, h.row.id)
    const failedStep = events.find(
      e => e.type === 'step' && (e.data as { status: string }).status === 'error'
    )
    expect(failedStep?.data).toMatchObject({ key: 'bootstrap', label: BOOT_STEP_LABELS.bootstrap })
    expect(events.at(-1)?.type).toBe('status')
  })

  it('prepares an unprepared app’s dev inline, then branches from it', async () => {
    const h = await harness({ prepared: false })
    const run = await drive(h, async () => {
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names.slice(0, 8)).toEqual([
      'claim',
      'db',
      'sandbox.start',
      'repo',
      'prepare',
      'branch',
      'bootstrap',
      'dev',
    ])
    const dev = h.cloud.neon.branchNamed(h.f.neonProjectId, 'dev')
    expect(dev?.init_source).toBe('schema-only')
    expect(dev?.roles.has('session_owner')).toBe(true)
    const [app] = await db.query.apps.findMany({
      where: (a, { and: all, eq: is }) => all(is(a.tenantId, h.f.tenant.id), is(a.id, h.f.app.id)),
    })
    expect(app?.sessionDb).toMatchObject({
      devBranchId: dev?.id,
      status: 'ready',
      preparedCommit: BASE_SHA,
      migrationsHash: 'a'.repeat(64),
    })
    // The bootstrap ran twice: once into dev (migrate + seed; never the database check), once into
    // the session's own branch — which starts from dev's migrations, so it touches no database.
    expect(bootstrapSkips(h.sandbox())).toEqual(['db-check', 'seed,db-check,migrate'])
    expect((await reload(h.row)).migrationsHash).toBe('a'.repeat(64))
  })

  it('a first boot on a ready dev with the same migrations touches no database; newer ones migrate', async () => {
    for (const [devHash, skips] of [
      ['a'.repeat(64), 'seed,db-check,migrate'],
      ['b'.repeat(64), 'seed,db-check'],
    ] as const) {
      const h = await harness()
      const prepared = h.f.app.sessionDb
      await db
        .update(apps)
        .set({ sessionDb: { ...(prepared as AppSessionDb), migrationsHash: devHash } })
        .where(eq(apps.id, h.f.app.id))
      await drive(h, async () => {
        await patch(h.row, { requestedAction: 'end' })
        return WAKE
      })
      expect(bootstrapSkips(h.sandbox())).toEqual([skips])
    }
  })

  it('a session branched while dev is still being prepared elsewhere seeds its own branch', async () => {
    const h = await harness()
    const prepared = h.f.app.sessionDb as AppSessionDb
    // Another live session holds the prepare claim.
    const holder = await insertSession(db, h.f, { status: 'booting' })
    await db
      .update(apps)
      .set({
        sessionDb: {
          ...prepared,
          status: 'preparing',
          preparingSessionId: holder.id,
          preparingSince: new Date().toISOString(),
        },
      })
      .where(eq(apps.id, h.f.app.id))
    await drive(h, async () => {
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(bootstrapSkips(h.sandbox())).toEqual(['db-check'])
  })
})

describe('SessionWorkflow: the loop', () => {
  it('runs a pending message at once after boot (3c’s runTurn); an end inside the debounce still saves', async () => {
    const h = await harness()
    await patch(h.row, { pendingMessage: 'Change the Home heading' })
    const run = await drive(h, async () => {
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names.slice(6)).toEqual([
      'inspect#0',
      'turn#0',
      'inspect#1',
      'wait#1',
      'inspect#2',
      'end#2',
      'cleanup',
    ])
    // No checkpoint straight after the turn: the wait is the debounce; the end saves.
    expect(run.waits[0]?.timeout).toBe('30 seconds')
    expect(h.checkpoints).toEqual(['end'])
    const types = await typesOf(h.row)
    expect(types).toEqual(expect.arrayContaining(['user.message', 'turn.start', 'turn.end']))
    expect((await reload(h.row)).turnCount).toBe(1)
  })

  it('a checkpoint that times out is a readable error event, and the session takes the next turn', async () => {
    let failed = 0
    const h = await harness({
      hooks: {
        checkpoint: async (_ctx, reason) => {
          if (reason === 'turn' && failed++ === 0) {
            throw new CheckpointError('add', 'the add did not finish within 120 s (timed out)')
          }
        },
      },
    })
    await patch(h.row, { pendingMessage: 'Change the Home heading' })
    await drive(h, async (_wait, n) => {
      // The debounce times out: the checkpoint runs, and fails.
      if (n === 0) return undefined
      if (n === 1) {
        expect((await reload(h.row)).status).toBe('ready')
        await patch(h.row, { pendingMessage: 'And make it blue' })
        return WAKE
      }
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    const events = await listSessionEvents(db, h.row.tenantId, h.row.id)
    const error = events.find(e => e.type === 'error')
    expect((error?.data as { message?: string } | undefined)?.message).toBe(
      "Could not save the session's work: Checkpoint failed at add: the add did not finish within 120 s (timed out)"
    )
    expect(events.filter(e => e.type === 'turn.end')).toHaveLength(2)
    expect((await reload(h.row)).turnCount).toBe(2)
  })

  it('idle → suspend keeps the container → a resume inside the warm window reuses it', async () => {
    const h = await harness()
    const run = await drive(h, async (_wait, n) => {
      if (n === 0) {
        // Nobody came: the idle timeout, the whole idle window gone by.
        await patch(h.row, { lastActivityAt: new Date(Date.now() - 31 * 60_000) })
        return undefined
      }
      if (n === 1) {
        const suspended = await reload(h.row)
        expect(suspended.status).toBe('suspended')
        expect(suspended.containerKeptAt).toBeInstanceOf(Date)
        // Checkpointed, but the container, its workspace and its dev server are still there.
        expect(h.sandbox().destroyed).toBe(false)
        await patch(h.row, { requestedAction: 'resume', pendingMessage: 'And make it blue' })
        return WAKE
      }
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })

    expect(run.names).toEqual([
      'claim',
      'db',
      'sandbox.start',
      'repo',
      'bootstrap',
      'dev',
      'inspect#0',
      'wait#0',
      'suspend#0',
      'inspect#1',
      'wait#1',
      'inspect#2',
      'resume#2',
      'sandbox.start#1',
      'dev#1',
      'inspect#3',
      'turn#3',
      'inspect#4',
      'wait#4',
      'inspect#5',
      'end#5',
      'cleanup',
    ])
    expect(new Set(run.names).size).toBe(run.names.length)
    expect(h.checkpoints).toEqual(['suspend', 'end'])
    const sandbox = h.sandbox()
    // No second clone, install or bootstrap, and the running dev server was reused.
    expect(sandbox.execs.filter(e => e.command.includes('git init'))).toHaveLength(1)
    expect(sandbox.backgroundRuns.filter(r => r.command.includes('pnpm install'))).toHaveLength(1)
    expect(
      sandbox.backgroundRuns.filter(r => r.command.includes('scripts/bootstrap.mjs'))
    ).toHaveLength(1)
    expect(sandbox.processes.filter(p => p.command === DEV_START_COMMAND)).toHaveLength(1)
    expect(sandbox.startCount).toBe(2)
    expect(sandbox.destroyCount).toBe(1) // cleanup's
    // The idle wait used the policy's idle timeout; the suspended one the warm window.
    expect(run.waits[0]?.timeout).toBe('30 minutes')
    expect(run.waits[1]?.timeout).toBe(`${SESSION_WARM_KEEP_MINUTES} minutes`)
    const after = await reload(h.row)
    expect(after).toMatchObject({ status: 'ended', turnCount: 1, containerKeptAt: null })
  })

  it('a warm resume keeps the session database on the allow-list', async () => {
    const h = await harness()
    let hosts: string[] = []
    await drive(h, async (_wait, n) => {
      if (n === 0) {
        await patch(h.row, { lastActivityAt: new Date(Date.now() - 31 * 60_000) })
        return undefined
      }
      if (n === 1) {
        // What the start re-applies: pretend the list was reset to the base one meanwhile.
        await h.sandbox().setAllowedHosts(['registry.npmjs.org'])
        await patch(h.row, { requestedAction: 'resume' })
        return WAKE
      }
      hosts = [...h.sandbox().allowedHosts]
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(hosts.some(host => host.includes('neon'))).toBe(true)
  })

  it('a warm resume whose dev server stopped answering restarts it', async () => {
    const h = await harness()
    await drive(h, async (_wait, n) => {
      if (n === 0) {
        await patch(h.row, { lastActivityAt: new Date(Date.now() - 31 * 60_000) })
        return undefined
      }
      if (n === 1) {
        // The kept dev server died while the session waited.
        h.sandbox().ports.clear()
        await patch(h.row, { requestedAction: 'resume' })
        return WAKE
      }
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    const sandbox = h.sandbox()
    expect(sandbox.execs.some(e => e.command === DEV_STOP_COMMAND)).toBe(true)
    expect(sandbox.processes.filter(p => p.command === DEV_START_COMMAND)).toHaveLength(2)
    expect(sandbox.execs.filter(e => e.command.includes('git init'))).toHaveLength(1)
  })

  it('a kept container that was recreated meanwhile (no boot marker) resumes cold', async () => {
    const h = await harness()
    const run = await drive(h, async (_wait, n) => {
      if (n === 0) {
        await patch(h.row, { lastActivityAt: new Date(Date.now() - 31 * 60_000) })
        return undefined
      }
      if (n === 1) {
        h.sandbox().recreate()
        await patch(h.row, { requestedAction: 'resume' })
        return WAKE
      }
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names.slice(12, 19)).toEqual([
      'resume#2',
      'sandbox.start#1',
      'restore.check#1',
      'repo#1',
      'bootstrap#1',
      'dev#1',
      'transcript#1',
    ])
    expect(h.sandbox().execs.filter(e => e.command.includes('git init'))).toHaveLength(2)
  })

  it('past the warm window the container is cooled; a later resume clones again and restores the transcript', async () => {
    const h = await harness()
    const claudeSessionId = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
    await h.env.FILES.put(`sessions/${h.row.id}/claude.jsonl`, '{"type":"user"}\n')
    let transcript: string | undefined
    const run = await drive(h, async (_wait, n) => {
      if (n === 0) {
        await patch(h.row, { lastActivityAt: new Date(Date.now() - 31 * 60_000) })
        return undefined
      }
      if (n === 1) {
        // Nobody came back inside the warm window either.
        return undefined
      }
      if (n === 2) {
        const cooled = await reload(h.row)
        expect(cooled).toMatchObject({ status: 'suspended', containerKeptAt: null })
        expect(h.sandbox().destroyed).toBe(true)
        // The last checkpoint recorded the transcript; the person comes back with a message.
        await patch(h.row, {
          requestedAction: 'resume',
          pendingMessage: 'And make it blue',
          transcriptKey: `sessions/${h.row.id}/claude.jsonl`,
          claudeSessionId,
        })
        return WAKE
      }
      transcript = h.sandbox().files.get(claudeTranscriptPath(claudeSessionId))
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })

    expect(run.names).toEqual([
      'claim',
      'db',
      'sandbox.start',
      'repo',
      'bootstrap',
      'dev',
      'inspect#0',
      'wait#0',
      'suspend#0',
      'inspect#1',
      'wait#1',
      'cool#1',
      'inspect#2',
      'wait#2',
      'inspect#3',
      'resume#3',
      'sandbox.start#1',
      'restore.check#1',
      'repo#1',
      'bootstrap#1',
      'dev#1',
      'transcript#1',
      'inspect#4',
      'turn#4',
      'inspect#5',
      'wait#5',
      'inspect#6',
      'end#6',
      'cleanup',
    ])
    expect(new Set(run.names).size).toBe(run.names.length)
    expect(h.checkpoints).toEqual(['suspend', 'end'])
    const sandbox = h.sandbox()
    expect(sandbox.execs.filter(e => e.command.includes('git init'))).toHaveLength(2)
    expect(sandbox.startCount).toBe(2)
    // Restored where `--resume` finds it (the file is written after the second boot).
    expect(transcript).toBe('{"type":"user"}\n')
    expect(run.waits.map(w => w.timeout)).toEqual([
      '30 minutes',
      `${SESSION_WARM_KEEP_MINUTES} minutes`,
      `${24 * 60} minutes`,
      // The turn changed the workspace: the checkpoint debounce.
      '30 seconds',
    ])
    expect(await reload(h.row)).toMatchObject({ status: 'ended', turnCount: 1 })
    // The first boot is on a branch of a ready dev whose migrations hash was never recorded: no
    // seed, no check, a migrate. The cold resume's: no migrate either — nothing changed.
    expect(bootstrapSkips(sandbox)).toEqual(['seed,db-check', 'seed,db-check,migrate'])
  })

  it('a cold resume migrates when the checkout’s migrations changed, and still never re-seeds', async () => {
    const h = await harness()
    const run = await drive(h, async (_wait, n) => {
      if (n === 0) {
        expect((await reload(h.row)).migrationsHash).toBe('a'.repeat(64))
        // A turn added a migration; then a drain destroys the container.
        migrations.hash = 'b'.repeat(64)
        paused.value = true
        return WAKE
      }
      if (n === 1) {
        paused.value = false
        await patch(h.row, { requestedAction: 'resume' })
        return WAKE
      }
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names).toContain('bootstrap#1')
    expect(bootstrapSkips(h.sandbox())).toEqual(['seed,db-check', 'seed,db-check'])
    expect(run.results).toContainEqual(expect.objectContaining({ migrated: true, seeded: false }))
    expect((await reload(h.row)).migrationsHash).toBe('b'.repeat(64))
  })

  it('a drain cools a warm-suspended session at once', async () => {
    const h = await harness()
    const run = await drive(h, async (_wait, n) => {
      if (n === 0) {
        await patch(h.row, { lastActivityAt: new Date(Date.now() - 31 * 60_000) })
        return undefined
      }
      if (n === 1) {
        paused.value = true
        return WAKE
      }
      return undefined
    })
    expect(run.names.slice(8)).toEqual([
      'suspend#0',
      'inspect#1',
      'wait#1',
      'inspect#2',
      'cool#2',
      'inspect#3',
      'wait#3',
      'end#3',
      'cleanup',
    ])
    expect(h.sandbox().destroyCount).toBe(2) // the cool, then cleanup's
  })

  it('an idle timeout while the person was using the preview does not suspend; it waits out the rest', async () => {
    const h = await harness()
    const run = await drive(h, async (_wait, n) => {
      if (n === 0) {
        // No turn, no wake — but the preview gateway bumped the activity 5 minutes ago.
        await patch(h.row, { lastActivityAt: new Date(Date.now() - 5 * 60_000) })
        return undefined
      }
      expect((await reload(h.row)).status).toBe('ready')
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names.slice(6)).toEqual([
      'inspect#0',
      'wait#0',
      'suspend#0',
      'inspect#1',
      'wait#1',
      'inspect#2',
      'end#2',
      'cleanup',
    ])
    // Not suspended: no suspend checkpoint, and the second wait is only what is left of the window.
    expect(h.checkpoints).toEqual(['end'])
    expect(run.waits[0]?.timeout).toBe('30 minutes')
    expect(run.waits[1]?.timeout).toBe('25 minutes')
    expect(await typesOf(h.row)).not.toContain('turn.start')
    const statuses = (await listSessionEvents(db, h.row.tenantId, h.row.id))
      .filter(e => e.type === 'status')
      .map(e => (e.data as { status?: string }).status)
    expect(statuses).not.toContain('suspended')
  })

  it('a rollout under a turn: turn.interrupted, suspended, no checkpoint', async () => {
    const h = await harness()
    await patch(h.row, { pendingMessage: 'Change the Home heading' })
    let armed = false
    h.hooks.runTurn = async ctx => {
      if (!armed) {
        armed = true
        h.sandbox().interruptNext()
      }
      return runTurn(ctx.db, ctx.ports, ctx.session, { sleep: tick, cancelPollMs: 5, flushMs: 5 })
    }
    const run = await drive(h, async () => {
      const suspended = await reload(h.row)
      expect(suspended.status).toBe('suspended')
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names.slice(6, 10)).toEqual(['inspect#0', 'turn#0', 'rollout#0', 'inspect#1'])
    expect(run.names).not.toContain('checkpoint#0')
    expect(h.checkpoints).toEqual([])
    const events = await listSessionEvents(db, h.row.tenantId, h.row.id)
    expect(events.find(e => e.type === 'turn.interrupted')?.data).toMatchObject({
      reason: 'rollout',
    })
    expect(h.sandbox().interruptions).toBe(1)
    expect((await reload(h.row)).status).toBe('ended')
  })

  it('a SandboxInterruptedError thrown out of the turn hook is a rollout too', async () => {
    const h = await harness()
    await patch(h.row, { pendingMessage: 'go' })
    h.hooks.runTurn = async ctx => {
      await ctx.db
        .update(sessions)
        .set({ status: 'working', pendingMessage: null, turnCount: 1 })
        .where(and(eq(sessions.tenantId, h.row.tenantId), eq(sessions.id, h.row.id)))
      const { SandboxInterruptedError } = await import('@/api/services/sessions/ports')
      throw new SandboxInterruptedError()
    }
    await drive(h, async () => {
      expect((await reload(h.row)).status).toBe('suspended')
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(await typesOf(h.row)).toContain('turn.interrupted')
  })

  it('a drain suspends a live session; a suspended one past its expiry ends', async () => {
    const h = await harness()
    const run = await drive(h, async (_wait, n) => {
      if (n === 0) {
        paused.value = true
        return WAKE
      }
      // Suspended, and nobody resumes it: the expiry timeout.
      return undefined
    })
    expect(run.names.slice(6)).toEqual([
      'inspect#0',
      'wait#0',
      'inspect#1',
      'suspend#1',
      'inspect#2',
      'wait#2',
      'end#2',
      'cleanup',
    ])
    const events = await listSessionEvents(db, h.row.tenantId, h.row.id)
    expect(
      events.some(e => e.type === 'status' && (e.data as { reason?: string }).reason === 'drain')
    ).toBe(true)
    expect((await reload(h.row)).status).toBe('ended')
  })

  it('ship: shipped leaves the loop and cleans up; a red gate goes back to ready', async () => {
    const h = await harness({
      hooks: {
        ship: async ctx => {
          const shipping = ctx.session.turnCount === 0 ? 'ready' : 'shipped'
          await ctx.db
            .update(sessions)
            .set({ status: shipping, turnCount: ctx.session.turnCount + 1, requestedAction: null })
            .where(and(eq(sessions.tenantId, h.row.tenantId), eq(sessions.id, h.row.id)))
        },
      },
    })
    const run = await drive(h, async () => {
      await patch(h.row, { requestedAction: 'ship' })
      return WAKE
    })
    expect(run.names.slice(6)).toEqual([
      'inspect#0',
      'wait#0',
      'inspect#1',
      'ship#1',
      'inspect#2',
      'wait#2',
      'inspect#3',
      'ship#3',
      'cleanup',
    ])
    const after = await reload(h.row)
    expect(after.status).toBe('shipped')
    expect(after.endedAt).toBeInstanceOf(Date)
    expect(h.sandbox().destroyed).toBe(true)
    expect(h.cloud.neon.branchNamed(h.f.neonProjectId, `session-${h.row.shortId}`)).toBeUndefined()
  })

  it('a lost instance under a live session whose container is gone: salvage saves nothing and it starts over from its branch', async () => {
    const h = await harness()
    // A fresh instance finds a `ready` row: the instance that booted it is gone.
    const cfg = loadConfig(h.env)
    await patch(h.row, {
      status: 'ready',
      baseSha: BASE_SHA,
      dbUriSealed: await encryptToken(
        cfg,
        'postgresql://session_owner:pw@ep-x.us-east-2.aws.neon.tech/session_app'
      ),
    })
    const run = await drive(h, async () => {
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    // No boot marker: nothing to stop, nothing to checkpoint.
    expect(h.checkpoints).not.toContain('salvage')
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
    // The old container was destroyed before starting over.
    expect(h.sandbox().destroyCount).toBeGreaterThanOrEqual(2)
    expect((await reload(h.row)).status).toBe('ended')
  })

  it('a lost instance under a live session whose container is still up: salvage stops the orphaned turn, checkpoints, and resumes WARM onto it', async () => {
    const h = await harness()
    const cfg = loadConfig(h.env)
    await patch(h.row, {
      status: 'ready',
      baseSha: BASE_SHA,
      dbUriSealed: await encryptToken(
        cfg,
        'postgresql://session_owner:pw@ep-x.us-east-2.aws.neon.tech/session_app'
      ),
    })
    h.sandbox().files.set(SESSION_BOOT_MARKER, 'boot-of-the-lost-instance')
    let destroysAtWait: number | undefined
    const run = await drive(h, async () => {
      destroysAtWait ??= h.sandbox().destroyCount
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names.slice(0, 6)).toEqual([
      'claim',
      'salvage',
      'inspect#0',
      'resume#0',
      'sandbox.start#1',
      'dev#1',
    ])
    expect(new Set(run.names).size).toBe(run.names.length)
    expect(h.checkpoints[0]).toBe('salvage')
    expect(h.sandbox().execs.some(e => e.command === turnKillScript())).toBe(true)
    expect(destroysAtWait).toBe(0)
    // A `ready` session had no turn to close: no turn.failed, no error.
    const types = await typesOf(h.row)
    expect(types).not.toContain('turn.failed')
    expect(types).not.toContain('error')
  })
})

describe('SessionWorkflow: debounced checkpoints', () => {
  /** The turn steps' results, in order. */
  const turnResults = (run: { results: unknown[] }) =>
    run.results.filter(
      (r): r is TurnStepResult =>
        typeof r === 'object' && r !== null && 'status' in r && 'changed' in r
    )

  it('a turn that changed nothing is not checkpointed, and the wait is the idle one', async () => {
    const h = await harness({ turnsChange: false })
    await patch(h.row, { pendingMessage: 'What does the Home page do?' })
    const run = await drive(h, async () => {
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names.slice(6)).toEqual([
      'inspect#0',
      'turn#0',
      'inspect#1',
      'wait#1',
      'inspect#2',
      'end#2',
      'cleanup',
    ])
    expect(turnResults(run)).toEqual([
      expect.objectContaining({ status: 'completed', changed: false, checkpointNow: false }),
    ])
    expect(run.waits[0]?.timeout).toBe('30 minutes')
    expect(h.checkpoints).toEqual(['end'])
  })

  it('a changed turn waits out the debounce, then checkpoints and waits on — it does not suspend', async () => {
    const h = await harness()
    await patch(h.row, { pendingMessage: 'Change the Home heading' })
    const run = await drive(h, async (_wait, n) => {
      if (n === 0) return undefined // quiet for 30 s
      expect((await reload(h.row)).status).toBe('ready')
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names.slice(6)).toEqual([
      'inspect#0',
      'turn#0',
      'inspect#1',
      'wait#1',
      'checkpoint#1',
      'inspect#2',
      'wait#2',
      'inspect#3',
      'end#3',
      'cleanup',
    ])
    expect(new Set(run.names).size).toBe(run.names.length)
    const [turn] = turnResults(run)
    expect(turn).toMatchObject({ status: 'completed', changed: true, checkpointNow: false })
    expect(Number.isNaN(Date.parse(turn?.endedAt ?? ''))).toBe(false)
    // The debounce, then (saved) the idle window again.
    expect(run.waits.map(w => w.timeout)).toEqual(['30 seconds', '30 minutes'])
    expect(h.checkpoints).toEqual(['turn', 'end'])
    const statuses = (await listSessionEvents(db, h.row.tenantId, h.row.id))
      .filter(e => e.type === 'status')
      .map(e => (e.data as { status?: string }).status)
    expect(statuses).not.toContain('suspended')
  })

  it('a message inside the debounce runs first; one checkpoint follows the burst', async () => {
    const h = await harness()
    await patch(h.row, { pendingMessage: 'Change the Home heading' })
    const run = await drive(h, async (_wait, n) => {
      if (n === 0) {
        await patch(h.row, { pendingMessage: 'And make it blue' })
        return WAKE
      }
      if (n === 1) return undefined // quiet for 30 s after the SECOND turn
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names.slice(6)).toEqual([
      'inspect#0',
      'turn#0',
      'inspect#1',
      'wait#1',
      'inspect#2',
      'turn#2',
      'inspect#3',
      'wait#3',
      'checkpoint#3',
      'inspect#4',
      'wait#4',
      'inspect#5',
      'end#5',
      'cleanup',
    ])
    expect(run.waits.map(w => w.timeout)).toEqual(['30 seconds', '30 seconds', '30 minutes'])
    expect(h.checkpoints).toEqual(['turn', 'end'])
    expect((await reload(h.row)).turnCount).toBe(2)
  })

  it('a session dirty for the cap checkpoints straight after its next turn, however busy', async () => {
    const h = await harness()
    await patch(h.row, { pendingMessage: 'Message 0' })
    const clock = { ms: Date.now() }
    let messages = 0
    const run = await drive(
      h,
      async () => {
        if (h.checkpoints.includes('turn')) {
          await patch(h.row, { requestedAction: 'end' })
          return WAKE
        }
        // A message 25 s after the last turn — always inside the debounce.
        clock.ms += 25_000
        await patch(h.row, { pendingMessage: `Message ${++messages}` })
        return WAKE
      },
      undefined,
      () => new Date(clock.ms)
    )
    // Turns end at 0 s, 25 s … 300 s: the thirteenth (turn#24, 5 min after the first) saves.
    const turns = run.names.filter(name => name.startsWith('turn#'))
    expect(turns).toHaveLength(13)
    const checkpointAt = run.names.indexOf('checkpoint#24')
    expect(checkpointAt).toBeGreaterThan(0)
    expect(run.names[checkpointAt - 1]).toBe('turn#24')
    expect(run.names.filter(name => name.startsWith('checkpoint#'))).toEqual(['checkpoint#24'])
    expect(turnResults(run).map(r => r.checkpointNow)).toEqual([...Array(12).fill(false), true])
    // Each debounce wait is 30 s — except the last, cut to what is left of the cap.
    expect(run.waits.map(w => w.timeout)).toEqual([
      ...Array(11).fill('30 seconds'),
      '25 seconds',
      // Saved: the idle wait (counted on the fake clock, which ran ahead of the turns' stamps).
      expect.stringMatching(/^\d+ minutes$/),
    ])
    expect(h.checkpoints).toEqual(['turn', 'end'])
  })

  it('an idle suspend while dirty still saves first (the suspend checkpoints)', async () => {
    const h = await harness()
    await patch(h.row, { pendingMessage: 'Change the Home heading' })
    const run = await drive(
      h,
      async (_wait, n) => {
        if (n === 0) {
          await patch(h.row, { lastActivityAt: new Date(Date.now() - 31 * 60_000) })
          return undefined
        }
        expect((await reload(h.row)).status).toBe('suspended')
        await patch(h.row, { requestedAction: 'end' })
        return WAKE
      },
      // A debounce (and cap) longer than the idle window: the wait is the idle one, dirty or not.
      { checkpointDebounceMs: 60 * 60_000, checkpointMaxDeferMs: 2 * 60 * 60_000 }
    )
    expect(run.names.slice(6)).toEqual([
      'inspect#0',
      'turn#0',
      'inspect#1',
      'wait#1',
      'suspend#1',
      'inspect#2',
      'wait#2',
      'inspect#3',
      'end#3',
      'cleanup',
    ])
    expect(run.waits[0]?.timeout).toBe('30 minutes')
    expect(h.checkpoints).toEqual(['suspend'])
  })

  it('a dirty check that fails counts as changed', async () => {
    const h = await harness({ turnsChange: false })
    h.workspace.broken = true
    await patch(h.row, { pendingMessage: 'Change the Home heading' })
    const run = await drive(h, async () => {
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(turnResults(run)).toEqual([expect.objectContaining({ changed: true })])
    expect(run.waits[0]?.timeout).toBe('30 seconds')
  })
})

describe('checkpoint debounce arithmetic', () => {
  const t0 = Date.parse('2026-09-28T10:00:00.000Z')
  const iso = (ms: number) => new Date(t0 + ms).toISOString()

  it('is due the debounce after the latest turn, or the cap after the first change', () => {
    const dirty = { dirtySince: iso(0), lastTurnAt: iso(0) }
    expect(checkpointDueInMs(dirty, new Date(t0))).toBe(SESSION_CHECKPOINT_DEBOUNCE_MS)
    expect(checkpointDueInMs(dirty, new Date(t0 + 10_000))).toBe(20_000)
    expect(checkpointDueInMs(dirty, new Date(t0 + 45_000))).toBe(-15_000)
    // A late turn: the debounce would run past the cap, so the cap wins.
    const busy = { dirtySince: iso(0), lastTurnAt: iso(SESSION_CHECKPOINT_MAX_DEFER_MS - 10_000) }
    expect(checkpointDueInMs(busy, new Date(t0 + SESSION_CHECKPOINT_MAX_DEFER_MS - 10_000))).toBe(
      10_000
    )
    // Limits shrink both.
    expect(
      checkpointDueInMs(dirty, new Date(t0), {
        ...SESSION_CALL_LIMITS,
        checkpointDebounceMs: 5_000,
      })
    ).toBe(5_000)
    expect(
      checkpointDueInMs(dirty, new Date(t0), {
        ...SESSION_CALL_LIMITS,
        checkpointMaxDeferMs: 1_000,
      })
    ).toBe(1_000)
  })

  it('renders a wait as minutes when whole, else seconds (at least one)', () => {
    expect(waitDuration(30 * 60)).toBe('30 minutes')
    expect(waitDuration(30)).toBe('30 seconds')
    expect(waitDuration(0.2)).toBe('1 seconds')
    expect(waitDuration(0)).toBe('1 seconds')
    expect(waitDuration(90)).toBe('90 seconds')
  })

  it('keeps the first change, moves the debounce, and forgets a clean workspace', () => {
    const first: TurnStepResult = { status: 'completed', changed: true, endedAt: iso(0) }
    const dirty = dirtyAfterTurn(null, first)
    expect(dirty).toEqual({ dirtySince: iso(0), lastTurnAt: iso(0) })
    expect(
      dirtyAfterTurn(dirty, { status: 'completed', changed: true, endedAt: iso(20_000) })
    ).toEqual({ dirtySince: iso(0), lastTurnAt: iso(20_000) })
    expect(
      dirtyAfterTurn(dirty, { status: 'completed', changed: false, endedAt: iso(20_000) })
    ).toBeNull()
    // A turn that never ran (skipped, blocked) leaves it as it was.
    expect(dirtyAfterTurn(dirty, { status: 'skipped' })).toBe(dirty)
  })
})

describe('workspaceChanged', () => {
  const sandboxAnswering = (script: Parameters<FakeSandbox['onExec']>[1]) =>
    new FakeSandbox().onExec(WORKSPACE_CHANGED_SCRIPT, script)

  it('is clean only when nothing is uncommitted and HEAD is the row’s head_sha', async () => {
    expect(
      await workspaceChanged(sandboxAnswering({ stdout: `${BASE_SHA}\nclean\n` }), BASE_SHA)
    ).toBe(false)
    expect(
      await workspaceChanged(sandboxAnswering({ stdout: `${BASE_SHA}\ndirty\n` }), BASE_SHA)
    ).toBe(true)
    // The turn committed on its own: HEAD moved.
    expect(
      await workspaceChanged(sandboxAnswering({ stdout: `${'f'.repeat(40)}\nclean\n` }), BASE_SHA)
    ).toBe(true)
  })

  it('runs in the checkout with the checkpoint’s git conventions and a bounded timeout', async () => {
    const sandbox = sandboxAnswering({ stdout: `${BASE_SHA}\nclean\n` })
    await workspaceChanged(sandbox, BASE_SHA)
    expect(sandbox.execs[0]?.opts).toMatchObject({
      cwd: SESSION_WORKSPACE,
      timeoutMs: WORKSPACE_CHANGED_TIMEOUT_MS,
      env: { HOME: SESSION_HOME, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
  })

  it('fails safe: an error, a throw or an odd answer is a change', async () => {
    expect(await workspaceChanged(sandboxAnswering({ exitCode: 128 }), BASE_SHA)).toBe(true)
    expect(await workspaceChanged(sandboxAnswering({ stdout: '' }), BASE_SHA)).toBe(true)
    expect(await workspaceChanged(sandboxAnswering({ stdout: `${BASE_SHA}\n` }), BASE_SHA)).toBe(
      true
    )
    const throwing = sandboxAnswering(() => {
      throw new Error('exec timed out')
    })
    expect(await workspaceChanged(throwing, BASE_SHA)).toBe(true)
  })
})

describe('SessionWorkflow: workspace backups', () => {
  /** Idle past the idle window, then past the warm window: the container is cooled (backed up). */
  const coolThenResume =
    (h: Harness, between?: () => Promise<void>, after?: () => void) =>
    async (_wait: RecordedWait, n: number) => {
      if (n === 0) {
        await patch(h.row, { lastActivityAt: new Date(Date.now() - 31 * 60_000) })
        return undefined
      }
      if (n === 1) return undefined
      if (n === 2) {
        await between?.()
        await patch(h.row, { requestedAction: 'resume' })
        return WAKE
      }
      after?.()
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    }

  it('the cool backs the workspace up; a cold resume restores it instead of cloning and installing', async () => {
    const h = await harness()
    h.ports.script(sandbox => sandbox.onExec(/rev-parse HEAD/, { stdout: `${BASE_SHA}\n` }))
    let backup = null as SessionRow['workspaceBackup']
    let settings: string | undefined
    const run = await drive(
      h,
      coolThenResume(
        h,
        async () => {
          backup = (await reload(h.row)).workspaceBackup
        },
        () => {
          settings = h.sandbox().files.get('/workspace/app/.claude/settings.local.json')
        }
      )
    )
    expect(backup).toMatchObject({
      dir: '/workspace/app',
      headSha: BASE_SHA,
      imageVersion: SESSION_IMAGE_VERSION,
    })
    expect(run.names.slice(15, 22)).toEqual([
      'resume#3',
      'sandbox.start#1',
      'restore.check#1',
      'restore#1',
      'bootstrap#1',
      'dev#1',
      'transcript#1',
    ])
    const sandbox = h.sandbox()
    expect(sandbox.restores).toEqual([backup?.id])
    // One clone, one install, one kit bootstrap: the restored workspace needed none of them again.
    expect(sandbox.execs.filter(e => e.command.includes('git init'))).toHaveLength(1)
    expect(sandbox.backgroundRuns.filter(r => r.command.includes('pnpm install'))).toHaveLength(1)
    expect(bootstrapSkips(sandbox)).toEqual(['seed,db-check'])
    expect(run.results).toContainEqual(expect.objectContaining({ reused: true, migrated: false }))
    // The restored checkout's settings came back with it; the dev-server keys were re-written.
    expect(settings).toContain('git push')
    // Cleanup deletes the backup and forgets it.
    expect(sandbox.deletedBackups).toContain(backup?.id)
    expect((await reload(h.row)).workspaceBackup).toBeNull()
    const steps = (await listSessionEvents(db, h.row.tenantId, h.row.id)).filter(
      e => e.type === 'step' && (e.data as { key: string }).key === 'restore'
    )
    expect(steps.map(e => (e.data as { status: string }).status)).toEqual(['running', 'done'])
  })

  it('a backup the branch has moved past is not restored: the resume clones', async () => {
    const h = await harness()
    h.ports.script(sandbox => sandbox.onExec(/rev-parse HEAD/, { stdout: `${BASE_SHA}\n` }))
    const run = await drive(
      h,
      coolThenResume(h, async () => {
        // A later checkpoint (elsewhere) moved the branch head.
        await patch(h.row, { headSha: 'f'.repeat(40) })
      })
    )
    expect(run.names).toContain('restore.check#1')
    expect(run.names).not.toContain('restore#1')
    expect(run.names).toContain('repo#1')
    expect(h.sandbox().restores).toEqual([])
  })

  it('a restore that fails falls back to the clone, and the checklist says so', async () => {
    const h = await harness()
    h.ports.script(sandbox => sandbox.onExec(/rev-parse HEAD/, { stdout: `${BASE_SHA}\n` }))
    const run = await drive(
      h,
      coolThenResume(h, async () => {
        h.sandbox().failNext('restore', new Error('BACKUP_RESTORE_FAILED: unsquashfs exited 1'))
      })
    )
    expect(run.names.slice(16, 20)).toEqual([
      'sandbox.start#1',
      'restore.check#1',
      'restore#1',
      'repo#1',
    ])
    expect(h.sandbox().execs.filter(e => e.command.includes('git init'))).toHaveLength(2)
    const restore = (await listSessionEvents(db, h.row.tenantId, h.row.id)).find(
      e =>
        e.type === 'step' &&
        (e.data as { key: string; status: string }).key === 'restore' &&
        (e.data as { status: string }).status === 'done'
    )
    expect((restore?.data as { detail?: string } | undefined)?.detail).toMatch(/^Cloning instead: /)
    expect((await reload(h.row)).status).toBe('ended')
  })

  it('a drain backs up before it destroys; a presigned backup widens the allow-list only while it runs', async () => {
    const h = await harness()
    h.ports.script(sandbox => {
      sandbox.onExec(/rev-parse HEAD/, { stdout: `${BASE_SHA}\n` })
      sandbox.backupHosts = ['acct.r2.cloudflarestorage.com']
    })
    await drive(h, async (_wait, n) => {
      if (n === 0) {
        paused.value = true
        return WAKE
      }
      return undefined
    })
    const sandbox = h.sandbox()
    expect(sandbox.backupAllowedHosts).toHaveLength(1)
    expect(sandbox.backupAllowedHosts[0]).toContain('acct.r2.cloudflarestorage.com')
    expect(sandbox.backupAllowedHosts[0]?.some(host => host.includes('neon'))).toBe(true)
    expect(sandbox.allowedHosts).not.toContain('acct.r2.cloudflarestorage.com')
  })

  it('a backup that fails never fails the suspend', async () => {
    const h = await harness()
    h.ports.script(sandbox => sandbox.onExec(/rev-parse HEAD/, { stdout: `${BASE_SHA}\n` }))
    const run = await drive(h, async (_wait, n) => {
      if (n === 0) {
        h.sandbox().failNext('backup', new Error('BACKUP_CREATE_FAILED'))
        paused.value = true
        return WAKE
      }
      expect((await reload(h.row)).status).toBe('suspended')
      return undefined
    })
    expect(run.names).toContain('suspend#1')
    expect((await reload(h.row)).workspaceBackup).toBeNull()
  })

  it('with backups off, nothing is backed up', async () => {
    const h = await harness({ env: { SESSION_WORKSPACE_BACKUP: 'off' } })
    h.ports.script(sandbox => sandbox.onExec(/rev-parse HEAD/, { stdout: `${BASE_SHA}\n` }))
    const run = await drive(h, coolThenResume(h))
    expect(h.sandbox().backups.size).toBe(0)
    expect(run.names).toContain('repo#1')
  })
})

describe('the Sandbox Durable Object’s onStop', () => {
  it('forgets a container a warm suspend kept, and meters its time', async () => {
    const h = await harness()
    const { recordContainerStop } = await import('@/api/services/sessions/lifecycle')
    await patch(h.row, { status: 'suspended', sandboxId: 'do-warm-1', containerKeptAt: new Date() })
    await recordContainerStop(db, 'do-warm-1', 42)
    expect(await reload(h.row)).toMatchObject({
      status: 'suspended',
      containerKeptAt: null,
      containerSeconds: 42,
    })
  })
})
