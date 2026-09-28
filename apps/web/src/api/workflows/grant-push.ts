/**
 * `GrantPushWorkflow` (Launch P5, plan §1.10) — one instance per `grant_pushes` row, bound as
 * `GRANT_PUSH_WORKFLOW` (`launch-grant-push[-staging]`) and shaped like `AppLaunchWorkflow`.
 * `startPush` (`services/grants/push.ts`) starts it with the push id as the instance id
 * (`<pushId>-rN` on a retry); the params are `GrantPushParams` (`@launch/shared/launch-grants`),
 * ids only.
 *
 * The shape slice 5c builds (every step name DISTINCT — `workflows/CLAUDE.md`):
 *
 *   plan    → materialise `grant_push_targets` (one per live grant in scope, an idempotent insert)
 *   push#N  → up to `GRANT_PUSH_BATCH` targets per step: skip a succeeded one and a grant already
 *             holding a newer version; put (or remove) the names through the `GrantBacking`
 *   finish  → the push's status and counts; retire the previous version when a rotation reached
 *             every holder; audit and notify
 *
 * - One DB client per step (`withStepDatabase`, `agent-run.ts`), `PIPELINE_STEP_CONFIG` and
 *   `LooseStep` (`app-launch.ts`); nudges through `createStepRealtime().settle()`.
 * - Values are decrypted inside a step and never returned: a step returns ids and counts.
 *
 * `overrides` is for tests (a backing, the clock). Exported from `src/worker.ts`, never from
 * `api/index.ts`.
 *
 * **Slice 5c owns this file.** From 5a it is a stub whose `run` throws `NotWiredError`.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { GrantPushParams, GrantPushStatus } from '@launch/shared/launch-grants'
import { type GrantBacking, NotWiredError } from '../services/grants/types'
import type { AppBindings } from '../types'

/** What the tests hand the class instead of the configured backing. */
export interface GrantPushWorkflowOverrides {
  backing?: GrantBacking
  now?: () => Date
}

export interface GrantPushOutcome {
  pushId: string
  status: GrantPushStatus
}

export class GrantPushWorkflow extends WorkflowEntrypoint<AppBindings, GrantPushParams> {
  /** Tests only — see the header. */
  overrides: GrantPushWorkflowOverrides = {}

  async run(
    _event: WorkflowEvent<GrantPushParams>,
    _step: WorkflowStep
  ): Promise<GrantPushOutcome> {
    throw new NotWiredError('GrantPushWorkflow.run', '5c')
  }
}
