/**
 * Reconciling a coding session whose Workflow died under it (Launch P3) — the sessions' version of
 * the pipeline's `pipeline/reconcile.ts`. A `SessionWorkflow` instance can stop without its step
 * recording anything: a `wrangler dev` reload kills the running step and the local engine keeps
 * reporting the instance `running` while nothing runs (measured: until something pokes the engine
 * again, minutes later), the platform can lose an instance, a step can wedge on an RPC. The row
 * then says `booting` (or `working`, or `shipping`) for ever and the page spins — or an idle row's
 * request (an End, a message) waits for ever on a wake that went nowhere. On read (`GET
 * /api/sessions/:id`, `GET /:id/pr`), on an end request (`POST /:id/end`) and from the five-minute
 * cron (`sessions.expire`), this asks:
 *
 * 1. **Only a quiet session.** `requested` / `booting` / `working` / `ending` with no heartbeat
 *    for {@link SESSION_STALL_MS} (a boot step writes `last_activity_at` every 30 s while it runs —
 *    `withProgress` in `steps.ts` — and a running turn every 10 s, `turn.ts`; `ending` gets
 *    {@link SESSION_ENDING_STALL_MS}, because cleanup retries patiently). **A Stop shortens it**: a
 *    `working` session with `cancel_requested_at` set is judged after
 *    {@link SESSION_CANCEL_STALL_MS} (three missed turn beats) — only the turn step polls for the
 *    cancel, so when that step is gone nothing else would act on it for 3 minutes. The cancel route
 *    calls this at once for that reason (`routes/session-chat.ts`). Anything fresher costs nothing.
 * 2. **Throttled in the database**: `last_activity_at` is moved to now in a compare-and-set, and
 *    only the request whose update landed goes on — so a session is reconciled at most once per
 *    window however many tabs poll it.
 * 3. **Ask the instance** (`instance_id`): not found, `errored`, `terminated`, `complete` → dead. A
 *    live status with a stale heartbeat is ALSO dead for `booting`, `working` and `ending` — no live
 *    boot step or turn is that quiet — and the instance is terminated (best effort). A `requested`
 *    session whose instance is live is only queued: left alone.
 * 4. **Dead** → an end the person asked for (`requested_action = 'end'`, or `ending`) becomes
 *    `ending`. A dead TURN (`working`) is not a dead session, and its container usually outlives
 *    the instance: the row is LEFT `working` and the fresh instance's `claim` → `salvage` step
 *    (`steps.ts`) stops the orphaned Claude Code process, checkpoints the work (commit, push,
 *    transcript), keeps the container for a warm resume when the process is confirmed stopped,
 *    and only then closes the turn — `turn.failed` saying whether the work was saved, or
 *    `turn.interrupted { cancelled }` for a pending Stop. (Only when no fresh instance can be
 *    started is the turn closed here, `turn.failed` and `ready`, so it does not spin.) Anything
 *    else becomes `failed`, with the step that was running named ("The session stopped while
 *    Starting dev server was running (its Workflow was running, but its step had not moved for 3
 *    minutes). Start a new session."), the checklist's line marked failed, and an `error` event.
 *    Then a FRESH instance (`restartSessionInstance`) runs the one thing still owed — `claim` sends
 *    an `ending` or unsettled session straight to `cleanup` (destroy the container, delete the
 *    branch, give back a prepare claim), and a live one through `salvage` — so no route ever runs
 *    the vendor or sandbox work itself.
 *
 * **An idle session that owes work.** A `ready` / `suspended` / `blocked` row runs nothing and
 * writes no heartbeat, so the steps above never look at it — but it can owe its Workflow work a
 * wake never delivered: End after a `wrangler dev` reload sent its wake to an instance that is
 * `running` in name only, and the row sat `ready` with `requested_action = 'end'` for ever (the
 * page said "ending"). Owed = what `inspectStep` would act on from the row (`owedWorkOf`): an end
 * from any idle status, a ship or a pending message on `ready`, a resume on `suspended` — never a
 * message to a `blocked` session or a resume held by a drain, which a healthy instance waits over.
 * Every request that creates owed work moves `last_activity_at` to now (`requestAction`,
 * `requestTurn`, the End and Ship routes), so its window, {@link SESSION_END_STALL_MS}, runs from
 * the request — and the End route's immediate reconcile never touches the instance it just woke.
 * Past the window, the same claim and the same question: `queued` is a fresh instance not yet
 * started (left alone); any other live status is alive in name only and is terminated (best
 * effort); and then — dead or terminated — the status is NOT changed and the session is NOT
 * failed: a FRESH instance runs the owed work from the row. Its `claim` salvages a `ready` /
 * `blocked` container (checkpoint, keep, `→ suspended` with the end still asked, else a resume),
 * so an End does not lose unsaved work to a straight `cleanup`; the loop's `inspect` then ends,
 * resumes, or (once resumed) runs the pending message. **A ship is the exception**: the salvage
 * replaces `requested_action = 'ship'` with the `resume` it needs, so the session comes back
 * `ready` with no ship asked — the person ships again. Audited `session.reconciled` with `owed`.
 *
 * **A ship, a landing, a release.** A `shipping` session runs steps, then waits between them — a
 * landing waits on CI for a round at a time (`land.wait#N`, a `waitForEvent`) — and a `wrangler
 * dev` reload in that wait left a landing at stage `ci` for ever: every wake went to an instance
 * `running` in name only, and the safety net (`nudgeLandingSessions`) only woke it. So every ship
 * step, every Phase A land step and every Phase B step (with the merged landing's `cleanup`) beats
 * `last_activity_at` while it runs (`withHeartbeat`, `steps.ts`), and the only quiet a healthy
 * instance leaves is what it waits BETWEEN steps — from which each window is computed, never
 * hard-coded: the gate (no Phase A landing yet) {@link SESSION_SHIP_GATE_STALL_MS} (the longest
 * retry delay, `cleanup`'s 160 s); a landing {@link SESSION_LANDING_STALL_MS} by stage (`ci`'s
 * 2-minute round or the 2-minute retry wait; `approval`'s 30-minute round); a merged landing in
 * Phase B (`shipped`, `releasing` / `deploying` — it runs after `cleanup`, so it is not `shipping`)
 * {@link SESSION_RELEASE_STALL_MS} — each plus one beat and two minutes. An End asked of a landing
 * outside `merging` wakes a healthy instance at once, so it is judged {@link SESSION_END_STALL_MS}
 * after the request (`cancel_requested_at`, which the End route writes). Past the window, the
 * owed-work rescue: `queued` is left alone, any other live status terminated, and a FRESH instance
 * started with the status and the landing untouched. Its `claim` resumes a Phase A landing straight
 * into the loop (`inspect` → `land`, or `end` for an End), a Phase B one into the release (after
 * `cleanup` if that never ran), and sends a gate to `salvage` (checkpoint, `→ suspended`, an
 * `error` saying the ship stopped — the person ships again; the gate is not re-run on its own). A
 * landing restarted in `merging` is safe to re-run: `land.merge` reads a recorded or GitHub-side
 * merge first, and a squash refused because an earlier one just landed reads the PR again and
 * records it. Audited `session.reconciled` with `phase` and `stage`. `GET /:id/pr` — the ship
 * panel's poll — reconciles too.
 *
 * **Why the salvage is a step and not done here**: stopping a process, committing and pushing take
 * seconds to minutes in the container, and this runs on a request path (a read, End, Stop) or the
 * cron. Routes enqueue, never run: the fresh instance is the queue.
 *
 * **Leftovers**: a `failed` / `ended` / `shipped` session with no `ended_at` (settled, but its
 * cleanup never ran — or settled by hand) older than {@link SESSION_CLEANUP_GRACE_MS} gets the same
 * fresh instance, once per window, so its container and its Neon branch are not kept for ever.
 *
 * {@link reconcileSessionSafely} is what the callers use: it never throws.
 */

import { agentStepEventDataSchema } from '@launch/shared/ai/agents'
import { type SessionStatus, TERMINAL_SESSION_STATUSES } from '@launch/shared/launch-sessions'
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type SessionRow, sessionEvents, sessions } from '../../../db/schema'
import type { AppBindings } from '../../types'
import { isMissingInstanceError } from '../agents/runs'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import type { Realtime } from '../realtime'
import { SESSION_CALL_LIMITS } from './deadline'
import { createSessionEmitter, nudgeSession } from './events'
import {
  LAND_APPROVAL_ROUND_SECONDS,
  LAND_CI_FAST_SECONDS,
  LAND_CI_SLOW_SECONDS,
  LAND_RETRY_SECONDS,
} from './land'
import {
  LAND_HEALTH_WAIT_SECONDS,
  LAND_RELEASE_WAIT_SECONDS,
  LAND_STAGING_WAIT_SECONDS,
} from './land-release'
import { restartSessionInstance, sessionsPaused } from './lifecycle'
import {
  BOOT_STEP,
  CLEANUP_STEP,
  gateStepConfig,
  LAND_PHASE_B_STEP,
  longestRetryDelayMs,
  SHIP_STEP,
} from './step-config'
import { landingOf, PHASE_B_LANDING_STAGES, type PhaseALandingStage, phaseAStageOf } from './steps'

/** How long a booting session may go without a heartbeat before its instance is asked. */
export const SESSION_STALL_MS = 3 * 60_000
/** The same for `ending`: cleanup retries for minutes on its own. */
export const SESSION_ENDING_STALL_MS = 15 * 60_000
/** A settled session's cleanup gets this long to run before a leftover is suspected. */
export const SESSION_CLEANUP_GRACE_MS = 2 * 60_000
/**
 * On an end request the window is shorter: two missed heartbeats say the boot step is gone. Also
 * the window of an idle session's owed work (an end, ship, message or resume nobody started).
 */
export const SESSION_END_STALL_MS = 75_000
/**
 * A `working` session with a Stop pending (`cancel_requested_at`): three missed turn heartbeats
 * (`TURN_HEARTBEAT_MS`, 10 s) say the turn step that should act on it is gone.
 */
export const SESSION_CANCEL_STALL_MS = 30_000

// ---- shipping: the windows (see the header) ------------------------------------------------------

/**
 * The slack on top of the longest gap a healthy shipping instance leaves between two heartbeats:
 * one beat interval (`withHeartbeat` beats every `heartbeatMs` while a step runs) and two minutes
 * for the platform to schedule the next step after a wait or a retry's delay.
 */
const SHIPPING_SLACK_MS = SESSION_CALL_LIMITS.heartbeatMs + 2 * 60_000

/**
 * A `shipping` session in its GATE (no Phase A landing yet): every ship step beats while it runs
 * — a gate command, a fix turn included — so the only quiet a healthy instance leaves is a
 * retry's delay between two attempts; the longest is `ship.db-clean`'s (`CLEANUP_STEP`, 160 s).
 */
export const SESSION_SHIP_GATE_STALL_MS =
  Math.max(...[SHIP_STEP, BOOT_STEP, CLEANUP_STEP, gateStepConfig(0)].map(longestRetryDelayMs)) +
  SHIPPING_SLACK_MS

/**
 * A `shipping` session whose landing is in Phase A, by stage: each round's step stamps and beats,
 * then `land.wait#N` waits the stage's round (`ci`: 30 s, then 2 min; `approval`: 30 min) or
 * `LAND_RETRY_SECONDS` after a step that threw (`merging` never waits otherwise) — the longest of
 * those, or of a land step's retry delay, plus the slack.
 */
export const SESSION_LANDING_STALL_MS: Record<PhaseALandingStage, number> = (() => {
  const gap = (waitSeconds: number) =>
    Math.max(waitSeconds * 1000, LAND_RETRY_SECONDS * 1000, longestRetryDelayMs(SHIP_STEP)) +
    SHIPPING_SLACK_MS
  return {
    ci: gap(Math.max(LAND_CI_FAST_SECONDS, LAND_CI_SLOW_SECONDS)),
    approval: gap(LAND_APPROVAL_ROUND_SECONDS),
    merging: gap(0),
  }
})()

/**
 * A merged landing in Phase B (`shipped`, `releasing` / `deploying`): its `cleanup` and each
 * round's step beat; between them a `step.sleep` of the hook's wait (20 s – 2 min), the retry
 * wait, or a retry's delay (`cleanup`'s up to 160 s).
 */
export const SESSION_RELEASE_STALL_MS =
  Math.max(
    LAND_RELEASE_WAIT_SECONDS * 1000,
    LAND_STAGING_WAIT_SECONDS * 1000,
    LAND_HEALTH_WAIT_SECONDS * 1000,
    // Issue #11: `land.main-ci-wait#K.R` sleeps a `land.ci` round.
    LAND_CI_SLOW_SECONDS * 1000,
    LAND_RETRY_SECONDS * 1000,
    longestRetryDelayMs(LAND_PHASE_B_STEP),
    longestRetryDelayMs(CLEANUP_STEP)
  ) + SHIPPING_SLACK_MS

const LIVE_STATUSES = new Set(['queued', 'running', 'waiting', 'waitingForPause', 'paused'])
const QUIET_STATUSES: readonly SessionStatus[] = ['requested', 'booting', 'working', 'ending']
/** Where a session waits on its Workflow with nothing running — and may owe it work. */
const IDLE_STATUSES: readonly SessionStatus[] = ['ready', 'suspended', 'blocked']

/** What an idle session asked its Workflow for that has not started (see the header). */
type OwedWork = 'end' | 'ship' | 'turn' | 'resume'

/**
 * The work an idle row owes its Workflow — exactly what `inspectStep` (`steps.ts`) would act on
 * from it, and nothing it would wait over: an end from any idle status, a ship or a message on
 * `ready`, a resume on `suspended` (a message to a suspended session asks for that resume —
 * `requestTurn`). A message to a `blocked` session waits for its budget, and a resume or message
 * waits out a drain: neither is owed, so a healthy waiting instance is never taken for a dead one.
 */
function owedWorkOf(session: SessionRow): OwedWork | null {
  if (!IDLE_STATUSES.includes(session.status)) return null
  if (session.requestedAction === 'end') return 'end'
  if (session.status === 'ready' && session.requestedAction === 'ship') return 'ship'
  if (session.status === 'ready' && session.pendingMessage !== null) return 'turn'
  if (session.status === 'suspended' && session.requestedAction === 'resume') return 'resume'
  return null
}

const OWED_LABEL: Record<OwedWork, string> = {
  end: 'the end you asked for',
  ship: 'the ship you asked for',
  turn: 'the message you sent',
  resume: 'the resume you asked for',
}

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

/** `3 minutes`, `30 seconds`: how long a quiet session had not moved, for a sentence. */
function quietFor(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0
    ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`
    : `${Math.round(ms / 1000)} seconds`
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

  // ---- a ship, a landing, or a merged landing's release whose instance died (see the header)
  const shipWindow = shippingWindowOf(session)
  if (shipWindow) return reconcileShipping(db, workflow, session, shipWindow, now, options)

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

  // ---- an idle session whose request never reached a running Workflow
  const owed = owedWorkOf(session)
  if (owed) return reconcileIdleOwed(db, workflow, session, owed, quietSince, now, options)

  // ---- a quiet boot, turn or end
  if (!QUIET_STATUSES.includes(session.status)) return SKIPPED
  const stopPending = session.status === 'working' && session.cancelRequestedAt !== null
  const stallMs =
    session.status === 'ending'
      ? SESSION_ENDING_STALL_MS
      : stopPending
        ? Math.min(options.stallMs ?? SESSION_STALL_MS, SESSION_CANCEL_STALL_MS)
        : (options.stallMs ?? SESSION_STALL_MS)
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
    // A `queued` instance under a dead turn is the fresh one a reconcile started: its `salvage`
    // has not begun yet (a Stop's 30 s window is shorter than a busy queue).
    if (session.status === 'working' && status === 'queued') {
      return { outcome: 'alive', instanceStatus: status }
    }
    const what = session.status === 'working' ? 'its turn' : 'its step'
    label = `its Workflow was ${status}, but ${what} had not moved for ${quietFor(stallMs)}`
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
    // A dead turn: left `working` for the fresh instance's `salvage` to close (see the header).
    settledStatus = 'working'
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
  if (settledStatus === 'working' && !restartedAs) {
    // Nothing will salvage it now: close the turn here so it does not spin. The next wake starts
    // an instance whose `claim` finds `ready` and salvages the container then.
    settledStatus = 'ready'
    const message = `This turn stopped (${label}). Launch could not restart the session to save its work just now; send your message again and it will save what the turn left before carrying on.`
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
  }
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

/**
 * An idle session (`ready` · `suspended` · `blocked`) that owes its Workflow work nobody started
 * for {@link SESSION_END_STALL_MS} (see the header). Nothing is settled here — the status is left
 * as it is and a fresh instance runs the work from the row: its `claim` salvages a `ready` /
 * `blocked` container first (checkpoint, keep — an end stays asked), and the loop's `inspect` then
 * ends, resumes or runs the message.
 */
async function reconcileIdleOwed(
  db: Database,
  workflow: SessionWorkflowBinding,
  session: SessionRow,
  owed: OwedWork,
  quietSince: Date,
  now: Date,
  options: ReconcileSessionOptions
): Promise<SessionReconcileResult> {
  const cutoff = new Date(now.getTime() - SESSION_END_STALL_MS)
  if (quietSince > cutoff) return SKIPPED
  // A drain holds every resume and message (`inspect` suspends instead): only an end is owed.
  if (owed !== 'end' && (await sessionsPaused(db))) return SKIPPED
  if (!(await claimTurn(db, session, cutoff, now))) return SKIPPED

  return restartQuietInstance(db, workflow, session, options, {
    quiet: `${OWED_LABEL[owed]} had not started after ${quietFor(SESSION_END_STALL_MS)}`,
    audit: { owed },
    message:
      'session reconcile: an idle session owed its Workflow work that never started; restarted it',
  })
}

/**
 * The rescue an idle session's owed work and a quiet ship share: ask the instance — `queued` is a
 * fresh one (a restart) that has not run its `claim` yet, left alone; any other live status is
 * alive in name only and is terminated (best effort) — then, dead or terminated, start a FRESH
 * instance that carries on from the row. The status is not changed here.
 */
async function restartQuietInstance(
  db: Database,
  workflow: SessionWorkflowBinding,
  session: SessionRow,
  options: ReconcileSessionOptions,
  what: { quiet: string; audit: Record<string, unknown>; message: string }
): Promise<SessionReconcileResult> {
  const instanceId = session.instanceId ?? session.id
  const status = await instanceStatus(workflow, instanceId, options.logger)
  if (status === null) return SKIPPED
  if (status === 'queued') return { outcome: 'alive', instanceStatus: status }
  let label: string
  if (LIVE_STATUSES.has(status)) {
    label = `its Workflow was ${status}, but ${what.quiet}`
    try {
      await (await workflow.get(instanceId)).terminate()
    } catch {
      // Gone already: the fresh instance is what matters.
    }
  } else {
    label = `its Workflow ${status === 'not found' ? 'was lost' : `ended ${status}`}`
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
    summary: {
      after: {
        status: session.status,
        ...what.audit,
        instanceId,
        instanceStatus: status,
        restartedAs,
      },
    },
  })
  if (current) nudgeSession(options.realtime, current)
  options.logger?.warn(
    {
      sessionId: session.id,
      instanceId,
      instanceStatus: status,
      ...what.audit,
      label,
      restartedAs,
    },
    what.message
  )
  return { outcome: 'settled', status: session.status, instanceStatus: status, restartedAs }
}

/** Which window a ship, a landing or a release is judged by (see the header), or null. */
interface ShippingWindow {
  phase: 'gate' | 'landing' | 'release'
  stage: string | null
  stallMs: number
  quietSince: Date
}

function shippingWindowOf(session: SessionRow): ShippingWindow | null {
  const quietSince = session.lastActivityAt ?? session.updatedAt
  if (session.status === 'shipped') {
    const stage = landingOf(session)?.stage
    if (!stage || !(PHASE_B_LANDING_STAGES as readonly string[]).includes(stage)) return null
    return { phase: 'release', stage, stallMs: SESSION_RELEASE_STALL_MS, quietSince }
  }
  if (session.status !== 'shipping') return null
  const stage = phaseAStageOf(session)
  if (!stage) return { phase: 'gate', stage: null, stallMs: SESSION_SHIP_GATE_STALL_MS, quietSince }
  const asked = session.cancelRequestedAt
  if (stage !== 'merging' && session.requestedAction === 'end' && asked) {
    // An End wakes a healthy landing at once (`inspect` ends it between rounds), so its window is
    // an end's, run from the request — which the End route writes as `cancel_requested_at`.
    return {
      phase: 'landing',
      stage,
      stallMs: Math.min(SESSION_END_STALL_MS, SESSION_LANDING_STALL_MS[stage]),
      quietSince: asked > quietSince ? asked : quietSince,
    }
  }
  return { phase: 'landing', stage, stallMs: SESSION_LANDING_STALL_MS[stage], quietSince }
}

const SHIPPING_QUIET: Record<ShippingWindow['phase'], string> = {
  gate: 'its ship had not moved',
  landing: 'its landing had not moved',
  release: 'its release had not moved',
}

/**
 * A ship (`shipping`, in its gate or its Phase A landing) or a merged landing's release (`shipped`,
 * Phase B) quiet past its window (see the header): the same rescue as owed work — nothing is
 * settled, the landing is untouched, and the fresh instance's `claim` resumes it where the row
 * stands (a landing in the loop, a release in Phase B, a gate through `salvage`).
 */
async function reconcileShipping(
  db: Database,
  workflow: SessionWorkflowBinding,
  session: SessionRow,
  window: ShippingWindow,
  now: Date,
  options: ReconcileSessionOptions
): Promise<SessionReconcileResult> {
  const cutoff = new Date(now.getTime() - window.stallMs)
  if (window.quietSince > cutoff) return SKIPPED
  if (!(await claimTurn(db, session, cutoff, now))) return SKIPPED
  return restartQuietInstance(db, workflow, session, options, {
    quiet: `${SHIPPING_QUIET[window.phase]} for ${quietFor(window.stallMs)}`,
    audit: {
      phase: window.phase,
      stage: window.stage,
      ...(session.requestedAction === 'end' ? { endAsked: true } : {}),
    },
    message: 'session reconcile: a ship or landing whose Workflow stopped; restarted it',
  })
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
 * The cron's sweep (`sessions.expire`): every quiet boot, turn or end, every idle session owing
 * work nobody started, every quiet ship, landing or release, and every settled session never
 * cleaned up, across organisations — each reconciled inside its own tenant.
 */
export async function reconcileStaleSessions(
  db: Database,
  env: AppBindings,
  options: { now?: Date; logger?: ReconcileLogger; tenantIds?: readonly string[] } = {}
): Promise<number> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - Math.min(SESSION_STALL_MS, SESSION_CLEANUP_GRACE_MS))
  const stopCutoff = new Date(now.getTime() - SESSION_CANCEL_STALL_MS)
  const owedCutoff = new Date(now.getTime() - SESSION_END_STALL_MS)
  // A ship's shortest window; `reconcileSession` judges each by its own (an `approval` landing
  // quiet for less than its 30-minute round is read and left).
  const shipCutoff = new Date(
    now.getTime() -
      Math.min(
        SESSION_SHIP_GATE_STALL_MS,
        SESSION_LANDING_STALL_MS.ci,
        SESSION_LANDING_STALL_MS.merging
      )
  )
  const releaseCutoff = new Date(now.getTime() - SESSION_RELEASE_STALL_MS)
  const quietSince = sql`coalesce(${sessions.lastActivityAt}, ${sessions.updatedAt})`
  const candidates = await db
    .select()
    .from(sessions)
    .where(
      and(
        or(
          and(
            or(
              inArray(sessions.status, [...QUIET_STATUSES]),
              and(
                inArray(sessions.status, [...TERMINAL_SESSION_STATUSES]),
                isNull(sessions.endedAt)
              )
            ),
            sql`${quietSince} < ${cutoff.toISOString()}::timestamptz`
          ),
          // A Stop nobody acted on (its turn step is gone) is judged sooner (see the header).
          and(
            eq(sessions.status, 'working'),
            isNotNull(sessions.cancelRequestedAt),
            sql`${quietSince} < ${stopCutoff.toISOString()}::timestamptz`
          ),
          // An idle session owing work nobody started (`owedWorkOf`; see the header).
          and(
            or(
              and(
                inArray(sessions.status, [...IDLE_STATUSES]),
                eq(sessions.requestedAction, 'end')
              ),
              and(
                eq(sessions.status, 'ready'),
                or(eq(sessions.requestedAction, 'ship'), isNotNull(sessions.pendingMessage))
              ),
              and(eq(sessions.status, 'suspended'), eq(sessions.requestedAction, 'resume'))
            ),
            sql`${quietSince} < ${owedCutoff.toISOString()}::timestamptz`
          ),
          // A ship or a landing whose instance died, and a merged landing's release (see the
          // header): an End asked of a landing is judged from the request, sooner.
          and(
            eq(sessions.status, 'shipping'),
            or(
              sql`${quietSince} < ${shipCutoff.toISOString()}::timestamptz`,
              and(
                eq(sessions.requestedAction, 'end'),
                sql`${quietSince} < ${owedCutoff.toISOString()}::timestamptz`
              )
            )
          ),
          and(
            eq(sessions.status, 'shipped'),
            inArray(sql<string>`${sessions.landing}->>'stage'`, [...PHASE_B_LANDING_STAGES]),
            sql`${quietSince} < ${releaseCutoff.toISOString()}::timestamptz`
          )
        ),
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
