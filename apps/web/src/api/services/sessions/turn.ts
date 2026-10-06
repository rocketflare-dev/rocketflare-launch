/**
 * One chat turn of a coding session (Launch P3, plan §3c) — the body of the Workflow's `turn#N`
 * step. Slice 3b's `SessionWorkflow` calls it; nothing else does.
 *
 * ## The contract (stable — the Workflow depends on exactly this)
 *
 * ```ts
 * import { runTurn, turnStepConfig } from '../services/sessions/turn'
 *
 * const outcome = await step.do(`turn#${n}`, turnStepConfig(policy), () =>
 *   withStepDatabase(env, cfg, db => runTurn(db, ports, session, { realtime, logger }))
 * )
 * // outcome.status: 'completed' | 'failed' | 'interrupted' | 'blocked' | 'rejected' | 'skipped'
 * // outcome.reason (interrupted): 'rollout' | 'container_lost' → the session is already
 * //   `suspended`; destroy what is left of the container (`rollout#N`), do NOT checkpoint (it is
 * //   gone) — `containerGone(outcome)`. 'cancelled' | 'timeout' → `ready`.
 * ```
 *
 * `runTurn(db, ports, session, opts?) → Promise<TurnOutcome>`:
 *
 * - `db` — the step's OWN client (`withStepDatabase`); `ports` — `SessionPorts` (only
 *   `ports.sandbox(session.id)` is used); `session` — the row (only `id` and `tenantId` are read
 *   from it: the turn RE-READS the row, because the row is the truth and a wake carries nothing).
 * - `opts` — {@link RunTurnOptions}: `realtime` for the `entity.changed` nudges (a step's
 *   `createStepRealtime()`; settle it after), `logger`, `bootId` (the id `sandbox.start` wrote into
 *   the container, `boot-marker.ts` — the Workflow always passes it; without it nothing is probed),
 *   and the clock/timer seams tests use.
 * - It never throws for anything the TURN did (a failed process, a rollout, a cancel, a timeout are
 *   outcomes, each with its own event); it throws only when the database does.
 * - Step config: `retries: 0` — a turn is not idempotent (it would re-run the person's message) —
 *   and a step timeout a little longer than the turn's own, so the turn's timeout fires first and
 *   writes `turn.interrupted { reason: 'timeout' }` rather than the platform killing the step.
 *
 * ## What it does
 *
 * 1. **Claim**: the row must be `ready` (or `blocked`) with a `pending_message`; otherwise `skipped`.
 *    **Never on an empty container**: with a `bootId`, the container must still carry it. One that
 *    answers without it was recreated under the session (it died — out of memory, most often):
 *    nothing runs, the message STAYS pending, the session goes `suspended` with a `resume`
 *    requested (an `error` event says so), and the outcome is `interrupted { container_lost }` —
 *    the Workflow destroys the empty container, resumes from the last checkpoint and runs the
 *    message on the new one.
 * 2. **Budget** (`budget.ts`): over → `blocked`, `budget.reached`, audit `session.budget.reached`;
 *    the message STAYS pending, so extending the budget (which un-blocks) runs it. `maxTurns`
 *    reached → `rejected`, an `error` event, and the message is dropped.
 * 3. A compare-and-set to `working` (turn_count + 1, pending_message cleared, cancel cleared — and
 *    `pending_model`, when the message asked for one, moved onto `policy.model`), then
 *    `user.message` and `turn.start` (naming the model the turn runs on). When the turn before
 *    was stopped (`turn.interrupted { cancelled }` — Stop, or a message sent with `interrupt`),
 *    the command's message starts with the `session-interrupted` line; `user.message` does not.
 *    A message with images (`pending_attachments`) names them in `user.message`'s data; one that is
 *    ONLY images (`pending_message = ''`) reaches the agent as {@link imageOnlyMessage}.
 * 4. **Run** it through the session's runtime — `runtimeOf(row).runTurn(ctx, input, sink)`
 *    (`runtimes/types.ts`). This file knows nothing about HOW: Claude Code and Codex are
 *    `processRuntime(cli)` (`runtimes/process/turn.ts` — the images staged into the container, the
 *    egress grant and the credential lease, the CLI's files and input, `startProcess`, its parser,
 *    the resume check and retry, the liveness probe, the self-metered budget stop, and the kill by
 *    pid when Launch stops reading). The {@link TurnContext} carries the step's clocks and the two
 *    row callbacks — the heartbeat every 10 s (`last_activity_at` of a `working` row, what
 *    `reconcile.ts` reads to tell a live turn from one whose Workflow died under it) and the
 *    `cancel_requested_at` read every 2 s (→ `cancelled`); the turn's own timeout is
 *    `policy.maxTurnMinutes` (→ `timeout`). The {@link TurnSink} is this file's: each normalised
 *    mapping's events buffered and written every 250 ms or 20 events (`event-log.ts`), its resume
 *    id stored at once (the next turn resumes it) and its `runtime_state` too. **A resume that
 *    cannot work never breaks the session**: the runtime asks the sink to forget it —
 *    `claude_session_id` is cleared, an `error` event says so ({@link CONVERSATION_LOST_MESSAGE})
 *    — and the turn runs as a new conversation.
 * 5. **End** with exactly one of `turn.end` (the result, with the turn's METERED cost — the model
 *    proxy's `ai_usage` rows, or the turn's own, as the row's running total moved), `turn.failed`
 *    (no result, or it would not start) or `turn.interrupted` (`rollout` — the container was
 *    replaced, `container_lost` — it died and came back empty, {@link CONTAINER_LOST_MESSAGE} —
 *    `cancelled` or `timeout`), and the status back to `ready` (`suspended` after a rollout or a
 *    lost container).
 *
 * ## The ship's fix turn (issue #1)
 *
 * `createShipTurnRunner(db, ports, opts?)` → `ShipTurnRunner` —
 * `({ message, session }) => Promise<{ outcome: 'completed' | 'failed' | 'interrupted' |
 * 'cancelled'; turn; text; reason? }>`, what the ship's `ship.fix#N.A` step runs (through the
 * `shipFix` hook). It is `runPromptTurn`: the same steps 4–5 — the same `runTurn` of the same
 * runtime — for a Launch-authored prompt while the session is `shipping` — no `pending_message`,
 * no `user.message`, no status change — returning the agent's final answer (`text`, the result).
 * Launch runs the gate itself; this turn only fixes what a step reported.
 *
 * No secret is in any event or in the outcome: the runtime's process env is placeholders, every
 * string it maps is redacted and clipped, and the outcome is ids, counts and flags.
 */
import {
  PENDING_MODEL_DEFAULT,
  resolveSessionPolicy,
  SESSION_REALTIME_ENTITY,
  type SessionAttachment,
  type SessionPolicy,
  sessionShipCiDataSchema,
  sessionTurnInterruptedDataSchema,
} from '@launch/shared/launch-sessions'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { apps, type SessionRow, sessionEvents, sessions, users } from '../../../db/schema'
import type { Logger } from '../../utils/core/logger'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import { resolvePrompt } from '../prompts'
import { nudge, type Realtime, realtimeEvent } from '../realtime'
import type { StorageService } from '../storage'
import {
  CONTAINER_LOST_BEFORE_TURN_MESSAGE,
  CONTAINER_LOST_MESSAGE,
  checkContainer,
} from './boot-marker'
import { checkBudget } from './budget'
import { createSessionEventWriter, type SessionEventWriter } from './event-log'
import { redactModelKeyText } from './model-key'
import { credentialsFor, egressFor, type SessionPorts } from './ports'
import { runtimeOf } from './runtimes'
import type {
  AgentRuntime,
  RuntimeTurnOutcome,
  RuntimeTurnResult,
  RuntimeTurnStop,
  TurnContext,
  TurnSink,
} from './runtimes/types'

/** Write buffered events at least this often while a turn streams (plan §3c). */
export const TURN_FLUSH_MS = 250
/** …or as soon as this many are waiting. */
export const TURN_FLUSH_EVERY = 20
/** How often a running turn re-reads `cancel_requested_at` (and checks its timeout). */
export const TURN_CANCEL_POLL_MS = 2_000
/**
 * How often a running turn writes its heartbeat (`last_activity_at`, while `working`) — the clock
 * `reconcile.ts` reads. A third of a boot step's (`deadline.ts` `heartbeatMs`) because a Stop reads
 * it too: a cancel whose turn has not beaten for `SESSION_CANCEL_STALL_MS` (30 s — three missed
 * beats) is acted on without the turn step (`reconcile.ts`), and a live turn must never look that
 * quiet. One small UPDATE every 10 s of a turn.
 */
export const TURN_HEARTBEAT_MS = 10_000
/**
 * How often a running turn reads the container's boot marker (`boot-marker.ts`). A container that
 * died does not close the turn's log stream; this is how a turn notices within a minute instead of
 * at its timeout. One small file read per probe.
 */
export const TURN_LIVENESS_PROBE_MS = 45_000
/** The bound on one probe: a container busy with a build may be slow, but not this slow. */
export const TURN_LIVENESS_CALL_MS = 20_000
/**
 * Probes in a row that got no answer before the container is judged lost — about four minutes of
 * silence. A missing marker needs no second opinion: that container answered, empty.
 */
export const TURN_LIVENESS_MAX_FAILURES = 4
/** The step timeout's margin over the turn's own, so the turn's timeout always fires first. */
export const TURN_STEP_TIMEOUT_MARGIN_MINUTES = 2

// The process runtimes' names, where their importers always found them (rocketflare-launch#13
// moved them to `runtimes/process/`, and the transcript check to `runtimes/claude-code/`).
export { transcriptCheckCommand } from './runtimes/claude-code/state'
export {
  TURN_KILL_CALL_MS,
  TURN_KILL_GRACE_SECONDS,
  TURN_PID_FILE,
  terminateTurnProcess,
  turnKillScript,
  turnProcessCommand,
} from './runtimes/process/kill'
export { selfMetered, TURN_INPUT_TIMEOUT_MS } from './runtimes/process/turn'

/**
 * What the person reads when the conversation a turn would resume is gone (it was never
 * checkpointed, did not come back with a resume, or the agent refused it): a new one starts.
 */
export const CONVERSATION_LOST_MESSAGE =
  'The earlier conversation could not be restored; Claude starts fresh with the code as it is.'

/** What a message from anyone but a personal-account session's owner meets (§18.22). */
export const CREDENTIAL_OWNER_ONLY_MESSAGE =
  'Only the person whose account this session uses can send it messages.'

/** The `step.do` config for `turn#N`: no retries (a turn is not idempotent), the policy's timeout. */
export function turnStepConfig(policy: Pick<SessionPolicy, 'maxTurnMinutes'>) {
  return {
    retries: { limit: 0, delay: '1 second' as const },
    timeout: `${policy.maxTurnMinutes + TURN_STEP_TIMEOUT_MARGIN_MINUTES} minutes` as const,
  }
}

export interface RunTurnOptions {
  /** `entity.changed { entity: 'session' }` after each status write. Settle it after the step. */
  realtime?: Realtime
  logger?: Logger
  /** The checkout the turn runs in (default: the runtime's own, `SESSION_WORKSPACE`). */
  cwd?: string
  /** Milliseconds clock (default `Date.now`). */
  now?: () => number
  /** MUST yield to the event loop (a timer), or the watch loops starve the stream. */
  sleep?: (ms: number) => Promise<void>
  /** Overrides `policy.maxTurnMinutes`. */
  timeoutMs?: number
  flushMs?: number
  flushEvery?: number
  cancelPollMs?: number
  heartbeatMs?: number
  /**
   * The id `sandbox.start` wrote into the container (`SESSION_BOOT_MARKER`). With it the turn
   * refuses an empty container and probes the marker while it runs; without it (a caller outside
   * the Workflow) neither happens.
   */
  bootId?: string
  /** Overrides {@link TURN_LIVENESS_PROBE_MS}. */
  probeMs?: number
  /** Overrides {@link TURN_LIVENESS_CALL_MS}. */
  probeCallMs?: number
  /** Overrides {@link TURN_LIVENESS_MAX_FAILURES}. */
  probeFailures?: number
  /**
   * R2 (`createR2Storage(env.FILES)`) — where a message's images are (`attachments.ts`); null or
   * absent: a message with images fails its turn, saying so.
   */
  storage?: StorageService | null
}

/**
 * `rollout` — the platform replaced the container under a call (`SandboxInterruptedError`);
 * `container_lost` — it died and came back empty (its boot marker is gone, or it stopped
 * answering); `cancelled` — a Stop; `timeout` — `maxTurnMinutes`.
 */
export type TurnInterruptReason = RuntimeTurnStop

/** The container a turn ran in is gone: the session is `suspended` and nothing is left to save. */
export function containerGone(outcome: { status: string; reason?: string }): boolean {
  return (
    outcome.status === 'interrupted' &&
    (outcome.reason === 'rollout' || outcome.reason === 'container_lost')
  )
}

/** Longest end of the final answer a {@link TurnResultSummary} carries. */
export const TURN_RESULT_TAIL_MAX = 500

/**
 * How the agent's `result` line ended the turn: its `subtype` (`success`, `error_max_turns`,
 * `error_during_execution`…), whether it flagged an error, and the END of its final answer
 * (redacted, at most {@link TURN_RESULT_TAIL_MAX} characters) — what an upgrade session's auto-ship
 * reads its `LAUNCH-UPGRADE:` line from (`launch/upgrades.ts`). Absent when no `result` line came.
 */
export interface TurnResultSummary {
  subtype: string
  isError: boolean
  tail: string | null
}

/** What the Workflow learns. Ids, counts and flags only — it is a step result. */
export type TurnOutcome =
  | { status: 'skipped'; sessionId: string }
  | { status: 'blocked'; sessionId: string; scope: 'session' | 'app_month' }
  | { status: 'rejected'; sessionId: string; reason: 'max_turns' | 'credential_owner_only' }
  | {
      status: 'completed' | 'failed'
      sessionId: string
      turn: number
      costMicrocents: number
      result?: TurnResultSummary
    }
  | {
      status: 'interrupted'
      sessionId: string
      turn: number
      reason: TurnInterruptReason
      costMicrocents: number
      result?: TurnResultSummary
    }

/** The {@link TurnResultSummary} of a `result` line, or undefined without one. */
export function turnResultSummary(
  result: RuntimeTurnResult | null | undefined
): TurnResultSummary | undefined {
  if (!result) return undefined
  const text = result.text?.trimEnd() ?? null
  return {
    subtype: result.subtype,
    isError: result.isError,
    tail: text === null ? null : text.slice(-TURN_RESULT_TAIL_MAX),
  }
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function readRow(db: Database, session: Pick<SessionRow, 'id' | 'tenantId'>) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, session.id)))
    .limit(1)
  return row ?? null
}

export async function runTurn(
  db: Database,
  ports: SessionPorts,
  session: Pick<SessionRow, 'id' | 'tenantId'>,
  opts: RunTurnOptions = {}
): Promise<TurnOutcome> {
  const now = opts.now ?? (() => Date.now())
  const sessionId = session.id
  const changed = () =>
    nudge(
      opts.realtime,
      realtimeEvent('entity.changed', session.tenantId, {
        entity: SESSION_REALTIME_ENTITY,
        id: sessionId,
      })
    )

  // ---- 1. claim ------------------------------------------------------------------------------
  const current = await readRow(db, session)
  if (
    !current ||
    current.pendingMessage === null ||
    !['ready', 'blocked'].includes(current.status)
  ) {
    return { status: 'skipped', sessionId }
  }
  // An image-only message is the empty string: it still runs.
  const message = current.pendingMessage
  const attachments = current.pendingAttachments ?? []
  // §18.22: who sent it — the creator for every row written before `pending_message_user_id`.
  const senderId = current.pendingMessageUserId ?? current.createdByUserId
  const policy = resolveSessionPolicy(current.policy)
  const writer = await createSessionEventWriter(db, current)

  // ---- never on an empty container -----------------------------------------------------------
  if (opts.bootId) {
    const verdict = await checkContainer(
      ports.sandbox(sessionId),
      opts.bootId,
      opts.probeCallMs ?? TURN_LIVENESS_CALL_MS
    )
    if (verdict === 'replaced' || verdict === 'interrupted') {
      opts.logger?.warn(
        { sessionId, verdict },
        'session turn: the container is not the one the boot prepared; suspending to resume'
      )
      const [suspended] = await db
        .update(sessions)
        .set({
          status: 'suspended',
          suspendedAt: new Date(now()),
          // The message stays pending: the resume runs it on the new container.
          requestedAction: current.requestedAction ?? 'resume',
          containerKeptAt: null,
          cancelRequestedAt: null,
          updatedAt: new Date(now()),
        })
        .where(
          and(
            eq(sessions.tenantId, session.tenantId),
            eq(sessions.id, sessionId),
            inArray(sessions.status, ['ready', 'blocked']),
            eq(sessions.turnCount, current.turnCount)
          )
        )
        .returning({ id: sessions.id })
      if (!suspended) return { status: 'skipped', sessionId }
      writer.append({
        type: 'error',
        turn: current.turnCount,
        data: { message: CONTAINER_LOST_BEFORE_TURN_MESSAGE },
      })
      await writer.flush()
      changed()
      return {
        status: 'interrupted',
        sessionId,
        turn: current.turnCount,
        reason: 'container_lost',
        costMicrocents: 0,
      }
    }
  }

  // ---- 2. budget and turn limit --------------------------------------------------------------
  const verdict = await checkBudget(db, current, new Date(now()))
  if (!verdict.ok) {
    if (current.status !== 'blocked') {
      const [blocked] = await db
        .update(sessions)
        .set({ status: 'blocked', updatedAt: new Date(now()) })
        .where(
          and(
            eq(sessions.tenantId, session.tenantId),
            eq(sessions.id, sessionId),
            eq(sessions.status, 'ready')
          )
        )
        .returning({ id: sessions.id })
      if (blocked) {
        writer.append({
          type: 'budget.reached',
          turn: current.turnCount,
          data: {
            spentMicrocents: verdict.spentMicrocents,
            capMicrocents: verdict.capMicrocents,
            scope: verdict.scope,
          },
        })
        await writer.flush()
        await recordAudit(db, {
          ...SYSTEM_ACTOR,
          tenantId: session.tenantId,
          action: 'session.budget.reached',
          targetType: 'session',
          targetId: sessionId,
          appId: current.appId,
          summary: {
            after: {
              scope: verdict.scope,
              spentMicrocents: verdict.spentMicrocents,
              capMicrocents: verdict.capMicrocents,
            },
          },
        })
        changed()
      }
    }
    return { status: 'blocked', sessionId, scope: verdict.scope }
  }

  // §18.22: a session on a personal account runs only its owner's messages (the route refuses
  // everyone else with 409 `session_credential_owner_only`; this is the backstop).
  if (current.credentialSource === 'user' && senderId !== current.createdByUserId) {
    const [dropped] = await db
      .update(sessions)
      .set({
        pendingMessage: null,
        pendingMessageUserId: null,
        pendingModel: null,
        pendingAttachments: null,
        updatedAt: new Date(now()),
      })
      .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, sessionId)))
      .returning({ id: sessions.id })
    if (dropped) {
      writer.append({
        type: 'error',
        turn: current.turnCount,
        data: { message: CREDENTIAL_OWNER_ONLY_MESSAGE },
      })
      await writer.flush()
      changed()
    }
    return { status: 'rejected', sessionId, reason: 'credential_owner_only' }
  }

  if (current.turnCount >= policy.maxTurns) {
    const [dropped] = await db
      .update(sessions)
      .set({
        pendingMessage: null,
        pendingModel: null,
        pendingAttachments: null,
        updatedAt: new Date(now()),
      })
      .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, sessionId)))
      .returning({ id: sessions.id })
    if (dropped) {
      writer.append({
        type: 'error',
        turn: current.turnCount,
        data: { message: `This session has reached its limit of ${policy.maxTurns} turns` },
      })
      await writer.flush()
      changed()
    }
    return { status: 'rejected', sessionId, reason: 'max_turns' }
  }

  // ---- 3. working ----------------------------------------------------------------------------
  const [claimed] = await db
    .update(sessions)
    .set({
      status: 'working',
      turnCount: current.turnCount + 1,
      pendingMessage: null,
      pendingMessageUserId: null,
      // The model the message asked for becomes the session's from this turn on — in the claim
      // itself, read from the column, so the proxy's allow-list (it re-reads `policy`) and the
      // command can never disagree about which model this turn runs.
      // `PENDING_MODEL_DEFAULT` is the way back to the agent's own default: `model` null.
      policy: sql`case when ${sessions.pendingModel} is null then ${sessions.policy}
        when ${sessions.pendingModel} = ${PENDING_MODEL_DEFAULT}
          then jsonb_set(${sessions.policy}, '{model}', 'null'::jsonb)
        else jsonb_set(${sessions.policy}, '{model}', to_jsonb(${sessions.pendingModel})) end`,
      pendingModel: null,
      pendingAttachments: null,
      cancelRequestedAt: null,
      lastActivityAt: new Date(now()),
      updatedAt: new Date(now()),
    })
    .where(
      and(
        eq(sessions.tenantId, session.tenantId),
        eq(sessions.id, sessionId),
        inArray(sessions.status, ['ready', 'blocked']),
        eq(sessions.turnCount, current.turnCount),
        eq(sessions.pendingMessage, message)
      )
    )
    .returning()
  if (!claimed) return { status: 'skipped', sessionId }
  const turn = claimed.turnCount
  const turnPolicy = resolveSessionPolicy(claimed.policy)
  // After a Stop (or Send now) the agent is told its last turn was cut off, so it takes this
  // message as the new instruction rather than finishing the old one. The transcript keeps the
  // person's own words.
  // An image-only message still needs words for the agent to act on.
  const words = message || imageOnlyMessage(attachments.length)
  const prompt = (await previousTurnStopped(db, claimed))
    ? `${await resolvePrompt(db, claimed.tenantId, 'session-interrupted', {})}\n\n${words}`
    : words

  writer.append(
    {
      type: 'user.message',
      turn,
      data: {
        text: redactModelKeyText(message),
        userId: senderId,
        ...(attachments.length ? { attachments } : {}),
      },
    },
    { type: 'turn.start', turn, data: { turn, model: turnPolicy.model } }
  )
  await writer.flush()
  changed()

  // ---- 4–6. run, stream, watch, end -----------------------------------------------------------
  const run = await executeTurn(
    db,
    ports,
    claimed,
    writer,
    { turn, message: prompt, policy: turnPolicy, attachments },
    opts
  )
  const summary = turnResultSummary(run.result)
  const outcome: TurnOutcome =
    run.status === 'interrupted'
      ? {
          status: 'interrupted',
          sessionId,
          turn,
          reason: run.reason,
          costMicrocents: run.costMicrocents,
          ...(summary ? { result: summary } : {}),
        }
      : {
          status: run.status,
          sessionId,
          turn,
          costMicrocents: run.costMicrocents,
          ...(summary ? { result: summary } : {}),
        }

  const gone = containerGone(run)
  await db
    .update(sessions)
    .set({
      status: gone ? 'suspended' : 'ready',
      ...(gone ? { suspendedAt: new Date(now()), containerKeptAt: null } : {}),
      cancelRequestedAt: null,
      lastActivityAt: new Date(now()),
      updatedAt: new Date(now()),
    })
    .where(
      and(
        eq(sessions.tenantId, session.tenantId),
        eq(sessions.id, sessionId),
        eq(sessions.status, 'working')
      )
    )
  changed()
  return outcome
}

/** What the agent reads for a message that is only images (the transcript keeps it empty). */
export function imageOnlyMessage(images: number): string {
  return images > 1 ? 'See the attached images.' : 'See the attached image.'
}

/** Whether the session's last turn ended `turn.interrupted { cancelled }` — a Stop or a Send now. */
async function previousTurnStopped(db: Database, row: SessionRow): Promise<boolean> {
  const [last] = await db
    .select({ type: sessionEvents.type, data: sessionEvents.data })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, row.tenantId),
        eq(sessionEvents.sessionId, row.id),
        inArray(sessionEvents.type, ['turn.end', 'turn.failed', 'turn.interrupted'])
      )
    )
    .orderBy(desc(sessionEvents.seq))
    .limit(1)
  if (last?.type !== 'turn.interrupted') return false
  return sessionTurnInterruptedDataSchema.safeParse(last.data).data?.reason === 'cancelled'
}

/** What one executed turn came to — before any status is written. */
export type ExecutedTurn =
  | {
      status: 'completed' | 'failed'
      costMicrocents: number
      /** The `result` line (absent when the process never printed one). */
      result: RuntimeTurnResult | null
    }
  | {
      status: 'interrupted'
      reason: TurnInterruptReason
      costMicrocents: number
      result: RuntimeTurnResult | null
    }

/**
 * Steps 4–6 without the status: run `message` as turn `turn` of `row` (already claimed — its
 * `turn_count` is `turn`) through the session's runtime (`runtimeOf(row).runTurn`), with this
 * turn's sink, and write the ONE closing event (`turn.end`, `turn.failed` or `turn.interrupted`).
 * Shared by the chat turn and the ship turn, which own their statuses differently.
 */
async function executeTurn(
  db: Database,
  ports: SessionPorts,
  row: SessionRow,
  writer: SessionEventWriter,
  input: {
    turn: number
    message: string
    policy: SessionPolicy
    /** The message's images (none for Launch's own prompts). */
    attachments?: readonly SessionAttachment[]
  },
  opts: RunTurnOptions
): Promise<ExecutedTurn> {
  const { turn, policy } = input
  const costBefore = Number(row.costMicrocents)
  const now = opts.now ?? (() => Date.now())
  // Issue #8: the first token is measured from here — what the person waits through.
  const startedAt = now()
  const ctx: TurnContext = {
    db,
    session: row,
    sandbox: ports.sandbox(row.id),
    logger: opts.logger,
    turn,
    egress: egressFor(ports, db),
    credentials: credentialsFor(ports, db),
    storage: opts.storage ?? null,
    cwd: opts.cwd,
    now,
    sleep: opts.sleep ?? realSleep,
    timeoutMs: opts.timeoutMs ?? policy.maxTurnMinutes * 60_000,
    flushMs: opts.flushMs ?? TURN_FLUSH_MS,
    flushEvery: opts.flushEvery ?? TURN_FLUSH_EVERY,
    cancelPollMs: opts.cancelPollMs ?? TURN_CANCEL_POLL_MS,
    heartbeatMs: opts.heartbeatMs ?? TURN_HEARTBEAT_MS,
    bootId: opts.bootId ?? null,
    probeMs: opts.probeMs ?? TURN_LIVENESS_PROBE_MS,
    probeCallMs: opts.probeCallMs ?? TURN_LIVENESS_CALL_MS,
    probeFailures: opts.probeFailures ?? TURN_LIVENESS_MAX_FAILURES,
    // "This turn is alive" — only while `working` (a ship's fix turn runs `shipping`, and its
    // step's `withHeartbeat` beats for it). A failed beat is not a failed turn: the next one tries.
    heartbeat: at =>
      db
        .update(sessions)
        .set({ lastActivityAt: new Date(at) })
        .where(
          and(
            eq(sessions.tenantId, row.tenantId),
            eq(sessions.id, row.id),
            eq(sessions.status, 'working')
          )
        )
        .then(
          () => {},
          err => opts.logger?.warn({ err, sessionId: row.id }, 'session turn: heartbeat failed')
        ),
    async cancelRequested() {
      const [flags] = await db
        .select({ cancelRequestedAt: sessions.cancelRequestedAt })
        .from(sessions)
        .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
        .limit(1)
      return Boolean(flags?.cancelRequestedAt)
    },
  }
  const runtime = runtimeOf(row)
  const run = await runtime.runTurn(
    ctx,
    {
      message: input.message,
      model: policy.model,
      attachments: input.attachments ?? [],
      systemNote: () => sessionSystemNote(db, row),
    },
    createTurnSink(db, row, writer, turn)
  )
  return closeTurn(db, row, writer, { turn, startedAt }, costBefore, runtime, run)
}

/**
 * The {@link TurnSink} a turn hands its runtime: a mapping's resume id (when it names a new one)
 * and runtime state written at once, its events into the turn's buffered writer.
 */
function createTurnSink(
  db: Database,
  row: SessionRow,
  writer: SessionEventWriter,
  turn: number
): TurnSink {
  let resumeId = row.claudeSessionId
  return {
    async apply(mapping) {
      if (mapping.resumeId && mapping.resumeId !== resumeId) {
        resumeId = mapping.resumeId
        // At once, not at the end: a turn that fails later must still be resumable.
        await db
          .update(sessions)
          .set({ claudeSessionId: resumeId })
          .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
      }
      if (mapping.runtimeState) {
        // §18.22: what the runtime keeps between turns (its own shape, `AgentRuntimeState`).
        await db
          .update(sessions)
          .set({ runtimeState: mapping.runtimeState })
          .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
      }
      if (mapping.events.length > 0) writer.append(...mapping.events)
    },
    append: (...events) => writer.append(...events),
    get pending() {
      return writer.pending
    },
    flush: () => writer.flush(),
    async forgetConversation() {
      resumeId = null
      await forgetConversation(db, row, writer, turn)
    },
  }
}

/** Write the turn's ONE closing event from what the run came to (see {@link executeTurn}). */
async function closeTurn(
  db: Database,
  row: SessionRow,
  writer: SessionEventWriter,
  { turn, startedAt }: { turn: number; startedAt: number },
  costBefore: number,
  runtime: AgentRuntime,
  run: RuntimeTurnOutcome
): Promise<ExecutedTurn> {
  // The turn's cost is what was metered while it ran — by the model proxy, or (a self-metered
  // turn) by the runtime itself as it ended: either way the row's total moved.
  const after = await readRow(db, row)
  const costMicrocents = Math.max(0, Number(after?.costMicrocents ?? costBefore) - costBefore)
  let executed: ExecutedTurn
  if (run.stop) {
    writer.append({
      type: 'turn.interrupted',
      turn,
      data: {
        turn,
        reason: run.stop,
        ...(run.stop === 'container_lost' ? { message: CONTAINER_LOST_MESSAGE } : {}),
      },
    })
    executed = { status: 'interrupted', reason: run.stop, costMicrocents, result: run.result }
  } else if (run.result && !run.failure) {
    writer.append({
      type: 'turn.end',
      turn,
      data: {
        turn,
        result: run.result.subtype,
        ...(run.result.durationMs !== null ? { durationMs: run.result.durationMs } : {}),
        ...(run.result.usage ? { usage: run.result.usage } : {}),
        costMicrocents,
        ...(run.firstOutputAt !== undefined
          ? { firstTokenMs: Math.max(0, Math.round(run.firstOutputAt - startedAt)) }
          : {}),
      },
    })
    executed = { status: 'completed', costMicrocents, result: run.result }
  } else {
    writer.append({
      type: 'turn.failed',
      turn,
      data: { turn, message: run.failure ?? `${runtime.label} stopped without finishing the turn` },
    })
    executed = { status: 'failed', costMicrocents, result: run.result }
  }
  await writer.flush()
  return executed
}

/** Clear the resume id (`claude_session_id` — the next turn starts a conversation) and say so. */
async function forgetConversation(
  db: Database,
  row: SessionRow,
  writer: SessionEventWriter,
  turn: number
): Promise<void> {
  await db
    .update(sessions)
    .set({ claudeSessionId: null })
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
  writer.append({ type: 'error', turn, data: { message: CONVERSATION_LOST_MESSAGE } })
  await writer.flush()
}

// ---- the ship turn -------------------------------------------------------------------------------

/** What a ship's FIX turn hands a message to (`ship.fix#N.A`, `ship-steps.ts`). */
export interface ShipTurnInput {
  /** Launch's own prompt (`session-ship-fix`), not a person's message. */
  message: string
  /** The row as the ship claimed it (`shipping`); the runner re-reads it by id. */
  session: SessionRow
}

export interface ShipTurnResult {
  outcome: 'completed' | 'failed' | 'interrupted' | 'cancelled'
  /** The turn number it ran as (0 when it never started). */
  turn: number
  /** The agent's final answer (its result). */
  text?: string | null
  /**
   * For `interrupted`: why — `rollout` and `container_lost` mean the container is gone
   * (`containerGone`), and the ship suspends the session rather than going back to `ready`.
   */
  reason?: TurnInterruptReason
}

export type ShipTurnRunner = (input: ShipTurnInput) => Promise<ShipTurnResult>

/**
 * Run a LAUNCH-authored prompt as a turn — the ship gate's "this step failed, here is its output:
 * fix it" (`session-ship-fix`) — while the session is `shipping`. Unlike {@link runTurn} it claims no `pending_message`, writes
 * no `user.message` (the prompt is Launch's, not the person's) and leaves the STATUS to its caller
 * (`ship-steps.ts`); it does count as a turn (`turn_count`, `turn.start` … `turn.end`), is metered and
 * cancellable like one, and refuses to start when the session is over budget (`budget.reached`,
 * `failed`). A `result` line that reports an error (`error_max_turns`…) is `failed` here: the
 * fix did not finish. With a `bootId` it probes the container like a chat turn, and an
 * `interrupted` outcome carries its `reason`.
 */
export async function runPromptTurn(
  db: Database,
  ports: SessionPorts,
  input: ShipTurnInput,
  opts: RunTurnOptions = {}
): Promise<ShipTurnResult> {
  const now = opts.now ?? (() => Date.now())
  const current = await readRow(db, input.session)
  if (!current || current.status === 'working') return { outcome: 'failed', turn: 0 }
  const policy = resolveSessionPolicy(current.policy)
  const writer = await createSessionEventWriter(db, current)

  const verdict = await checkBudget(db, current, new Date(now()))
  if (!verdict.ok) {
    writer.append({
      type: 'budget.reached',
      turn: current.turnCount,
      data: {
        spentMicrocents: verdict.spentMicrocents,
        capMicrocents: verdict.capMicrocents,
        scope: verdict.scope,
      },
    })
    await writer.flush()
    return { outcome: 'failed', turn: 0 }
  }

  const [claimed] = await db
    .update(sessions)
    .set({
      turnCount: current.turnCount + 1,
      cancelRequestedAt: null,
      lastActivityAt: new Date(now()),
      updatedAt: new Date(now()),
    })
    .where(
      and(
        eq(sessions.tenantId, current.tenantId),
        eq(sessions.id, current.id),
        eq(sessions.turnCount, current.turnCount)
      )
    )
    .returning()
  if (!claimed) return { outcome: 'failed', turn: 0 }
  const turn = claimed.turnCount
  writer.append({ type: 'turn.start', turn, data: { turn } })
  await writer.flush()

  const run = await executeTurn(
    db,
    ports,
    claimed,
    writer,
    { turn, message: input.message, policy },
    opts
  )
  const text = run.result?.text ?? null
  if (run.status === 'interrupted') {
    return {
      outcome: run.reason === 'cancelled' ? 'cancelled' : 'interrupted',
      turn,
      text,
      reason: run.reason,
    }
  }
  if (run.status === 'completed' && !run.result?.isError)
    return { outcome: 'completed', turn, text }
  return { outcome: 'failed', turn, text }
}

/** A {@link ShipTurnRunner} over one database client and the session's ports — the fix turn's. */
export function createShipTurnRunner(
  db: Database,
  ports: SessionPorts,
  opts: RunTurnOptions = {}
): ShipTurnRunner {
  return input => runPromptTurn(db, ports, input, opts)
}

/** How far back `latestCiFailure` looks for the last ship's CI verdict. */
const CI_FAILURE_LOOKBACK = 50

/**
 * Issue #5: the last ship's CI failure, when it is still unresolved — the latest `ship.ci` with
 * `state: 'failure'` and no `ship.pr` after it (a re-ship resolves it). Its log tail was redacted
 * when the event was written (`land.ts`). Null otherwise.
 */
export async function latestCiFailure(
  db: Database,
  row: Pick<SessionRow, 'id' | 'tenantId'>
): Promise<{ name: string; url: string | null; logTail: string | null } | null> {
  const events = await db
    .select({ type: sessionEvents.type, data: sessionEvents.data })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, row.tenantId),
        eq(sessionEvents.sessionId, row.id),
        inArray(sessionEvents.type, ['ship.pr', 'ship.ci'])
      )
    )
    .orderBy(desc(sessionEvents.seq))
    .limit(CI_FAILURE_LOOKBACK)
  for (const event of events) {
    if (event.type === 'ship.pr') return null
    const ci = sessionShipCiDataSchema.safeParse(event.data)
    if (!ci.success || ci.data.state !== 'failure') continue
    const check = ci.data.failedCheck
    return {
      name: check?.name ?? 'a check',
      url: check?.url ?? null,
      logTail: check?.logTail ?? null,
    }
  }
  return null
}

/** The system note's paragraph about an unresolved CI failure (issue #5), so "fix it" works. */
export function ciFailureNote(failure: NonNullable<Awaited<ReturnType<typeof latestCiFailure>>>) {
  const lines = [
    `The last ship's CI failed on GitHub: the check "${failure.name}"${failure.url ? ` (${failure.url})` : ''} is red, so Launch did not merge the pull request.`,
  ]
  if (failure.logTail) lines.push('The end of its log:', '```', failure.logTail, '```')
  lines.push(
    'When the person asks you to fix it, find and fix the cause, run the checks that failed locally, and tell them to ship again.'
  )
  return lines.join('\n')
}

/**
 * `session-system-note` filled in for this session: the agent's appended system prompt — plus,
 * after a red CI reopened the ship (issue #5), the failing check and its redacted log tail.
 */
export async function sessionSystemNote(db: Database, row: SessionRow): Promise<string> {
  const [app] = await db
    .select({ name: apps.displayName, slug: apps.slug })
    .from(apps)
    .where(and(eq(apps.tenantId, row.tenantId), eq(apps.id, row.appId)))
    .limit(1)
  const [creator] = row.createdByUserId
    ? await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, row.createdByUserId))
        .limit(1)
    : []
  const note = await resolvePrompt(db, row.tenantId, 'session-system-note', {
    appName: app?.name,
    appSlug: app?.slug,
    userName: creator?.name ?? 'the person in this session',
    branch: `session/${row.shortId}`,
  })
  const failure = await latestCiFailure(db, row)
  return failure ? `${note}\n\n${ciFailureNote(failure)}` : note
}
