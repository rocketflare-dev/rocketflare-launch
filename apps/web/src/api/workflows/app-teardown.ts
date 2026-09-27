/**
 * `AppTeardownWorkflow` (P2) — archiving an app, bound as `APP_TEARDOWN_WORKFLOW`. It gathers the
 * ids every `create` run recorded (`app_operations` plus `app_environments`) and deletes in the
 * reverse order of `APP_TEARDOWN_STEPS`; a 404 counts as done.
 *
 * Slice 2a ships the class and its binding; slice 2c fills `run`. Exported from `src/worker.ts`.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { AppTeardownParams } from '@launch/shared/launch-pipeline'
import type { AppBindings } from '../types'

export class AppTeardownWorkflow extends WorkflowEntrypoint<AppBindings, AppTeardownParams> {
  async run(event: WorkflowEvent<AppTeardownParams>, _step: WorkflowStep): Promise<unknown> {
    return { runId: event.payload.runId, status: 'skipped' }
  }
}
