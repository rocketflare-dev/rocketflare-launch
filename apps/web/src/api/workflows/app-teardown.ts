/**
 * `AppTeardownWorkflow` (Launch P2) — archiving an app, bound as `APP_TEARDOWN_WORKFLOW`
 * (`launch-app-teardown[-staging]`). `startTeardown` (`services/launch/pipeline/create.ts`)
 * starts it with a fresh run id; a retry is `<runId>-rN` with the same `runId`, so the deletions
 * that already succeeded are skipped. The steps are `APP_TEARDOWN_STEPS`, their bodies plain
 * functions in `services/launch/pipeline/teardown-steps.ts`: the ids every `create` run recorded,
 * deleted in reverse order, a 404 counting as done.
 *
 * One DB client per step (`withStepDatabase`), distinct step names, ids-only step results. An
 * uncaught failure is audited (`app.teardown_failed`) and the run returns; the app keeps its
 * status until `archived` succeeds. `overrides` is for tests. Exported from `src/worker.ts`.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { AppTeardownParams } from '@launch/shared/launch-pipeline'
import { loadConfig } from '../../config'
import {
  type PipelineDeps,
  type PipelineOverrides,
  pipelineDeps,
} from '../services/launch/pipeline/launch-steps'
import { defaultPorts } from '../services/launch/pipeline/ports'
import {
  archivedStep,
  CLOUDFLARE_DELETIONS,
  deletionStep,
  emailDeletion,
  neonDeletion,
  oidcClientTeardownStep,
  repoTeardownStep,
  teardownFailedStep,
} from '../services/launch/pipeline/teardown-steps'
import type { AppBindings } from '../types'
import { loggerFor } from '../utils/core/logger'
import { withStepDatabase } from './agent-run'
import { type LooseStep, PIPELINE_STEP_CONFIG } from './app-launch'

export interface TeardownOutcome {
  runId: string
  status: 'archived' | 'failed'
}

export class AppTeardownWorkflow extends WorkflowEntrypoint<AppBindings, AppTeardownParams> {
  /** Tests only: the credentials and a no-wait `sleep`. */
  overrides: PipelineOverrides = {}

  async run(event: WorkflowEvent<AppTeardownParams>, step: WorkflowStep): Promise<TeardownOutcome> {
    const params = event.payload
    const env = this.env
    const cfg = loadConfig(env)
    const logger = loggerFor(cfg, { handler: 'workflow', workflow: 'app-teardown', ...params })
    const run = <T>(name: string, body: (d: PipelineDeps) => Promise<T>): Promise<T> =>
      (step as unknown as LooseStep).do(name, PIPELINE_STEP_CONFIG, () =>
        withStepDatabase(env, cfg, db =>
          body(pipelineDeps(db, cfg, this.overrides, { ports: defaultPorts }))
        )
      ) as Promise<T>

    try {
      for (const name of [
        'routes',
        'queue_consumers',
        'workers',
        'workflows',
        'queues',
        'r2',
        'kv',
      ] as const) {
        await run(name, d => deletionStep(d, params, name, CLOUDFLARE_DELETIONS[name]))
      }
      await run('email', d => deletionStep(d, params, 'email', emailDeletion))
      await run('neon', d => deletionStep(d, params, 'neon', neonDeletion))
      await run('oidc_client', d => oidcClientTeardownStep(d, params))
      await run('repo', d => repoTeardownStep(d, params))
      await run('archived', d => archivedStep(d, params))
      return { runId: params.runId, status: 'archived' }
    } catch (err) {
      logger.error({ err }, 'app-teardown: the teardown failed')
      await run('teardown_failed', d => teardownFailedStep(d, params))
      return { runId: params.runId, status: 'failed' }
    }
  }
}
