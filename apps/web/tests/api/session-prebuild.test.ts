// @vitest-isolate
// Mocks `sessionsPaused` (a GLOBAL launch setting another file may be flipping), so this file needs its own module registry.
/**
 * Issue #16: the per-app prebuild (`services/sessions/prebuild.ts`, `prebuild-steps.ts`) driven
 * through the real `SessionWorkflow` with `SESSION_PREBUILD=on`: a first boot that finds none asks
 * for one; the `prebuild` run clones the default branch, installs and saves it (one shared
 * FakeSandbox "bucket", `createFakeSessionPorts().backups`, so it restores into another session's
 * sandbox); the next session restores it instead of cloning and installing; a changed lockfile
 * installs over it and asks for a new one, whose save evicts the old archive; another image, a
 * failed restore and backups off all fall back to today's boot. Plus the claim (one build at a
 * time, a failed one holds off the next) and the table's tenant predicates.
 */
import {
  SESSION_WAKE_EVENT,
  type SessionBootTimingData,
  type SessionWorkspacePrebuildData,
  sessionBootTimingDataSchema,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_CHANGED_SCRIPT } from '@/api/services/sessions/checkpoint'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import { listSessionEvents } from '@/api/services/sessions/event-log'
import type { SessionStepHooks } from '@/api/services/sessions/hooks'
import {
  claimPrebuild,
  loadPrebuild,
  PREBUILD_RETRY_AFTER_MS,
  recordPrebuild,
  releasePrebuildClaim,
  requestPrebuild,
} from '@/api/services/sessions/prebuild'
import {
  SESSION_IMAGE_VERSION,
  WORKSPACE_FACTS_COMMAND,
} from '@/api/services/sessions/rocketflare-dev'
import { SessionWorkflow } from '@/api/workflows/session'
import { loadConfig } from '@/config'
import { appPrebuilds, type SessionRow, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import type { FakeSandbox } from '../helpers/fake-sandbox'
import {
  createFakeSessionPorts,
  type FakeSessionPorts,
  insertSession,
  type SessionAppFixture,
  seedSessionApp,
  UNEXPECTED_LAND_HOOKS,
} from '../helpers/sessions'
import { createExecutionContext, createTestEnv, stubs, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

const paused = vi.hoisted(() => ({ value: false }))
vi.mock('@/api/services/sessions/lifecycle', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/sessions/lifecycle')>()
  return { ...actual, sessionsPaused: vi.fn(async () => paused.value) }
})

const db = setupTestDatabase()
const NEON_KEY = 'neon-test-key-abcdefghijklmnop'
const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const TREE_SHA = 'b2c3d4e5f60718293a4b5c6d7e8f9012345678a1'
const WAKE = { type: SESSION_WAKE_EVENT, payload: {} }
const WS = '/workspace/app'

/** What the checkout's `pnpm-lock.yaml` hashes to now (a session's branch may change it). */
const lock = { hash: 'c'.repeat(64) }
/** Whether `pnpm install` fails (a registry the build cannot reach). */
const install = { fails: false }

beforeEach(() => {
  paused.value = false
  lock.hash = 'c'.repeat(64)
  install.fails = false
})

interface Harness {
  env: TestEnv
  cloud: FakeCloud
  f: SessionAppFixture
  ports: FakeSessionPorts
  hooks: SessionStepHooks
}

/** A prepared app with prebuilds on; every sandbox scripted like a kit checkout. */
async function harness(env: Partial<TestEnv> = {}): Promise<Harness> {
  const testEnv = createTestEnv({ SESSION_PREBUILD: 'on', ...env })
  const cfg = loadConfig(testEnv)
  const cloud = createFakeCloud()
  const f = await seedSessionApp(db, cloud, { prepared: true })
  const ports = createFakeSessionPorts({
    sessionDb: d =>
      new NeonSessionDb(d, cfg, { fetch: cloud.fetch, sleep: async () => {}, apiKey: NEON_KEY }),
  }).script(sandbox =>
    sandbox
      // Before `/sha256sum/`: the facts command hashes the lockfile with it too.
      .onExec(WORKSPACE_FACTS_COMMAND, () => ({
        stdout: `head=${BASE_SHA}\ntree=${TREE_SHA}\nlockfile=${lock.hash}\n`,
      }))
      .onExec(/git init/, () => {
        // The clone: a checkout with a lockfile.
        sandbox.files.set(`${WS}/pnpm-lock.yaml`, `lockfile ${lock.hash}`)
        return { stdout: `base=${BASE_SHA}\nhead=${BASE_SHA}\n` }
      })
      .onExec(/git remote set-url/, { stdout: `base=${BASE_SHA}\nhead=${BASE_SHA}\n` })
      .onExec(/sha256sum/, { stdout: `migrations=${'a'.repeat(64)}\n` })
      .onExec(WORKSPACE_CHANGED_SCRIPT, { stdout: `${BASE_SHA}\nclean\n` })
      .onBackground(/pnpm install/, () => {
        if (install.fails) return { exitCode: 1, log: 'ERR_PNPM_FETCH_404' }
        sandbox.files.set(`${WS}/node_modules/.modules.yaml`, `installed ${lock.hash}`)
        return { exitCode: 0 }
      })
      .onProcess(/exec pnpm dev /, { lines: ['ready'], ports: [5173, 8787], hang: true })
  )
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
    ...UNEXPECTED_LAND_HOOKS,
  }
  return { env: testEnv, cloud, f, ports, hooks }
}

const sandboxOf = (h: Harness, row: Pick<SessionRow, 'id'>) =>
  h.ports.sandbox(row.id) as FakeSandbox

async function reload(row: Pick<SessionRow, 'id' | 'tenantId'>): Promise<SessionRow> {
  const [latest] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
  if (!latest) throw new Error('session vanished')
  return latest
}

/** Run `row`'s Workflow; the first idle wait ends a coding session. Every step name is distinct. */
async function drive(h: Harness, row: Pick<SessionRow, 'id' | 'tenantId'>) {
  const fake = createFakeWorkflowStep({
    onWait: async () => {
      await db.update(sessions).set({ requestedAction: 'end' }).where(eq(sessions.id, row.id))
      return WAKE
    },
  })
  const workflow = new SessionWorkflow(createExecutionContext(), h.env)
  workflow.overrides = { ports: h.ports, hooks: h.hooks }
  const outcome = await workflow.run(
    {
      payload: { sessionId: row.id, tenantId: row.tenantId },
      timestamp: new Date(),
      instanceId: row.id,
      workflowName: 'launch-session',
    },
    fake.step as unknown as Parameters<SessionWorkflow['run']>[1]
  )
  expect(new Set(fake.names).size).toBe(fake.names.length)
  return { outcome, names: fake.names }
}

/** A coding session, booted and ended; returns its row and its run. */
async function bootSession(h: Harness) {
  const row = await insertSession(db, h.f, { status: 'requested', instanceId: undefined })
  const run = await drive(h, row)
  return { row, run }
}

const prebuildEvents = async (row: Pick<SessionRow, 'id' | 'tenantId'>) =>
  (await listSessionEvents(db, row.tenantId, row.id))
    .filter(e => e.type === 'workspace.prebuild')
    .map(e => e.data as SessionWorkspacePrebuildData)

const timingOf = async (row: Pick<SessionRow, 'id' | 'tenantId'>) =>
  (await listSessionEvents(db, row.tenantId, row.id))
    .filter(e => e.type === 'boot.timing')
    .map(e => sessionBootTimingDataSchema.parse(e.data))[0]

/** The phases in start order, `db` and `sandbox.start` (which start together) in a fixed order. */
const phasesOf = (timing: SessionBootTimingData | undefined) => {
  const names = timing?.phases.map(p => p.phase) ?? []
  const rest = names.filter(p => p !== 'db' && p !== 'sandbox.start')
  return [...names.filter(p => p === 'db' || p === 'sandbox.start').sort(), ...rest]
}

/** The `prebuild` sessions `SESSION_WORKFLOW` was asked to start, newest last. */
async function prebuildRuns(h: Harness): Promise<SessionRow[]> {
  const created = stubs(h.env).sessionWorkflow?.created ?? []
  const rows: SessionRow[] = []
  for (const c of created) {
    const id = (c.params as { sessionId: string }).sessionId
    const [row] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, h.f.tenant.id), eq(sessions.id, id)))
    if (row?.kind === 'prebuild') rows.push(row)
  }
  return rows
}

/** A first session (no prebuild yet → it asks), then the `prebuild` run it asked for. */
async function prebuilt(h: Harness) {
  const first = await bootSession(h)
  const [run] = await prebuildRuns(h)
  if (!run) throw new Error('no prebuild was asked for')
  const built = await drive(h, run)
  const row = await loadPrebuild(db, h.f.tenant.id, h.f.app.id)
  if (!row?.backup) throw new Error('the prebuild was not saved')
  return { first, run, built, row }
}

describe('a first boot with no prebuild', () => {
  it('clones and installs as before, then asks for one; the prebuild run builds and saves it', async () => {
    const h = await harness()
    const { row, run } = await bootSession(h)
    expect(run.names).toEqual([
      'claim',
      'db',
      'prebuild.check',
      'sandbox.start',
      'repo',
      'bootstrap',
      'dev',
      'prebuild.request',
      'inspect#0',
      'wait#0',
      'inspect#1',
      'end#1',
      'cleanup',
    ])
    expect(await prebuildEvents(row)).toEqual([
      { status: 'skipped', mode: 'binding', reason: 'no prebuild yet' },
      expect.objectContaining({ status: 'requested', reason: 'no prebuild yet' }),
    ])
    const [prebuild] = await prebuildRuns(h)
    expect(prebuild).toMatchObject({
      kind: 'prebuild',
      status: 'requested',
      branch: null,
      baseRef: h.f.app.defaultBranch ?? 'main',
      sandboxHost: 'local',
      createdByUserId: null,
    })
    const claim = await loadPrebuild(db, h.f.tenant.id, h.f.app.id)
    expect(claim).toMatchObject({ buildingSessionId: prebuild?.id, backup: null })
    if (!prebuild) throw new Error('unreachable')

    // A leftover a session would have written: never in the archive.
    sandboxOf(h, prebuild).files.set(`${WS}/apps/web/.dev.vars`, 'DATABASE_URL=postgres://secret')
    const built = await drive(h, prebuild)
    expect(built.names).toEqual([
      'claim',
      'sandbox.start',
      'prebuild.build',
      'prebuild.save',
      'cleanup',
    ])
    const sandbox = sandboxOf(h, prebuild)
    // The default branch, detached; no runtime files; the same install a session runs.
    const clone = sandbox.commands.find(c => c.includes('git init'))
    expect(clone).toContain('--detach')
    expect(clone).not.toContain('session/')
    expect(sandbox.files.has(`${WS}/.claude/settings.local.json`)).toBe(false)
    expect(sandbox.backgroundRuns.map(r => r.name)).toEqual(['install'])
    expect(sandbox.destroyed).toBe(true)

    const saved = await loadPrebuild(db, h.f.tenant.id, h.f.app.id)
    expect(saved).toMatchObject({
      mode: 'binding',
      sandboxHost: 'local',
      imageVersion: SESSION_IMAGE_VERSION,
      baseSha: BASE_SHA,
      treeSha: TREE_SHA,
      lockfileHash: lock.hash,
      buildingSessionId: null,
      lastError: null,
    })
    expect(saved?.builtAt).toBeInstanceOf(Date)
    const archive = h.ports.backups.get(saved?.backup?.id ?? '')
    expect([...(archive?.files.keys() ?? [])].sort()).toEqual([
      `${WS}/node_modules/.modules.yaml`,
      `${WS}/pnpm-lock.yaml`,
    ])
    expect(await prebuildEvents(prebuild)).toEqual([
      expect.objectContaining({ status: 'saved', mode: 'binding', baseSha: BASE_SHA }),
    ])
    expect(await reload(prebuild)).toMatchObject({ status: 'ended' })
  })
})

describe('a session after the prebuild', () => {
  it('restores it instead of cloning and installing: no repo and no install in boot.timing', async () => {
    const h = await harness()
    const { row: prebuild } = await prebuilt(h)
    const { row, run } = await bootSession(h)
    expect(run.names).toEqual([
      'claim',
      'db',
      'prebuild.check',
      'sandbox.start',
      'restore',
      'bootstrap',
      'dev',
      'inspect#0',
      'wait#0',
      'inspect#1',
      'end#1',
      'cleanup',
    ])
    const sandbox = sandboxOf(h, row)
    expect(sandbox.restores).toEqual([prebuild.backup?.id])
    // Checked out IN PLACE over the prebuild: no fresh clone, and the session's own branch.
    expect(sandbox.commands.some(c => c.includes('git init'))).toBe(false)
    const checkout = sandbox.commands.find(c => c.includes('git remote set-url'))
    expect(checkout).toContain(`session/${row.shortId}`)
    expect(checkout).toContain('git clean -q -fd')
    // No install; the kit bootstrap for the session's own database still ran.
    expect(sandbox.backgroundRuns.map(r => r.name)).toEqual(['bootstrap'])
    expect(phasesOf(await timingOf(row))).toEqual([
      'db',
      'sandbox.start',
      'restore',
      'bootstrap',
      'dev',
    ])
    expect(await prebuildEvents(row)).toEqual([
      expect.objectContaining({ status: 'restored', lockfile: 'same', baseSha: BASE_SHA }),
    ])
    // Nothing more was asked for.
    expect(await prebuildRuns(h)).toHaveLength(1)
    expect((await reload(row)).baseSha).toBe(BASE_SHA)
  })

  it('a changed lockfile installs over it, asks for a new one, and that one evicts the old archive', async () => {
    const h = await harness()
    const { row: old } = await prebuilt(h)
    lock.hash = 'd'.repeat(64)
    const { row, run } = await bootSession(h)
    expect(run.names).toContain('restore')
    expect(run.names).not.toContain('repo')
    expect(run.names.indexOf('prebuild.request')).toBe(run.names.indexOf('dev') + 1)
    expect(sandboxOf(h, row).backgroundRuns.map(r => r.name)).toEqual(['install', 'bootstrap'])
    expect(phasesOf(await timingOf(row))).toEqual([
      'db',
      'sandbox.start',
      'restore',
      'install',
      'bootstrap',
      'dev',
    ])
    expect(await prebuildEvents(row)).toEqual([
      expect.objectContaining({ status: 'restored', lockfile: 'changed' }),
      expect.objectContaining({ status: 'requested', reason: 'the lockfile changed' }),
    ])

    const runs = await prebuildRuns(h)
    expect(runs).toHaveLength(2)
    const next = runs[1]
    if (!next) throw new Error('unreachable')
    await drive(h, next)
    const saved = await loadPrebuild(db, h.f.tenant.id, h.f.app.id)
    expect(saved?.lockfileHash).toBe('d'.repeat(64))
    expect(saved?.backup?.id).not.toBe(old.backup?.id)
    // One prebuild per app: the replaced archive is deleted.
    expect(sandboxOf(h, next).deletedBackups).toEqual([old.backup?.id])
    expect(h.ports.backups.has(old.backup?.id ?? '')).toBe(false)
    expect(h.ports.backups.has(saved?.backup?.id ?? '')).toBe(true)
  })

  it('built on another session image: not restored — the boot clones and asks for a new one', async () => {
    const h = await harness()
    await prebuilt(h)
    await db
      .update(appPrebuilds)
      .set({ imageVersion: 'session-0' })
      .where(and(eq(appPrebuilds.tenantId, h.f.tenant.id), eq(appPrebuilds.appId, h.f.app.id)))
    const { row, run } = await bootSession(h)
    expect(run.names).toContain('repo')
    expect(run.names).not.toContain('restore')
    expect(sandboxOf(h, row).restores).toEqual([])
    expect(await prebuildEvents(row)).toEqual([
      expect.objectContaining({
        status: 'skipped',
        reason: 'it was built on another session image',
      }),
      expect.objectContaining({ status: 'requested' }),
    ])
    expect(await prebuildRuns(h)).toHaveLength(2)
  })

  it('a restore that fails falls back to the clone, says why, and asks for a new one', async () => {
    const h = await harness()
    await prebuilt(h)
    const row = await insertSession(db, h.f, { status: 'requested', instanceId: undefined })
    sandboxOf(h, row).failNext('restore', new Error('BACKUP_RESTORE_FAILED: unsquashfs exited 1'))
    const run = await drive(h, row)
    expect(run.names.slice(3, 6)).toEqual(['sandbox.start', 'restore', 'repo'])
    expect(sandboxOf(h, row).commands.filter(c => c.includes('git init'))).toHaveLength(1)
    expect(await prebuildEvents(row)).toEqual([
      expect.objectContaining({ status: 'failed', reason: expect.stringMatching(/unsquashfs/) }),
      expect.objectContaining({ status: 'requested' }),
    ])
    const restore = (await listSessionEvents(db, row.tenantId, row.id)).find(
      e =>
        e.type === 'step' &&
        (e.data as { key: string; status: string }).key === 'restore' &&
        (e.data as { status: string }).status === 'done'
    )
    expect((restore?.data as { detail?: string } | undefined)?.detail).toMatch(/^Cloning instead: /)
    expect((await reload(row)).status).toBe('ended')
  })
})

describe('prebuilds stay out of the way', () => {
  it('with workspace backups off: today’s boot — nothing restored, asked for, or recorded', async () => {
    const h = await harness({ SESSION_WORKSPACE_BACKUP: 'off' })
    const { row, run } = await bootSession(h)
    expect(run.names).not.toContain('restore')
    expect(run.names).not.toContain('prebuild.request')
    expect(run.names).toContain('repo')
    expect(await prebuildEvents(row)).toEqual([])
    expect(stubs(h.env).sessionWorkflow?.created).toEqual([])
    expect(await loadPrebuild(db, h.f.tenant.id, h.f.app.id)).toBeNull()
  })

  it('with SESSION_PREBUILD off: not even the check runs', async () => {
    const h = await harness({ SESSION_PREBUILD: 'off' })
    const { run } = await bootSession(h)
    expect(run.names.some(n => n.startsWith('prebuild'))).toBe(false)
  })

  it('a build that fails gives the claim back with the reason, which holds off the next request', async () => {
    const h = await harness()
    await bootSession(h)
    const [run] = await prebuildRuns(h)
    if (!run) throw new Error('no prebuild was asked for')
    install.fails = true
    const built = await drive(h, run)
    expect(built.names).toEqual(['claim', 'sandbox.start', 'prebuild.build', 'fail', 'cleanup'])
    expect(await reload(run)).toMatchObject({ status: 'failed' })
    const row = await loadPrebuild(db, h.f.tenant.id, h.f.app.id)
    expect(row).toMatchObject({ buildingSessionId: null, backup: null })
    expect(row?.lastError).toMatch(/pnpm install failed/)
    install.fails = false
    // The next boot does not start another container straight away…
    const second = await bootSession(h)
    expect(await prebuildRuns(h)).toHaveLength(1)
    expect(second.run.names).toContain('prebuild.request')
    // …only once the retry window has passed.
    const cfg = loadConfig(h.env)
    const later = new Date(Date.now() + PREBUILD_RETRY_AFTER_MS + 1000)
    const again = await requestPrebuild(db, h.env, cfg, {
      tenantId: h.f.tenant.id,
      appId: h.f.app.id,
      host: 'local',
      now: later,
      notBuiltSince: later,
    })
    expect(again.requested).toBe(true)
  })

  it('a prebuild run whose instance was lost mid-build is failed and gives its claim back', async () => {
    const h = await harness()
    await bootSession(h)
    const [run] = await prebuildRuns(h)
    if (!run) throw new Error('no prebuild was asked for')
    await db.update(sessions).set({ status: 'booting' }).where(eq(sessions.id, run.id))
    const lost = await drive(h, run)
    expect(lost.names).toEqual(['claim', 'cleanup'])
    expect(await reload(run)).toMatchObject({
      status: 'failed',
      error: 'The prebuild was interrupted',
    })
    expect(await loadPrebuild(db, h.f.tenant.id, h.f.app.id)).toMatchObject({
      buildingSessionId: null,
      lastError: 'The prebuild was interrupted',
    })
  })
})

describe('the claim', () => {
  it('one build per app at a time; a prebuild newer than the caller saw is not rebuilt', async () => {
    const h = await harness()
    const cfg = loadConfig(h.env)
    const now = new Date()
    const ask = (at: Date, notBuiltSince: Date) =>
      requestPrebuild(db, h.env, cfg, {
        tenantId: h.f.tenant.id,
        appId: h.f.app.id,
        host: 'local',
        now: at,
        notBuiltSince,
      })
    const first = await ask(now, now)
    expect(first.requested).toBe(true)
    expect(await ask(now, now)).toEqual({
      requested: false,
      reason: 'a prebuild is being built, or is new enough',
    })
    if (!first.requested) throw new Error('unreachable')
    // Saved at `now`: a caller that saw the app before then gets nothing new…
    await recordPrebuild(
      db,
      { tenantId: h.f.tenant.id, appId: h.f.app.id, sessionId: first.sessionId },
      {
        backup: { id: 'saved-1', dir: WS },
        mode: 'binding',
        sandboxHost: 'local',
        baseSha: BASE_SHA,
        treeSha: TREE_SHA,
        lockfileHash: lock.hash,
        buildMs: 10,
        builtAt: now,
      }
    )
    expect((await ask(now, new Date(now.getTime() - 1000))).requested).toBe(false)
    // …a merge after it (the default branch moved) does.
    expect((await ask(now, new Date(now.getTime() + 1000))).requested).toBe(true)
  })

  it('paused sessions ask for nothing', async () => {
    const h = await harness()
    paused.value = true
    const res = await requestPrebuild(db, h.env, loadConfig(h.env), {
      tenantId: h.f.tenant.id,
      appId: h.f.app.id,
      host: 'local',
      now: new Date(),
      notBuiltSince: new Date(),
    })
    expect(res).toEqual({ requested: false, reason: 'sessions are paused' })
  })
})

describe('app_prebuilds is tenant-scoped', () => {
  it('another tenant can neither read, claim, record nor release an app’s prebuild', async () => {
    const h = await harness()
    const { row } = await prebuilt(h)
    const other = await seedSessionApp(db, h.cloud, { prepared: true })
    const cfg = loadConfig(h.env)
    // Read: tenant B naming A's app sees nothing.
    expect(await loadPrebuild(db, other.tenant.id, h.f.app.id)).toBeNull()
    // Ask: A's app is not B's — refused before any claim, and no row appears under B.
    const asked = await requestPrebuild(db, h.env, cfg, {
      tenantId: other.tenant.id,
      appId: h.f.app.id,
      host: 'local',
      now: new Date(Date.now() + 60_000),
      notBuiltSince: new Date(Date.now() + 60_000),
    })
    expect(asked).toEqual({ requested: false, reason: 'the app has no repository' })
    const underB = await db
      .select()
      .from(appPrebuilds)
      .where(eq(appPrebuilds.tenantId, other.tenant.id))
    expect(underB).toEqual([])
    // Record / release under B's tenant never touch A's row.
    const ref = { tenantId: other.tenant.id, appId: h.f.app.id, sessionId: crypto.randomUUID() }
    expect(await releasePrebuildClaim(db, { ...ref, error: 'x' })).toBe(false)
    expect(
      (
        await recordPrebuild(db, ref, {
          backup: { id: 'stolen', dir: WS },
          mode: 'binding',
          sandboxHost: 'local',
          baseSha: BASE_SHA,
          treeSha: TREE_SHA,
          lockfileHash: null,
          buildMs: 1,
          builtAt: new Date(),
        })
      ).recorded
    ).toBe(false)
    expect((await loadPrebuild(db, h.f.tenant.id, h.f.app.id))?.backup).toEqual(row.backup)
    // The claim checks the app is the tenant's before it makes a row: no cross-tenant row, ever.
    expect(
      await claimPrebuild(db, {
        tenantId: h.f.tenant.id,
        appId: other.app.id,
        sessionId: crypto.randomUUID(),
        now: new Date(),
        notBuiltSince: new Date(),
      })
    ).toBe(false)
    const crossed = await db
      .select()
      .from(appPrebuilds)
      .where(and(eq(appPrebuilds.tenantId, h.f.tenant.id), eq(appPrebuilds.appId, other.app.id)))
    expect(crossed).toEqual([])
  })
})
