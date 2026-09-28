/**
 * Reconciling a coding session whose Workflow died under it (Launch P3) — the sessions' version of
 * the pipeline's `pipeline/reconcile.ts`. A `SessionWorkflow` instance can stop without its step
 * recording anything: a `wrangler dev` reload kills the running step and the local engine keeps
 * reporting the instance `running` while nothing runs (measured: until something pokes the engine
 * again, minutes later), the platform can lose an instance, a step can wedge on an RPC. The row
 * then says `booting` (or `working`) for ever and the page spins. On read (`GET /api/sessions/:id`), on an end
 * request (`POST /:id/end`) and from the five-minute cron (`sessions.expire`), this asks:
 *
 * 1. **Only a quiet session.** `requested` / `booting` / `working` / `ending` with no heartbeat
 *    for {@link SESSION_STALL_MS} (a boot step writes `last_activity_at` every 30 s while it runs —
 *    `withProgress` in `steps.ts` — and so does a running turn, `turn.ts`; `ending` gets
 *    {@link SESSION_ENDING_STALL_MS}, because cleanup retries patiently). Anything fresher costs
 *    nothing.
 * 2. **Throttled in the database**: `last_activity_at` is moved to now in a compare-and-set, and
 *    only the request whose update landed goes on — so a session is reconciled at most once per
 *    window however many tabs poll it.
 * 3. **Ask the instance** (`instance_id`): not found, `errored`, `terminated`, `complete` → dead. A
 *    live status with a stale heartbeat is ALSO dead for `booting`, `working` and `ending` — no live
 *    boot step or turn is that quiet — and the instance is terminated (best effort). A `requested`
 *    session whose instance is live is only queued: left alone.
 * 4. **Dead** → an end the person asked for (`requested_action = 'end'`, or `ending`) becomes
 *    `ending`. A dead TURN (`working`) is not a dead session: the turn ends `turn.failed` with a
 *    sentence ("This turn stopped (its Workflow ended errored). Launch is restarting the session
 *    from its last checkpoint; send your message again.") and the row goes back to `ready`. Anything
 *    else becomes `failed`, with the step that was running named ("The session stopped while
 *    Starting dev server was running (its Workflow was running, but its step had not moved for 3
 *    minutes). Start a new session."), the checklist's line marked failed, and an `error` event.
 *    Then a FRESH instance (`restartSessionInstance`) runs the one thing still owed — `claim` sends
 *    an `ending` or unsettled session straight to `cleanup` (destroy the container, delete the
 *    branch, give back a prepare claim), and a `ready` one through its lost-instance path: destroy
 *    the container, `suspended` with a `resume`, boot again from the branch — so no route ever runs
 *    the vendor work itself.
 *
 * **Why a dead turn's container is not kept**, even when it is still up: the turn's Claude Code
 * process may still be running in it (the step that would have killed it on a cancel or a timeout
 * is gone), spending and editing with nobody reading its output, and a new instance cannot adopt a
 * process it did not start. Destroying it is what `claim` already does for a lost instance under
 * a live session; what is lost is the dead turn's unsaved edits, since the branch holds the state
 * of the last checkpoint (the end of the previous turn).
 *
 * **Leftovers**: a `failed` / `ended` / `shipped` session with no `ended_at` (settled, but its
 * cleanup never ran — or settled by hand) older than {@link SESSION_CLEANUP_GRACE_MS} gets the same
 * fresh instance, once per window, so its container and its Neon branch are not kept for ever.
 *
 * {@link reconcileSessionSafely} is what the callers use: it never throws.
 */

import { agentStepEventDataSchema } from '@launch/shared/ai/agents'
import { type SessionStatus, TERMINAL_SESSION_STATUSES } from '@launch/shared/launch-sessions'
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type SessionRow, sessionEvents, sessions } from '../../../db/schema'
import type { AppBindings } from '../../types'
import { isMissingInstanceError } from '../agents/runs'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import type { Realtime } from '../realtime'
import { createSessionEmitter, nudgeSession } from './events'
import { restartSessionInstance } from './lifecycle'

/** How long a booting session may go without a heartbeat before its instance is asked. */
export const SESSION_STALL_MS = 3 * 60_000
/** The same for `ending`: cleanup retries for minutes on its own. */
export const SESSION_ENDING_STALL_MS = 15 * 60_000
/** A settled session's cleanup gets this long to run before a leftover is suspected. */
export const SESSION_CLEANUP_GRACE_MS = 2 * 60_000
/** On an end request the window is shorter: two missed heartbeats say the boot step is gone. */
export const SESSION_END_STALL_MS = 75_000

const LIVE_STATUSES = new Set(['queued', 'running', 'waiting', 'waitingForPause', 'paused'])
const QUIET_STATUSES: readonly SessionStatus[] = ['requested', 'booting', 'working', 'ending']

export interface ReconcileLogger {
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

/** The slice of the Workflow binding this needs — `RecordingWorkflow` satisfies it. */
export type SessionWorkflowBinding = Workflow

export type SessionReconcileResult =
  | { outcome: 'skipped' }
  | { outcome: 'alive'; instanceStatus: string }
  | {
      outcome: 'settled'
      status: SessionStatus
      instanceStatus: string
      restartedAs: string | null
    }

const SKIPPED: SessionReconcileResult = { outcome: 'skipped' }

export interface ReconcileSessionOptions {
  now?: Date
  logger?: ReconcileLogger
  realtime?: Realtime
  /** The quiet window for `booting` (the end route passes {@link SESSION_END_STALL_MS}). */
  stallMs?: number
}

const isTerminal = (status: string) =>
  (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status)

/** Take the session's reconcile turn: true for the one caller whose compare-and-set landed. */
async function claimTurn(
  db: Database,
  session: SessionRow,
  cutoff: Date,
  now: Date
): Promise<boolean> {
  const claimed = await db
    .update(sessions)
    .set({ lastActivityAt: now })
    .where(
      and(
        eq(sessions.tenantId, session.tenantId),
        eq(sessions.id, session.id),
        or(isNull(sessions.lastActivityAt), lt(sessions.lastActivityAt, cutoff))
      )
    )
    .returning({ id: sessions.id })
  return claimed.length > 0
}

/** `status()` of the instance, `'not found'` when there is none, null when the lookup failed. */
async function instanceStatus(
  workflow: SessionWorkflowBinding,
  instanceId: string,
  logger?: ReconcileLogger
): Promise<string | null> {
  try {
    return (await (await workflow.get(instanceId)).status()).status
  } catch (err) {
    if (isMissingInstanceError(err)) return 'not found'
    logger?.warn({ err, instanceId }, 'session reconcile: could not read the instance status')
    return null
  }
}

/** The boot step still `running` in the checklist (the latest one without a done/error after it). */
async function runningStep(
  db: Database,
  session: SessionRow
): Promise<{ key: string; label: string } | null> {
  const rows = await db
    .select({ data: sessionEvents.data })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, session.tenantId),
        eq(sessionEvents.sessionId, session.id),
        eq(sessionEvents.type, 'step')
      )
    )
    .orderBy(desc(sessionEvents.seq))
    .limit(30)
  const settled = new Set<string>()
  for (const row of rows) {
    const step = agentStepEventDataSchema.safeParse(row.data)
    if (!step.success) continue
    if (step.data.status !== 'running') settled.add(step.data.key)
    else if (!settled.has(step.data.key)) return { key: step.data.key, label: step.data.label }
  }
  return null
}

async function restart(
  db: Database,
  workflow: SessionWorkflowBinding,
  session: SessionRow,
  logger?: ReconcileLogger
): Promise<string | null> {
  try {
    return (await restartSessionInstance(db, workflow, session)).instanceId
  } catch (err) {
    logger?.error({ err, sessionId: session.id }, 'session reconcile: could not start a cleanup')
    return null
  }
}

/** Reconcile one session (see the header). Throws only on a database error. */
export async function reconcileSession(
  db: Database,
  env: AppBindings,
  session: SessionRow,
  options: ReconcileSessionOptions = {}
): Promise<SessionReconcileResult> {
  const workflow = (env as { SESSION_WORKFLOW?: SessionWorkflowBinding }).SESSION_WORKFLOW
  if (!workflow) return SKIPPED
  const now = options.now ?? new Date()
  const quietSince = session.lastActivityAt ?? session.updatedAt

  // ---- a settled session whose cleanup never ran
  if (isTerminal(session.status)) {
    if (session.endedAt !== null) return SKIPPED
    const cutoff = new Date(now.getTime() - SESSION_CLEANUP_GRACE_MS)
    if (session.updatedAt > cutoff || quietSince > cutoff) return SKIPPED
    if (!(await claimTurn(db, session, cutoff, now))) return SKIPPED
    const restartedAs = await restart(db, workflow, session, options.logger)
    options.logger?.warn(
      { sessionId: session.id, status: session.status, restartedAs },
      'session reconcile: a settled session was never cleaned up; started its cleanup'
    )
    return { outcome: 'settled', status: session.status, instanceStatus: 'n/a', restartedAs }
  }

  // ---- a quiet boot, turn or end
  if (!QUIET_STATUSES.includes(session.status)) return SKIPPED
  const stallMs =
    session.status === 'ending' ? SESSION_ENDING_STALL_MS : (options.stallMs ?? SESSION_STALL_MS)
  const cutoff = new Date(now.getTime() - stallMs)
  if (quietSince > cutoff) return SKIPPED
  if (!(await claimTurn(db, session, cutoff, now))) return SKIPPED

  const instanceId = session.instanceId ?? session.id
  const status = await instanceStatus(workflow, instanceId, options.logger)
  if (status === null) return SKIPPED
  let label = status
  if (LIVE_STATUSES.has(status)) {
    // A live `requested` instance is queued behind others; a boot or an end that quiet is dead.
    if (session.status === 'requested') return { outcome: 'alive', instanceStatus: status }
    const what = session.status === 'working' ? 'its turn' : 'its step'
    label = `its Workflow was ${status}, but ${what} had not moved for ${Math.round(stallMs / 60_000)} minutes`
    try {
      await (await workflow.get(instanceId)).terminate()
    } catch {
      // Gone already: the row and the fresh instance are what matter.
    }
  } else {
    label = `its Workflow ${status === 'not found' ? 'was lost' : `ended ${status}`}`
  }

  const endAsked = session.requestedAction === 'end' || session.status === 'ending'
  const emit = createSessionEmitter(db, session, options.realtime)
  let settledStatus: SessionStatus
  if (endAsked) {
    settledStatus = 'ending'
    await db
      .update(sessions)
      .set({ status: 'ending', requestedAction: null })
      .where(
        and(
          eq(sessions.tenantId, session.tenantId),
          eq(sessions.id, session.id),
          inArray(sessions.status, [...QUIET_STATUSES])
        )
      )
  } else if (session.status === 'working') {
    // A dead turn: fail the TURN, not the session (see the header).
    settledStatus = 'ready'
    const message = `This turn stopped (${label}). Launch is restarting the session from its last checkpoint; send your message again.`
    const [settled] = await db
      .update(sessions)
      .set({ status: 'ready', cancelRequestedAt: null })
      .where(
        and(
          eq(sessions.tenantId, session.tenantId),
          eq(sessions.id, session.id),
          eq(sessions.status, 'working')
        )
      )
      .returning({ turnCount: sessions.turnCount })
    if (settled) {
      const turn = Math.max(1, settled.turnCount)
      await emit([{ type: 'turn.failed' as const, turn, data: { turn, message } }])
    }
  } else {
    settledStatus = 'failed'
    const step = await runningStep(db, session)
    const where = step ? `while ${step.label} was running` : 'while it was starting'
    const message = `The session stopped ${where} (${label}). Start a new session.`
    const [failed] = await db
      .update(sessions)
      .set({ status: 'failed', error: message })
      .where(
        and(
          eq(sessions.tenantId, session.tenantId),
          eq(sessions.id, session.id),
          inArray(sessions.status, [...QUIET_STATUSES])
        )
      )
      .returning({ id: sessions.id })
    if (failed) {
      await emit([
        ...(step
          ? [
              {
                type: 'step' as const,
                turn: 0,
                data: { key: step.key, label: step.label, status: 'error', detail: message },
              },
            ]
          : []),
        { type: 'error' as const, turn: session.turnCount, data: { message } },
      ])
    }
  }
  const [current] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, session.id)))
  const restartedAs = current ? await restart(db, workflow, current, options.logger) : null
  await recordAudit(db, {
    ...SYSTEM_ACTOR,
    tenantId: session.tenantId,
    action: 'session.reconciled',
    targetType: 'session',
    targetId: session.id,
    appId: session.appId,
    summary: { after: { status: settledStatus, instanceId, instanceStatus: status, restartedAs } },
  })
  if (current) nudgeSession(options.realtime, current)
  options.logger?.warn(
    { sessionId: session.id, instanceId, instanceStatus: status, settledStatus, restartedAs },
    'session reconcile: the Workflow stopped under a quiet session; settled it'
  )
  return { outcome: 'settled', status: settledStatus, instanceStatus: status, restartedAs }
}

/** {@link reconcileSession} for a route or a cron: any error is logged and nothing changes. */
export async function reconcileSessionSafely(
  db: Database,
  env: AppBindings,
  session: SessionRow,
  options: ReconcileSessionOptions = {}
): Promise<SessionReconcileResult> {
  try {
    return await reconcileSession(db, env, session, options)
  } catch (err) {
    options.logger?.error({ err, sessionId: session.id }, 'session reconcile failed; unchanged')
    return SKIPPED
  }
}

/**
 * The cron's sweep (`sessions.expire`): every quiet boot, turn or end, and every settled session never
 * cleaned up, across organisations — each reconciled inside its own tenant.
 */
export async function reconcileStaleSessions(
  db: Database,
  env: AppBindings,
  options: { now?: Date; logger?: ReconcileLogger; tenantIds?: readonly string[] } = {}
): Promise<number> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - Math.min(SESSION_STALL_MS, SESSION_CLEANUP_GRACE_MS))
  const candidates = await db
    .select()
    .from(sessions)
    .where(
      and(
        or(
          inArray(sessions.status, [...QUIET_STATUSES]),
          and(inArray(sessions.status, [...TERMINAL_SESSION_STATUSES]), isNull(sessions.endedAt))
        ),
        sql`coalesce(${sessions.lastActivityAt}, ${sessions.updatedAt}) < ${cutoff.toISOString()}::timestamptz`,
        options.tenantIds ? inArray(sessions.tenantId, [...options.tenantIds]) : undefined
      )
    )
    .limit(100)
  let settled = 0
  for (const session of candidates) {
    const result = await reconcileSessionSafely(db, env, session, { logger: options.logger, now })
    if (result.outcome === 'settled') settled += 1
  }
  return settled
}
