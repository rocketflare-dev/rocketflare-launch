/**
 * The three things the `SessionWorkflow` (slice 3b) asks OTHER slices' modules to do, behind one
 * small seam so the Workflow is tested with fakes (`overrides.hooks`) and bound to the real
 * functions here, once:
 *
 * | Hook         | Slice | Function                                   | Called from step             |
 * |--------------|-------|--------------------------------------------|------------------------------|
 * | `runTurn`    | 3c    | `runTurn(db, ports, session, opts)`         | `turn#N`                     |
 * | `checkpoint` | 3d    | `checkpoint(db, deps, ref, opts)`           | `checkpoint#N`, `suspend#N`, `end#N` |
 * | `ship`       | 3d    | `ship(db, deps, ref)` with 3c's ship turn   | `ship#N`                     |
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
 * `ready → working` and settles back to `ready` / `blocked` / `suspended` (a rollout); `ship`
 * claims `ready → shipping` and ends `shipped` or back at `ready`; `checkpoint` changes no status.
 * The Workflow reads the ROW afterwards, and only repairs a session a hook left mid-flight (a
 * `working` row after the turn step itself died is settled `ready` with `turn.failed`).
 */
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { SessionRow } from '../../../db/schema'
import type { AppBindings } from '../../types'
import type { Logger } from '../../utils/core/logger'
import { scanShipConfig } from '../grants/detect'
import type { Realtime } from '../realtime'
import type { StorageService } from '../storage'
import { checkpoint } from './checkpoint'
import type { SessionEmitter } from './events'
import { egressFor, type SandboxPort, type SessionPorts } from './ports'
import { ship } from './ship'
import { createShipTurnRunner, runTurn, type TurnOutcome } from './turn'

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
  emit: SessionEmitter
  realtime: Realtime
  logger: Logger
  now: () => Date
}

export type CheckpointReason = 'turn' | 'suspend' | 'end'

export interface SessionStepHooks {
  runTurn(ctx: SessionStepContext): Promise<TurnOutcome>
  /** Result ignored: the row (`head_sha`, `transcript_key`) is what counts. Throws on failure. */
  checkpoint(ctx: SessionStepContext, reason: CheckpointReason): Promise<unknown>
  /** Result ignored: the row's status afterwards (`shipped` or not) is what counts. */
  ship(ctx: SessionStepContext): Promise<unknown>
}

/** The real functions (slices 3c and 3d). */
export const defaultSessionStepHooks: SessionStepHooks = {
  runTurn: ctx =>
    runTurn(ctx.db, ctx.ports, ctx.session, { realtime: ctx.realtime, logger: ctx.logger }),
  checkpoint: (ctx, reason) =>
    checkpoint(
      ctx.db,
      {
        cfg: ctx.cfg,
        sandbox: ctx.sandbox,
        storage: ctx.storage,
        now: ctx.now,
        egress: egressFor(ctx.ports, ctx.db),
      },
      ctx.ref,
      reason === 'turn' ? {} : { message: CHECKPOINT_MESSAGES[reason](ctx.session.shortId) }
    ),
  ship: ctx =>
    ship(
      ctx.db,
      {
        cfg: ctx.cfg,
        ports: ctx.ports,
        storage: ctx.storage,
        runTurn: createShipTurnRunner(ctx.db, ctx.ports, {
          realtime: ctx.realtime,
          logger: ctx.logger,
        }),
        emit: events => ctx.emit(events),
        now: ctx.now,
        scanConfig: input => scanShipConfig(ctx, input),
      },
      ctx.ref
    ),
}

/** The commit subject of a checkpoint that is not a turn's own. */
const CHECKPOINT_MESSAGES: Record<
  Exclude<CheckpointReason, 'turn'>,
  (shortId: string) => string
> = {
  suspend: shortId => `Launch session ${shortId}: saved before suspending`,
  end: shortId => `Launch session ${shortId}: saved at the end of the session`,
}
