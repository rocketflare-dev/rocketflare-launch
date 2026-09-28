/**
 * Stopping a create run that is still `running` (`POST /api/apps/:id/pipeline/cancel`,
 * `manage App`) — the way out of a run stuck in a wait, so that "Retry from failed step" becomes
 * available. A run's status is derived from its rows (`runs.ts`), so stopping it is writing a
 * failed row:
 *
 * 1. Every `running` row is marked failed "Stopped by <who>"; with none running (between steps),
 *    the next step without a row gets that failed row instead.
 * 2. An `approved` scaffold ticket of the run is withdrawn (`failed`), so a job still on its way
 *    cannot claim it, and a poll of the old instance ends its wait.
 * 3. The live Workflow instance (`launchInstanceOf`) is terminated — best effort: an instance the
 *    platform no longer has is already stopped, and one that refuses finds its wait row failed at
 *    its next poll and fails the run itself.
 * 4. The app is `failed`, audited `app.pipeline.cancelled`.
 *
 * A retry then restarts the step that failed, and a failed wait restarts the job it waited on
 * (`retry.ts`), on a fresh ticket.
 */
import type { CancelPipelineResponse } from '@launch/shared/launch-pipeline'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { apps, deployTickets } from '../../../../db/schema'
import { ConflictError } from '../../../utils/core/errors'
import { getAppRow } from '../apps'
import { type AuditActor, recordAudit } from '../audit'
import { launchInstanceOf } from './instance'
import { failOpenStep } from './operations'
import { deriveRunStatus, latestRunId, nextStepOf, runRows } from './runs'

/** The slice of `APP_LAUNCH_WORKFLOW` a cancel needs. */
export interface WorkflowTerminator {
  get(id: string): Promise<{ terminate(): Promise<void> }>
}

export async function cancelLaunch(
  db: Database,
  workflow: WorkflowTerminator | undefined,
  tenantId: string,
  appId: string,
  actor: AuditActor
): Promise<CancelPipelineResponse> {
  const app = await getAppRow(db, tenantId, appId)
  const runId = await latestRunId(db, tenantId, app, 'create')
  const rows = runId ? await runRows(db, tenantId, runId) : []
  // A run still waiting on its `app.create` approval has no rows and no instance: that is the
  // approvals inbox's to reject, not this route's.
  if (!runId || rows.length === 0 || deriveRunStatus('create', rows) !== 'running') {
    throw new ConflictError('Only a launch that is running can be stopped', 'run_not_running')
  }

  const message = `Stopped by ${actor.actorEmail ?? 'an administrator'}`
  const key = (step: string) => ({ tenantId, appId, runId, kind: 'create', step })
  const running = rows.filter(r => r.status === 'running').map(r => r.step)
  const next = nextStepOf('create', rows)
  const stopped = running.length > 0 ? running : next ? [next] : []
  if (stopped.length === 0) {
    throw new ConflictError('Only a launch that is running can be stopped', 'run_not_running')
  }
  for (const step of stopped) await failOpenStep(db, key(step), message)

  await db
    .update(deployTickets)
    .set({ status: 'failed', error: message, updatedAt: new Date() })
    .where(
      and(
        eq(deployTickets.tenantId, tenantId),
        eq(deployTickets.launchRunId, runId),
        eq(deployTickets.purpose, 'scaffold'),
        eq(deployTickets.status, 'approved')
      )
    )

  let terminated = false
  if (workflow) {
    try {
      const instance = await workflow.get(launchInstanceOf(app, runId))
      await instance.terminate()
      terminated = true
    } catch {
      // Gone already, or finished: its rows say failed either way.
    }
  }

  await db
    .update(apps)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, app.id)))
  await recordAudit(db, {
    tenantId,
    ...actor,
    action: 'app.pipeline.cancelled',
    targetType: 'App',
    targetId: app.id,
    appId: app.id,
    summary: { after: { kind: 'create', runId, steps: stopped, terminated } },
  })
  return { runId, step: stopped[0] as string, terminated }
}
