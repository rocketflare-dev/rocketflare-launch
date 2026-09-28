/**
 * `GET /api/apps/:id/pipeline`'s service half (Launch P2): bring the latest run up to date, then
 * read it. Two looks, each throttled in the database and neither able to throw into the request:
 *
 * 1. A create run's open wait is polled (`wait-poll.ts`, at most once per 20 s per wait): a job
 *    that died on GitHub fails its wait here, with the run URL, and its Workflow is nudged.
 * 2. A stale running run is reconciled against its Workflow instance (`reconcile.ts`, at most once
 *    per 3 minutes): a run whose instance died mid-step is failed, so Retry is offered.
 *
 * Then the view (`runs.ts`), over the app as those left it.
 */
import type { PipelineKind, PipelineView } from '@launch/shared/launch-pipeline'
import type { Database } from '../../../../db/client'
import { getAppRow } from '../apps'
import type { PipelineDeps } from './launch-steps'
import { type ReconcileLogger, reconcilePipelineSafely, type WorkflowInspector } from './reconcile'
import { pipelineView } from './runs'
import { pollOpenWaitsSafely, type WaitEventSender } from './wait-poll'

/** The two Workflow bindings as a read uses them — `c.env` and `RecordingWorkflow` satisfy it. */
export interface PipelineReadWorkflows {
  APP_LAUNCH_WORKFLOW?: WorkflowInspector & WaitEventSender
  APP_TEARDOWN_WORKFLOW?: WorkflowInspector
}

export async function readPipeline(
  db: Database,
  workflows: PipelineReadWorkflows,
  deps: PipelineDeps,
  tenantId: string,
  appId: string,
  kind: PipelineKind,
  options: { now?: Date; logger?: ReconcileLogger } = {}
): Promise<PipelineView> {
  const app = await getAppRow(db, tenantId, appId)
  let changed = false
  if (kind === 'create') {
    const waits = await pollOpenWaitsSafely(
      db,
      deps,
      workflows.APP_LAUNCH_WORKFLOW,
      tenantId,
      app,
      options
    )
    changed = waits.polled.some(p => p.state.error)
  }
  const reconciled = await reconcilePipelineSafely(
    db,
    workflows,
    tenantId,
    app,
    kind,
    options.logger
  )
  changed ||= reconciled.outcome === 'failed'
  const current = changed ? await getAppRow(db, tenantId, appId) : app
  return pipelineView(db, tenantId, current, kind)
}
