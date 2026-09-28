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
 * // outcome.reason (interrupted): 'rollout' → the session is already `suspended`; run suspend#N's
 * //   bookkeeping, do NOT checkpoint (the container is gone). 'cancelled' | 'timeout' → `ready`.
 * ```
 *
 * `runTurn(db, ports, session, opts?) → Promise<TurnOutcome>`:
 *
 * - `db` — the step's OWN client (`withStepDatabase`); `ports` — `SessionPorts` (only
 *   `ports.sandbox(session.id)` is used); `session` — the row (only `id` and `tenantId` are read
 *   from it: the turn RE-READS the row, because the row is the truth and a wake carries nothing).
 * - `opts` — {@link RunTurnOptions}: `realtime` for the `entity.changed` nudges (a step's
 *   `createStepRealtime()`; settle it after), `logger`, and the clock/timer seams tests use.
 * - It never throws for anything the TURN did (a failed process, a rollout, a cancel, a timeout are
 *   outcomes, each with its own event); it throws only when the database does.
 * - Step config: `retries: 0` — a turn is not idempotent (it would re-run the person's message) —
 *   and a step timeout a little longer than the turn's own, so the turn's timeout fires first and
 *   writes `turn.interrupted { reason: 'timeout' }` rather than the platform killing the step.
 *
 * ## What it does
 *
 * 1. **Claim**: the row must be `ready` (or `blocked`) with a `pending_message`; otherwise `skipped`.
 * 2. **Budget** (`budget.ts`): over → `blocked`, `budget.reached`, audit `session.budget.reached`;
 *    the message STAYS pending, so extending the budget (which un-blocks) runs it. `maxTurns`
 *    reached → `rejected`, an `error` event, and the message is dropped.
 * 3. A compare-and-set to `working` (turn_count + 1, pending_message cleared, cancel cleared), then
 *    `user.message` and `turn.start`.
 * 4. **Run** `claude -p …` (`claude-stream.ts`) with `startProcess`, and read `streamLogs`: each
 *    stream-json line → events, buffered and written every 250 ms or 20 events (`event-log.ts`);
 *    `system.init`'s session id is stored at once (the next turn `--resume`s it).
 * 5. **Watch**, concurrently: every 2 s re-read `cancel_requested_at` (→ `kill`, `cancelled`) and
 *    the clock against `policy.maxTurnMinutes` (→ `kill`, `timeout`); every 30 s write the
 *    heartbeat (`last_activity_at` of a `working` row) that `reconcile.ts` reads to tell a live
 *    turn from one whose Workflow died under it.
 * 6. **End** with exactly one of `turn.end` (the `result` line, with the turn's METERED cost — the
 *    model proxy's `ai_usage` rows, as the row's running total moved), `turn.failed` (the process
 *    exited without a result, or would not start) or `turn.interrupted` (`rollout` — the
 *    container was replaced, `SandboxInterruptedError` — `cancelled` or `timeout`), and the status
 *    back to `ready` (`suspended` after a rollout).
 *
 * ## The ship turn (slice 3d)
 *
 * `createShipTurnRunner(db, ports, opts?)` → `ShipTurnRunner` —
 * `({ message, session }) => Promise<{ outcome: 'completed' | 'failed' | 'interrupted' |
 * 'cancelled'; turn; text }>`, what `ship()` takes. It is `runPromptTurn`: the same steps 4–6 for a
 * Launch-authored prompt while the session is `shipping` — no `pending_message`, no
 * `user.message`, no status change — returning Claude's final answer (`text`, the `result` line).
 *
 * No secret is in any event or in the outcome: the process env is the placeholder
 * (`claudeTurnEnv`), every string is redacted and clipped (`mapClaudeLine`), and the outcome is
 * ids, counts and flags.
 */
import {
  resolveSessionPolicy,
  SESSION_REALTIME_ENTITY,
  type SessionPolicy,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type SessionRow, sessions } from '../../../db/schema'
import type { Logger } from '../../utils/core/logger'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import { nudge, type Realtime, realtimeEvent } from '../realtime'
import { checkBudget } from './budget'
import {
  buildClaudeCommand,
  type ClaudeLineMapping,
  type ClaudeTurnResult,
  claudeTurnEnv,
  clipStrings,
  createClaudeStreamParser,
  SESSION_WORKDIR,
} from './claude-stream'
import { createSessionEventWriter, type SessionEventWriter } from './event-log'
import { redactModelKeyText } from './model-key'
import { SandboxInterruptedError, type SandboxPort, type SessionPorts } from './ports'

/** Write buffered events at least this often while a turn streams (plan §3c). */
export const TURN_FLUSH_MS = 250
/** …or as soon as this many are waiting. */
export const TURN_FLUSH_EVERY = 20
/** How often a running turn re-reads `cancel_requested_at` (and checks its timeout). */
export const TURN_CANCEL_POLL_MS = 2_000
/**
 * How often a running turn writes its heartbeat (`last_activity_at`, while `working`) — the clock
 * `reconcile.ts` reads; the same cadence as a boot step's (`deadline.ts` `heartbeatMs`).
 */
export const TURN_HEARTBEAT_MS = 30_000
/** The step timeout's margin over the turn's own, so the turn's timeout always fires first. */
export const TURN_STEP_TIMEOUT_MARGIN_MINUTES = 2

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
}

export type TurnInterruptReason = 'rollout' | 'cancelled' | 'timeout'

/** What the Workflow learns. Ids, counts and flags only — it is a step result. */
export type TurnOutcome =
  | { status: 'skipped'; sessionId: string }
  | { status: 'blocked'; sessionId: string; scope: 'session' | 'app_month' }
  | { status: 'rejected'; sessionId: string; reason: 'max_turns' }
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
  const policy = resolveSessionPolicy(current.policy)
  const writer = await createSessionEventWriter(db, current)

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

  if (current.turnCount >= policy.maxTurns) {
    const [dropped] = await db
      .update(sessions)
      .set({ pendingMessage: null, updatedAt: new Date(now()) })
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
        isNotNull(sessions.pendingMessage)
      )
    )
    .returning()
  if (!claimed) return { status: 'skipped', sessionId }
  const turn = claimed.turnCount

  writer.append(
    {
      type: 'user.message',
      turn,
      data: { text: redactModelKeyText(message), userId: claimed.createdByUserId },
    },
    { type: 'turn.start', turn, data: { turn } }
  )
  await writer.flush()
  changed()

  // ---- 4–6. run, stream, watch, end -----------------------------------------------------------
  const run = await executeTurn(db, ports, claimed, writer, { turn, message, policy }, opts)
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

  const rollout = run.status === 'interrupted' && run.reason === 'rollout'
  await db
    .update(sessions)
    .set({
      status: rollout ? 'suspended' : 'ready',
      ...(rollout ? { suspendedAt: new Date(now()) } : {}),
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
  const run = await streamTurn(db, ports.sandbox(row.id), row, writer, {
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
    logger: opts.logger,
  })

  // The turn's cost is what the model proxy metered while it ran: the row's running total moved.
  const after = await readRow(db, row)
  const costMicrocents = Math.max(0, Number(after?.costMicrocents ?? costBefore) - costBefore)
  let executed: ExecutedTurn
  if (run.stop) {
    writer.append({ type: 'turn.interrupted', turn, data: { turn, reason: run.stop } })
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
      data: { turn, message: run.failure ?? 'Claude Code stopped without finishing the turn' },
    })
    executed = { status: 'failed', costMicrocents, result: run.result }
  }
  await writer.flush()
  return executed
}

// ---- the ship turn -------------------------------------------------------------------------------

/** What slice 3d's `ship()` hands a message to (its `ShipTurnRunner`). */
export interface ShipTurnInput {
  /** Launch's own prompt (`session-ship`), not a person's message. */
  message: string
  /** The row as the ship claimed it (`shipping`); the runner re-reads it by id. */
  session: SessionRow
}

export interface ShipTurnResult {
  outcome: 'completed' | 'failed' | 'interrupted' | 'cancelled'
  /** The turn number it ran as (0 when it never started). */
  turn: number
  /** Claude's final answer (the `result` line) — where the ship prompt's `{ title, body }` is. */
  text?: string | null
}

export type ShipTurnRunner = (input: ShipTurnInput) => Promise<ShipTurnResult>

/**
 * Run a LAUNCH-authored prompt as a turn — the ship gate's "fix it and print `{ title, body }`" —
 * while the session is `shipping`. Unlike {@link runTurn} it claims no `pending_message`, writes
 * no `user.message` (the prompt is Launch's, not the person's) and leaves the STATUS to its caller
 * (`ship.ts`); it does count as a turn (`turn_count`, `turn.start` … `turn.end`), is metered and
 * cancellable like one, and refuses to start when the session is over budget (`budget.reached`,
 * `failed`). A `result` line that reports an error (`error_max_turns`…) is `failed` here: the
 * gate did not finish.
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
    return { outcome: run.reason === 'cancelled' ? 'cancelled' : 'interrupted', turn, text }
  }
  if (run.status === 'completed' && !run.result?.isError)
    return { outcome: 'completed', turn, text }
  return { outcome: 'failed', turn, text }
}

/** A {@link ShipTurnRunner} over one database client and the session's ports, for `ship()`. */
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
  logger?: Logger
}

interface StreamTurnResult {
  result: ClaudeTurnResult | null
  /** Why the turn stopped before its end, if it did. */
  stop: TurnInterruptReason | null
  /** A human sentence for `turn.failed` — redacted and clipped. */
  failure: string | null
}

/** A sentence for `turn.failed`, safe to store and show. */
const failureText = (text: string) => clipStrings(redactModelKeyText(text), 1_000)

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
  const out: StreamTurnResult = { result: null, stop: null, failure: null }

  let processId: string
  try {
    const proc = await sandbox.startProcess(
      buildClaudeCommand({
        message: p.message,
        model: p.policy.model,
        resumeSessionId: row.claudeSessionId,
      }),
      { cwd: p.cwd, env: claudeTurnEnv(p.policy.model) }
    )
    processId = proc.id
  } catch (err) {
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else {
      p.logger?.warn({ err, sessionId: row.id }, 'session turn: could not start Claude Code')
      out.failure = 'Claude Code could not be started in the sandbox'
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

  const stop = async (reason: 'cancelled' | 'timeout') => {
    if (out.stop || finished) return
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

  let claudeSessionId = row.claudeSessionId
  let exitCode: number | null = null
  let stderrTail = ''
  const apply = async (mappings: ClaudeLineMapping[]) => {
    for (const mapping of mappings) {
      if (mapping.claudeSessionId && mapping.claudeSessionId !== claudeSessionId) {
        claudeSessionId = mapping.claudeSessionId
        // At once, not at the end: a turn that fails later must still be resumable.
        await db
          .update(sessions)
          .set({ claudeSessionId })
          .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
      }
      if (mapping.result) out.result = mapping.result
      if (mapping.events.length > 0) writer.append(...mapping.events)
    }
    if (writer.pending >= p.flushEvery) await writer.flush()
  }

  const parser = createClaudeStreamParser(p.turn)
  try {
    for await (const event of sandbox.streamLogs(processId, { signal: reader.signal })) {
      if (event.type === 'stdout') await apply(parser.push(event.data))
      else if (event.type === 'stderr') stderrTail = (stderrTail + event.data).slice(-2_000)
      else if (event.type === 'exit') exitCode = event.exitCode
    }
    await apply(parser.end())
  } catch (err) {
    if (err instanceof SandboxInterruptedError) out.stop = 'rollout'
    else if (!out.stop) {
      p.logger?.warn({ err, sessionId: row.id }, 'session turn: reading the process failed')
      out.failure = 'Launch lost the connection to Claude Code in the sandbox'
    }
  } finally {
    finished = true
    markDone()
  }
  const [watched, flushed] = await Promise.allSettled([watcher, flusher])
  if (watched.status === 'rejected') {
    p.logger?.warn({ err: watched.reason, sessionId: row.id }, 'session turn: watch failed')
  }
  if (flushed.status === 'rejected') throw flushed.reason

  // A `result` line is the end of the turn whatever the exit code; no `result` is a failure.
  if (!out.stop && !out.failure && !out.result) {
    const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : ''
    const code = exitCode === null ? '' : ` with code ${exitCode}`
    out.failure = failureText(`Claude Code exited${code} before finishing the turn${detail}`)
  }
  return out
}
