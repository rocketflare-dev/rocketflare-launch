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
 * The bodies are `services/grants/push-steps.ts`. A step that throws past its retries ends in
 * `fail` (the push `failed`, its active slot released, Retry offered) and the run RETURNS — the
 * row, not the instance status, is what the resource page and the retry route read.
 *
 * **Slice 5c owns this file.**
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { GrantPushParams, GrantPushStatus } from '@launch/shared/launch-grants'
import { loadConfig } from '../../config'
import type { Database } from '../../db/client'
import { createStepRealtime } from '../services/agents/runtime'
import {
  batchCount,
  failPush,
  finishPush,
  type PushStepDeps,
  planPush,
  pushBatch,
} from '../services/grants/push-steps'
import type { GrantBacking } from '../services/grants/types'
import type { AppBindings } from '../types'
import { loggerFor } from '../utils/core/logger'
import { withStepDatabase } from './agent-run'
import { type LooseStep, PIPELINE_STEP_CONFIG } from './app-launch'

/** What the tests hand the class instead of the configured backing. */
export interface GrantPushWorkflowOverrides {
  backing?: GrantBacking
  now?: () => Date
  /** Vendor calls (the Cloudflare backing) go through this — FakeCloud in tests. */
  fetch?: typeof fetch
}

export interface GrantPushOutcome {
  pushId: string
  status: GrantPushStatus
}

export class GrantPushWorkflow extends WorkflowEntrypoint<AppBindings, GrantPushParams> {
  /** Tests only — see the header. */
  overrides: GrantPushWorkflowOverrides = {}

  async run(event: WorkflowEvent<GrantPushParams>, step: WorkflowStep): Promise<GrantPushOutcome> {
    const params = event.payload
    const env = this.env
    const cfg = loadConfig(env)
    const logger = loggerFor(cfg, { handler: 'workflow', workflow: 'grant-push', ...params })
    const run = <T>(name: string, body: (d: PushStepDeps) => Promise<T>): Promise<T> =>
      (step as unknown as LooseStep).do(name, PIPELINE_STEP_CONFIG, () =>
        withStepDatabase(env, cfg, async (db: Database) => {
          const { realtime, settle } = createStepRealtime(env, logger)
          try {
            return await body({
              db,
              env,
              cfg,
              logger,
              realtime,
              ...(this.overrides.backing ? { backing: this.overrides.backing } : {}),
              ...(this.overrides.now ? { now: this.overrides.now } : {}),
              ...(this.overrides.fetch ? { fetch: this.overrides.fetch } : {}),
            })
          } finally {
            await settle()
          }
        })
      ) as Promise<T>

    try {
      const plan = await run('plan', d => planPush(d, params))
      if (!plan.go) return { pushId: params.pushId, status: 'failed' }
      for (let n = 0; n < batchCount(plan.total); n++) {
        await run(`push#${n}`, d => pushBatch(d, params, n))
      }
      const done = await run('finish', d => finishPush(d, params))
      return { pushId: params.pushId, status: done.status }
    } catch (err) {
      logger.error({ err }, 'grant-push: a step failed past its retries')
      await run('fail', d => failPush(d, params))
      return { pushId: params.pushId, status: 'failed' }
    }
  }
}
