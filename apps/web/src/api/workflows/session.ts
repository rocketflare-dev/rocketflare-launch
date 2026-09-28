/**
 * `SessionWorkflow` (Launch P3, plan §1.2, §3b) — one instance per coding session, bound as
 * `SESSION_WORKFLOW` (`launch-session[-staging]`). `createSession` starts it with the session id
 * as the instance id (`<id>-rN` after a restart, `wakeSession`); the params are
 * `SessionWorkflowParams`, ids only. Exported from `src/worker.ts`, never from `api/index.ts`.
 *
 * The shape (every step name DISTINCT — a name is its identity to the platform, and a repeated
 * one replays the first call's result, `workflows/CLAUDE.md`):
 *
 *   claim
 *   boot:    db → sandbox.start → repo → [prepare → branch]* → bootstrap → dev (`preview.ready`)
 *            (* only when this session prepares the app's `dev`; a `prepare` run stops after it)
 *   loop N:  inspect#N → one of
 *              wait#N (`waitForEvent(SESSION_WAKE_EVENT)`, the idle / expiry timeout) → on a
 *                timeout suspend#N (live) or end#N (suspended past expiry)
 *              turn#N (3c's `runTurn`) → checkpoint#N · turn-settle#N if the step itself died
 *              ship#N (3d's `ship`) → shipped: leave the loop
 *              suspend#N (a drain) · resume#N → sandbox.start#K → repo#K → bootstrap#K → dev#K →
 *                transcript#K
 *              end#N → leave the loop
 *   fail     (a step gave up: `failed`, with a secret-free sentence)
 *   cleanup  ALWAYS: destroy the sandbox, delete the branch, settle `ended` (or keep `shipped` /
 *            `failed`), audit `session.ended`
 *
 * - One DB client per step (`withStepDatabase`, as `agent-run.ts`) and nudges through
 *   `createStepRealtime().settle()` — no `waitUntil` in a step. The step bodies are
 *   `services/sessions/steps.ts`.
 * - The row is the truth: a wake carries nothing, and `inspect#N` re-reads `pending_message`,
 *   `requested_action`, the status and `sessions_paused`. Every transition is a compare-and-set.
 * - No secret in any step result or event: steps return ids, flags and timings.
 * - The turn step runs with `retries: 0` (a turn is not idempotent — it spends money and edits
 *   files) and the policy's `maxTurnMinutes` as its timeout; the boot steps keep the platform's
 *   default retries, which is why each of them is idempotent.
 *
 * `overrides` is for tests (`FakeSandbox`, the FakeCloud-backed db port, fake hooks); production
 * uses `defaultSessionPorts(env, cfg)` and `defaultSessionStepHooks` (bound at the P3 merge).
 */
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import { SESSION_WAKE_EVENT, type SessionWorkflowParams } from '@launch/shared/launch-sessions'
import { loadConfig } from '../../config'
import { createStepRealtime } from '../services/agents/runtime'
import { SESSION_CALL_LIMITS, type SessionCallLimits } from '../services/sessions/deadline'
import { safeErrorMessage } from '../services/sessions/events'
import { defaultSessionStepHooks, type SessionStepHooks } from '../services/sessions/hooks'
import { defaultSessionPorts, type SessionPorts } from '../services/sessions/ports'
import {
  BOOT_ERROR_MAX_CHARS,
  bootstrapStep,
  branchStep,
  checkpointStep,
  claimStep,
  cleanupStep,
  dbStep,
  devStep,
  endStep,
  failStep,
  inspectStep,
  prepareStep,
  repoStep,
  restoreTranscriptStep,
  resumeStep,
  rolloutStep,
  type StepScope,
  shipStep,
  startSandboxStep,
  suspendStep,
  type TurnStepResult,
  turnNeedsCheckpoint,
  turnSettleStep,
  turnStep,
  withProgress,
} from '../services/sessions/steps'
import { turnStepConfig } from '../services/sessions/turn'
import type { AppBindings } from '../types'
import { loggerFor } from '../utils/core/logger'
import { withStepDatabase } from './agent-run'

/** What the tests hand the class instead of the real adapters. */
export interface SessionWorkflowOverrides {
  ports?: SessionPorts
  hooks?: SessionStepHooks
  /** A no-wait sleep for the polling helpers. */
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
  /** Smaller deadlines and poll intervals (`services/sessions/deadline.ts`). */
  limits?: Partial<SessionCallLimits>
}

export interface SessionOutcome {
  sessionId: string
  status: string
}

/**
 * A correctness guard, not a capacity one: each round is two or three steps and a session caps
 * at `maxTurns` (100 by default); the platform's step budget per instance is far above this.
 */
export const MAX_SESSION_ROUNDS = 1000

/** `step.do` over a `StepScope` — the one way the Workflow runs a step body. */
type StepRunner = <T>(
  name: string,
  fn: (scope: StepScope) => Promise<T>,
  config?: WorkflowStepConfig
) => Promise<T>

/** Boot steps: a few retries — each is idempotent (`steps.ts`). */
const BOOT_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
  timeout: '20 minutes',
}
/** Cleanup must happen: more retries, patient. */
const CLEANUP_STEP: WorkflowStepConfig = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
}

export class SessionWorkflow extends WorkflowEntrypoint<AppBindings, SessionWorkflowParams> {
  /** Tests only — see the header. */
  overrides: SessionWorkflowOverrides = {}

  async run(
    event: WorkflowEvent<SessionWorkflowParams>,
    step: WorkflowStep
  ): Promise<SessionOutcome> {
    const params = event.payload
    const env = this.env
    const cfg = loadConfig(env)
    const logger = loggerFor(cfg, { handler: 'workflow', workflow: 'session', ...params })
    const ports = this.overrides.ports ?? defaultSessionPorts(env, cfg)
    const hooks = this.overrides.hooks ?? defaultSessionStepHooks
    const now = this.overrides.now ?? (() => new Date())
    const limits = { ...SESSION_CALL_LIMITS, ...this.overrides.limits }

    /** One step's scope: its own DB client and realtime, both closed when it ends. */
    const inStep = <T>(fn: (scope: StepScope) => Promise<T>): Promise<T> =>
      withStepDatabase(env, cfg, async db => {
        const { realtime, settle } = createStepRealtime(env, logger)
        try {
          return await fn({ db, env, cfg, ports, hooks, realtime, logger, now, params, limits })
        } finally {
          await settle()
        }
      })
    // Step results are plain JSON objects (ids, flags, timings) — serializable by construction,
    // which the platform's `Rpc.Serializable` constraint cannot see through a generic.
    const run: StepRunner = (name, fn, config) => {
      const body = () => inStep(fn) as never
      return (config ? step.do(name, config, body) : step.do(name, body)) as never
    }

    const claim = await run('claim', claimStep)
    if (claim.start === 'skip') return { sessionId: params.sessionId, status: claim.status }

    try {
      if (claim.start === 'boot') {
        const db = await run('db', withProgress('db', dbStep), BOOT_STEP)
        const { bootId } = await run(
          'sandbox.start',
          withProgress('sandbox', startSandboxStep),
          BOOT_STEP
        )
        await run(
          'repo',
          withProgress('repo', s => repoStep(s, bootId)),
          BOOT_STEP
        )
        if (db.prepare) {
          await run(
            'prepare',
            withProgress('prepare', s => prepareStep(s, bootId)),
            BOOT_STEP
          )
          if (claim.kind === 'prepare') {
            return await this.finish(run, params.sessionId)
          }
          await run('branch', withProgress('branch', branchStep), BOOT_STEP)
        }
        await run(
          'bootstrap',
          withProgress('bootstrap', s => bootstrapStep(s, bootId)),
          BOOT_STEP
        )
        await run(
          'dev',
          withProgress('dev', s => devStep(s, bootId)),
          BOOT_STEP
        )
      }
      if (claim.start !== 'cleanup') await this.loop(run, step)
    } catch (err) {
      logger.error({ err }, 'session: giving up')
      const message = safeErrorMessage(
        err,
        'The session stopped unexpectedly',
        BOOT_ERROR_MAX_CHARS
      )
      await run('fail', scope => failStep(scope, message)).catch(failErr =>
        logger.error({ err: failErr }, 'session: could not record the failure')
      )
    }
    return this.finish(run, params.sessionId)
  }

  private async finish(run: StepRunner, sessionId: string): Promise<SessionOutcome> {
    const { status } = await run('cleanup', cleanupStep, CLEANUP_STEP)
    return { sessionId, status }
  }

  /** The turn loop — see the header. Returns when the session should be cleaned up. */
  private async loop(run: StepRunner, step: WorkflowStep): Promise<void> {
    let resumes = 0
    for (let n = 0; n < MAX_SESSION_ROUNDS; n++) {
      const next = await run(`inspect#${n}`, inspectStep)
      switch (next.action) {
        case 'done':
          return
        case 'end':
          await run(`end#${n}`, scope => endStep(scope, next.reason))
          return
        case 'suspend':
          await run(`suspend#${n}`, scope => suspendStep(scope, next.reason))
          break
        case 'wait': {
          try {
            await step.waitForEvent(`wait#${n}`, {
              type: SESSION_WAKE_EVENT,
              timeout: `${next.timeoutMinutes} minutes` as WorkflowSleepDuration,
            })
          } catch {
            // Nobody woke us inside the window: an idle live session suspends; a suspended one
            // that nobody resumed before its expiry ends.
            if (next.waitingIn === 'suspended') {
              await run(`end#${n}`, scope => endStep(scope, 'expired'))
              return
            }
            await run(`suspend#${n}`, scope => suspendStep(scope, 'idle'))
          }
          break
        }
        case 'turn': {
          let outcome: TurnStepResult
          try {
            outcome = await run(`turn#${n}`, turnStep, turnStepConfig(next))
          } catch (err) {
            // The step itself died (its timeout, the database): repair a row left `working`.
            await run(`turn-settle#${n}`, scope =>
              turnSettleStep(scope, safeErrorMessage(err, 'The turn took too long and was stopped'))
            )
            outcome = { status: 'failed' }
          }
          if (outcome.status === 'interrupted' && outcome.reason === 'rollout') {
            await run(`rollout#${n}`, rolloutStep)
          } else if (turnNeedsCheckpoint(outcome)) {
            await run(`checkpoint#${n}`, scope => checkpointStep(scope, 'turn'))
          }
          break
        }
        case 'ship': {
          const shipped = await run(`ship#${n}`, shipStep)
          if (shipped.status === 'shipped') return
          break
        }
        case 'resume': {
          const resumed = await run(`resume#${n}`, resumeStep)
          if (!resumed.resumed) break
          resumes += 1
          const k = resumes
          const { bootId } = await run(
            `sandbox.start#${k}`,
            withProgress('sandbox', startSandboxStep),
            BOOT_STEP
          )
          await run(
            `repo#${k}`,
            withProgress('repo', s => repoStep(s, bootId)),
            BOOT_STEP
          )
          await run(
            `bootstrap#${k}`,
            withProgress('bootstrap', s => bootstrapStep(s, bootId)),
            BOOT_STEP
          )
          await run(
            `dev#${k}`,
            withProgress('dev', s => devStep(s, bootId)),
            BOOT_STEP
          )
          await run(
            `transcript#${k}`,
            withProgress('transcript', s => restoreTranscriptStep(s, bootId)),
            BOOT_STEP
          )
          break
        }
      }
    }
    // A runaway loop: end it rather than grow the instance for ever.
    await run('end#max', scope => endStep(scope, 'max_rounds'))
  }
}
