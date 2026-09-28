// @vitest-isolate
// Installs the FakeCloud as the GLOBAL fetch (the Workflow's vendor clients use the default), so this file needs its own module registry.
/**
 * Polling a launch's open wait on READ (`services/launch/pipeline/wait-poll.ts`, through
 * `readPipeline` — `GET /api/apps/:id/pipeline`'s service half). The bug it closes: a staging
 * deploy job that died on GitHub before reaching `/ci/deploy` sends no event, the Workflow's first
 * poll ran before GitHub listed the run, and a Workflow parked in `waitForEvent` never polls again
 * under local wrangler — so the page showed "Deploy staging" running, with no run link, for ever.
 *
 * Each test reads the pipeline from INSIDE the Workflow's wait (the harness's `onWait`), where the
 * real instance would be parked, and the job's GitHub run is hidden until then, as it was.
 */
import {
  DEPLOY_FINISHED_EVENT,
  type PipelineView,
  SCAFFOLD_FINISHED_EVENT,
} from '@launch/shared/launch-pipeline'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { pipelineDeps } from '@/api/services/launch/pipeline/launch-steps'
import { readPipeline } from '@/api/services/launch/pipeline/read'
import { retryPipeline } from '@/api/services/launch/pipeline/retry'
import { WAIT_POLL_WINDOW_MS } from '@/api/services/launch/pipeline/wait-poll'
import { GitHubActionsScaffoldRunner } from '@/api/services/launch/scaffold/github-actions-runner'
import { loadConfig } from '@/config'
import { appOperations, apps, auditEvents } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import type { FakeWorkflowRun } from '../helpers/fake-cloud/github'
import { forgetApps } from '../helpers/launch-apps'
import { fakeVendors, type Launch, LaunchHarness } from '../helpers/launch-pipeline'
import { createTestEnv, RecordingWorkflow } from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

let cloud: FakeCloud
let restore: () => void
let h: LaunchHarness
beforeEach(() => {
  cloud = createFakeCloud()
  restore = cloud.install()
  h = new LaunchHarness(db, cloud, tenantIds)
})
afterEach(() => restore())

const HIDDEN = 'not-listed-yet.yml'

function runUrl(run: FakeWorkflowRun): string {
  return `https://github.com/${run.owner}/${run.repo}/actions/runs/${run.id}`
}

/** GitHub's `…/runs` lists for one workflow file — the call the throttle bounds. */
function listCalls(file: string): number {
  return cloud
    .callsTo('github')
    .filter(c => c.method === 'GET' && c.path.includes(`/actions/workflows/${file}/runs`)).length
}

/** The read the route makes, with the test's vendors and ports, against a recorded instance. */
function reader(launch: Launch, workflow: RecordingWorkflow) {
  const deps = pipelineDeps(
    db,
    cfg,
    { ports: launch.ports, vendors: fakeVendors(cloud) },
    { ports: () => launch.ports }
  )
  return (now?: Date): Promise<PipelineView> =>
    readPipeline(
      db,
      { APP_LAUNCH_WORKFLOW: workflow },
      deps,
      launch.tenantId,
      launch.params.appId,
      'create',
      { now }
    )
}

/** The instance the platform is running, parked in its wait. */
function parkedInstance(id: string): RecordingWorkflow {
  const workflow = new RecordingWorkflow()
  workflow.setStatus(id, { status: 'waiting' })
  return workflow
}

/** Hide the dispatched run of `file` from GitHub's list until the test shows it. */
function hideRuns(file: string): FakeWorkflowRun[] {
  const hidden: FakeWorkflowRun[] = []
  cloud.github.onDispatch = run => {
    if (run.workflow !== file) return
    run.workflow = HIDDEN
    hidden.push(run)
  }
  return hidden
}

function show(
  run: FakeWorkflowRun,
  file: string,
  status: FakeWorkflowRun['status'],
  conclusion: string | null
) {
  run.workflow = file
  run.status = status
  run.conclusion = conclusion
}

async function waitRow(launch: Launch, step: string) {
  const [row] = await db
    .select()
    .from(appOperations)
    .where(
      and(
        eq(appOperations.tenantId, launch.tenantId),
        eq(appOperations.runId, launch.params.runId),
        eq(appOperations.step, step)
      )
    )
  return row
}

async function appStatus(launch: Launch) {
  const [row] = await db
    .select({ status: apps.status })
    .from(apps)
    .where(and(eq(apps.tenantId, launch.tenantId), eq(apps.id, launch.params.appId)))
  return row?.status
}

async function launchFailedAudits(launch: Launch) {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.tenantId, launch.tenantId), eq(auditEvents.action, 'app.launch_failed'))
    )
}

describe('a staging deploy job that dies on GitHub', () => {
  it('the read fails the wait with the run URL and a readable error, wakes the run, and Retry is offered', async () => {
    const launch = await h.request()
    const hidden = hideRuns('deploy.yml')
    const workflow = parkedInstance(launch.params.runId)
    const read = reader(launch, workflow)
    let seen: PipelineView | null = null
    let appWhileParked: string | undefined
    const { outcome } = await h.run(launch, {
      onWait: async wait => {
        if (wait.type === SCAFFOLD_FINISHED_EVENT) return h.scaffoldJob(launch)
        if (wait.type !== DEPLOY_FINISHED_EVENT || seen) return undefined
        // The gate went red: GitHub lists the run now, `completed` / `failure`.
        const run = hidden[0] as FakeWorkflowRun
        show(run, 'deploy.yml', 'completed', 'failure')
        seen = await read()
        appWhileParked = await appStatus(launch)
        return undefined
      },
    })
    const run = hidden[0] as FakeWorkflowRun
    const view = seen as unknown as PipelineView
    expect(view.status).toBe('failed')
    const deploy = view.steps.find(s => s.step === 'deploy_staging')
    expect(deploy).toMatchObject({ status: 'failed', url: runUrl(run) })
    expect(deploy?.error).toMatch(
      /The staging deploy job failed: the GitHub Actions run ended “failure”/
    )
    expect(appWhileParked).toBe('failed')
    // The parked instance is woken with the event its wait listens for.
    expect(workflow.events).toEqual([
      {
        instanceId: launch.params.runId,
        type: DEPLOY_FINISHED_EVENT,
        payload: { polledOnRead: true },
      },
    ])

    // The woken Workflow's next poll finds the row failed and ends the run — the app is failed and
    // audited once, by the read.
    expect(outcome.status).toBe('failed')
    expect(await launchFailedAudits(launch)).toHaveLength(1)
    expect((await launchFailedAudits(launch))[0]?.summary.after?.error).toMatch(
      /^deploy_staging\.wait: The staging deploy job failed/
    )
    expect(await waitRow(launch, 'deploy_staging.wait')).toMatchObject({
      status: 'failed',
      attempt: 1,
      externalIds: expect.objectContaining({ runId: String(run.id), runUrl: runUrl(run) }),
    })

    // Retry is accepted: the run is failed.
    const retried = await retryPipeline(
      db,
      { APP_LAUNCH_WORKFLOW: new RecordingWorkflow() },
      launch.tenantId,
      launch.params.appId,
      'create',
      SYSTEM_ACTOR
    )
    expect(retried.runId).toBe(launch.params.runId)
  })

  it('a settled wait is not polled again', async () => {
    const launch = await h.request()
    const hidden = hideRuns('deploy.yml')
    const workflow = parkedInstance(launch.params.runId)
    const read = reader(launch, workflow)
    const calls: number[] = []
    await h.run(launch, {
      onWait: async wait => {
        if (wait.type === SCAFFOLD_FINISHED_EVENT) return h.scaffoldJob(launch)
        if (wait.type !== DEPLOY_FINISHED_EVENT || calls.length) return undefined
        show(hidden[0] as FakeWorkflowRun, 'deploy.yml', 'completed', 'failure')
        await read()
        calls.push(listCalls('deploy.yml'))
        // Well past the window: the wait is failed, so nothing is asked of GitHub.
        await read(new Date(Date.now() + 10 * WAIT_POLL_WINDOW_MS))
        calls.push(listCalls('deploy.yml'))
        return undefined
      },
    })
    expect(calls[1]).toBe(calls[0])
    expect(workflow.events).toHaveLength(1)
  })

  it('sends the event to the instance the app recorded (a retry is <runId>-rN)', async () => {
    const launch = await h.request()
    const hidden = hideRuns('deploy.yml')
    const instanceId = `${launch.params.runId}-r1`
    const workflow = parkedInstance(instanceId)
    const read = reader(launch, workflow)
    let done = false
    await h.run(launch, {
      onWait: async wait => {
        if (wait.type === SCAFFOLD_FINISHED_EVENT) return h.scaffoldJob(launch)
        if (wait.type !== DEPLOY_FINISHED_EVENT || done) return undefined
        done = true
        await db
          .update(apps)
          .set({ launchInstanceId: instanceId })
          .where(and(eq(apps.tenantId, launch.tenantId), eq(apps.id, launch.params.appId)))
        show(hidden[0] as FakeWorkflowRun, 'deploy.yml', 'completed', 'cancelled')
        await read()
        return undefined
      },
    })
    expect(workflow.events.map(e => [e.instanceId, e.type])).toEqual([
      [instanceId, DEPLOY_FINISHED_EVENT],
    ])
  })
})

describe('a staging deploy job that is still running', () => {
  it('records only its URL, and GitHub is asked once per window however many reads', async () => {
    const launch = await h.request()
    const hidden = hideRuns('deploy.yml')
    const workflow = parkedInstance(launch.params.runId)
    const read = reader(launch, workflow)
    const seen: { view: PipelineView; calls: number }[] = []
    let rowWhileRunning: Awaited<ReturnType<typeof waitRow>> | undefined
    let rowNextWindow: Awaited<ReturnType<typeof waitRow>> | undefined
    await h.run(launch, {
      onWait: async wait => {
        if (wait.type === SCAFFOLD_FINISHED_EVENT) return h.scaffoldJob(launch)
        if (wait.type !== DEPLOY_FINISHED_EVENT || seen.length) return undefined
        const run = hidden[0] as FakeWorkflowRun
        show(run, 'deploy.yml', 'in_progress', null)
        const before = listCalls('deploy.yml')
        for (let i = 0; i < 3; i++) {
          seen.push({ view: await read(), calls: listCalls('deploy.yml') - before })
        }
        rowWhileRunning = await waitRow(launch, 'deploy_staging.wait')
        // The next window: one more look.
        seen.push({
          view: await read(new Date(Date.now() + WAIT_POLL_WINDOW_MS + 1000)),
          calls: listCalls('deploy.yml') - before,
        })
        rowNextWindow = await waitRow(launch, 'deploy_staging.wait')
        // End the test's run: the job dies.
        show(run, 'deploy.yml', 'completed', 'failure')
        return undefined
      },
    })
    const run = hidden[0] as FakeWorkflowRun
    expect(seen.map(s => s.calls)).toEqual([1, 1, 1, 2])
    for (const { view } of seen) {
      expect(view.status).toBe('running')
      const deploy = view.steps.find(s => s.step === 'deploy_staging')
      expect(deploy).toMatchObject({ status: 'running', error: null, url: runUrl(run) })
    }
    expect(rowWhileRunning).toMatchObject({
      status: 'running',
      externalIds: expect.objectContaining({ runId: String(run.id), runUrl: runUrl(run) }),
    })
    // Not settled: no event.
    expect(workflow.events).toEqual([])
    // A second claim with nothing new to record leaves `updated_at` — the reconcile's staleness
    // clock — where it was, so reads never keep a dead run looking fresh.
    expect(rowNextWindow?.externalIds.readPolledAt).not.toBe(
      rowWhileRunning?.externalIds.readPolledAt
    )
    expect(rowNextWindow?.updatedAt.getTime()).toBe(rowWhileRunning?.updatedAt.getTime())
  })
})

describe('a scaffold job that dies on GitHub', () => {
  it('the read fails the wait with the run URL and a readable error, and Retry is offered', async () => {
    const launch = await h.request()
    launch.ports.scaffoldRunner = new GitHubActionsScaffoldRunner()
    const hidden = hideRuns('launch-scaffold.yml')
    const workflow = parkedInstance(launch.params.runId)
    const read = reader(launch, workflow)
    let seen: PipelineView | null = null
    const { outcome } = await h.run(launch, {
      onWait: async wait => {
        if (wait.type !== SCAFFOLD_FINISHED_EVENT || seen) return undefined
        show(hidden[0] as FakeWorkflowRun, 'launch-scaffold.yml', 'completed', 'failure')
        seen = await read()
        return undefined
      },
    })
    const run = hidden[0] as FakeWorkflowRun
    const view = seen as unknown as PipelineView
    expect(view.status).toBe('failed')
    const scaffold = view.steps.find(s => s.step === 'scaffold')
    expect(scaffold).toMatchObject({ status: 'failed', url: runUrl(run) })
    expect(scaffold?.error).toMatch(
      /The scaffold job failed: the GitHub Actions run ended “failure”/
    )
    expect(workflow.events.map(e => [e.instanceId, e.type])).toEqual([
      [launch.params.runId, SCAFFOLD_FINISHED_EVENT],
    ])
    expect(outcome.status).toBe('failed')
    expect(await appStatus(launch)).toBe('failed')
    expect(await launchFailedAudits(launch)).toHaveLength(1)
    await expect(
      retryPipeline(
        db,
        { APP_LAUNCH_WORKFLOW: new RecordingWorkflow() },
        launch.tenantId,
        launch.params.appId,
        'create',
        SYSTEM_ACTOR
      )
    ).resolves.toMatchObject({ runId: launch.params.runId })
  })
})
