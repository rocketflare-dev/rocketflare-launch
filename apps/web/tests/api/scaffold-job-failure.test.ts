// @vitest-isolate
// Installs the FakeCloud as the GLOBAL fetch (the Workflow's vendor clients use the default), so this file needs its own module registry.
/**
 * A scaffold job that dies on GitHub (the manual-testing bug: Launch at `http://localhost:3000`,
 * the job could not call `/ci/scaffold/token` back) — driven through the REAL
 * `GitHubActionsScaffoldRunner` over the FakeCloud's GitHub, not the fake runner the other suites
 * use, so the run lookup (`workflow_dispatch` answers no run id) is exercised too.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { cancelLaunch } from '@/api/services/launch/pipeline/cancel'
import { retryPipeline } from '@/api/services/launch/pipeline/retry'
import { pipelineView } from '@/api/services/launch/pipeline/runs'
import { GitHubActionsScaffoldRunner } from '@/api/services/launch/scaffold/github-actions-runner'
import { type AppRow, appOperations, apps, deployTickets } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import type { FakeWorkflowRun } from '../helpers/fake-cloud/github'
import { forgetApps } from '../helpers/launch-apps'
import { type Launch, LaunchHarness } from '../helpers/launch-pipeline'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
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

async function rows(launch: Launch) {
  const list = await db
    .select()
    .from(appOperations)
    .where(
      and(eq(appOperations.tenantId, launch.tenantId), eq(appOperations.runId, launch.params.runId))
    )
  return Object.fromEntries(list.map(r => [r.step, r]))
}

async function appRow(launch: Launch): Promise<AppRow> {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, launch.tenantId), eq(apps.id, launch.params.appId)))
  return row as AppRow
}

/** A launch whose scaffold runner is the real GitHub Actions one. */
async function realRunnerLaunch(): Promise<Launch> {
  const launch = await h.request()
  launch.ports.scaffoldRunner = new GitHubActionsScaffoldRunner()
  return launch
}

function runUrl(run: FakeWorkflowRun): string {
  return `https://github.com/${run.owner}/${run.repo}/actions/runs/${run.id}`
}

describe('a scaffold job that fails on GitHub', () => {
  it('fails the wait at the next poll, with the run URL on the step row', async () => {
    const launch = await realRunnerLaunch()
    const dispatched: FakeWorkflowRun[] = []
    cloud.github.onDispatch = run => {
      dispatched.push(run)
      // The job cannot reach Launch: it ends `failure` within seconds.
      run.status = 'completed'
      run.conclusion = 'failure'
    }
    const { outcome, fake } = await h.run(launch, { onWait: async () => undefined })
    expect(outcome.status).toBe('failed')
    expect(fake.waits.length).toBeLessThanOrEqual(1)
    const run = dispatched[0] as FakeWorkflowRun
    const byStep = await rows(launch)
    expect(byStep['scaffold.wait']).toMatchObject({ status: 'failed' })
    expect(byStep['scaffold.wait']?.error).toMatch(/the GitHub Actions run ended “failure”/)
    // The test Launch is at http://localhost:3001: the error says why the job could not call back.
    expect(byStep['scaffold.wait']?.error).toMatch(
      /localhost:3001, which GitHub's runners cannot reach/
    )
    // One attempt: the poll does not fail inside a retried step.do.
    expect(byStep['scaffold.wait']?.attempt).toBe(1)
    expect(byStep['scaffold.wait']?.externalIds).toMatchObject({
      runId: String(run.id),
      runUrl: runUrl(run),
    })
    expect(byStep.neon).toBeUndefined()

    // The page sees a failed run it may retry, and the URL to open.
    const view = await pipelineView(db, launch.tenantId, await appRow(launch), 'create')
    expect(view.status).toBe('failed')
    const wait = view.steps.find(s => s.step === 'scaffold.wait')
    expect(wait).toMatchObject({ status: 'failed', url: runUrl(run) })
  })

  it('a run GitHub never lists fails the wait once the start window passes', async () => {
    const launch = await realRunnerLaunch()
    cloud.github.onDispatch = run => {
      // Not listed: another workflow's run, as far as the lookup can tell.
      run.workflow = 'something-else.yml'
    }
    let polls = 0
    const { outcome } = await h.run(launch, {
      onWait: async () => {
        polls++
        // Move the dispatch into the past, as if the rounds had elapsed.
        await db
          .update(appOperations)
          .set({
            externalIds: {
              ...(await rows(launch))['scaffold.start']?.externalIds,
              dispatchedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
            },
          })
          .where(
            and(
              eq(appOperations.tenantId, launch.tenantId),
              eq(appOperations.runId, launch.params.runId),
              eq(appOperations.step, 'scaffold.start')
            )
          )
        return undefined
      },
    })
    expect(outcome.status).toBe('failed')
    expect(polls).toBeLessThanOrEqual(2)
    expect((await rows(launch))['scaffold.wait']?.error).toMatch(
      /has not started a run of launch-scaffold\.yml 20 minutes after/
    )
  })

  it('shows the wait as running, with the run URL, while the job runs', async () => {
    const launch = await realRunnerLaunch()
    let seen: Awaited<ReturnType<typeof pipelineView>> | null = null
    cloud.github.onDispatch = run => {
      run.status = 'in_progress'
    }
    await h.run(launch, {
      onWait: async wait => {
        if (seen) return undefined
        seen = await pipelineView(db, launch.tenantId, await appRow(launch), 'create')
        // End the test's run: the job dies.
        for (const r of cloud.github.runs) {
          r.status = 'completed'
          r.conclusion = 'cancelled'
        }
        return wait.type ? undefined : undefined
      },
    })
    const view = seen as unknown as Awaited<ReturnType<typeof pipelineView>>
    expect(view.status).toBe('running')
    const start = view.steps.find(s => s.step === 'scaffold.start')
    const wait = view.steps.find(s => s.step === 'scaffold.wait')
    expect(start?.status).toBe('succeeded')
    expect(wait?.status).toBe('running')
    expect(wait?.url).toMatch(/\/actions\/runs\/\d+$/)
    expect((await rows(launch))['scaffold.wait']?.error).toMatch(/cancelled/)
  })

  it('a retry dispatches a fresh job on a new ticket', async () => {
    const launch = await realRunnerLaunch()
    cloud.github.onDispatch = run => {
      run.status = 'completed'
      run.conclusion = 'failure'
    }
    const first = await h.run(launch, { onWait: async () => undefined })
    expect(first.outcome.status).toBe('failed')
    const [ticket] = await db
      .select()
      .from(deployTickets)
      .where(
        and(eq(deployTickets.tenantId, launch.tenantId), eq(deployTickets.purpose, 'scaffold'))
      )
    // The job never reached Launch, so it never claimed its ticket.
    expect(ticket?.runId).toBeNull()

    const env = createTestEnv()
    await retryPipeline(
      db,
      { APP_LAUNCH_WORKFLOW: stubs(env).launchWorkflow },
      launch.tenantId,
      launch.params.appId,
      'create',
      SYSTEM_ACTOR
    )
    cloud.github.onDispatch = null
    const again = await h.run(launch)
    expect(again.outcome.status).toBe('live')
    expect(cloud.github.runs.filter(r => r.workflow === 'launch-scaffold.yml')).toHaveLength(2)
    const tickets = await db
      .select()
      .from(deployTickets)
      .where(
        and(eq(deployTickets.tenantId, launch.tenantId), eq(deployTickets.purpose, 'scaffold'))
      )
    expect(tickets).toHaveLength(2)
    expect(tickets.find(t => t.id === ticket?.id)?.status).toBe('failed')
    const byStep = await rows(launch)
    expect(byStep['scaffold.wait']).toMatchObject({ status: 'succeeded', error: null })
  })

  it('a person stops a run stuck in the wait; the run fails and a retry is offered', async () => {
    const launch = await realRunnerLaunch()
    cloud.github.onDispatch = run => {
      run.status = 'queued'
    }
    const env = createTestEnv()
    const workflow = stubs(env).launchWorkflow
    // The instance the platform is running (`get` answers only for one it knows).
    workflow?.setStatus(launch.params.runId, { status: 'running' })
    let cancelled: Awaited<ReturnType<typeof cancelLaunch>> | null = null
    const { outcome, fake } = await h.run(launch, {
      onWait: async () => {
        if (!cancelled) {
          cancelled = await cancelLaunch(db, workflow, launch.tenantId, launch.params.appId, {
            ...SYSTEM_ACTOR,
            actorType: 'user',
            actorEmail: 'ops@example.com',
          })
        }
        return undefined
      },
    })
    // The instance here ignores terminate (a plain run): its next poll finds the row failed.
    expect(outcome.status).toBe('failed')
    expect(fake.waits).toHaveLength(1)
    expect(cancelled).toMatchObject({ step: 'scaffold.wait', terminated: true })
    expect(workflow?.terminated).toEqual([launch.params.runId])
    const byStep = await rows(launch)
    expect(byStep['scaffold.wait']).toMatchObject({
      status: 'failed',
      error: 'Stopped by ops@example.com',
    })
    const view = await pipelineView(db, launch.tenantId, await appRow(launch), 'create')
    expect(view.status).toBe('failed')
    const [ticket] = await db
      .select()
      .from(deployTickets)
      .where(
        and(eq(deployTickets.tenantId, launch.tenantId), eq(deployTickets.purpose, 'scaffold'))
      )
    expect(ticket).toMatchObject({ status: 'failed', error: 'Stopped by ops@example.com' })

    // A second stop is refused: the run is no longer running.
    await expect(
      cancelLaunch(db, workflow, launch.tenantId, launch.params.appId, SYSTEM_ACTOR)
    ).rejects.toMatchObject({ statusCode: 409, code: 'run_not_running' })

    await retryPipeline(
      db,
      { APP_LAUNCH_WORKFLOW: workflow },
      launch.tenantId,
      launch.params.appId,
      'create',
      SYSTEM_ACTOR
    )
    cloud.github.onDispatch = null
    expect((await h.run(launch)).outcome.status).toBe('live')
  })
})
