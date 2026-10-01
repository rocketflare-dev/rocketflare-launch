/**
 * The things the `SessionWorkflow` (slice 3b) asks OTHER slices' modules to do — everything that
 * runs Claude Code, calls a model or pushes — behind one small seam so the Workflow is tested with
 * fakes (`overrides.hooks`) and bound to the real functions here, once:
 *
 * | Hook          | Function                                     | Called from step             |
 * |---------------|----------------------------------------------|------------------------------|
 * | `runTurn`     | `runTurn(db, ports, session, opts)` (3c)      | `turn#N`                     |
 * | `checkpoint`  | `checkpoint(db, deps, ref, opts)` (3d)        | `checkpoint#N`, `suspend#N`, `end#N`, `salvage`, `ship.save#N`, `ship.commit#N` |
 * | `shipFix`     | 3c's `createShipTurnRunner` (a fix turn)      | `ship.fix#N.A` (issue #1)    |
 * | `shipSummary` | `summarizeShip` (`ship.ts`, one model call)   | `ship.summary#N` (issue #1)  |
 * | `landRelease` | `landRelease` (`land-release.ts`, issue #5 S3) | `land.release#K.R`          |
 * | `landStaging` | `landStaging` (`land-release.ts`, issue #5 S3) | `land.staging#K.R`          |
 * | `landHealth`  | `landHealth` (`land-release.ts`, issue #5 S3)  | `land.health#K.R`           |
 *
 * Every hook gets ONE argument, a `SessionStepContext` carrying what those functions take (`db`,
 * `cfg`, `ports`, `sandbox`, `storage`, `emit`, `realtime`, `logger`, the ids), so each binding
 * in `defaultSessionStepHooks` is one call.
 *
 * Paths the three agree on, defined ONCE in `rocketflare-dev.ts`: the checkout is
 * `SESSION_WORKSPACE` (`/workspace/app`; `SESSION_REPO_DIR` in `checkpoint.ts` and `SESSION_WORKDIR`
 * in `claude-stream.ts` are aliases of it), commands run as root with `SESSION_HOME` (`/root`), so
 * Claude Code's transcripts are under `CLAUDE_PROJECT_DIR` (`/root/.claude/projects/-workspace-app/`).
 *
 * **Who writes the status.** The hooks own the transitions INSIDE their work — `runTurn` claims
 * `ready → working` and settles back to `ready` / `blocked` / `suspended` (a rollout); the ship's
 * own steps (`ship-steps.ts`) own `shipping`; `checkpoint`, `shipFix` and `shipSummary` change no
 * status.
 * The Workflow reads the ROW afterwards, and only repairs a session a hook left mid-flight (a
 * `working` row after the turn step itself died is settled `ready` with `turn.failed`).
 */
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { SessionRow } from '../../../db/schema'
import type { AppBindings } from '../../types'
import type { Logger } from '../../utils/core/logger'
import type { Realtime } from '../realtime'
import type { StorageService } from '../storage'
import { checkpoint } from './checkpoint'
import type { SessionEmitter } from './events'
import { landHealth, landRelease, landStaging } from './land-release'
import { egressFor, type SandboxPort, type SessionPorts } from './ports'
import { type ShipSummaryInput, type ShipSummaryResult, summarizeShip } from './ship'
import {
  createShipTurnRunner,
  runTurn,
  type ShipTurnInput,
  type ShipTurnResult,
  type TurnOutcome,
} from './turn'

export type { TurnOutcome }

/** Everything a hook gets. One step's worth: the client closes when the step ends. */
export interface SessionStepContext {
  db: Database
  env: AppBindings
  cfg: AppConfig
  ports: SessionPorts
  /** This session's container (`ports.sandbox(session.id)`). */
  sandbox: SandboxPort
  /** R2 (`createR2Storage(env.FILES)`) — where transcripts are checkpointed; null without `FILES`. */
  storage: StorageService | null
  /** `{ tenantId, sessionId }` — what the slices' functions take to re-read the row themselves. */
  ref: { tenantId: string; sessionId: string }
  /** The row as it stands at the start of the step. */
  session: SessionRow
  /** The turn this step belongs to (`turn_count` after the claim). */
  turn: number
  /**
   * The id `sandbox.start` wrote into the container (`boot-marker.ts`), when the Workflow knows it:
   * the turn refuses a container without it and probes it while it runs.
   */
  bootId?: string
  emit: SessionEmitter
  realtime: Realtime
  logger: Logger
  now: () => Date
}

export type CheckpointReason = 'turn' | 'suspend' | 'end' | 'salvage' | 'ship'

export interface SessionStepHooks {
  runTurn(ctx: SessionStepContext): Promise<TurnOutcome>
  /** Result ignored: the row (`head_sha`, `transcript_key`) is what counts. Throws on failure. */
  checkpoint(ctx: SessionStepContext, reason: CheckpointReason): Promise<unknown>
  /**
   * A ship's FIX turn: Launch's `session-ship-fix` message as a turn while `shipping` — never a
   * status change. Its outcome decides whether the gate runs again.
   */
  shipFix(ctx: SessionStepContext, input: Pick<ShipTurnInput, 'message'>): Promise<ShipTurnResult>
  /** The PR's `{ title, body }` — one cheap model call, or the fallback. Never throws for the model. */
  shipSummary(ctx: SessionStepContext, input: ShipSummaryInput): Promise<ShipSummaryResult>
  /**
   * Issue #5 Phase B, `land.release#K.R` (plan §1.8): the release that carries the merge. Called
   * with the landing at stage `releasing`; idempotent (`landing.releaseId` set → that release).
   */
  landRelease(ctx: SessionStepContext): Promise<LandReleaseResult>
  /** Issue #5 Phase B, `land.staging#K.R` (plan §1.9): the release's staging deploy, read once. */
  landStaging(ctx: SessionStepContext): Promise<LandStagingResult>
  /** Issue #5 Phase B, `land.health#K.R` (plan §1.9): one health probe of staging. */
  landHealth(ctx: SessionStepContext): Promise<LandHealthResult>
}

/**
 * `landRelease`'s answer.
 *
 * - `released`: the release is cut (or an existing one already lists this PR — `shared`). The hook
 *   has ALREADY recorded `releaseId` / `version` / `tag` on `sessions.landing` and moved its stage
 *   `releasing → deploying` (one compare-and-set), and emitted `ship.released`.
 * - `wait`: another holder has the app's release claim (`withReleaseClaim`); the Workflow sleeps
 *   `waitSeconds` (`land.release-wait#K.R`, 20 s) and calls again. The hook itself answers
 *   `stalled` once the landing has waited longer than its cap (15 min).
 * - `stalled`: the release could not be cut (GitHub refused the bump or the tag). Nothing written:
 *   the Workflow's `land.stalled#K` records `stalledReason` and `error`.
 */
export type LandReleaseResult =
  | { status: 'released'; releaseId: string; version: string; tag: string; shared: boolean }
  | { status: 'wait'; waitSeconds: number }
  | { status: 'stalled'; reason: 'release_failed'; error: string }

/**
 * `landStaging`'s answer: `active` — the release reached `staging_active` (or later; `ship.staging
 * {status:'active'}` emitted), health next; `wait` — still deploying, read again after
 * `waitSeconds` (`land.staging-wait#K.R`, 2 min); `stalled` — the deploy failed, or the release is
 * still `tagged` 45 minutes on. Nothing written for `stalled`: `land.stalled#K` does.
 */
export type LandStagingResult =
  | { status: 'active' }
  | { status: 'wait'; waitSeconds: number }
  | { status: 'stalled'; reason: 'deploy_failed' | 'deploy_timeout'; error: string }

/**
 * `landHealth`'s answer: `live` — staging answered `up` on the release's version (`url` is
 * staging's `app_environments.url`); the Workflow's `land.live#K` records it. `wait` — probe again
 * after `waitSeconds` (`land.health-wait#K.R`, 30 s); `stalled` — not healthy after 10 probes.
 */
export type LandHealthResult =
  | { status: 'live'; url: string | null; version: string }
  | { status: 'wait'; waitSeconds: number }
  | { status: 'stalled'; reason: 'unhealthy'; error: string }

/** The real functions (slices 3c and 3d). */
export const defaultSessionStepHooks: SessionStepHooks = {
  runTurn: ctx =>
    runTurn(ctx.db, ctx.ports, ctx.session, {
      realtime: ctx.realtime,
      logger: ctx.logger,
      ...(ctx.bootId ? { bootId: ctx.bootId } : {}),
    }),
  checkpoint: (ctx, reason) =>
    checkpoint(
      ctx.db,
      {
        cfg: ctx.cfg,
        sandbox: ctx.sandbox,
        storage: ctx.storage,
        now: ctx.now,
        emit: events => ctx.emit(events),
        egress: egressFor(ctx.ports, ctx.db),
      },
      ctx.ref,
      reason === 'turn' ? {} : { message: CHECKPOINT_MESSAGES[reason](ctx.session.shortId) }
    ),
  shipFix: (ctx, input) =>
    createShipTurnRunner(ctx.db, ctx.ports, {
      realtime: ctx.realtime,
      logger: ctx.logger,
      ...(ctx.bootId ? { bootId: ctx.bootId } : {}),
    })({ message: input.message, session: ctx.session }),
  shipSummary: (ctx, input) =>
    summarizeShip(ctx.db, ctx.cfg, ctx.env, ctx.session, input, { logger: ctx.logger }),
  // Issue #5 Phase B (`land-release.ts`, slice S3).
  landRelease: ctx => landRelease(ctx),
  landStaging: ctx => landStaging(ctx),
  landHealth: ctx => landHealth(ctx),
}

/** The commit subject of a checkpoint that is not a turn's own. */
const CHECKPOINT_MESSAGES: Record<
  Exclude<CheckpointReason, 'turn'>,
  (shortId: string) => string
> = {
  suspend: shortId => `Launch session ${shortId}: saved before suspending`,
  end: shortId => `Launch session ${shortId}: saved at the end of the session`,
  salvage: shortId => `Launch session ${shortId}: saved after its turn was interrupted`,
  ship: shortId => `Launch session ${shortId}: saved to ship`,
}
