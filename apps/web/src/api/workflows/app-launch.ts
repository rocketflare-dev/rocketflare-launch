/**
 * `AppLaunchWorkflow` (P2) — creating an app, bound as `APP_LAUNCH_WORKFLOW`. The instance id is
 * the pipeline run id (`<runId>-rN` on a retry, with the SAME `runId` in the params so every
 * succeeded `app_operations` row is skipped). The steps are `APP_LAUNCH_STEPS` in
 * `@launch/shared/launch-pipeline`; each is a `step.do` wrapped in `runStep`
 * (`services/launch/pipeline/operations.ts`), one DB client per step (`withStepDatabase`).
 *
 * Slice 2a ships the class and its binding so the Worker, the tomls and the types agree; slice 2c
 * fills `run`. Exported from `src/worker.ts`, never from `api/index.ts`.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { AppLaunchParams } from '@launch/shared/launch-pipeline'
import type { AppBindings } from '../types'

export class AppLaunchWorkflow extends WorkflowEntrypoint<AppBindings, AppLaunchParams> {
  async run(event: WorkflowEvent<AppLaunchParams>, _step: WorkflowStep): Promise<unknown> {
    return { runId: event.payload.runId, status: 'skipped' }
  }
}
