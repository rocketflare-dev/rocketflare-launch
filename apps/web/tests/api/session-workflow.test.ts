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
import { SESSION_WAKE_EVENT, type SessionEventType } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptToken } from '@/api/auth/oauth-encryption'
import { CheckpointError } from '@/api/services/sessions/checkpoint'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import type { SessionCallLimits } from '@/api/services/sessions/deadline'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import type { SessionStepHooks } from '@/api/services/sessions/hooks'
import {
  claudeTranscriptPath,
  DEV_START_COMMAND,
  DEV_STOP_COMMAND,
  SESSION_IMAGE_VERSION,
} from '@/api/services/sessions/rocketflare-dev'
import { BOOT_STEP_LABELS, SESSION_BOOT_MARKER } from '@/api/services/sessions/steps'
import { runTurn, turnKillScript } from '@/api/services/sessions/turn'
import { SESSION_WARM_KEEP_MINUTES } from '@/api/services/sessions/warm'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import { auditEvents, type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { claudeStreamJson } from '../helpers/fake-anthropic'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import type { FakeSandbox } from '../helpers/fake-sandbox'
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
  sandbox.execs
    .filter(e => e.command.includes('scripts/bootstrap.mjs'))
    .map(e => e.opts?.env?.LAUNCH_BOOTSTRAP_SKIP ?? '')

interface Harness {
  env: TestEnv
  cloud: FakeCloud
  f: SessionAppFixture
  row: SessionRow
  ports: FakeSessionPorts
  hooks: SessionStepHooks
  checkpoints: string[]
  sandbox: () => FakeSandbox
}

/** A prepared app, a `requested` session, the ports and hooks, the sandbox scripted like a kit app. */
async function harness(
  opts: {
    prepared?: boolean
    hooks?: Partial<SessionStepHooks>
    env?: Parameters<typeof createTestEnv>[0]
  } = {}
): Promise<Harness> {
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
      .onProcess(/exec pnpm dev /, { lines: ['ready'], ports: [5173, 8787], hang: true })
      .onProcess(/claude -p/, claudeStreamJson({ text: 'Changed the heading.' }))
  )
  const checkpoints: string[] = []
  const hooks: SessionStepHooks = {
    runTurn: ctx =>
      runTurn(ctx.db, ctx.ports, ctx.session, {
        realtime: ctx.realtime,
        logger: ctx.logger,
        sleep: tick,
        cancelPollMs: 5,
        flushMs: 5,
      }),
    checkpoint: async (_ctx, reason) => {
      checkpoints.push(reason)
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
  limits?: Partial<SessionCallLimits>
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
  workflow.overrides = { ports: h.ports, hooks: h.hooks, limits }
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
    const commands = sandbox.execs.map(e => e.command)
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
    const bootstrap = h.sandbox().execs.find(e => e.command.includes('scripts/bootstrap.mjs'))
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

  it('a failure at bootstrap marks the session failed, destroys the sandbox and deletes the branch', async () => {
    const h = await harness()
    h.ports.script(sandbox =>
      sandbox.onExec(/scripts\/bootstrap\.mjs/, {
        exitCode: 1,
        stdout: '✖ 5/10 migrate   relation "users" already exists',
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
    })
    // The bootstrap ran twice: once into dev, once into the session's own branch.
    expect(h.sandbox().execs.filter(e => e.command.includes('scripts/bootstrap.mjs'))).toHaveLength(
      2
    )
  })
})

describe('SessionWorkflow: the loop', () => {
  it('runs a pending message at once after boot (3c’s runTurn), then checkpoints', async () => {
    const h = await harness()
    await patch(h.row, { pendingMessage: 'Change the Home heading' })
    const run = await drive(h, async () => {
      await patch(h.row, { requestedAction: 'end' })
      return WAKE
    })
    expect(run.names.slice(6)).toEqual([
      'inspect#0',
      'turn#0',
      'checkpoint#0',
      'inspect#1',
      'wait#1',
      'inspect#2',
      'end#2',
      'cleanup',
    ])
    expect(h.checkpoints).toEqual(['turn', 'end'])
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
      if (n === 0) {
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
      'checkpoint#3',
      'inspect#4',
      'wait#4',
      'inspect#5',
      'end#5',
      'cleanup',
    ])
    expect(new Set(run.names).size).toBe(run.names.length)
    expect(h.checkpoints).toEqual(['suspend', 'turn', 'end'])
    const sandbox = h.sandbox()
    // No second clone, install or bootstrap, and the running dev server was reused.
    expect(sandbox.execs.filter(e => e.command.includes('git init'))).toHaveLength(1)
    expect(sandbox.execs.filter(e => e.command.includes('pnpm install'))).toHaveLength(1)
    expect(sandbox.execs.filter(e => e.command.includes('scripts/bootstrap.mjs'))).toHaveLength(1)
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
      'checkpoint#4',
      'inspect#5',
      'wait#5',
      'inspect#6',
      'end#6',
      'cleanup',
    ])
    expect(new Set(run.names).size).toBe(run.names.length)
    expect(h.checkpoints).toEqual(['suspend', 'turn', 'end'])
    const sandbox = h.sandbox()
    expect(sandbox.execs.filter(e => e.command.includes('git init'))).toHaveLength(2)
    expect(sandbox.startCount).toBe(2)
    // Restored where `--resume` finds it (the file is written after the second boot).
    expect(transcript).toBe('{"type":"user"}\n')
    expect(run.waits.map(w => w.timeout)).toEqual([
      '30 minutes',
      `${SESSION_WARM_KEEP_MINUTES} minutes`,
      `${24 * 60} minutes`,
      '30 minutes',
    ])
    expect(await reload(h.row)).toMatchObject({ status: 'ended', turnCount: 1 })
    // The cold resume's bootstrap is against a prepared database: no seed, no check, and no
    // migrate — the migrations did not change.
    expect(bootstrapSkips(sandbox)).toEqual(['', 'seed,db-check,migrate'])
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
    expect(bootstrapSkips(h.sandbox())).toEqual(['', 'seed,db-check'])
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
    expect(sandbox.execs.filter(e => e.command.includes('pnpm install'))).toHaveLength(1)
    expect(bootstrapSkips(sandbox)).toEqual([''])
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
