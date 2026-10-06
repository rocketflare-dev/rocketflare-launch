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
 *   boot:    (db ‖ [prebuild.check →] sandbox.start → restore | repo) → [prepare → branch]* →
 *            bootstrap → dev (`preview.ready`) → [prebuild.request]
 *            (‖: side by side, both settled before what follows — issue #15; * only when this
 *            session prepares the app's `dev`; a `prepare` run stops after it). Issue #16, while
 *            `SESSION_PREBUILD` is on: `restore` puts the app's PREBUILD back and checks the
 *            session's commit out over it instead of `repo`'s clone (a failed one falls through to
 *            `repo`), `bootstrap` then installs only when the lockfile moved, and
 *            `prebuild.request` asks for a new prebuild when there was none to use or its lockfile
 *            had moved on (`services/sessions/prebuild.ts`). A container replaced under `restore`,
 *            `repo`, `bootstrap` or `dev` boots again from `sandbox.start.rN`
 *            (`restartable`, at most `MAX_BOOT_RESTARTS`; `BootContainer`).
 *   prebuild (a `prebuild` session, issue #16): claim → sandbox.start → prebuild.build →
 *            prebuild.save → cleanup
 *            Each boot step's result carries its clock (`timing`); the boot's last step — `dev`,
 *            on every kind of boot — writes them as ONE `boot.timing` event and a
 *            `session.boot` trace (issue #8, `services/sessions/boot-timing.ts`)
 *   loop N:  inspect#N (given the loop's `DirtyState`) → one of
 *              wait#N (`waitForEvent(SESSION_WAKE_EVENT)`, the idle / warm / expiry timeout, or
 *                the checkpoint DEBOUNCE's when the workspace holds unsaved changes) →
 *                on a timeout suspend#N (live; an idle suspend KEEPS the container) — or end#N
 *                for a warm start nobody has written to (issue #17, `warm.ts`) — cool#N
 *                (suspended with a kept container past its warm window), end#N (suspended
 *                past expiry) or, for a debounce wait, checkpoint#N — and the loop waits on
 *              turn#N (3c's `runTurn`; reports `changed` + `endedAt`) → nothing (the debounce
 *                runs from the next inspect) · checkpoint#N when the session has been dirty for
 *                the cap · rollout#N (the container is gone: a rollout, or it died and came back
 *                empty — `containerGone`) · turn-settle#N → checkpoint#N if the step itself died
 *              checkpoint#N (the debounce already due)
 *              the ship (issue #1, `services/sessions/ship-steps.ts`): ship.claim#N → ship.save#N →
 *                ship.kit#N (which commands the checkout's kit takes) → per attempt A: ship.tree#N.A → ship.gate#N.A.lint → ship.gate#N.A.typecheck → ship.db#N.A →
 *                ship.gate#N.A.test → ship.db-clean#N.A (always, after ship.db) → on red
 *                ship.fix#N.A → … → green: ship.commit#N → ship.attest#N (issue #9: the
 *                `launch/gate` check run, only with a gate tree, and never when a gate step
 *                rewrote files — each attempt first reads its tree in ship.tree#N.A, issue #21) → ship.summary#N → ship.pr#N → shipped
 *                (`pr` mode): leave the loop · `staging` mode (issue #5): still `shipping`, the
 *                landing in `ci` — the next inspect lands it · otherwise ship.settle#N (back to
 *                ready) · a lost container: suspended, the next inspect resumes
 *              the landing (issue #5, `services/sessions/land.ts`, Phase A): land.ci#N →
 *                [land.review#N] → [land.merge#N] → land.wait#N (one round of the wake event) ·
 *                land.reopen#N (back to ready / suspended) · merged: prebuild.refresh#N (issue
 *                #16, while prebuilds are on: the default branch moved), then leave the loop
 *              suspend#N (a drain) · cool#N (a drain, or a warm window already over)
 *              resume#N → sandbox.start#K → warm (the kept container is still there,
 *                `services/sessions/warm.ts`): dev#K only · cold: restore.check#K →
 *                [restore#K] (the workspace backup, when it is at the branch head) → repo#K
 *                (unless restored) → (bootstrap#K ‖ transcript#K) → dev#K
 *              end#N → leave the loop
 *   fail     (a step gave up: `failed`, with a secret-free sentence)
 *   cleanup  ALWAYS: destroy the sandbox, delete the gate branches then the session's branch,
 *            settle `ended` (or keep `shipped` /
 *            `failed`), audit `session.ended`
 *   Phase B  (issue #5, after a merge — or straight from `claim` for a merged landing whose
 *            instance was lost): land.main-ci#K.R (issue #11: the squash commit's `Gate`) /
 *            land.release#K.R / land.staging#K.R / land.health#K.R, each with a wait between
 *            its rounds — `waitForEvent(SESSION_WAKE_EVENT)` …-wake#K.R for the first three (a
 *            GitHub webhook wakes it, issue #19), a `step.sleep` land.health-wait#K.R for health —
 *            → land.live#K | land.stalled#K
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
 * - **Ship, landing and Phase B steps beat** `last_activity_at` while they run (`withHeartbeat`):
 *   the reconcile (`services/sessions/reconcile.ts`) restarts an instance quiet past a window
 *   computed from the waits and retry delays between them (`services/sessions/step-config.ts`
 *   holds the retry policies for that reason).
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
import type { BootStepTiming } from '../services/sessions/boot-timing'
import { SESSION_CALL_LIMITS, type SessionCallLimits } from '../services/sessions/deadline'
import { safeErrorMessage } from '../services/sessions/events'
import type { ShipGateCommand } from '../services/sessions/gate'
import { shipAttestStep } from '../services/sessions/gate-attest'
import { defaultSessionStepHooks, type SessionStepHooks } from '../services/sessions/hooks'
import {
  LAND_RETRY_SECONDS,
  type LandRound,
  landCiStep,
  landHealthStep,
  landLiveStep,
  landMainCiStep,
  landMergeStep,
  landReleaseStep,
  landReopenStep,
  landReviewStep,
  landStagingStep,
  landStalledStep,
} from '../services/sessions/land'
import { defaultSessionPorts, type SessionPorts } from '../services/sessions/ports'
import { prebuildsEnabled } from '../services/sessions/prebuild'
import {
  type PrebuildCheckResult,
  prebuildBuildStep,
  prebuildCheckStep,
  prebuildRequestStep,
  prebuildRestoreStep,
  prebuildSaveStep,
} from '../services/sessions/prebuild-steps'
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
  shipGateTreeStep,
  shipKitStep,
  shipPrStep,
  shipSettleStep,
  shipSummaryStep,
} from '../services/sessions/ship-steps'
import {
  BOOT_STEP,
  CLEANUP_STEP,
  gateStepConfig,
  LAND_PHASE_B_STEP,
  SALVAGE_STEP,
  SHIP_STEP,
} from '../services/sessions/step-config'
import {
  BOOT_ERROR_MAX_CHARS,
  type BootRestart,
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
  isBootRestart,
  MAX_BOOT_RESTARTS,
  type PhaseALandingStage,
  prepareStep,
  repoStep,
  restartable,
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
  withHeartbeat,
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

/**
 * The most rounds one Phase B stage takes before the landing stalls (the hooks cap their own waits
 * — 15 min for the release claim, 45 for the deploy, 10 probes of health — far below this).
 */
export const MAX_LAND_PHASE_ROUNDS = 200

/**
 * A ship or Phase A landing step's body, beating `last_activity_at` while the row is `shipping`
 * (`withHeartbeat`): the clock the reconcile reads to tell a dead instance from a busy one.
 */
const shipping = <T>(body: (scope: StepScope) => Promise<T>) => withHeartbeat(['shipping'], body)
/** The same for a merged landing's `cleanup` and Phase B steps (the row is `shipped`). */
const released = <T>(body: (scope: StepScope) => Promise<T>) => withHeartbeat(['shipped'], body)

/**
 * The container half of a first boot: `sandbox.start` → `repo`, and again — `sandbox.start.rN` →
 * `repo.rN`, then the caller's `bootstrap.rN` / `dev.rN` — each time a step finds the container
 * replaced under it ({@link restartable}). State lives only in step RESULTS (replay-safe):
 * `bootId` is the latest `sandbox.start`'s, `timings` the completed steps' clocks not yet taken.
 */
class BootContainer {
  restarts = 0
  bootId = ''
  timings: (BootStepTiming | undefined)[] = []
  /**
   * Issue #16, from step results: `prebuild.check`'s answer (once per boot), whether the workspace
   * came from the prebuild (and whether its lockfile still matched), and why the boot should ask
   * for a new prebuild once it is done (null: no need).
   */
  check: PrebuildCheckResult | null = null
  prebuilt: { install: boolean } | null = null
  refresh: string | null = null

  /** `prebuilds`: this boot may restore the app's prebuild (`SESSION_PREBUILD` is not `off`). */
  constructor(
    private readonly run: StepRunner,
    private readonly prebuilds = false
  ) {}

  /** `base` for the first attempt, `base.rN` for the Nth restart. */
  name(base: string): string {
    return this.restarts === 0 ? base : `${base}.r${this.restarts}`
  }

  /**
   * Start the container and fill its workspace — the app's prebuild when there is one to use
   * (`restore`, issue #16), else the clone (`repo`) — again while a step finds it replaced.
   */
  async up(): Promise<void> {
    if (this.prebuilds && !this.check) {
      this.check = await this.run('prebuild.check', prebuildCheckStep)
      if (this.check.refresh) this.refresh = this.check.reason ?? 'no usable prebuild'
    }
    for (;;) {
      // Each pass fills a NEW container: what an earlier pass restored is gone with its own (a
      // clone after a failed `restore.rN` must install).
      this.prebuilt = null
      const started = await this.run(
        this.name('sandbox.start'),
        withProgress('sandbox', startSandboxStep),
        BOOT_STEP
      )
      this.bootId = started.bootId
      this.timings.push(started.timing)
      const booted = started.bootId
      if (this.check?.usable) {
        const restored = await this.run(
          this.name('restore'),
          restartable(
            'restore',
            withProgress('restore', s => prebuildRestoreStep(s, booted))
          ),
          BOOT_STEP
        )
        if (isBootRestart(restored)) {
          this.next(restored)
          continue
        }
        this.timings.push(restored.timing)
        if (restored.refresh) this.refresh = restored.reason ?? 'the prebuild did not fit'
        if (restored.restored) {
          this.prebuilt = { install: restored.install }
          return
        }
      }
      const repo = await this.run(
        this.name('repo'),
        restartable(
          'repo',
          withProgress('repo', s => repoStep(s, booted))
        ),
        BOOT_STEP
      )
      if (!isBootRestart(repo)) {
        this.timings.push(repo.timing)
        return
      }
      this.next(repo)
    }
  }

  /** A later step found the container replaced: count it, then {@link up} again. */
  async again(lost: BootRestart): Promise<void> {
    this.next(lost)
    await this.up()
  }

  private next(lost: BootRestart): void {
    if (this.restarts >= MAX_BOOT_RESTARTS) throw new Error(lost.restart)
    this.restarts += 1
  }
}

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
  /**
   * Issue #16: `SESSION_PREBUILD` is not `off` — taken from the `claim` step's RESULT, so every
   * replay of this run sees the value the run started with, even across a config change.
   */
  private prebuilds = false

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

    const claim = await run('claim', async s => ({
      ...(await claimStep(s)),
      prebuilds: prebuildsEnabled(s.cfg),
    }))
    // A result recorded before issue #16 has no flag: no prebuild for that run.
    this.prebuilds = claim.prebuilds === true
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
        // Issue #15: the database (Neon) runs ALONGSIDE the container's start and the clone —
        // neither needs the other; `bootstrap` (or `prepare`) waits for both. Settled, not raced:
        // a failure on one side still lets the other's step finish before `fail` and `cleanup`
        // run, so nothing is left running under them, and the first side's error fails the boot.
        // A container replaced under `repo`, `bootstrap` or `dev` boots again from `sandbox.start`
        // (`restartable`): `.rN` step names, at most MAX_BOOT_RESTARTS times. Each attempt's
        // completed steps keep their clocks, so `boot.timing` counts the lost time too.
        // Issue #16: a `prebuild` run is its own short shape (`SessionWorkflow.prebuild`).
        if (claim.kind === 'prebuild') {
          await this.prebuild(run)
          return await this.finish(run, params.sessionId)
        }
        const boot = new BootContainer(run, this.prebuilds)
        const [dbSide, sandboxSide] = await Promise.allSettled([
          run('db', withProgress('db', dbStep), BOOT_STEP),
          boot.up(),
        ])
        if (dbSide.status === 'rejected') throw dbSide.reason
        if (sandboxSide.status === 'rejected') throw sandboxSide.reason
        const db = dbSide.value
        // Issue #8: each boot step's clock, from its result; `dev` writes them as `boot.timing`.
        const timings: (BootStepTiming | undefined)[] = [db.timing, ...boot.timings]
        boot.timings = []
        if (db.prepare) {
          const booted = boot.bootId
          const prepared = await run(
            'prepare',
            withProgress('prepare', s => prepareStep(s, booted)),
            BOOT_STEP
          )
          timings.push(prepared.timing)
          if (claim.kind === 'prepare') {
            return await this.finish(run, params.sessionId)
          }
          const branched = await run('branch', withProgress('branch', branchStep), BOOT_STEP)
          timings.push(branched.timing)
        }
        for (;;) {
          const booted = boot.bootId
          // Issue #16: a prebuild whose lockfile still matched needs no install.
          const install = boot.prebuilt?.install ?? true
          const bootstrapped = await run(
            boot.name('bootstrap'),
            restartable(
              'bootstrap',
              withProgress('bootstrap', s =>
                bootstrapStep(s, booted, install ? {} : { install: false })
              )
            ),
            BOOT_STEP
          )
          if (isBootRestart(bootstrapped)) {
            await boot.again(bootstrapped)
            timings.push(...boot.timings)
            boot.timings = []
            continue
          }
          timings.push(bootstrapped.timing)
          const before = [...timings]
          const dev = await run(
            boot.name('dev'),
            restartable(
              'dev',
              withProgress('dev', s => devStep(s, booted), { kind: 'boot', before })
            ),
            BOOT_STEP
          )
          if (isBootRestart(dev)) {
            await boot.again(dev)
            timings.push(...boot.timings)
            boot.timings = []
            continue
          }
          break
        }
        bootId = boot.bootId
        // Issue #16: the boot found no prebuild to use, or one whose lockfile had moved on — ask
        // for a new one now the session is ready (a request, never the build; never a failure).
        const reason = boot.refresh
        if (reason) {
          await run('prebuild.request', s => prebuildRequestStep(s, { reason, after: 'boot' }))
        }
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

  /**
   * Issue #16: a `prebuild` run (`services/sessions/prebuild.ts`) — `sandbox.start` →
   * `prebuild.build` (clone the default branch, install) → `prebuild.save` (the archive, made the
   * app's prebuild); `cleanup` follows in `run`. No restart on a replaced container: a failed
   * build is `fail` + `cleanup`, and the next request builds again.
   */
  private async prebuild(run: StepRunner): Promise<void> {
    const started = await run('sandbox.start', withProgress('sandbox', startSandboxStep), BOOT_STEP)
    const booted = started.bootId
    const built = await run(
      'prebuild.build',
      withProgress('prebuild', s => prebuildBuildStep(s, booted)),
      BOOT_STEP
    )
    const { baseSha, treeSha, lockfileHash, buildMs, imageVersion } = built
    await run(
      'prebuild.save',
      withProgress('prebuild', s =>
        prebuildSaveStep(s, booted, { baseSha, treeSha, lockfileHash, buildMs, imageVersion })
      ),
      BOOT_STEP
    )
  }

  private async finish(run: StepRunner, sessionId: string): Promise<SessionOutcome> {
    const { status } = await run('cleanup', released(cleanupStep), CLEANUP_STEP)
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
        case 'end': {
          // `endStep` checkpoints a live session first (never an unprompted warm start's).
          const { ending } = await run(`end#${n}`, scope => endStep(scope, next.reason, bootId))
          // Issue #17: a first message beat the end of an abandoned warm start — carry on.
          if (!ending && next.reason === 'unprompted') break
          return done
        }
        case 'land': {
          // Issue #5 Phase A: the PR's CI, its review and the merge (`land.ts`).
          const landed = await this.land(run, step, n, bootId, next.stage)
          if (landed === 'merged') {
            // Issue #16: the default branch moved — the app's prebuild is rebuilt from it.
            if (this.prebuilds) {
              await run(`prebuild.refresh#${n}`, s =>
                prebuildRequestStep(s, { reason: 'merged to the default branch', after: 'merge' })
              )
            }
            return { merged: n }
          }
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
            // Issue #17: a warm start nobody wrote to ends (no suspend, no kept container) —
            // unless the preview kept it busy or a message just landed: then wait on.
            if (next.unprompted) {
              const { ending } = await run(`end#${n}`, scope =>
                endStep(scope, 'unprompted', bootId)
              )
              if (ending) return done
              break
            }
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
          // Issue #8: the resume's step clocks; its last step writes them as `boot.timing`.
          const timings: (BootStepTiming | undefined)[] = [started.timing]
          const booted = started.bootId
          bootId = booted
          if (started.warm) {
            // The kept container: workspace, dependencies, database and transcript are all there.
            await run(
              `dev#${k}`,
              withProgress('dev', s => devStep(s, booted, { warm: true }), {
                kind: 'warm',
                before: timings,
              }),
              BOOT_STEP
            )
            break
          }
          // Cold: the workspace backup the last destroying suspend made, when it is still the
          // branch head — else (or when it will not restore) the clone and the install.
          const { usable } = await run(`restore.check#${k}`, restoreCheckStep)
          let restored = false
          if (usable) {
            const restore = await run(
              `restore#${k}`,
              withProgress('restore', s => restoreStep(s, booted)),
              BOOT_STEP
            )
            restored = restore.restored
            timings.push(restore.timing)
          }
          if (!restored) {
            const repo = await run(
              `repo#${k}`,
              withProgress('repo', s => repoStep(s, booted)),
              BOOT_STEP
            )
            timings.push(repo.timing)
          }
          // The conversation (Claude Code's transcript, under `$HOME`, not the workspace) needs
          // neither the bootstrap nor the dev server: it is put back ALONGSIDE the bootstrap —
          // settled, not raced, as the first boot's `db` beside the container — and `dev` comes
          // last, once the bootstrap's migrate is done, so `ready` means everything is back.
          const [bootstrapSide, transcriptSide] = await Promise.allSettled([
            run(
              `bootstrap#${k}`,
              withProgress('bootstrap', s => bootstrapStep(s, booted, { restored })),
              BOOT_STEP
            ),
            run(
              `transcript#${k}`,
              withProgress('transcript', s => restoreTranscriptStep(s, booted)),
              BOOT_STEP
            ),
          ])
          if (bootstrapSide.status === 'rejected') throw bootstrapSide.reason
          if (transcriptSide.status === 'rejected') throw transcriptSide.reason
          timings.push(bootstrapSide.value.timing, transcriptSide.value.timing)
          await run(
            `dev#${k}`,
            withProgress('dev', s => devStep(s, booted), { kind: 'cold', before: timings }),
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
            ? await run(`land.ci#${n}`, shipping(landCiStep), SHIP_STEP)
            : todo === 'review'
              ? await run(`land.review#${n}`, shipping(landReviewStep), SHIP_STEP)
              : await run(`land.merge#${n}`, shipping(landMergeStep), SHIP_STEP)
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
          shipping(s => landReopenStep(s, { reason, message, bootId: bootId ?? null })),
          SHIP_STEP
        )
        return 'continue'
      }
      default:
        return 'continue'
    }
  }

  /**
   * Phase B (issue #5), after `cleanup`: the merge commit's own `Gate` on the default branch
   * (`land.main-ci#K.R`, issue #11: green or past its bound → on; red → stalled `main_ci_failed`),
   * the release that carries the merge, its staging deploy, staging's health — each a round of its
   * hook (`land.release#K.R`, `land.staging#K.R`, `land.health#K.R`). Between the GitHub-facing
   * rounds a `waitForEvent(SESSION_WAKE_EVENT)` with the round as its timeout (`…-wake#K.R`,
   * issue #19: a webhook ends it early); between health probes a `step.sleep` (`land.health-wait#K.R`
   * — the probes are counted, so nothing may shorten the gap) — then `land.live#K`, or
   * `land.stalled#K` with the hook's reason. `K` is the merge's loop round (0 under a fresh
   * instance). Nothing here reopens the session: after the merge a failure stalls (decision §0.1).
   */
  private async release(run: StepRunner, step: WorkflowStep, k: number): Promise<void> {
    /**
     * Issue #19: one round of a GitHub-facing stage — `SESSION_WAKE_EVENT` (a GitHub webhook about
     * the merge commit, the default branch or the release's tag, `github-events.ts`) or the
     * round's timeout, whichever comes first; either way the next round reads GitHub itself.
     */
    const wake = async (name: string, seconds: number) => {
      try {
        await step.waitForEvent(name, {
          type: SESSION_WAKE_EVENT,
          timeout: waitDuration(seconds) as WorkflowSleepDuration,
        })
      } catch {
        // The round is over: poll again.
      }
    }
    /** Health probes staging, not GitHub, and counts its probes: a plain sleep, never woken. */
    const sleep = (name: string, seconds: number) =>
      step.sleep(name, waitDuration(seconds) as WorkflowSleepDuration)
    const stall = async (reason: ShipStalledReason, error: string) => {
      await run(
        `land.stalled#${k}`,
        released(s => landStalledStep(s, { reason, error })),
        SHIP_STEP
      )
    }
    /** One hook round; a step that threw past its retries is a wait. */
    const attempt = async <T>(
      name: string,
      body: (s: StepScope) => Promise<T>
    ): Promise<T | { status: 'wait'; waitSeconds: number }> => {
      try {
        return await run(name, released(body), LAND_PHASE_B_STEP)
      } catch {
        return { status: 'wait', waitSeconds: LAND_RETRY_SECONDS }
      }
    }

    // Issue #11: the squash commit's own `Gate` first, so the tag's deploy can skip its gate. The
    // step bounds itself (`SHIP_MAIN_CI_MAX_MINUTES`); out of rounds, the release goes ahead too.
    for (let r = 0; r < MAX_LAND_PHASE_ROUNDS; r++) {
      const res = await attempt(`land.main-ci#${k}.${r}`, landMainCiStep)
      if (res.status === 'done') return
      if (res.status === 'ready') break
      if (res.status === 'stalled') return stall(res.reason, res.error)
      await wake(`land.main-ci-wake#${k}.${r}`, res.waitSeconds)
    }
    for (let r = 0; ; r++) {
      if (r >= MAX_LAND_PHASE_ROUNDS) {
        return stall('release_failed', 'Launch gave up waiting to cut the release')
      }
      const res = await attempt(`land.release#${k}.${r}`, landReleaseStep)
      if (res.status === 'done') return
      if (res.status === 'released') break
      if (res.status === 'stalled') return stall(res.reason, res.error)
      await wake(`land.release-wake#${k}.${r}`, res.waitSeconds)
    }
    for (let r = 0; ; r++) {
      if (r >= MAX_LAND_PHASE_ROUNDS) {
        return stall('deploy_timeout', 'The release did not reach staging in time')
      }
      const res = await attempt(`land.staging#${k}.${r}`, landStagingStep)
      if (res.status === 'done') return
      if (res.status === 'active') break
      if (res.status === 'stalled') return stall(res.reason, res.error)
      await wake(`land.staging-wake#${k}.${r}`, res.waitSeconds)
    }
    for (let r = 0; ; r++) {
      if (r >= MAX_LAND_PHASE_ROUNDS) {
        return stall('unhealthy', 'Staging never answered healthy on the release')
      }
      const res = await attempt(`land.health#${k}.${r}`, landHealthStep)
      if (res.status === 'done') return
      if (res.status === 'live') {
        const { url, version } = res
        await run(
          `land.live#${k}`,
          released(s => landLiveStep(s, { url, version })),
          SHIP_STEP
        )
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
    const claim = await run(`ship.claim#${n}`, shipping(shipClaimStep), SHIP_STEP)
    if (claim.status === 'shipped') return { status: 'shipped' }
    if (claim.status === 'skipped') return { status: 'skipped' }
    let saved = false
    let reason: ShipSettleReason = 'exhausted'
    let detail: string | undefined
    try {
      const save = await run(
        `ship.save#${n}`,
        shipping(s => shipCheckpointStep(s, bootId, 'before the gate')),
        SHIP_STEP
      )
      if (save.lost) return { status: 'lost' }
      saved = save.ok
      const first = claim.firstAttempt
      const last = first + claim.maxAttempts - 1
      const kit = await run(
        `ship.kit#${n}`,
        shipping(s => shipKitStep(s, first, bootId)),
        SHIP_STEP
      )
      if (!kit.ok && kit.stop === 'container_lost') return { status: 'lost' }
      if (!kit.ok) reason = kit.stop === 'ended' ? 'ended' : 'unfixable'
      const commands = kit.ok ? kit.commands : []
      let green: number | null = null
      let gateTree: string | undefined
      let rewrote: string[] | undefined
      for (let attempt = first; kit.ok && attempt <= last; attempt++) {
        const gate = await this.gate(run, `${n}.${attempt}`, attempt, bootId, commands)
        if (gate.passed) {
          green = attempt
          gateTree = gate.tree
          rewrote = gate.rewrote
          break
        }
        if (gate.stop === 'container_lost') return { status: 'lost' }
        if (gate.stop) {
          reason = gate.stop === 'ended' || gate.stop === 'db_unreachable' ? gate.stop : 'unfixable'
          break
        }
        if (attempt === last) {
          reason = 'exhausted'
          break
        }
        const fix = await run(
          `ship.fix#${n}.${attempt}`,
          shipping(s =>
            shipFixStep(
              s,
              { attempt: attempt - first + 1, maxAttempts: claim.maxAttempts, failed: gate },
              bootId
            )
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
          shipping(s => shipCheckpointStep(s, bootId, 'to open the pull request', gateTree)),
          SHIP_STEP
        )
        if (commit.lost) return { status: 'lost' }
        if (!commit.ok) {
          reason = commit.changed ? 'tree_changed' : 'not_committed'
        } else {
          // Issue #9: the `launch/gate` check run on the pushed head (never fails the ship).
          const tree = commit.tree
          const attempt = green
          if (tree) {
            await run(
              `ship.attest#${n}`,
              shipping(s => shipAttestStep(s, { attempt, tree, ...(rewrote ? { rewrote } : {}) })),
              SHIP_STEP
            )
          }
          const summary = await run(`ship.summary#${n}`, shipping(shipSummaryStep), SHIP_STEP)
          const ran = commands.map(c => c.command)
          const pr = await run(
            `ship.pr#${n}`,
            shipping(s => shipPrStep(s, summary, fixTurns, ran, tree)),
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
      shipping(s =>
        shipSettleStep(s, { reason, attempts: claim.maxAttempts, ...(detail ? { detail } : {}) })
      ),
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
    let passed: GateStepResult = { passed: true, step: 'test' }
    // Issue #21: the tree the attempt starts on — the last step says whether a step rewrote it.
    let startTree: string | undefined
    if (commands.length > 0) {
      const start = await run(
        `ship.tree#${tag}`,
        shipping(s => shipGateTreeStep(s, bootId)),
        SHIP_STEP
      )
      if (!start.ok) return { passed: false, step: commands[0]?.step ?? 'test', stop: start.stop }
      startTree = start.tree
    }
    for (const [i, command] of commands.entries()) {
      // Issue #9: the last command reads the tree the green gate ran on.
      const last = i === commands.length - 1
      const name = `ship.gate#${tag}.${command.step}`
      const config = gateStepConfig(command.timeoutMs)
      let result: GateStepResult
      if (command.database) {
        try {
          const db = await run(
            `ship.db#${tag}`,
            shipping(s => shipDbStep(s, attempt, bootId, command.command)),
            BOOT_STEP
          )
          if (!db.ok) return { passed: false, step: command.step, stop: db.stop }
          const branch = db.branch
          result = await run(
            name,
            shipping(s =>
              shipGateStep(
                s,
                { step: command.step, attempt, branch, command, last, startTree },
                bootId
              )
            ),
            config
          )
        } finally {
          await run(`ship.db-clean#${tag}`, shipping(shipDbCleanStep), CLEANUP_STEP)
        }
      } else {
        result = await run(
          name,
          shipping(s =>
            shipGateStep(s, { step: command.step, attempt, command, last, startTree }, bootId)
          ),
          config
        )
      }
      if (!result.passed) return result
      passed = result
    }
    return passed
  }
}
