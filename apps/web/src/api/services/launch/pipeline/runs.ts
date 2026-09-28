/**
 * Pipeline RUNS as the app page sees them (Launch P2): which run of a kind is the latest, its
 * whole status derived from its `app_operations` rows, and the ordered view `GET
 * /api/apps/:id/pipeline` returns. There is no runs table — the rows are the truth, and a run is
 * the set of rows sharing a `run_id`.
 *
 * **How a run's status is derived**: `none` with no rows; `succeeded` once its FINAL step (`live`,
 * `archived`) has succeeded; `failed` when any row has failed, except a step the run carries on
 * past (`email` — plan step 11 is non-blocking); otherwise `running`.
 */
import type { AppOperationStatus } from '@launch/shared/launch-apps'
import {
  APP_LAUNCH_STEPS,
  APP_TEARDOWN_STEPS,
  type PipelineKind,
  type PipelineRunStatus,
  type PipelineStepDefinition,
  type PipelineView,
} from '@launch/shared/launch-pipeline'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import {
  type AppOperationRow,
  type AppRow,
  appOperations,
  auditEvents,
} from '../../../../db/schema'

export const PIPELINE_STEPS: Record<PipelineKind, readonly PipelineStepDefinition[]> = {
  create: APP_LAUNCH_STEPS,
  teardown: APP_TEARDOWN_STEPS,
}

/** Steps whose failure the run carries on past. */
export const NON_BLOCKING_STEPS: Record<PipelineKind, readonly string[]> = {
  create: ['email'],
  teardown: [],
}

/** The audit action that STARTED a run of each kind — its summary carries the run's options. */
export const REQUESTED_ACTION: Record<PipelineKind, string> = {
  create: 'app.create.requested',
  teardown: 'app.teardown.requested',
}

/** The latest run of `kind` for the app: the recorded launch run, else the newest row's. */
export async function latestRunId(
  db: Database,
  tenantId: string,
  app: AppRow,
  kind: PipelineKind
): Promise<string | null> {
  if (kind === 'create' && app.launchRunId) return app.launchRunId
  const [row] = await db
    .select({ runId: appOperations.runId })
    .from(appOperations)
    .where(
      and(
        eq(appOperations.tenantId, tenantId),
        eq(appOperations.appId, app.id),
        eq(appOperations.kind, kind)
      )
    )
    .orderBy(desc(appOperations.createdAt))
    .limit(1)
  if (row) return row.runId
  // A run whose Workflow has not written its first row yet is still a run: its request is audited.
  const [requested] = await db
    .select({ runId: sql<string>`${auditEvents.summary} -> 'after' ->> 'runId'` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.appId, app.id),
        eq(auditEvents.action, REQUESTED_ACTION[kind])
      )
    )
    .orderBy(desc(auditEvents.at))
    .limit(1)
  return requested?.runId ?? null
}

export async function runRows(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AppOperationRow[]> {
  return db
    .select()
    .from(appOperations)
    .where(and(eq(appOperations.tenantId, tenantId), eq(appOperations.runId, runId)))
}

/** The run's status from its rows (see the header). */
export function deriveRunStatus(
  kind: PipelineKind,
  rows: readonly Pick<AppOperationRow, 'step' | 'status'>[]
): PipelineRunStatus {
  if (rows.length === 0) return 'none'
  const steps = PIPELINE_STEPS[kind]
  const final = steps[steps.length - 1]?.step
  if (rows.some(r => r.step === final && r.status === 'succeeded')) return 'succeeded'
  const blocking = rows.filter(r => !NON_BLOCKING_STEPS[kind].includes(r.step))
  if (blocking.some(r => r.status === 'failed')) return 'failed'
  return 'running'
}

/** A wait's GitHub run page, when its row recorded one (`runUrl`, an https URL — nothing else). */
function runUrlOf(ids: Record<string, string> | undefined): string | null {
  const url = ids?.runUrl
  return typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url) ? url : null
}

/** The whole run, every step of `kind` in order (`pending` where no row exists yet). */
export async function pipelineView(
  db: Database,
  tenantId: string,
  app: AppRow,
  kind: PipelineKind
): Promise<PipelineView> {
  const runId = await latestRunId(db, tenantId, app, kind)
  const rows = runId ? await runRows(db, tenantId, runId) : []
  const byStep = new Map(rows.map(r => [r.step, r]))
  // Requested but no row yet: running — unless starting the Workflow itself failed.
  const status =
    runId && rows.length === 0
      ? kind === 'create' && app.status === 'failed'
        ? 'failed'
        : 'running'
      : deriveRunStatus(kind, rows)
  return {
    appId: app.id,
    runId,
    kind,
    status,
    steps: PIPELINE_STEPS[kind].map(def => {
      const row = byStep.get(def.step)
      return {
        step: def.step,
        label: def.label,
        status: (row?.status ?? 'pending') as AppOperationStatus,
        attempt: row?.attempt ?? 0,
        error: row?.error ?? null,
        startedAt: row?.startedAt ?? null,
        finishedAt: row?.finishedAt ?? null,
        url: runUrlOf(row?.externalIds),
      }
    }),
  }
}

/** The options a run was started with, from the audit row that requested it. */
export async function requestedOptions(
  db: Database,
  tenantId: string,
  appId: string,
  kind: PipelineKind,
  runId: string
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ summary: auditEvents.summary })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.appId, appId),
        eq(auditEvents.action, REQUESTED_ACTION[kind]),
        sql`${auditEvents.summary} -> 'after' ->> 'runId' = ${runId}`
      )
    )
    .limit(1)
  return (row?.summary.after ?? {}) as Record<string, unknown>
}
