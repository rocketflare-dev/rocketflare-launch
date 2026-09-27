/**
 * `AppLaunchWorkflow` (Launch P2) — creating an app, bound as `APP_LAUNCH_WORKFLOW`
 * (`launch-app-create[-staging]`). `createApp` (`services/launch/pipeline/create.ts`) starts it
 * with the pipeline run id as the instance id; a retry is `<runId>-rN` with the SAME `runId` in
 * the params, so every `app_operations` row that already succeeded is skipped and the run resumes
 * where it failed. The steps are `APP_LAUNCH_STEPS`; their bodies are plain functions in
 * `services/launch/pipeline/launch-steps.ts`, and this class only wires them:
 *
 *   reserve → repo → scaffold.start → (scaffold.poll#N → scaffold.wait#N)… → scaffold.wait →
 *   scaffold.verify → neon → cloudflare → oidc_client → write_config → placeholders → github_env →
 *   worker_secrets → email (non-blocking) → deploy_staging.start →
 *   (deploy_staging.poll#N → deploy_staging.wait#N)… → deploy_staging.wait → deploy_staging.check
 *   → (health#N → health-wait#N)… → health → production (skipped) → live
 *
 * - **Every name is distinct** — a step name is its identity to the platform, and a repeated one
 *   replays the first call's result (`workflows/CLAUDE.md`). Rounds carry `#N`.
 * - **One DB client per step** (`withStepDatabase`), and the credentials are unsealed inside the
 *   step that uses them. A step returns ids and flags only: never a secret.
 * - **An uncaught failure** ends in `launch_failed` (status `failed`, audit `app.launch_failed`)
 *   and the run RETURNS — the rows, not the instance status, are what the app page and the retry
 *   route read.
 *
 * `overrides` is for tests: the adapter ports, the credentials and a no-wait `sleep`. Exported from
 * `src/worker.ts`, never from `api/index.ts`.
 */
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
} from 'cloudflare:workers'
import {
  type AppLaunchParams,
  DEPLOY_FINISHED_EVENT,
  SCAFFOLD_FINISHED_EVENT,
} from '@launch/shared/launch-pipeline'
import { type AppConfig, loadConfig } from '../../config'
import {
  cloudflareStep,
  DEPLOY_WAIT,
  deployCheckStep,
  deployPoll,
  deployStartStep,
  deployWaitStep,
  emailStep,
  githubEnvStep,
  HEALTH_TRIES,
  type HealthProbe,
  healthProbe,
  healthStep,
  launchFailedStep,
  liveStep,
  neonStep,
  oidcClientStep,
  type PipelineDeps,
  type PipelineOverrides,
  pipelineDeps,
  placeholdersStep,
  productionStep,
  repoStep,
  reserveStep,
  SCAFFOLD_WAIT,
  scaffoldPoll,
  scaffoldStartStep,
  scaffoldVerifyStep,
  scaffoldWaitStep,
  skipDeploy,
  workerSecretsStep,
  writeConfigStep,
} from '../services/launch/pipeline/launch-steps'
import { defaultPorts } from '../services/launch/pipeline/ports'
import type { AppBindings } from '../types'
import { loggerFor } from '../utils/core/logger'
import { withStepDatabase } from './agent-run'

/** Every pipeline step: retried with backoff, bounded per attempt (plan §3 2c). */
export const PIPELINE_STEP_CONFIG = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const

/** A wait round's look at a ticket: cheap, so fewer retries. */
export const POLL_STEP_CONFIG = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'constant' },
  timeout: '1 minute',
} as const

type StepConfig = typeof PIPELINE_STEP_CONFIG | typeof POLL_STEP_CONFIG

/**
 * `step.do` without the platform's `Serializable<T>` bound, which a generic wrapper cannot prove:
 * every body behind it returns plain JSON — ids, flags, `runStep`'s `{ externalIds, skipped,
 * attempt }` — never a row and never a secret.
 */
export interface LooseStep {
  do(name: string, config: StepConfig, fn: () => Promise<unknown>): Promise<unknown>
}

export interface LaunchOutcome {
  runId: string
  status: 'live' | 'failed'
  error?: string
}

export class AppLaunchWorkflow extends WorkflowEntrypoint<AppBindings, AppLaunchParams> {
  /** Tests only — see the header. */
  overrides: PipelineOverrides = {}

  async run(event: WorkflowEvent<AppLaunchParams>, step: WorkflowStep): Promise<LaunchOutcome> {
    const params = event.payload
    const env = this.env
    const cfg = loadConfig(env)
    const logger = loggerFor(cfg, { handler: 'workflow', workflow: 'app-launch', ...params })
    const run = <T>(
      name: string,
      body: (d: PipelineDeps) => Promise<T>,
      config: StepConfig = PIPELINE_STEP_CONFIG
    ): Promise<T> =>
      (step as unknown as LooseStep).do(name, config, () =>
        withStepDatabase(env, cfg, db => body(this.deps(db, cfg)))
      ) as Promise<T>

    try {
      await run('reserve', d => reserveStep(d, params))
      await run('repo', d => repoStep(d, params))
      await run('scaffold.start', d => scaffoldStartStep(d, params))
      await this.awaitTicket(step, run, 'scaffold', SCAFFOLD_FINISHED_EVENT, SCAFFOLD_WAIT, d =>
        scaffoldPoll(d, params)
      )
      await run('scaffold.wait', d => scaffoldWaitStep(d, params))
      await run('scaffold.verify', d => scaffoldVerifyStep(d, params))
      await run('neon', d => neonStep(d, params))
      await run('cloudflare', d => cloudflareStep(d, params))
      await run('oidc_client', d => oidcClientStep(d, params))
      await run('write_config', d => writeConfigStep(d, params))
      await run('placeholders', d => placeholdersStep(d, params))
      await run('github_env', d => githubEnvStep(d, params))
      await run('worker_secrets', d => workerSecretsStep(d, params))
      try {
        await run('email', d => emailStep(d, params))
      } catch (err) {
        // Non-blocking (spec/06 step 12): the row says `failed`, the app falls back to "email not
        // configured", and the launch carries on.
        logger.warn({ err }, 'app-launch: email key failed; carrying on without email')
      }
      if (params.options.deployStaging) {
        await run('deploy_staging.start', d => deployStartStep(d, params))
        await this.awaitTicket(step, run, 'deploy_staging', DEPLOY_FINISHED_EVENT, DEPLOY_WAIT, d =>
          deployPoll(d, params)
        )
        await run('deploy_staging.wait', d => deployWaitStep(d, params))
        await run('deploy_staging.check', d => deployCheckStep(d, params))
        let probe: HealthProbe = { up: false, status: 'unknown', error: null, version: null }
        for (let n = 0; n < HEALTH_TRIES; n++) {
          probe = await run(`health#${n}`, d => healthProbe(d, params), POLL_STEP_CONFIG)
          if (probe.up) break
          if (n < HEALTH_TRIES - 1) await step.sleep(`health-wait#${n}`, '30 seconds')
        }
        const last = probe
        await run('health', d => healthStep(d, params, last))
      } else {
        await run('deploy_staging.skipped', d => skipDeploy(d, params))
      }
      await run('production', d => productionStep(d, params))
      await run('live', d => liveStep(d, params))
      return { runId: params.runId, status: 'live' }
    } catch (err) {
      logger.error({ err }, 'app-launch: the launch failed')
      await run('launch_failed', d => launchFailedStep(d, params))
      return { runId: params.runId, status: 'failed', error: 'See the failed step' }
    }
  }

  private deps(db: Parameters<typeof pipelineDeps>[0], cfg: AppConfig): PipelineDeps {
    return pipelineDeps(db, cfg, this.overrides, { ports: defaultPorts })
  }

  /**
   * Wait for a ticket in ROUNDS (`launch-steps.ts` header): poll the row (and the job), then park
   * on the event for one round. Returns when the poll says done or the rounds run out — the
   * `<prefix>.wait` step after it decides which. A poll that finds a failure throws.
   */
  private async awaitTicket(
    step: WorkflowStep,
    run: <T>(
      name: string,
      body: (d: PipelineDeps) => Promise<T>,
      config?: StepConfig
    ) => Promise<T>,
    prefix: 'scaffold' | 'deploy_staging',
    type: string,
    plan: { rounds: number; roundTimeout: string },
    poll: (d: PipelineDeps) => Promise<{ done: boolean }>
  ): Promise<void> {
    for (let round = 0; round < plan.rounds; round++) {
      const state = await run(`${prefix}.poll#${round}`, poll, POLL_STEP_CONFIG)
      if (state.done) return
      try {
        // The payload is ignored on purpose: the ticket row is the truth, re-read next round.
        await step.waitForEvent(`${prefix}.wait#${round}`, {
          type,
          timeout: plan.roundTimeout as WorkflowSleepDuration,
        })
      } catch {
        // No event this round — poll again.
      }
    }
    await run(`${prefix}.poll#${plan.rounds}`, poll, POLL_STEP_CONFIG)
  }
}
