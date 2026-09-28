/**
 * Reconciling a pipeline run whose Workflow died under it (Launch P2) — the pipeline's version of
 * the agent runs' `reconcileRun`. A run's status is derived from its `app_operations` rows
 * (`runs.ts`), so an instance that stops without its step recording a failure — `wrangler dev`
 * reloading the Worker mid-step, an uncaught throw outside `runStep`, the platform's own limits —
 * leaves a row `running` for ever, and "Retry from failed step" never appears. On read (`GET
 * /api/apps/:id/pipeline`) and before a retry, this asks the Workflow what happened:
 *
 * 1. **Only a stale run**: the latest run of the kind derives `running`, has rows, and none of
 *    them was written for {@link RECONCILE_STALE_MS} (3 minutes — a step attempt that is working
 *    records its claim, its ids or its result far more often). A fresh run costs no subrequest.
 * 2. **Throttled in the database**: the run's newest row gets `updated_at = now()` in a
 *    compare-and-set (`updated_at < now - 3 min`), and only the request whose update landed asks
 *    the runtime — so a run is reconciled at most once per 3 minutes however many tabs poll it,
 *    and no migration was needed. `updated_at` is otherwise only an ordering hint.
 * 3. **Ask the instance** — `apps.launch_instance_id` for a launch (`launchInstanceOf`), and for a
 *    teardown `<runId>` or the `<runId>-rN` its latest `app.pipeline.retried` row recorded.
 *    - `errored`, `terminated`, `complete`, `unknown` (any status not in the live set), or NOT
 *      FOUND (a local restart loses it; retention expires) → the run is dead.
 *    - `queued`, `running`, `waiting`, `waitingForPause`, `paused` → alive, left alone. A WAIT
 *      (`scaffold.wait`, `deploy_staging.wait`) parks inside `step.waitForEvent` for up to one
 *      round with nothing to write, and its instance says `waiting`: healthy.
 *    - **Except a stalled step**: a `running` NON-wait row whose attempt started more than
 *      {@link STALLED_STEP_MS} ago (7 minutes) while the instance claims `queued|running`. One
 *      attempt is capped at `PIPELINE_STEP_CONFIG.timeout` (5 minutes) and every retry re-claims
 *      the row with a new `started_at`, so no live attempt is that old. This is the `wrangler dev`
 *      reload: the local engine keeps its persisted status `running` after the reload killed it,
 *      and nothing ever moves it again. The instance is terminated (best effort).
 *    - A lookup that fails any other way is logged and changes nothing.
 * 4. **Dead** → every `running` row (between steps: the next step without a row or `pending`, as a cancel
 *    does) is `failed` "The launch's Workflow stopped (<status>) while this step ran — Retry
 *    resumes from here", keeping its recorded ids (`failOpenStep`), so a retry's `ctx.prior`
 *    adopts what the dead attempt created. A launch's app becomes `failed` with `app.launch_failed`
 *    (`markLaunchFailed`, as the Workflow's own failure path); a teardown gets
 *    `app.teardown_failed` and the app keeps its status (as `teardownFailedStep`). Audited
 *    `app.pipeline.reconciled` (system actor) with the instance, its status and the steps.
 *
 * {@link reconcilePipelineSafely} is what the routes call: it never throws into the request.
 */
import type { PipelineKind } from '@launch/shared/launch-pipeline'
import { and, eq, lt } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppOperationRow, type AppRow, appOperations } from '../../../../db/schema'
import { isMissingInstanceError } from '../../agents/runs'
import { recordAudit, SYSTEM_ACTOR } from '../audit'
import { markLaunchFailed } from './create'
import { launchInstanceOf } from './instance'
import { failOpenStep } from './operations'
import { lastRetrySuffix } from './retry'
import { deriveRunStatus, latestRunId, nextStepOf, runRows } from './runs'

/** How long a run must have written nothing before the runtime is asked about it. */
export const RECONCILE_STALE_MS = 3 * 60_000

/** How old a running non-wait step's attempt must be to be dead whatever the instance claims. */
export const STALLED_STEP_MS = 7 * 60_000

/** Rows opened `running` by the step that dispatched a job, and held open while the run waits. */
export const WAIT_STEPS: readonly string[] = ['scaffold.wait', 'deploy_staging.wait']

/** Instance statuses that mean the Workflow is still in charge of the run. */
const LIVE_STATUSES = new Set(['queued', 'running', 'waiting', 'waitingForPause', 'paused'])

/** The logging a reconcile does (the request's pino logger satisfies it). */
export interface ReconcileLogger {
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

/** The slice of a Workflow binding a reconcile needs — `RecordingWorkflow` satisfies it. */
export interface WorkflowInspector {
  get(id: string): Promise<{
    status(): Promise<{ status: string }>
    terminate(): Promise<void>
  }>
}

export interface ReconcileWorkflows {
  APP_LAUNCH_WORKFLOW?: WorkflowInspector
  APP_TEARDOWN_WORKFLOW?: WorkflowInspector
}

export type ReconcileResult =
  | { outcome: 'skipped' }
  | { outcome: 'alive'; instanceId: string; instanceStatus: string }
  | { outcome: 'failed'; instanceId: string; instanceStatus: string; steps: string[] }

const SKIPPED: ReconcileResult = { outcome: 'skipped' }

async function instanceIdOf(
  db: Database,
  tenantId: string,
  app: AppRow,
  kind: PipelineKind,
  runId: string
): Promise<string> {
  if (kind === 'create') return launchInstanceOf(app, runId)
  const n = await lastRetrySuffix(db, tenantId, app.id, runId)
  return n > 0 ? `${runId}-r${n}` : runId
}

/** The run's newest row, or null when one of them was written inside the stale window. */
function staleNewest(rows: readonly AppOperationRow[], cutoff: Date): AppOperationRow | null {
  let newest: AppOperationRow | null = null
  for (const row of rows) if (!newest || row.updatedAt > newest.updatedAt) newest = row
  return newest && newest.updatedAt < cutoff ? newest : null
}

/** Take the run's reconcile turn: true for the one request whose compare-and-set landed. */
async function claimTurn(
  db: Database,
  tenantId: string,
  row: AppOperationRow,
  cutoff: Date,
  now: Date
): Promise<boolean> {
  const claimed = await db
    .update(appOperations)
    .set({ updatedAt: now })
    .where(
      and(
        eq(appOperations.tenantId, tenantId),
        eq(appOperations.id, row.id),
        lt(appOperations.updatedAt, cutoff)
      )
    )
    .returning({ id: appOperations.id })
  return claimed.length > 0
}

/** `status()` of the instance, `'not found'` when there is none, null when the lookup failed. */
async function instanceStatus(
  workflow: WorkflowInspector,
  instanceId: string,
  logger?: ReconcileLogger
): Promise<string | null> {
  try {
    return (await (await workflow.get(instanceId)).status()).status
  } catch (err) {
    if (isMissingInstanceError(err)) return 'not found'
    logger?.warn({ err, instanceId }, 'pipeline reconcile: could not read the instance status')
    return null
  }
}

/** Reconcile the latest run of `kind` (see the header). Throws only on a database error. */
export async function reconcilePipeline(
  db: Database,
  workflows: ReconcileWorkflows,
  tenantId: string,
  app: AppRow,
  kind: PipelineKind,
  options: { now?: Date; logger?: ReconcileLogger } = {}
): Promise<ReconcileResult> {
  const now = options.now ?? new Date()
  const workflow =
    kind === 'create' ? workflows.APP_LAUNCH_WORKFLOW : workflows.APP_TEARDOWN_WORKFLOW
  if (!workflow) return SKIPPED
  const runId = await latestRunId(db, tenantId, app, kind)
  if (!runId) return SKIPPED
  const rows = await runRows(db, tenantId, runId)
  // No rows: the run is waiting on its approval, or its Workflow is only just starting.
  if (rows.length === 0 || deriveRunStatus(kind, rows) !== 'running') return SKIPPED
  const cutoff = new Date(now.getTime() - RECONCILE_STALE_MS)
  const newest = staleNewest(rows, cutoff)
  if (!newest || !(await claimTurn(db, tenantId, newest, cutoff, now))) return SKIPPED

  const instanceId = await instanceIdOf(db, tenantId, app, kind, runId)
  const status = await instanceStatus(workflow, instanceId, options.logger)
  if (status === null) return SKIPPED

  const running = rows.filter(r => r.status === 'running')
  let label = status
  if (LIVE_STATUSES.has(status)) {
    const stalled =
      (status === 'queued' || status === 'running') &&
      running.some(
        r =>
          !WAIT_STEPS.includes(r.step) &&
          (r.startedAt ?? r.updatedAt).getTime() < now.getTime() - STALLED_STEP_MS
      )
    if (!stalled) return { outcome: 'alive', instanceId, instanceStatus: status }
    label = `${status}, but its step has not moved for ${STALLED_STEP_MS / 60_000} minutes`
    try {
      await (await workflow.get(instanceId)).terminate()
    } catch {
      // Gone already: the rows are what the page and the retry read.
    }
  }

  const next = nextStepOf(kind, rows)
  const steps = running.length > 0 ? running.map(r => r.step) : next ? [next] : []
  if (steps.length === 0) return SKIPPED
  const what = kind === 'create' ? 'launch' : 'teardown'
  const message = `The ${what}'s Workflow stopped (${label}) while this step ran — Retry resumes from here`
  for (const step of steps) {
    await failOpenStep(db, { tenantId, appId: app.id, runId, kind, step }, message)
  }

  const reason = `${steps[0]}: ${message}`
  if (kind === 'create') {
    if (app.status === 'provisioning') {
      await markLaunchFailed(db, tenantId, app.id, runId, new Error(reason))
    }
  } else {
    await recordAudit(db, {
      tenantId,
      ...SYSTEM_ACTOR,
      action: 'app.teardown_failed',
      targetType: 'App',
      targetId: app.id,
      appId: app.id,
      summary: { after: { runId, error: reason.slice(0, 500) } },
    })
  }
  await recordAudit(db, {
    tenantId,
    ...SYSTEM_ACTOR,
    action: 'app.pipeline.reconciled',
    targetType: 'App',
    targetId: app.id,
    appId: app.id,
    summary: { after: { kind, runId, instanceId, instanceStatus: status, steps } },
  })
  options.logger?.warn(
    { appId: app.id, kind, runId, instanceId, instanceStatus: status, steps },
    'pipeline reconcile: the Workflow stopped under a running step; failed it'
  )
  return { outcome: 'failed', instanceId, instanceStatus: status, steps }
}

/** {@link reconcilePipeline} for a route: any error is logged and the request carries on. */
export async function reconcilePipelineSafely(
  db: Database,
  workflows: ReconcileWorkflows,
  tenantId: string,
  app: AppRow,
  kind: PipelineKind,
  logger?: ReconcileLogger
): Promise<ReconcileResult> {
  try {
    return await reconcilePipeline(db, workflows, tenantId, app, kind, { logger })
  } catch (err) {
    logger?.error({ err, appId: app.id, kind }, 'pipeline reconcile failed; the view is unchanged')
    return SKIPPED
  }
}
