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
 * 4. **Run** `claude -p …` (`claude-stream.ts`) with `startProcess`, and read `streamLogs`: each
 *    stream-json line → events, buffered and written every 250 ms or 20 events (`event-log.ts`);
 *    `system.init`'s session id is stored at once (the next turn `--resume`s it). **A resume that
 *    cannot work never breaks the session**: when the container answers that the transcript is
 *    missing (`test -s`), or Claude Code ends a `--resume` at once with `error_during_execution`,
 *    no tokens and nothing said, `claude_session_id` is cleared, an `error` event says so
 *    ({@link CONVERSATION_LOST_MESSAGE}) and the turn runs (again, once) as a new conversation.
 * 5. **Watch**, concurrently: every 2 s re-read `cancel_requested_at` (→ `kill`, `cancelled`) and
 *    the clock against `policy.maxTurnMinutes` (→ `kill`, `timeout`); every 10 s write the
 *    heartbeat (`last_activity_at` of a `working` row) that `reconcile.ts` reads to tell a live
 *    turn from one whose Workflow died under it. And every {@link TURN_LIVENESS_PROBE_MS} (with a
 *    `bootId`) read the boot marker: a container that died does not end its log stream — it just
 *    goes quiet — so without this a dead container holds the turn until its timeout. A marker that
 *    is gone (the read booted a fresh, empty container) ends the turn at once; a read that does
 *    not answer within {@link TURN_LIVENESS_CALL_MS} {@link TURN_LIVENESS_MAX_FAILURES} times in a
 *    row does too — `interrupted { container_lost }`. A lost or ended stream is checked once more.
 * 6. **End** with exactly one of `turn.end` (the `result` line, with the turn's METERED cost — the
 *    model proxy's `ai_usage` rows, as the row's running total moved), `turn.failed` (the process
 *    exited without a result, or would not start) or `turn.interrupted` (`rollout` — the
 *    container was replaced, `SandboxInterruptedError` — `container_lost` — it died and came back
 *    empty, {@link CONTAINER_LOST_MESSAGE} — `cancelled` or `timeout`), and the status back to
 *    `ready` (`suspended` after a rollout or a lost container).
 * 7. **Never leave it running**: whenever Launch stops reading a process that has not exited — the
 *    log stream failed or closed early, or a cancel/timeout aborted the reader — it SIGTERMs the
 *    turn's pid (`TURN_PID_FILE`) and its children, and SIGKILLs them after
 *    `TURN_KILL_GRACE_SECONDS` (`terminateTurnProcess`: bounded, logged, never throws). Not after a
 *    rollout or a lost container: that container is gone.
 *
 * ## The ship's fix turn (issue #1)
 *
 * `createShipTurnRunner(db, ports, opts?)` → `ShipTurnRunner` —
 * `({ message, session }) => Promise<{ outcome: 'completed' | 'failed' | 'interrupted' |
 * 'cancelled'; turn; text; reason? }>`, what the ship's `ship.fix#N.A` step runs (through the
 * `shipFix` hook). It is `runPromptTurn`: the same steps 4–6 for a Launch-authored prompt while
 * the session is `shipping` — no `pending_message`, no `user.message`, no status change —
 * returning Claude's final answer (`text`, the `result` line). Launch runs the gate itself; this
 * turn only fixes what a step reported.
 *
 * No secret is in any event or in the outcome: the process env is the placeholder
 * (`claudeTurnEnv`), every string is redacted and clipped (`mapClaudeLine`), and the outcome is
 * ids, counts and flags.
 */
import {
  resolveSessionPolicy,
  SESSION_REALTIME_ENTITY,
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
import {
  CONTAINER_LOST_BEFORE_TURN_MESSAGE,
  CONTAINER_LOST_MESSAGE,
  checkContainer,
} from './boot-marker'
import { type BudgetHeadroom, budgetHeadroom, checkBudget } from './budget'
import { type ClaudeTurnResult, clipStrings, SESSION_WORKDIR } from './claude-stream'
import {
  CredentialBusyError,
  CredentialNeedsLoginError,
  CredentialPortMissingError,
} from './credentials/errors'
import { createSessionEventWriter, type SessionEventWriter } from './event-log'
import { ModelKeyMissingError, redactModelKeyText } from './model-key'
import {
  credentialsFor,
  egressFor,
  NotWiredError,
  SandboxInterruptedError,
  type SandboxPort,
  type SessionEgressPort,
  type SessionPorts,
} from './ports'
import { claudeTranscriptPath, SESSION_LAUNCH_DIR } from './rocketflare-dev'
import { runtimeOf } from './runtimes'
import type {
  AgentRuntime,
  RuntimeLineMapping,
  RuntimeStreamParser,
  SessionCredentialPort,
  TurnCredentialLease,
} from './runtimes/types'
import { createTurnMeter, recordTurnUsage, type TurnMeter } from './turn-meter'

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

/**
 * The turn's `claude` pid: the command writes `$$` and `exec`s into Claude Code, so it IS that pid
 * (the dev server's `DEV_PID_FILE` pattern). What {@link terminateTurnProcess} signals directly.
 */
export const TURN_PID_FILE = `${SESSION_LAUNCH_DIR}/turn.pid`
/** Between SIGTERM and SIGKILL, when Launch stops a turn's process it no longer reads. */
export const TURN_KILL_GRACE_SECONDS = 5
/** The bound on each call {@link terminateTurnProcess} makes: it never holds the turn up longer. */
export const TURN_KILL_CALL_MS = 30_000

/**
 * What the person reads when the conversation a turn would `--resume` is gone (its transcript was
 * never checkpointed, or did not come back with a resume): Claude starts a new one.
 */
export const CONVERSATION_LOST_MESSAGE =
  'The earlier conversation could not be restored; Claude starts fresh with the code as it is.'

/** What a message from anyone but a personal-account session's owner meets (§18.22). */
export const CREDENTIAL_OWNER_ONLY_MESSAGE =
  'Only the person whose account this session uses can send it messages.'

/** `test -s` on the transcript `--resume` needs: exit 1 = missing or empty. */
export const transcriptCheckCommand = (claudeSessionId: string) =>
  `test -s ${claudeTranscriptPath(claudeSessionId)}`

/** The process a turn starts: its pid recorded, then `exec` into Claude Code. */
export function turnProcessCommand(claudeCommand: string): string {
  return `mkdir -p ${SESSION_LAUNCH_DIR} && echo $$ > ${TURN_PID_FILE} && exec ${claudeCommand}`
}

/**
 * SIGTERM the recorded pid (and its children), wait up to `graceSeconds`, then SIGKILL whatever is
 * left. Signals by pid rather than through the SDK because the SDK's `killProcess` drops its
 * signal argument (0.12.10 sends a bare `DELETE /api/process/:id`), so it can neither escalate nor
 * be told apart from a polite stop.
 */
export function turnKillScript(
  graceSeconds = TURN_KILL_GRACE_SECONDS,
  pidFile = TURN_PID_FILE
): string {
  const ticks = Math.max(1, graceSeconds * 2)
  return [
    `pid=$(cat ${pidFile} 2>/dev/null)`,
    '[ -n "$pid" ] || exit 0',
    'kill -0 "$pid" 2>/dev/null || exit 0',
    'pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null',
    `for i in $(seq 1 ${ticks}); do kill -0 "$pid" 2>/dev/null || exit 0; sleep 0.5; done`,
    'pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null',
    'echo killed',
  ].join('; ')
}

/** `work`, or a rejection after `ms` (the work itself cannot be cancelled — it is an RPC). */
async function bounded<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = work()
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
    promise.catch(() => {})
  }
}

/**
 * Stop a turn's Claude Code process that Launch has stopped READING — a lost log stream, or a
 * cancel/timeout whose reader was aborted — so it cannot run on for minutes spending tokens and
 * editing the workspace. Best effort, bounded, logged; never throws. `signalled`: the SDK kill was
 * already sent (a cancel), so only the pid escalation runs.
 */
export async function terminateTurnProcess(
  sandbox: SandboxPort,
  processId: string,
  opts: {
    logger?: Logger
    sessionId: string
    reason: string
    signalled?: boolean
    callMs?: number
  }
): Promise<void> {
  const callMs = opts.callMs ?? TURN_KILL_CALL_MS
  const log = { sessionId: opts.sessionId, processId, reason: opts.reason }
  if (!opts.signalled) {
    try {
      await bounded(callMs, () => sandbox.kill(processId, 'SIGTERM'))
    } catch (err) {
      if (err instanceof SandboxInterruptedError) return
      opts.logger?.warn({ err, ...log }, 'session turn: kill failed')
    }
  }
  try {
    const result = await bounded(callMs, () =>
      sandbox.exec(turnKillScript(), { timeoutMs: (TURN_KILL_GRACE_SECONDS + 15) * 1000 })
    )
    if (result.stdout.includes('killed')) {
      opts.logger?.warn(log, 'session turn: Claude Code ignored SIGTERM and was SIGKILLed')
    } else {
      opts.logger?.info(log, 'session turn: stopped the Claude Code process')
    }
  } catch (err) {
    if (err instanceof SandboxInterruptedError) return
    opts.logger?.warn({ err, ...log }, 'session turn: could not stop the Claude Code process')
  }
}

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
  /** The checkout the turn runs in (default `SESSION_WORKDIR`). */
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
}

/**
 * `rollout` — the platform replaced the container under a call (`SandboxInterruptedError`);
 * `container_lost` — it died and came back empty (its boot marker is gone, or it stopped
 * answering); `cancelled` — a Stop; `timeout` — `maxTurnMinutes`.
 */
export type TurnInterruptReason = 'rollout' | 'container_lost' | 'cancelled' | 'timeout'

/** The container a turn ran in is gone: the session is `suspended` and nothing is left to save. */
export function containerGone(outcome: { status: string; reason?: string }): boolean {
  return (
    outcome.status === 'interrupted' &&
    (outcome.reason === 'rollout' || outcome.reason === 'container_lost')
  )
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
    }
  | {
      status: 'interrupted'
      sessionId: string
      turn: number
      reason: TurnInterruptReason
      costMicrocents: number
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
  if (!current || !current.pendingMessage || !['ready', 'blocked'].includes(current.status)) {
    return { status: 'skipped', sessionId }
  }
  const message = current.pendingMessage
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
      .set({ pendingMessage: null, pendingModel: null, updatedAt: new Date(now()) })
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
      policy: sql`case when ${sessions.pendingModel} is null then ${sessions.policy}
        else jsonb_set(${sessions.policy}, '{model}', to_jsonb(${sessions.pendingModel})) end`,
      pendingModel: null,
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
  const prompt = (await previousTurnStopped(db, claimed))
    ? `${await resolvePrompt(db, claimed.tenantId, 'session-interrupted', {})}\n\n${message}`
    : message

  writer.append(
    {
      type: 'user.message',
      turn,
      data: { text: redactModelKeyText(message), userId: senderId },
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
    { turn, message: prompt, policy: turnPolicy },
    opts
  )
  const outcome: TurnOutcome =
    run.status === 'interrupted'
      ? {
          status: 'interrupted',
          sessionId,
          turn,
          reason: run.reason,
          costMicrocents: run.costMicrocents,
        }
      : { status: run.status, sessionId, turn, costMicrocents: run.costMicrocents }

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
      result: ClaudeTurnResult | null
    }
  | {
      status: 'interrupted'
      reason: TurnInterruptReason
      costMicrocents: number
      result: ClaudeTurnResult | null
    }

/**
 * Steps 4–6 without the status: run `message` as turn `turn` of `row` (already claimed — its
 * `turn_count` is `turn`), stream its events, and write the ONE closing event (`turn.end`,
 * `turn.failed` or `turn.interrupted`). Shared by the chat turn and the ship turn, which own their
 * statuses differently.
 */
async function executeTurn(
  db: Database,
  ports: SessionPorts,
  row: SessionRow,
  writer: SessionEventWriter,
  input: { turn: number; message: string; policy: SessionPolicy },
  opts: RunTurnOptions
): Promise<ExecutedTurn> {
  const { turn, policy } = input
  const costBefore = Number(row.costMicrocents)
  const sandbox = ports.sandbox(row.id)
  const params: StreamTurnParams = {
    turn,
    message: input.message,
    policy,
    now: opts.now ?? (() => Date.now()),
    sleep: opts.sleep ?? realSleep,
    cwd: opts.cwd ?? SESSION_WORKDIR,
    timeoutMs: opts.timeoutMs ?? policy.maxTurnMinutes * 60_000,
    flushMs: opts.flushMs ?? TURN_FLUSH_MS,
    flushEvery: opts.flushEvery ?? TURN_FLUSH_EVERY,
    cancelPollMs: opts.cancelPollMs ?? TURN_CANCEL_POLL_MS,
    heartbeatMs: opts.heartbeatMs ?? TURN_HEARTBEAT_MS,
    bootId: opts.bootId ?? null,
    probeMs: opts.probeMs ?? TURN_LIVENESS_PROBE_MS,
    probeCallMs: opts.probeCallMs ?? TURN_LIVENESS_CALL_MS,
    probeFailures: opts.probeFailures ?? TURN_LIVENESS_MAX_FAILURES,
    logger: opts.logger,
    egress: egressFor(ports, db),
    credentials: credentialsFor(ports, db),
  }

  // A conversation to resume whose transcript is not in the container (a resume that had nothing
  // to restore, a turn that died before any checkpoint): `claude --resume` would fail every turn
  // from now on, so start a fresh conversation instead — the code is all in the checkout.
  const runtime = runtimeOf(row)
  let resumeId = row.claudeSessionId
  if (resumeId && (await transcriptMissing(sandbox, runtime, row, opts.logger))) {
    await forgetConversation(db, row, writer, turn)
    resumeId = null
  }
  let run = await streamTurn(db, sandbox, { ...row, claudeSessionId: resumeId }, writer, params)
  if (resumeId && runtime.resumeRefused(run)) {
    // The transcript was there but Claude Code would not resume it (an `error_during_execution`
    // with no tokens and nothing said): the same turn once more, as a new conversation.
    opts.logger?.warn(
      { sessionId: row.id, turn },
      'session turn: --resume ended at once with nothing done; retrying without it'
    )
    await forgetConversation(db, row, writer, turn)
    run = await streamTurn(db, sandbox, { ...row, claudeSessionId: null }, writer, params)
  }

  // The turn's cost is what was metered while it ran — by the model proxy, or (`host`, and a
  // ChatGPT plan's Codex turn) by the turn itself as it ended: either way the row's total moved.
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

/**
 * True only when the container ANSWERED that the transcript `--resume` needs is missing or empty;
 * a check that failed (the container busy, a rollout on its way) is not evidence, and the turn
 * resumes as asked — {@link resumeRefused} still catches a resume that cannot work.
 */
async function transcriptMissing(
  sandbox: SandboxPort,
  runtime: AgentRuntime,
  row: SessionRow,
  logger?: Logger
): Promise<boolean> {
  const path = runtime.state.restorePath(row)
  if (!path) return true
  try {
    const result = await bounded(TURN_KILL_CALL_MS, () =>
      sandbox.exec(runtime.state.checkCommand(path), { timeoutMs: 15_000 })
    )
    return result.exitCode === 1
  } catch (err) {
    logger?.warn({ err }, 'session turn: could not check the transcript; resuming as asked')
    return false
  }
}

/** Clear `claude_session_id` (the next `claude -p` starts a conversation) and say so. */
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
  /** Claude's final answer (the `result` line). */
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

interface StreamTurnParams {
  turn: number
  message: string
  policy: SessionPolicy
  now: () => number
  sleep: (ms: number) => Promise<void>
  cwd: string
  timeoutMs: number
  flushMs: number
  flushEvery: number
  cancelPollMs: number
  heartbeatMs: number
  /** The boot's id — the marker the liveness probe expects; null = no probe. */
  bootId: string | null
  probeMs: number
  probeCallMs: number
  probeFailures: number
  logger?: Logger
  /** How the container reaches Anthropic and GitHub (`proxied` unless the sandbox is remote). */
  egress: SessionEgressPort
  /** §18.22: the turn's credential lease (platform: nothing). */
  credentials: SessionCredentialPort
}

interface StreamTurnResult {
  result: ClaudeTurnResult | null
  /** Why the turn stopped before its end, if it did. */
  stop: TurnInterruptReason | null
  /** A human sentence for `turn.failed` — redacted and clipped. */
  failure: string | null
  /** Claude Code said or did something (a text, a tool call) — {@link resumeRefused} reads it. */
  output: boolean
}

/** A sentence for `turn.failed`, safe to store and show. */
const failureText = (text: string) => clipStrings(redactModelKeyText(text), 1_000)

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
 * `session-system-note` filled in for this session: Claude Code's appended system prompt — plus,
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

/**
 * Start the process, read it to its end, and write what it says; meanwhile watch for a cancel and
 * the timeout. Resolves when the process has ended (or was killed, or the container went away).
 */
async function streamTurn(
  db: Database,
  sandbox: SandboxPort,
  row: SessionRow,
  writer: SessionEventWriter,
  p: StreamTurnParams
): Promise<StreamTurnResult> {
  const out: StreamTurnResult = { result: null, stop: null, failure: null, output: false }
  const runtime = runtimeOf(row)

  // `host` (a remote sandbox): the host is granted the turn's model credential and a fresh token
  // (the process keeps the runtime's placeholders), and the turn meters itself against what the
  // budget has left (`turn-meter.ts`) — a personal account has no money budget, so it is only
  // recorded. `proxied`: none of it, except that a Codex turn on a ChatGPT plan meters itself too
  // ({@link selfMetered}).
  try {
    return await streamGrantedTurn(db, sandbox, row, writer, p, out, runtime)
  } finally {
    await p.egress
      .endTurn?.(sandbox, row)
      .catch(err =>
        p.logger?.warn({ err, sessionId: row.id }, 'session turn: could not revoke the turn grant')
      )
  }
}

/**
 * Does the turn meter ITSELF from the CLI's own output (`turn-meter.ts`)? Under `host`, always —
 * the host's handlers cannot reach the database. Under `proxied`, a Codex turn on a person's
 * ChatGPT plan: its model calls go to `chatgpt.com` directly (ChatGPT blocks the Workers runtime,
 * `egress/registry.ts`), so no proxy sees them. Every other proxied turn is metered per request by
 * its proxy, and metering it here as well would count it twice.
 */
export function selfMetered(
  mode: SessionEgressPort['mode'],
  row: Pick<SessionRow, 'runtime' | 'credentialSource'>
): boolean {
  if (mode === 'host') return true
  return row.runtime === 'codex' && row.credentialSource === 'user'
}

/** The turn once the egress may be granted: grant, lease, run. */
async function streamGrantedTurn(
  db: Database,
  sandbox: SandboxPort,
  row: SessionRow,
  writer: SessionEventWriter,
  p: StreamTurnParams,
  out: StreamTurnResult,
  runtime: AgentRuntime
): Promise<StreamTurnResult> {
  let egressEnv: Record<string, string>
  let meter: TurnMeter | null = null
  let headroom: BudgetHeadroom = {
    microcents: Number.POSITIVE_INFINITY,
    scope: 'session',
    spentMicrocents: 0,
    capMicrocents: 0,
  }
  try {
    await p.egress.prepareGit(sandbox, row)
    egressEnv = await p.egress.turnEnv(sandbox, row)
    if (selfMetered(p.egress.mode, row)) {
      const subscription = row.credentialSource === 'user'
      meter = createTurnMeter(p.policy.model, {
        provider: runtime.provider,
        billing: subscription ? 'subscription' : 'metered',
      })
      if (!subscription) headroom = await budgetHeadroom(db, row, new Date(p.now()))
    }
  } catch (err) {
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else if (err instanceof ModelKeyMissingError || err instanceof CredentialNeedsLoginError) {
      out.failure = err.message
    } else {
      p.logger?.warn({ err, sessionId: row.id }, 'session turn: could not prepare the sandbox')
      out.failure = 'Launch could not give the sandbox its credentials for this turn'
    }
    return out
  }

  // §18.22: the turn's credential. Platform: nothing (the egress swaps Launch's key in). A personal
  // account: the runtime's lease, released in the `finally` below whatever happens.
  let lease: TurnCredentialLease
  try {
    lease = await p.credentials.lease(row, sandbox, runtime)
  } catch (err) {
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else out.failure = leaseFailure(err, runtime, row.id, p.logger)
    return out
  }
  try {
    return await runLeasedTurn(db, sandbox, row, writer, p, {
      out,
      runtime,
      lease,
      egressEnv,
      meter,
      headroom,
    })
  } finally {
    await lease
      .release()
      .catch(err =>
        p.logger?.warn({ err, sessionId: row.id }, 'session turn: could not release the credential')
      )
  }
}

/** A lease that would not come: a sentence safe for `turn.failed`, never the credential. */
function leaseFailure(err: unknown, runtime: AgentRuntime, sessionId: string, logger?: Logger) {
  if (
    err instanceof CredentialNeedsLoginError ||
    err instanceof CredentialBusyError ||
    err instanceof CredentialPortMissingError ||
    err instanceof NotWiredError
  ) {
    return err.message
  }
  logger?.warn({ err, sessionId }, 'session turn: could not lease the credential')
  return `Launch could not get ${runtime.label} its credential for this turn`
}

/** What `streamTurn` hands the leased half of the turn. */
interface LeasedTurn {
  out: StreamTurnResult
  runtime: AgentRuntime
  lease: TurnCredentialLease
  egressEnv: Record<string, string>
  meter: TurnMeter | null
  headroom: BudgetHeadroom
}

/** The turn once its credential is leased: start, read, watch, end. */
async function runLeasedTurn(
  db: Database,
  sandbox: SandboxPort,
  row: SessionRow,
  writer: SessionEventWriter,
  p: StreamTurnParams,
  leased: LeasedTurn
): Promise<StreamTurnResult> {
  const { out, runtime, lease, egressEnv, meter, headroom } = leased
  let parser: RuntimeStreamParser
  let processId: string
  try {
    parser = runtime.createParser(p.turn, { runtimeState: row.runtimeState ?? null })
    const systemNote = await sessionSystemNote(db, row)
    const files = [
      ...(runtime.beforeTurnFiles?.({
        model: p.policy.model,
        systemNote,
        source: lease.source,
      }) ?? []),
      ...lease.files,
    ]
    for (const file of files) await sandbox.writeFile(file.path, file.content)
    const proc = await sandbox.startProcess(
      turnProcessCommand(
        runtime.buildCommand({
          message: p.message,
          model: p.policy.model,
          resumeId: row.claudeSessionId,
          systemNote,
        })
      ),
      {
        cwd: p.cwd,
        env: {
          ...runtime.turnEnv({ model: p.policy.model, source: lease.source }),
          ...lease.env,
          ...egressEnv,
        },
      }
    )
    processId = proc.id
  } catch (err) {
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else if (err instanceof NotWiredError) out.failure = err.message
    else {
      p.logger?.warn({ err, sessionId: row.id }, `session turn: could not start ${runtime.label}`)
      out.failure = `${runtime.label} could not be started in the sandbox`
    }
    return out
  }

  // Everything below waits on `done` as well as its timer, so the turn ends when the process does.
  let finished = false
  let markDone: () => void = () => {}
  const done = new Promise<void>(resolve => {
    markDone = resolve
  })
  const pause = (ms: number) => Promise.race([p.sleep(ms), done])
  const reader = new AbortController()
  const startedAt = p.now()

  let overBudget = false
  const stop = async (reason: 'cancelled' | 'timeout') => {
    if (out.stop || overBudget || finished) return
    out.stop = reason
    try {
      await sandbox.kill(processId, 'SIGTERM')
    } catch (err) {
      p.logger?.warn({ err, sessionId: row.id }, 'session turn: kill failed')
    }
    // Stop READING too: a killed process's last lines are not worth waiting for.
    reader.abort()
  }

  let lastBeat = startedAt
  const watcher = (async () => {
    while (!finished) {
      await pause(p.cancelPollMs)
      if (finished) return
      if (p.now() - startedAt >= p.timeoutMs) return stop('timeout')
      if (p.now() - lastBeat >= p.heartbeatMs) {
        lastBeat = p.now()
        // "This turn is alive" — only while `working` (a ship turn's `shipping` is not reconciled).
        // A failed beat is not a failed turn: the next one tries again.
        await db
          .update(sessions)
          .set({ lastActivityAt: new Date(lastBeat) })
          .where(
            and(
              eq(sessions.tenantId, row.tenantId),
              eq(sessions.id, row.id),
              eq(sessions.status, 'working')
            )
          )
          .catch(err =>
            p.logger?.warn({ err, sessionId: row.id }, 'session turn: heartbeat failed')
          )
      }
      const [flags] = await db
        .select({ cancelRequestedAt: sessions.cancelRequestedAt })
        .from(sessions)
        .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
        .limit(1)
      if (flags?.cancelRequestedAt) return stop('cancelled')
    }
  })()

  const flusher = (async () => {
    while (!finished) {
      await pause(p.flushMs)
      if (writer.pending > 0) await writer.flush()
    }
  })()

  /** The container is gone (`boot-marker.ts`): stop reading — there is nothing left to kill. */
  const lose = (verdict: 'replaced' | 'interrupted' | 'silent') => {
    if (out.stop || overBudget || finished) return
    p.logger?.warn({ sessionId: row.id, verdict }, 'session turn: the container is gone')
    out.stop = verdict === 'interrupted' ? 'rollout' : 'container_lost'
    reader.abort()
  }

  // Liveness: a dead container's log stream does not end, it goes quiet. Its own loop, so a slow
  // probe never delays the cancel poll or the heartbeat.
  const bootId = p.bootId
  const prober = (async () => {
    if (!bootId) return
    let silent = 0
    while (!finished) {
      await pause(p.probeMs)
      if (finished) return
      const verdict = await checkContainer(sandbox, bootId, p.probeCallMs)
      if (finished) return
      if (verdict === 'ours') silent = 0
      else if (verdict === 'unknown') {
        silent += 1
        p.logger?.warn(
          { sessionId: row.id, silent },
          'session turn: the container did not answer the liveness probe'
        )
        if (silent >= p.probeFailures) return lose('silent')
      } else return lose(verdict)
    }
  })()

  /**
   * `host` only: the turn's running cost reached the headroom — stop reading and say why; the
   * process itself is stopped below by `terminateTurnProcess` (SIGTERM, then SIGKILL by pid).
   */
  const stopForBudget = async () => {
    if (out.stop || overBudget || finished || !meter) return
    overBudget = true
    writer.append({
      type: 'budget.reached',
      turn: p.turn,
      data: {
        spentMicrocents: headroom.spentMicrocents + meter.runningCostMicrocents(),
        capMicrocents: headroom.capMicrocents,
        scope: headroom.scope,
      },
    })
    out.failure =
      headroom.scope === 'session'
        ? 'This turn was stopped: the session reached its budget. Ask an app owner to extend it.'
        : "This turn was stopped: this app's coding sessions reached their monthly budget."
    reader.abort()
  }

  let claudeSessionId = row.claudeSessionId
  let exitCode: number | null = null
  let stderrTail = ''
  const apply = async (mappings: RuntimeLineMapping[]) => {
    for (const mapping of mappings) {
      if (mapping.resumeId && mapping.resumeId !== claudeSessionId) {
        claudeSessionId = mapping.resumeId
        // At once, not at the end: a turn that fails later must still be resumable.
        await db
          .update(sessions)
          .set({ claudeSessionId })
          .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
      }
      if (mapping.runtimeState) {
        // §18.22: what the runtime keeps between turns (Codex: its running usage total).
        await db
          .update(sessions)
          .set({ runtimeState: mapping.runtimeState })
          .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
      }
      if (mapping.result) out.result = mapping.result
      if (mapping.events.length > 0) {
        out.output = true
        writer.append(...mapping.events)
      }
      if (meter) {
        meter.observe(mapping)
        if (meter.runningCostMicrocents() >= headroom.microcents) await stopForBudget()
      }
    }
    if (writer.pending >= p.flushEvery) await writer.flush()
  }

  let readFailed = false
  let exited = false
  try {
    for await (const event of sandbox.streamLogs(processId, { signal: reader.signal })) {
      if (event.type === 'stdout') await apply(parser.push(event.data))
      else if (event.type === 'stderr') stderrTail = (stderrTail + event.data).slice(-2_000)
      else if (event.type === 'exit') {
        exited = true
        exitCode = event.exitCode
      }
    }
    await apply(parser.end())
  } catch (err) {
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else if (!out.stop && !overBudget) {
      readFailed = true
      p.logger?.warn({ err, sessionId: row.id }, 'session turn: reading the process failed')
      out.failure = `Launch lost the connection to ${runtime.label} in the sandbox`
    }
  } finally {
    finished = true
    markDone()
  }
  const [watched, flushed, probed] = await Promise.allSettled([watcher, flusher, prober])
  if (watched.status === 'rejected') {
    p.logger?.warn({ err: watched.reason, sessionId: row.id }, 'session turn: watch failed')
  }
  if (probed.status === 'rejected') {
    p.logger?.warn({ err: probed.reason, sessionId: row.id }, 'session turn: probe failed')
  }

  // A stream that failed, or ended with no exit and no result: was it the container that went?
  // Then say so (and suspend) rather than "lost the connection" on a session with nothing in it.
  if (bootId && !out.stop && !overBudget && !exited && (readFailed || !out.result)) {
    const verdict = await checkContainer(sandbox, bootId, p.probeCallMs)
    if (verdict === 'replaced' || verdict === 'interrupted') {
      out.stop = verdict === 'interrupted' ? 'rollout' : 'container_lost'
      out.failure = null
      readFailed = false
    }
  }

  // Launch has stopped reading a process that may still be running: stop it too, or it spends
  // tokens and edits the workspace unseen. Not after a rollout or a lost container (it is gone)
  // and not after an `exit` (it is over); a cancel/timeout already sent the SDK kill, so only
  // escalate. A `host` turn that reached its budget stops here too (the SDK kill, then the pid).
  const cutOff = out.stop === 'cancelled' || out.stop === 'timeout'
  const gone = out.stop === 'rollout' || out.stop === 'container_lost'
  if (!gone && !exited && (readFailed || cutOff || overBudget || !out.result)) {
    await terminateTurnProcess(sandbox, processId, {
      logger: p.logger,
      sessionId: row.id,
      reason: readFailed
        ? 'read-failed'
        : cutOff
          ? (out.stop as string)
          : overBudget
            ? 'budget'
            : 'stream-ended',
      signalled: cutOff,
    })
  }
  if (flushed.status === 'rejected') throw flushed.reason

  if (meter) {
    // Before `executeTurn` reads the row's total back: the turn's cost IS this write.
    await recordTurnUsage(db, row, meter).catch(err =>
      p.logger?.error({ err, sessionId: row.id }, 'session turn: could not record usage')
    )
  }

  // A `result` line is the end of the turn whatever the exit code; no `result` is a failure.
  if (!out.stop && !out.failure && !out.result) {
    const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : ''
    const code = exitCode === null ? '' : ` with code ${exitCode}`
    out.failure = failureText(`${runtime.label} exited${code} before finishing the turn${detail}`)
  }
  return out
}
