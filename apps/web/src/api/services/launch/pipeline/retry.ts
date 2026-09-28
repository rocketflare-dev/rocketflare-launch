/**
 * Retrying a failed pipeline run (Launch P2, `POST /api/apps/:id/pipeline/retry`). A retry is a
 * NEW Workflow instance `<runId>-rN` carrying the SAME `runId`, so every `app_operations` row that
 * already succeeded is skipped by `runStep` and the run resumes at the step that failed — with the
 * ids that step's earlier attempts recorded in `ctx.prior`.
 *
 * - Only the latest run of the kind, and only when it is `failed` (409 `run_not_failed`).
 * - The run's options (`deployStaging`, `deleteRepo`) come back from the audit row that requested
 *   it — the one place they were written.
 * - `N` follows the highest suffix an earlier retry recorded (its audit row): local wrangler
 *   hands back an existing instance instead of refusing the id, so nothing would run. An id
 *   Cloudflare (or the test double) still refuses as `already_exists` moves on to the next.
 * - A create retry puts the app back to `provisioning` (the `reserve` step, which would, is
 *   skipped), and a failed WAIT re-opens the step that started its job (`RESTARTS`), so the
 *   scaffold job or the staging deploy is dispatched again. A restarted scaffold also withdraws
 *   its old ticket — even one no job ever claimed (a job that could not reach Launch) — so the
 *   new dispatch gets a fresh ticket. Audited `app.pipeline.retried`.
 * - The new instance id is recorded on `apps.launch_instance_id`, so the job events reach it.
 */
import type {
  AppLaunchParams,
  AppTeardownParams,
  PipelineKind,
  RetryPipelineResponse,
} from '@launch/shared/launch-pipeline'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import {
  type AppOperationRow,
  appOperations,
  apps,
  auditEvents,
  deployTickets,
} from '../../../../db/schema'
import { ConflictError } from '../../../utils/core/errors'
import { getAppRow } from '../apps'
import { type AuditActor, recordAudit } from '../audit'
import { requireWorkflow, type WorkflowStarter } from './create'
import { deriveRunStatus, latestRunId, requestedOptions, runRows } from './runs'

const MAX_RETRY_SUFFIX = 100

/**
 * A failed WAIT is retried by starting its job again: the job it waited on died (or never
 * reported), so skipping its succeeded `…start` row would only wait on a dead job a second time.
 */
const RESTARTS: Record<string, string> = {
  'scaffold.wait': 'scaffold.start',
  'deploy_staging.wait': 'deploy_staging.start',
  'deploy_staging.check': 'deploy_staging.start',
}

async function restartJobs(
  db: Database,
  tenantId: string,
  runId: string,
  rows: readonly Pick<AppOperationRow, 'step' | 'status' | 'externalIds'>[]
): Promise<void> {
  const starts = rows.flatMap(r => {
    const start = r.status === 'failed' ? RESTARTS[r.step] : undefined
    return start ? [start] : []
  })
  if (starts.length === 0) return
  const ticketId = rows.find(r => r.step === 'scaffold.start')?.externalIds.scaffoldTicketId
  if (starts.includes('scaffold.start') && ticketId) {
    await db
      .update(deployTickets)
      .set({ status: 'failed', error: 'Superseded by a retry', updatedAt: new Date() })
      .where(
        and(
          eq(deployTickets.tenantId, tenantId),
          eq(deployTickets.id, ticketId),
          eq(deployTickets.status, 'approved')
        )
      )
  }
  await db
    .update(appOperations)
    .set({ status: 'failed', error: 'Started again by a retry', updatedAt: new Date() })
    .where(
      and(
        eq(appOperations.tenantId, tenantId),
        eq(appOperations.runId, runId),
        inArray(appOperations.step, starts)
      )
    )
}

export interface RetryWorkflows {
  APP_LAUNCH_WORKFLOW?: WorkflowStarter<AppLaunchParams>
  APP_TEARDOWN_WORKFLOW?: WorkflowStarter<AppTeardownParams>
}

/**
 * The highest `-rN` an earlier retry of `runId` started (0 for none), from the retry audit rows.
 * Local wrangler does not refuse an instance id that exists — it hands back the old instance and
 * nothing runs — so the next id cannot be found by trying `-r1` again.
 */
export async function lastRetrySuffix(
  db: Database,
  tenantId: string,
  appId: string,
  runId: string
): Promise<number> {
  const rows = await db
    .select({ summary: auditEvents.summary })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.appId, appId),
        eq(auditEvents.action, 'app.pipeline.retried'),
        sql`${auditEvents.summary} -> 'after' ->> 'runId' = ${runId}`
      )
    )
  let last = 0
  for (const { summary } of rows) {
    const id = (summary.after as { instanceId?: unknown } | undefined)?.instanceId
    const n =
      typeof id === 'string' && id.startsWith(`${runId}-r`) ? Number(id.slice(runId.length + 2)) : 0
    if (Number.isInteger(n) && n > last) last = n
  }
  return last
}

async function createNextInstance<P>(
  starter: WorkflowStarter<P>,
  runId: string,
  params: P,
  after: number
): Promise<string> {
  for (let n = after + 1; n <= MAX_RETRY_SUFFIX; n++) {
    const id = `${runId}-r${n}`
    try {
      await starter.create({ id, params })
      return id
    } catch (err) {
      if (err instanceof Error && /already.?exists/i.test(err.message)) continue
      throw err
    }
  }
  throw new ConflictError('This run has been retried too many times', 'retry_limit')
}

export async function retryPipeline(
  db: Database,
  workflows: RetryWorkflows,
  tenantId: string,
  appId: string,
  kind: PipelineKind,
  actor: AuditActor
): Promise<RetryPipelineResponse> {
  const app = await getAppRow(db, tenantId, appId)
  const runId = await latestRunId(db, tenantId, app, kind)
  if (!runId) throw new ConflictError(`This app has no ${kind} run to retry`, 'no_run')
  const rows = await runRows(db, tenantId, runId)
  const status =
    rows.length === 0 && kind === 'create' && app.status === 'failed'
      ? 'failed'
      : deriveRunStatus(kind, rows)
  if (status !== 'failed') {
    throw new ConflictError(
      `Only a failed run can be retried (this one is ${status})`,
      'run_not_failed'
    )
  }
  const options = await requestedOptions(db, tenantId, app.id, kind, runId)
  const after = await lastRetrySuffix(db, tenantId, app.id, runId)

  let instanceId: string
  if (kind === 'create') {
    const starter = requireWorkflow(workflows.APP_LAUNCH_WORKFLOW, 'APP_LAUNCH_WORKFLOW')
    await restartJobs(db, tenantId, runId, rows)
    await db
      .update(apps)
      .set({ status: 'provisioning', updatedAt: new Date() })
      .where(and(eq(apps.tenantId, tenantId), eq(apps.id, app.id)))
    instanceId = await createNextInstance(
      starter,
      runId,
      {
        tenantId,
        appId: app.id,
        runId,
        userId: app.createdByUserId,
        options: { deployStaging: options.deployStaging !== false },
      },
      after
    )
    // Where `/ci/scaffold/done` and `/ci/deploy/:id/finish` now send their events (`instance.ts`).
    await db
      .update(apps)
      .set({ launchInstanceId: instanceId, updatedAt: new Date() })
      .where(and(eq(apps.tenantId, tenantId), eq(apps.id, app.id)))
  } else {
    const starter = requireWorkflow(workflows.APP_TEARDOWN_WORKFLOW, 'APP_TEARDOWN_WORKFLOW')
    instanceId = await createNextInstance(
      starter,
      runId,
      {
        tenantId,
        appId: app.id,
        runId,
        userId: actor.actorUserId,
        deleteRepo: options.deleteRepo === true,
      },
      after
    )
  }

  await recordAudit(db, {
    tenantId,
    ...actor,
    action: 'app.pipeline.retried',
    targetType: 'App',
    targetId: app.id,
    appId: app.id,
    summary: { after: { kind, runId, instanceId } },
  })
  return { runId, instanceId }
}
