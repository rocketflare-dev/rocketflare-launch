/**
 * `SessionWorkflow` (Launch P3, plan §1.2, §3b) — one instance per coding session, bound as
 * `SESSION_WORKFLOW` (`launch-session[-staging]`). `createSession` starts it with the session id
 * as the instance id (`<id>-rN` after a restart, `wakeSession`); the params are
 * `SessionWorkflowParams`, ids only. Exported from `src/worker.ts`, never from `api/index.ts`.
 *
 * The shape (every step name DISTINCT — a name is its identity to the platform, and a repeated
 * one replays the first call's result, `workflows/CLAUDE.md`):
 *
 *   claim → salvage (a live session whose instance was lost: stop the orphaned turn, checkpoint,
 *            keep the container for a warm resume or destroy it — `salvageStep`)
 *   boot:    db → sandbox.start → repo → [prepare → branch]* → bootstrap → dev (`preview.ready`)
 *            (* only when this session prepares the app's `dev`; a `prepare` run stops after it)
 *   loop N:  inspect#N (given the loop's `DirtyState`) → one of
 *              wait#N (`waitForEvent(SESSION_WAKE_EVENT)`, the idle / warm / expiry timeout, or
 *                the checkpoint DEBOUNCE's when the workspace holds unsaved changes) →
 *                on a timeout suspend#N (live; an idle suspend KEEPS the container), cool#N
 *                (suspended with a kept container past its warm window), end#N (suspended
 *                past expiry) or, for a debounce wait, checkpoint#N — and the loop waits on
 *              turn#N (3c's `runTurn`; reports `changed` + `endedAt`) → nothing (the debounce
 *                runs from the next inspect) · checkpoint#N when the session has been dirty for
 *                the cap · rollout#N (the container is gone: a rollout, or it died and came back
 *                empty — `containerGone`) · turn-settle#N → checkpoint#N if the step itself died
 *              checkpoint#N (the debounce already due)
 *              ship#N (3d's `ship`) → shipped: leave the loop
 *              suspend#N (a drain) · cool#N (a drain, or a warm window already over)
 *              resume#N → sandbox.start#K → warm (the kept container is still there,
 *                `services/sessions/warm.ts`): dev#K only · cold: restore.check#K →
 *                [restore#K] (the workspace backup, when it is at the branch head) → repo#K
 *                (unless restored) → bootstrap#K → dev#K → transcript#K
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
 * - **Checkpoints are debounced** (`services/sessions/checkpoint.ts`): a turn that left the
 *   workspace changed is saved `SESSION_CHECKPOINT_DEBOUNCE_MS` (30 s) after the LATEST turn — a
 *   message inside the window runs first and the window restarts from its end — or straight after
 *   a turn once the session has held unsaved work for `SESSION_CHECKPOINT_MAX_DEFER_MS` (5 min).
 *   The loop's `DirtyState` is built ONLY from step results (`turn#N`'s `endedAt`); every clock
 *   read and every sum over it happens inside a step (`inspectStep`, `turnStep`), because the
 *   code out here is replayed and a clock read here would differ on each replay. `suspend#N`,
 *   `end#N` and a green ship checkpoint first, so nothing unsaved outlives the container.
 * - **The boot's id is carried through the loop** (`bootId`, from `sandbox.start[#K]`'s result —
 *   replay-safe) into every turn, checkpoint, suspend, end and ship: a container that died and
 *   came back EMPTY (out of memory, most often) is never worked on. A turn refuses it before it
 *   starts (the message kept, the session `suspended` with a resume requested) and probes it while
 *   it runs; a checkpoint reports it lost instead of failing at `cd` (`boot-marker.ts`).
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
  coolStep,
  type DirtyState,
  dbStep,
  devStep,
  dirtyAfterTurn,
  endStep,
  failStep,
  inspectStep,
  prepareStep,
  repoStep,
  restoreCheckStep,
  restoreStep,
  restoreTranscriptStep,
  resumeStep,
  rolloutStep,
  type StepScope,
  salvageStep,
  shipStep,
  startSandboxStep,
  suspendStep,
  type TurnStepResult,
  turnSettleStep,
  turnStep,
  waitDuration,
  withProgress,
} from '../services/sessions/steps'
import { containerGone, turnStepConfig } from '../services/sessions/turn'
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
/** Salvage: its sandbox calls are bounded and caught, so a retry only covers the database. */
const SALVAGE_STEP: WorkflowStepConfig = {
  retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
  timeout: '15 minutes',
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
      // The id `sandbox.start` wrote into the container: every turn and checkpoint checks the
      // container still carries it (`boot-marker.ts`). A step result, so replay-safe.
      let bootId: string | undefined
      if (claim.start === 'salvage') await run('salvage', salvageStep, SALVAGE_STEP)
      if (claim.start === 'boot') {
        const db = await run('db', withProgress('db', dbStep), BOOT_STEP)
        const started = await run(
          'sandbox.start',
          withProgress('sandbox', startSandboxStep),
          BOOT_STEP
        )
        const booted = started.bootId
        bootId = booted
        await run(
          'repo',
          withProgress('repo', s => repoStep(s, booted)),
          BOOT_STEP
        )
        if (db.prepare) {
          await run(
            'prepare',
            withProgress('prepare', s => prepareStep(s, booted)),
            BOOT_STEP
          )
          if (claim.kind === 'prepare') {
            return await this.finish(run, params.sessionId)
          }
          await run('branch', withProgress('branch', branchStep), BOOT_STEP)
        }
        await run(
          'bootstrap',
          withProgress('bootstrap', s => bootstrapStep(s, booted)),
          BOOT_STEP
        )
        await run(
          'dev',
          withProgress('dev', s => devStep(s, booted)),
          BOOT_STEP
        )
      }
      if (claim.start !== 'cleanup') await this.loop(run, step, bootId)
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
  private async loop(
    run: StepRunner,
    step: WorkflowStep,
    initialBootId: string | undefined
  ): Promise<void> {
    let resumes = 0
    // The container the loop's steps must find (`boot-marker.ts`): the boot's, then each resume's.
    let bootId = initialBootId
    // Unsaved work (debounced checkpoints): derived ONLY from step results, never from a clock
    // read here — this code is replayed, a step's result is not. Null = nothing to save.
    let dirty: DirtyState | null = null
    const saveNow = async (n: number) => {
      await run(`checkpoint#${n}`, scope => checkpointStep(scope, 'turn', bootId))
      dirty = null
    }
    for (let n = 0; n < MAX_SESSION_ROUNDS; n++) {
      const before = dirty
      const next = await run(`inspect#${n}`, scope => inspectStep(scope, before))
      switch (next.action) {
        case 'done':
          return
        case 'end':
          // `endStep` checkpoints a live session first.
          await run(`end#${n}`, scope => endStep(scope, next.reason, bootId))
          return
        case 'suspend': {
          // `suspendStep` checkpoints before it suspends.
          const { suspended } = await run(`suspend#${n}`, scope =>
            suspendStep(scope, next.reason, bootId)
          )
          if (suspended) dirty = null
          break
        }
        case 'cool':
          await run(`cool#${n}`, scope => coolStep(scope, next.reason))
          break
        case 'checkpoint':
          await saveNow(n)
          break
        case 'wait': {
          try {
            await step.waitForEvent(`wait#${n}`, {
              type: SESSION_WAKE_EVENT,
              timeout: waitDuration(next.timeoutSeconds) as WorkflowSleepDuration,
            })
          } catch {
            // Quiet for the checkpoint debounce: save, and carry on waiting (never a suspend).
            if (next.debounce) {
              await saveNow(n)
              break
            }
            // Nobody woke us inside the window: an idle live session suspends; a suspended one
            // that nobody resumed before its expiry ends.
            if (next.waitingIn === 'suspended' && next.cool) {
              await run(`cool#${n}`, scope => coolStep(scope, 'idle'))
              break
            }
            if (next.waitingIn === 'suspended') {
              await run(`end#${n}`, scope => endStep(scope, 'expired', bootId))
              return
            }
            // `suspendStep` checkpoints first; it does nothing when the preview kept it busy.
            const { suspended } = await run(`suspend#${n}`, scope =>
              suspendStep(scope, 'idle', bootId)
            )
            if (suspended) dirty = null
          }
          break
        }
        case 'turn': {
          let outcome: TurnStepResult
          try {
            outcome = await run(
              `turn#${n}`,
              scope => turnStep(scope, before, bootId),
              turnStepConfig(next)
            )
          } catch (err) {
            // The step itself died (its timeout, the database): repair a row left `working`, and
            // save at once — nothing measured the workspace, so assume it changed.
            await run(`turn-settle#${n}`, scope =>
              turnSettleStep(scope, safeErrorMessage(err, 'The turn took too long and was stopped'))
            )
            await saveNow(n)
            break
          }
          if (containerGone(outcome)) {
            // The container, and whatever it had not saved, is gone (a rollout, or it died and came
            // back empty): the session is `suspended`, and the next message resumes it.
            await run(`rollout#${n}`, rolloutStep)
            dirty = null
          } else if (outcome.checkpointNow) {
            // Unsaved for the cap already: a busy conversation does not defer it further.
            await saveNow(n)
          } else {
            // Changed → debounce (the next `inspect` waits it out); unchanged → nothing to save.
            dirty = dirtyAfterTurn(dirty, outcome)
          }
          break
        }
        case 'ship': {
          // A green ship checkpoints inside `ship()`; a red one leaves the dirty state as it was.
          const shipped = await run(`ship#${n}`, scope => shipStep(scope, bootId))
          if (shipped.status === 'shipped') return
          break
        }
        case 'resume': {
          const resumed = await run(`resume#${n}`, resumeStep)
          if (!resumed.resumed) break
          resumes += 1
          const k = resumes
          const started = await run(
            `sandbox.start#${k}`,
            withProgress('sandbox', startSandboxStep),
            BOOT_STEP
          )
          const booted = started.bootId
          bootId = booted
          if (started.warm) {
            // The kept container: workspace, dependencies, database and transcript are all there.
            await run(
              `dev#${k}`,
              withProgress('dev', s => devStep(s, booted, { warm: true })),
              BOOT_STEP
            )
            break
          }
          // Cold: the workspace backup the last destroying suspend made, when it is still the
          // branch head — else (or when it will not restore) the clone and the install.
          const { usable } = await run(`restore.check#${k}`, restoreCheckStep)
          let restored = false
          if (usable) {
            ;({ restored } = await run(
              `restore#${k}`,
              withProgress('restore', s => restoreStep(s, booted)),
              BOOT_STEP
            ))
          }
          if (!restored) {
            await run(
              `repo#${k}`,
              withProgress('repo', s => repoStep(s, booted)),
              BOOT_STEP
            )
          }
          await run(
            `bootstrap#${k}`,
            withProgress('bootstrap', s => bootstrapStep(s, booted, { restored })),
            BOOT_STEP
          )
          await run(
            `dev#${k}`,
            withProgress('dev', s => devStep(s, booted)),
            BOOT_STEP
          )
          await run(
            `transcript#${k}`,
            withProgress('transcript', s => restoreTranscriptStep(s, booted)),
            BOOT_STEP
          )
          break
        }
      }
    }
    // A runaway loop: end it rather than grow the instance for ever.
    await run('end#max', scope => endStep(scope, 'max_rounds', bootId))
  }
}
