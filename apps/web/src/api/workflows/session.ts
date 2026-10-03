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
 *              the ship (issue #1, `services/sessions/ship-steps.ts`): ship.claim#N → ship.save#N →
 *                ship.kit#N (which commands the checkout's kit takes) → per attempt A: ship.gate#N.A.lint → ship.gate#N.A.typecheck → ship.db#N.A →
 *                ship.gate#N.A.test → ship.db-clean#N.A (always, after ship.db) → on red
 *                ship.fix#N.A → … → green: ship.commit#N → ship.summary#N → ship.pr#N → shipped
 *                (`pr` mode): leave the loop · `staging` mode (issue #5): still `shipping`, the
 *                landing in `ci` — the next inspect lands it · otherwise ship.settle#N (back to
 *                ready) · a lost container: suspended, the next inspect resumes
 *              the landing (issue #5, `services/sessions/land.ts`, Phase A): land.ci#N →
 *                [land.review#N] → [land.merge#N] → land.wait#N (one round of the wake event) ·
 *                land.reopen#N (back to ready / suspended) · merged: leave the loop
 *              suspend#N (a drain) · cool#N (a drain, or a warm window already over)
 *              resume#N → sandbox.start#K → warm (the kept container is still there,
 *                `services/sessions/warm.ts`): dev#K only · cold: restore.check#K →
 *                [restore#K] (the workspace backup, when it is at the branch head) → repo#K
 *                (unless restored) → bootstrap#K → dev#K → transcript#K
 *              end#N → leave the loop
 *   fail     (a step gave up: `failed`, with a secret-free sentence)
 *   cleanup  ALWAYS: destroy the sandbox, delete the gate branches then the session's branch,
 *            settle `ended` (or keep `shipped` /
 *            `failed`), audit `session.ended`
 *   Phase B  (issue #5, after a merge — or straight from `claim` for a merged landing whose
 *            instance was lost): land.release#K.R / land.staging#K.R / land.health#K.R, each with
 *            a `step.sleep` …-wait#K.R between its rounds → land.live#K | land.stalled#K
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
import {
  SESSION_WAKE_EVENT,
  type SessionWorkflowParams,
  type ShipStalledReason,
} from '@launch/shared/launch-sessions'
import { loadConfig } from '../../config'
import type { Database } from '../../db/client'
import { createStepRealtime } from '../services/agents/runtime'
import { SESSION_CALL_LIMITS, type SessionCallLimits } from '../services/sessions/deadline'
import { safeErrorMessage } from '../services/sessions/events'
import type { ShipGateCommand } from '../services/sessions/gate'
import { defaultSessionStepHooks, type SessionStepHooks } from '../services/sessions/hooks'
import {
  LAND_RETRY_SECONDS,
  type LandRound,
  landCiStep,
  landHealthStep,
  landLiveStep,
  landMergeStep,
  landReleaseStep,
  landReopenStep,
  landReviewStep,
  landStagingStep,
  landStalledStep,
} from '../services/sessions/land'
import { defaultSessionPorts, type SessionPorts } from '../services/sessions/ports'
import { sessionSandboxHostOf } from '../services/sessions/sandbox-host'
import {
  type GateStepResult,
  type ShipSettleReason,
  type ShipSettleResult,
  shipCheckpointStep,
  shipClaimStep,
  shipDbCleanStep,
  shipDbStep,
  shipFixStep,
  shipGateStep,
  shipKitStep,
  shipPrStep,
  shipSettleStep,
  shipSummaryStep,
} from '../services/sessions/ship-steps'
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
  type PhaseALandingStage,
  prepareStep,
  repoStep,
  restoreCheckStep,
  restoreStep,
  restoreTranscriptStep,
  resumeStep,
  rolloutStep,
  type StepScope,
  salvageStep,
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
/** The ship's short steps (claim, save, commit, summary, the PR, settle): idempotent, retried. */
const SHIP_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
}
/**
 * A gate command: ONE retry, which re-attaches to the command still running
 * (`runInBackground`), and the command's own deadline plus a margin — the command is killed at
 * its deadline first, so the step answers red rather than being cut off.
 */
function gateStepConfig(timeoutMs: number): WorkflowStepConfig {
  return {
    retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
    timeout: `${Math.ceil(timeoutMs / 60_000) + 5} minutes`,
  }
}

/**
 * A Phase B round's step (issue #5): the hooks are I/O against GitHub, Cloudflare and the app's
 * health; a throw after these retries counts as one more round, never a failed session.
 */
const LAND_PHASE_B_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
}

/**
 * The most rounds one Phase B stage takes before the landing stalls (the hooks cap their own waits
 * — 15 min for the release claim, 45 for the deploy, 10 probes of health — far below this).
 */
export const MAX_LAND_PHASE_ROUNDS = 200

/** How one ship round ended, for the loop's dirty state. */
type ShipRound =
  | { status: 'shipped' }
  /** Issue #5 `staging` mode: the PR is open and the loop's `land` rounds follow it. */
  | { status: 'landing' }
  | { status: 'skipped' }
  /** The container is gone and the session `suspended`: nothing is left to save. */
  | { status: 'lost' }
  /** Back at `ready`: `saved` = `ship.save` checkpointed; `settle` = what the fix turns left. */
  | { status: 'settled'; saved: boolean; settle: ShipSettleResult }

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
    // The session's frozen sandbox host (`sessions.sandbox_host`), read once per step — the
    // setting can change while a session runs, and a session never moves host.
    const portsFor = async (db: Database): Promise<SessionPorts> =>
      this.overrides.ports ??
      defaultSessionPorts(
        env,
        cfg,
        await sessionSandboxHostOf(db, params.tenantId, params.sessionId)
      )
    const hooks = this.overrides.hooks ?? defaultSessionStepHooks
    const now = this.overrides.now ?? (() => new Date())
    const limits = { ...SESSION_CALL_LIMITS, ...this.overrides.limits }

    /** One step's scope: its own DB client and realtime, both closed when it ends. */
    const inStep = <T>(fn: (scope: StepScope) => Promise<T>): Promise<T> =>
      withStepDatabase(env, cfg, async db => {
        const { realtime, settle } = createStepRealtime(env, logger)
        try {
          const ports = await portsFor(db)
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
    if (claim.start === 'land') {
      // Issue #5 Phase B under a fresh instance: the merge is done; cleanup if it never ran.
      const outcome = claim.cleanup
        ? await this.finish(run, params.sessionId)
        : { sessionId: params.sessionId, status: 'shipped' }
      await this.release(run, step, 0)
      return outcome
    }

    // Issue #5: the merge round, when the loop left for Phase B (`release` after `cleanup`).
    let merged: number | null = null
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
      if (claim.start !== 'cleanup') merged = (await this.loop(run, step, bootId)).merged
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
    const outcome = await this.finish(run, params.sessionId)
    // Phase B (issue #5): the container and the branch are gone; follow the merge to staging.
    if (merged !== null) await this.release(run, step, merged)
    return outcome
  }

  private async finish(run: StepRunner, sessionId: string): Promise<SessionOutcome> {
    const { status } = await run('cleanup', cleanupStep, CLEANUP_STEP)
    return { sessionId, status }
  }

  /**
   * The turn loop — see the header. Returns when the session should be cleaned up; `merged` is the
   * round whose landing merged (issue #5: Phase B follows `cleanup`), else null.
   */
  private async loop(
    run: StepRunner,
    step: WorkflowStep,
    initialBootId: string | undefined
  ): Promise<{ merged: number | null }> {
    const done = { merged: null }
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
          return done
        case 'end':
          // `endStep` checkpoints a live session first.
          await run(`end#${n}`, scope => endStep(scope, next.reason, bootId))
          return done
        case 'land': {
          // Issue #5 Phase A: the PR's CI, its review and the merge (`land.ts`).
          const landed = await this.land(run, step, n, bootId, next.stage)
          if (landed === 'merged') return { merged: n }
          // Everything was committed at `ship.commit`; a reopen leaves nothing unsaved.
          dirty = null
          break
        }
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
              return done
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
          const round = await this.ship(run, n, bootId)
          if (round.status === 'shipped') return done
          // `ship.commit` checkpointed everything; the next `inspect` starts the landing.
          if (round.status === 'lost' || round.status === 'landing') dirty = null
          if (round.status === 'settled') {
            // `ship.save` checkpointed what was dirty; the fix turns' changes (if any) debounce.
            dirty = dirtyAfterTurn(round.saved ? null : dirty, {
              status: 'completed',
              ...round.settle,
            })
          }
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
    return done
  }

  /**
   * One Phase A round (issue #5, `services/sessions/land.ts`): from the landing's stage, `land.ci#N`
   * → [`land.review#N`] → [`land.merge#N`] as far as each lets it, then one of `land.wait#N` (one
   * round of `waitForEvent(SESSION_WAKE_EVENT)`), `land.reopen#N`, or nothing (merged — the loop
   * leaves for Phase B; or the row moved — the next `inspect` reads it). A thrown land step
   * (GitHub did not answer, after its retries) is one more round, never a failed session.
   */
  private async land(
    run: StepRunner,
    step: WorkflowStep,
    n: number,
    bootId: string | undefined,
    stage: PhaseALandingStage
  ): Promise<'merged' | 'continue'> {
    const waitRound = async (seconds: number) => {
      try {
        await step.waitForEvent(`land.wait#${n}`, {
          type: SESSION_WAKE_EVENT,
          timeout: waitDuration(seconds) as WorkflowSleepDuration,
        })
      } catch {
        // The round is over: the next `inspect` reads the landing again.
      }
    }
    let todo: 'ci' | 'review' | 'merge' =
      stage === 'ci' ? 'ci' : stage === 'approval' ? 'review' : 'merge'
    let round: LandRound
    try {
      for (;;) {
        round =
          todo === 'ci'
            ? await run(`land.ci#${n}`, landCiStep, SHIP_STEP)
            : todo === 'review'
              ? await run(`land.review#${n}`, landReviewStep, SHIP_STEP)
              : await run(`land.merge#${n}`, landMergeStep, SHIP_STEP)
        // Forward only: ci → review → merge, each at most once a round.
        if (round.next === 'review' && todo === 'ci') todo = 'review'
        else if (round.next === 'merge' && todo !== 'merge') todo = 'merge'
        else break
      }
    } catch {
      // Logged by the platform with the step; the next round reads the landing again.
      await waitRound(LAND_RETRY_SECONDS)
      return 'continue'
    }
    switch (round.next) {
      case 'release':
        return 'merged'
      case 'wait':
        await waitRound(round.waitSeconds)
        return 'continue'
      case 'reopen': {
        const { reason, message } = round
        await run(
          `land.reopen#${n}`,
          s => landReopenStep(s, { reason, message, bootId: bootId ?? null }),
          SHIP_STEP
        )
        return 'continue'
      }
      default:
        return 'continue'
    }
  }

  /**
   * Phase B (issue #5), after `cleanup`: the release that carries the merge, its staging deploy,
   * staging's health — each a round of its hook (`land.release#K.R`, `land.staging#K.R`,
   * `land.health#K.R`) with a `step.sleep` between (`…-wait#K.R`) — then `land.live#K`, or
   * `land.stalled#K` with the hook's reason. `K` is the merge's loop round (0 under a fresh
   * instance). Nothing here reopens the session: after the merge a failure stalls (decision §0.1).
   */
  private async release(run: StepRunner, step: WorkflowStep, k: number): Promise<void> {
    const sleep = (name: string, seconds: number) =>
      step.sleep(name, waitDuration(seconds) as WorkflowSleepDuration)
    const stall = async (reason: ShipStalledReason, error: string) => {
      await run(`land.stalled#${k}`, s => landStalledStep(s, { reason, error }), SHIP_STEP)
    }
    /** One hook round; a step that threw past its retries is a wait. */
    const attempt = async <T>(
      name: string,
      body: (s: StepScope) => Promise<T>
    ): Promise<T | { status: 'wait'; waitSeconds: number }> => {
      try {
        return await run(name, body, LAND_PHASE_B_STEP)
      } catch {
        return { status: 'wait', waitSeconds: LAND_RETRY_SECONDS }
      }
    }

    for (let r = 0; ; r++) {
      if (r >= MAX_LAND_PHASE_ROUNDS) {
        return stall('release_failed', 'Launch gave up waiting to cut the release')
      }
      const res = await attempt(`land.release#${k}.${r}`, landReleaseStep)
      if (res.status === 'done') return
      if (res.status === 'released') break
      if (res.status === 'stalled') return stall(res.reason, res.error)
      await sleep(`land.release-wait#${k}.${r}`, res.waitSeconds)
    }
    for (let r = 0; ; r++) {
      if (r >= MAX_LAND_PHASE_ROUNDS) {
        return stall('deploy_timeout', 'The release did not reach staging in time')
      }
      const res = await attempt(`land.staging#${k}.${r}`, landStagingStep)
      if (res.status === 'done') return
      if (res.status === 'active') break
      if (res.status === 'stalled') return stall(res.reason, res.error)
      await sleep(`land.staging-wait#${k}.${r}`, res.waitSeconds)
    }
    for (let r = 0; ; r++) {
      if (r >= MAX_LAND_PHASE_ROUNDS) {
        return stall('unhealthy', 'Staging never answered healthy on the release')
      }
      const res = await attempt(`land.health#${k}.${r}`, landHealthStep)
      if (res.status === 'done') return
      if (res.status === 'live') {
        const { url, version } = res
        await run(`land.live#${k}`, s => landLiveStep(s, { url, version }), SHIP_STEP)
        return
      }
      if (res.status === 'stalled') return stall(res.reason, res.error)
      await sleep(`land.health-wait#${k}.${r}`, res.waitSeconds)
    }
  }

  /**
   * One ship round (issue #1) — see the header and `services/sessions/ship-steps.ts`. Every name
   * carries the round and the attempt; a thrown step settles the round (`error`) instead of
   * failing the session.
   */
  private async ship(run: StepRunner, n: number, bootId: string | undefined): Promise<ShipRound> {
    const claim = await run(`ship.claim#${n}`, shipClaimStep, SHIP_STEP)
    if (claim.status === 'shipped') return { status: 'shipped' }
    if (claim.status === 'skipped') return { status: 'skipped' }
    let saved = false
    let reason: ShipSettleReason = 'exhausted'
    let detail: string | undefined
    try {
      const save = await run(
        `ship.save#${n}`,
        s => shipCheckpointStep(s, bootId, 'before the gate'),
        SHIP_STEP
      )
      if (save.lost) return { status: 'lost' }
      saved = save.ok
      const first = claim.firstAttempt
      const last = first + claim.maxAttempts - 1
      const kit = await run(`ship.kit#${n}`, s => shipKitStep(s, first, bootId), SHIP_STEP)
      if (!kit.ok && kit.stop === 'container_lost') return { status: 'lost' }
      if (!kit.ok) reason = kit.stop === 'ended' ? 'ended' : 'unfixable'
      const commands = kit.ok ? kit.commands : []
      let green: number | null = null
      for (let attempt = first; kit.ok && attempt <= last; attempt++) {
        const gate = await this.gate(run, `${n}.${attempt}`, attempt, bootId, commands)
        if (gate.passed) {
          green = attempt
          break
        }
        if (gate.stop === 'container_lost') return { status: 'lost' }
        if (gate.stop) {
          reason = gate.stop === 'ended' ? 'ended' : 'unfixable'
          break
        }
        if (attempt === last) {
          reason = 'exhausted'
          break
        }
        const fix = await run(
          `ship.fix#${n}.${attempt}`,
          s =>
            shipFixStep(
              s,
              { attempt: attempt - first + 1, maxAttempts: claim.maxAttempts, failed: gate },
              bootId
            ),
          turnStepConfig(claim)
        )
        if (fix.lost) return { status: 'lost' }
        if (!fix.ok) {
          reason = 'fix_failed'
          break
        }
      }
      if (green !== null) {
        const fixTurns = green - first
        const commit = await run(
          `ship.commit#${n}`,
          s => shipCheckpointStep(s, bootId, 'to open the pull request'),
          SHIP_STEP
        )
        if (commit.lost) return { status: 'lost' }
        if (!commit.ok) {
          reason = 'not_committed'
        } else {
          const summary = await run(`ship.summary#${n}`, shipSummaryStep, SHIP_STEP)
          const ran = commands.map(c => c.command)
          const pr = await run(
            `ship.pr#${n}`,
            s => shipPrStep(s, summary, fixTurns, ran),
            SHIP_STEP
          )
          if (pr.shipped) return { status: 'shipped' }
          if (pr.landing) return { status: 'landing' }
          reason = 'not_opened'
        }
      }
    } catch (err) {
      reason = 'error'
      detail = safeErrorMessage(err, 'a ship step failed')
    }
    const settle = await run(
      `ship.settle#${n}`,
      s =>
        shipSettleStep(s, { reason, attempts: claim.maxAttempts, ...(detail ? { detail } : {}) }),
      SHIP_STEP
    )
    return { status: 'settled', saved, settle }
  }

  /**
   * One gate attempt: each of the kit's commands (`ship.kit#N`'s, in its order), stopping at the
   * first red. The test step's database lives from `ship.db` to `ship.db-clean` — the clean in a
   * `finally`, so a red, a thrown step, an end or a lost container never leaves the branch behind.
   */
  private async gate(
    run: StepRunner,
    tag: string,
    attempt: number,
    bootId: string | undefined,
    commands: readonly ShipGateCommand[]
  ): Promise<GateStepResult> {
    for (const command of commands) {
      const name = `ship.gate#${tag}.${command.step}`
      const config = gateStepConfig(command.timeoutMs)
      let result: GateStepResult
      if (command.database) {
        try {
          const db = await run(
            `ship.db#${tag}`,
            s => shipDbStep(s, attempt, bootId, command.command),
            BOOT_STEP
          )
          if (!db.ok) return { passed: false, step: command.step, stop: db.stop }
          const branch = db.branch
          result = await run(
            name,
            s => shipGateStep(s, { step: command.step, attempt, branch, command }, bootId),
            config
          )
        } finally {
          await run(`ship.db-clean#${tag}`, shipDbCleanStep, CLEANUP_STEP)
        }
      } else {
        result = await run(
          name,
          s => shipGateStep(s, { step: command.step, attempt, command }, bootId),
          config
        )
      }
      if (!result.passed) return result
    }
    return { passed: true, step: 'test' }
  }
}
