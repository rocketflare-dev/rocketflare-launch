/**
 * `reconcilePipeline` (Launch P2, `services/launch/pipeline/reconcile.ts`) — a pipeline run whose
 * Workflow died under a `running` step (a `wrangler dev` reload, an uncaught throw, the platform's
 * limits) is failed on read so it can be retried; a live one is left alone, a fresh one costs no
 * subrequest, and a stale one is asked about at most once per window.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { recordAudit, SYSTEM_ACTOR } from '@/api/services/launch/audit'
import {
  RECONCILE_STALE_MS,
  reconcilePipeline,
  reconcilePipelineSafely,
  STALLED_STEP_MS,
} from '@/api/services/launch/pipeline/reconcile'
import { retryPipeline } from '@/api/services/launch/pipeline/retry'
import { deriveRunStatus, runRows } from '@/api/services/launch/pipeline/runs'
import { type AppRow, appOperations, apps, auditEvents } from '@/db/schema'
import { createTestTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, seedApp } from '../helpers/launch-apps'
import { RecordingWorkflow } from '../mocks/bindings'

const db = setupTestDatabase()
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)
const STALE = minutesAgo(RECONCILE_STALE_MS / 60_000 + 1)

interface RowSpec {
  step: string
  status: 'running' | 'succeeded' | 'failed'
  updatedAt?: Date
  startedAt?: Date
  externalIds?: Record<string, string>
}

/** A provisioning app whose create run `runId` has these rows, and a fresh pair of bindings. */
async function launchRun(rows: RowSpec[], kind: 'create' | 'teardown' = 'create') {
  const tenant = await createTestTenant(db)
  tenantIds.push(tenant.id)
  const runId = crypto.randomUUID()
  const { app: seeded } = await seedApp(db, tenant.id, {
    status: kind === 'create' ? 'provisioning' : 'live',
  })
  const [app] =
    kind === 'create'
      ? await db
          .update(apps)
          .set({ launchRunId: runId, source: 'created' })
          .where(eq(apps.id, seeded.id))
          .returning()
      : [seeded]
  for (const spec of rows) {
    await db.insert(appOperations).values({
      tenantId: tenant.id,
      appId: seeded.id,
      runId,
      kind,
      step: spec.step,
      status: spec.status,
      attempt: 1,
      externalIds: spec.externalIds ?? {},
      startedAt: spec.startedAt ?? spec.updatedAt ?? new Date(),
      updatedAt: spec.updatedAt ?? new Date(),
    })
  }
  const launch = new RecordingWorkflow()
  const teardown = new RecordingWorkflow()
  // The instance the run was started as (`<runId>`), as `startLaunch` / `startTeardown` do.
  await (kind === 'create' ? launch : teardown).create({ id: runId, params: {} })
  const workflows = { APP_LAUNCH_WORKFLOW: launch, APP_TEARDOWN_WORKFLOW: teardown }
  return { tenantId: tenant.id, app: app as AppRow, runId, launch, teardown, workflows }
}

async function step(runId: string, name: string) {
  const [row] = await db
    .select()
    .from(appOperations)
    .where(and(eq(appOperations.runId, runId), eq(appOperations.step, name)))
  return row
}

async function auditActions(appId: string) {
  const rows = await db
    .select({ action: auditEvents.action, summary: auditEvents.summary })
    .from(auditEvents)
    .where(eq(auditEvents.appId, appId))
  return rows
}

const NEON_RUNNING: RowSpec[] = [
  { step: 'reserve', status: 'succeeded', updatedAt: minutesAgo(20) },
  { step: 'scaffold.verify', status: 'succeeded', updatedAt: minutesAgo(19) },
  {
    step: 'neon',
    status: 'running',
    updatedAt: STALE,
    startedAt: STALE,
    externalIds: { neonProjectId: 'proj-1' },
  },
]

describe('reconcilePipeline — a launch', () => {
  it('fails the running step of an ERRORED instance, fails the app, audits, and Retry resumes', async () => {
    const { tenantId, app, runId, launch, workflows } = await launchRun(NEON_RUNNING)
    launch.setStatus(runId, { status: 'errored' })

    const result = await reconcilePipeline(db, workflows, tenantId, app, 'create')
    expect(result).toEqual({
      outcome: 'failed',
      instanceId: runId,
      instanceStatus: 'errored',
      steps: ['neon'],
    })
    expect(launch.statusCalls).toEqual([runId])
    const neon = await step(runId, 'neon')
    expect(neon).toMatchObject({
      status: 'failed',
      error:
        "The launch's Workflow stopped (errored) while this step ran — Retry resumes from here",
      // The ids the dead attempt recorded stay, so the retry's `ctx.prior` adopts them.
      externalIds: { neonProjectId: 'proj-1' },
    })
    expect(deriveRunStatus('create', await runRows(db, tenantId, runId))).toBe('failed')
    const [row] = await db.select().from(apps).where(eq(apps.id, app.id))
    expect(row?.status).toBe('failed')
    const audit = await auditActions(app.id)
    expect(audit.map(a => a.action).sort()).toEqual([
      'app.launch_failed',
      'app.pipeline.reconciled',
    ])
    expect(audit.find(a => a.action === 'app.pipeline.reconciled')?.summary).toMatchObject({
      after: {
        kind: 'create',
        runId,
        instanceId: runId,
        instanceStatus: 'errored',
        steps: ['neon'],
      },
    })

    // Retry is now offered, and resumes at `neon` on a new instance with the same run id.
    const retried = await retryPipeline(db, workflows, tenantId, app.id, 'create', SYSTEM_ACTOR)
    expect(retried).toEqual({ runId, instanceId: `${runId}-r1` })
    expect(launch.created.at(-1)).toMatchObject({ id: `${runId}-r1`, params: { runId } })
  })

  it('fails the run when the instance is NOT FOUND (a local restart lost it)', async () => {
    const { tenantId, app, runId, launch, workflows } = await launchRun(NEON_RUNNING)
    launch.clear() // the platform no longer has `<runId>`

    const result = await reconcilePipeline(db, workflows, tenantId, app, 'create')
    expect(result).toMatchObject({ outcome: 'failed', instanceStatus: 'not found' })
    expect((await step(runId, 'neon'))?.error).toContain('stopped (not found)')
  })

  it('asks the instance the latest retry recorded (`apps.launch_instance_id`)', async () => {
    const { tenantId, app, runId, launch, workflows } = await launchRun(NEON_RUNNING)
    await db
      .update(apps)
      .set({ launchInstanceId: `${runId}-r2` })
      .where(eq(apps.id, app.id))
    launch.setStatus(`${runId}-r2`, { status: 'terminated' })
    const [current] = await db.select().from(apps).where(eq(apps.id, app.id))

    const result = await reconcilePipeline(db, workflows, tenantId, current as AppRow, 'create')
    expect(result).toMatchObject({ outcome: 'failed', instanceId: `${runId}-r2` })
    expect(launch.statusCalls).toEqual([`${runId}-r2`])
  })

  it('leaves a RUNNING or WAITING instance alone', async () => {
    for (const status of ['running', 'waiting'] as const) {
      const { tenantId, app, runId, launch, workflows } = await launchRun([
        { step: 'scaffold.start', status: 'succeeded', updatedAt: minutesAgo(30) },
        // A wait parks inside `step.waitForEvent` with nothing to write for a whole round.
        { step: 'scaffold.wait', status: 'running', updatedAt: STALE, startedAt: minutesAgo(30) },
      ])
      launch.setStatus(runId, { status })
      const result = await reconcilePipeline(db, workflows, tenantId, app, 'create')
      expect(result).toEqual({ outcome: 'alive', instanceId: runId, instanceStatus: status })
      expect((await step(runId, 'scaffold.wait'))?.status).toBe('running')
      const [row] = await db.select().from(apps).where(eq(apps.id, app.id))
      expect(row?.status).toBe('provisioning')
      expect(launch.terminated).toEqual([])
    }
  })

  it('does not ask the runtime about a run that wrote a row inside the stale window', async () => {
    const { tenantId, app, runId, launch, workflows } = await launchRun([
      { step: 'reserve', status: 'succeeded', updatedAt: minutesAgo(10) },
      { step: 'neon', status: 'running', updatedAt: minutesAgo(1) },
    ])
    launch.setStatus(runId, { status: 'errored' })
    expect(await reconcilePipeline(db, workflows, tenantId, app, 'create')).toEqual({
      outcome: 'skipped',
    })
    expect(launch.statusCalls).toEqual([])
    expect((await step(runId, 'neon'))?.status).toBe('running')
  })

  it('asks at most once per window however often the view is read (a DB claim)', async () => {
    const { tenantId, app, runId, launch, workflows } = await launchRun(NEON_RUNNING)
    launch.setStatus(runId, { status: 'running' })
    const reads = await Promise.all(
      [1, 2, 3].map(() => reconcilePipeline(db, workflows, tenantId, app, 'create'))
    )
    await reconcilePipeline(db, workflows, tenantId, app, 'create')
    expect(launch.statusCalls).toEqual([runId])
    expect(reads.filter(r => r.outcome === 'alive')).toHaveLength(1)
  })

  it('fails a non-wait step stalled past STALLED_STEP_MS though the engine still says running', async () => {
    // `wrangler dev`: the reload killed the step, and the local engine's persisted status stays
    // `running` for good.
    const stalled = minutesAgo(STALLED_STEP_MS / 60_000 + 1)
    const { tenantId, app, runId, launch, workflows } = await launchRun([
      { step: 'reserve', status: 'succeeded', updatedAt: minutesAgo(20) },
      { step: 'neon', status: 'running', updatedAt: stalled, startedAt: stalled },
    ])
    const result = await reconcilePipeline(db, workflows, tenantId, app, 'create')
    expect(result).toMatchObject({ outcome: 'failed', instanceStatus: 'running', steps: ['neon'] })
    expect((await step(runId, 'neon'))?.error).toContain(
      'stopped (running, but its step has not moved for 7 minutes)'
    )
    expect(launch.terminated).toEqual([runId])
  })

  it('between steps, fails the next step without a row', async () => {
    const { tenantId, app, runId, launch, workflows } = await launchRun([
      { step: 'reserve', status: 'succeeded', updatedAt: minutesAgo(10) },
      { step: 'repo', status: 'succeeded', updatedAt: STALE },
    ])
    launch.setStatus(runId, { status: 'errored' })
    const result = await reconcilePipeline(db, workflows, tenantId, app, 'create')
    expect(result).toMatchObject({ outcome: 'failed', steps: ['scaffold.start'] })
    expect((await step(runId, 'scaffold.start'))?.status).toBe('failed')
  })

  it('leaves a settled run, and a run with no rows, alone', async () => {
    const failed = await launchRun([{ step: 'neon', status: 'failed', updatedAt: STALE }])
    expect(
      await reconcilePipeline(db, failed.workflows, failed.tenantId, failed.app, 'create')
    ).toEqual({ outcome: 'skipped' })
    const empty = await launchRun([])
    expect(
      await reconcilePipeline(db, empty.workflows, empty.tenantId, empty.app, 'create')
    ).toEqual({ outcome: 'skipped' })
    expect(failed.launch.statusCalls).toEqual([])
    expect(empty.launch.statusCalls).toEqual([])
  })

  it('reconcilePipelineSafely logs a lookup failure and carries on', async () => {
    const { tenantId, app, runId, workflows } = await launchRun(NEON_RUNNING)
    const errors: unknown[] = []
    const broken = {
      ...workflows,
      APP_LAUNCH_WORKFLOW: {
        get: async () => {
          throw new Error('network down')
        },
      },
    }
    const logger = { warn: (o: object) => errors.push(o), error: (o: object) => errors.push(o) }
    expect(await reconcilePipelineSafely(db, broken, tenantId, app, 'create', logger)).toEqual({
      outcome: 'skipped',
    })
    expect(errors).toHaveLength(1)
    expect((await step(runId, 'neon'))?.status).toBe('running')
  })
})

describe('reconcilePipeline — a teardown', () => {
  it('fails the running step of a dead teardown, audits app.teardown_failed, and keeps the app', async () => {
    const { tenantId, app, runId, teardown, workflows } = await launchRun(
      [
        { step: 'routes', status: 'succeeded', updatedAt: minutesAgo(10) },
        { step: 'workers', status: 'running', updatedAt: STALE, startedAt: STALE },
      ],
      'teardown'
    )
    teardown.setStatus(runId, { status: 'terminated' })

    const result = await reconcilePipeline(db, workflows, tenantId, app, 'teardown')
    expect(result).toMatchObject({ outcome: 'failed', instanceId: runId, steps: ['workers'] })
    expect((await step(runId, 'workers'))?.error).toBe(
      "The teardown's Workflow stopped (terminated) while this step ran — Retry resumes from here"
    )
    const [row] = await db.select().from(apps).where(eq(apps.id, app.id))
    expect(row?.status).toBe('live')
    expect((await auditActions(app.id)).map(a => a.action).sort()).toEqual([
      'app.pipeline.reconciled',
      'app.teardown_failed',
    ])
    const retried = await retryPipeline(db, workflows, tenantId, app.id, 'teardown', SYSTEM_ACTOR)
    expect(retried.instanceId).toBe(`${runId}-r1`)
  })

  it('asks the teardown instance its latest retry started (`<runId>-rN`)', async () => {
    const { tenantId, app, runId, teardown, workflows } = await launchRun(
      [{ step: 'workers', status: 'running', updatedAt: STALE, startedAt: STALE }],
      'teardown'
    )
    await recordAudit(db, {
      tenantId,
      ...SYSTEM_ACTOR,
      action: 'app.pipeline.retried',
      targetType: 'App',
      targetId: app.id,
      appId: app.id,
      summary: { after: { kind: 'teardown', runId, instanceId: `${runId}-r3` } },
    })
    teardown.setStatus(`${runId}-r3`, { status: 'waiting' })
    const result = await reconcilePipeline(db, workflows, tenantId, app, 'teardown')
    expect(result).toEqual({
      outcome: 'alive',
      instanceId: `${runId}-r3`,
      instanceStatus: 'waiting',
    })
  })
})
