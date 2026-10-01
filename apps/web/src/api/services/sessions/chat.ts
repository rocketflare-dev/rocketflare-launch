/**
 * The chat routes' writes (Launch P3, slice 3c): a route never RUNS a turn, it writes a request
 * column on the row and wakes the session's Workflow (`SESSION_WAKE_EVENT`), which re-reads the
 * row — the row is the truth and the wake carries nothing.
 *
 * - `requestTurn`: stores `pending_message` with a compare-and-set that also IS the 409 — one
 *   message may wait at a time, and none while a turn is `working` (`turn_in_progress`); a
 *   `blocked` session is `session_budget_exhausted`. A message to a `suspended` session also asks
 *   for a `resume`, so the Workflow boots again and then runs it; one sent while the session is
 *   still booting waits for `ready`.
 * - `requestCancel`: a `working` turn gets `cancel_requested_at` (the turn polls it and kills the
 *   process); a message still waiting is simply withdrawn. Nothing to cancel is 409
 *   `no_turn_in_progress`.
 * - `wakeSession`: `SESSION_WORKFLOW.get(instance).sendEvent(...)`. A lost wake is logged, not
 *   thrown — the request is already on the row, and the Workflow's idle wait re-reads it.
 * - `toSessionDetail`: the row as `sessionSchema` — no token, no sealed column, no preview token.
 */
import {
  resolveSessionPolicy,
  SESSION_WAKE_EVENT,
  type Session,
  type SessionStatus,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type SessionRow, sessions } from '../../../db/schema'
import type { AppBindings } from '../../types'
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../../utils/core/errors'
import { sessionSpend } from './budget'

/** Any logger with `warn` — a route's (hono-pino) or a step's (pino). */
export interface WarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

/** Statuses a new message is accepted in (it waits on the row until the Workflow can run it). */
export const TURN_ACCEPTING_STATUSES = [
  'requested',
  'booting',
  'ready',
  'suspended',
] as const satisfies readonly SessionStatus[]

/** The Workflow binding, or 503 `sessions_not_configured` — checked BEFORE any write. */
export function requireSessionWorkflow(env: AppBindings): Workflow {
  const workflow = (env as { SESSION_WORKFLOW?: Workflow }).SESSION_WORKFLOW
  if (!workflow) {
    throw new ServiceUnavailableError(
      'Coding sessions are not configured on this deployment',
      'sessions_not_configured'
    )
  }
  return workflow
}

/** Nudge the session's Workflow to re-read its row. Never throws. */
export async function wakeSession(
  workflow: Workflow,
  session: Pick<SessionRow, 'id' | 'instanceId'>,
  logger?: WarnLogger
): Promise<boolean> {
  try {
    const instance = await workflow.get(session.instanceId ?? session.id)
    await instance.sendEvent({ type: SESSION_WAKE_EVENT, payload: {} })
    return true
  } catch (err) {
    logger?.warn({ err, sessionId: session.id }, 'session: could not wake the workflow')
    return false
  }
}

/** Why `row` cannot take a message right now, as the 409 to answer. */
function turnConflict(row: SessionRow): ConflictError {
  if (row.status === 'blocked') {
    return new ConflictError(
      'This session has reached its budget. Ask an app owner to extend it.',
      'session_budget_exhausted'
    )
  }
  if (row.status === 'working' || row.pendingMessage) {
    return new ConflictError('A turn is already in progress', 'turn_in_progress')
  }
  return new ConflictError(`This session is ${row.status}`, 'session_not_active')
}

/** Store the next message (see the header). Returns the updated row. */
export async function requestTurn(
  db: Database,
  row: SessionRow,
  message: string,
  now: Date = new Date()
): Promise<SessionRow> {
  if (!(TURN_ACCEPTING_STATUSES as readonly SessionStatus[]).includes(row.status)) {
    throw turnConflict(row)
  }
  const [updated] = await db
    .update(sessions)
    .set({
      pendingMessage: message,
      // A suspended session has no sandbox: ask for the resume that will run it.
      ...(row.status === 'suspended' && !row.requestedAction
        ? { requestedAction: 'resume' as const }
        : {}),
      lastActivityAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessions.tenantId, row.tenantId),
        eq(sessions.id, row.id),
        isNull(sessions.pendingMessage),
        inArray(sessions.status, [...TURN_ACCEPTING_STATUSES])
      )
    )
    .returning()
  if (updated) return updated
  // Lost the race (or the row moved on): answer from what it is now.
  const [latest] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
    .limit(1)
  if (!latest) throw new NotFoundError('Session not found', 'session_not_found')
  throw turnConflict(latest)
}

export interface CancelResult {
  row: SessionRow
  /** `running`: the turn will be killed; `withdrawn`: the waiting message was dropped. */
  cancelled: 'running' | 'withdrawn'
}

/** Cancel the running turn, or withdraw the waiting message (see the header). */
export async function requestCancel(
  db: Database,
  row: SessionRow,
  now: Date = new Date()
): Promise<CancelResult> {
  const scope = and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id))
  const [running] = await db
    .update(sessions)
    .set({ cancelRequestedAt: now, updatedAt: now })
    .where(and(scope, eq(sessions.status, 'working')))
    .returning()
  if (running) return { row: running, cancelled: 'running' }
  const [withdrawn] = await db
    .update(sessions)
    .set({ pendingMessage: null, updatedAt: now })
    .where(and(scope, isNotNull(sessions.pendingMessage)))
    .returning()
  if (withdrawn) return { row: withdrawn, cancelled: 'withdrawn' }
  throw new ConflictError('There is no turn to cancel', 'no_turn_in_progress')
}

/** The row as `sessionSchema`. */
export function toSessionDetail(row: SessionRow, viewerCanManage: boolean): Session {
  return {
    id: row.id,
    appId: row.appId,
    kind: row.kind,
    shortId: row.shortId,
    title: row.title,
    status: row.status,
    createdByUserId: row.createdByUserId,
    branch: row.branch,
    turnCount: row.turnCount,
    costMicrocents: Number(row.costMicrocents),
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    baseRef: row.baseRef,
    baseSha: row.baseSha,
    headSha: row.headSha,
    requestedAction: row.requestedAction,
    pendingMessage: row.pendingMessage !== null,
    cancelRequested: row.cancelRequestedAt !== null,
    imageVersion: row.imageVersion,
    policy: resolveSessionPolicy(row.policy),
    usage: {
      tokensIn: Number(row.tokensIn),
      tokensOut: Number(row.tokensOut),
      cacheRead: Number(row.cacheRead),
      cacheWrite: Number(row.cacheWrite),
    },
    budget: sessionSpend(row),
    containerSeconds: row.containerSeconds,
    prChecks: row.prChecks,
    error: row.error,
    readyAt: row.readyAt,
    suspendedAt: row.suspendedAt,
    endedAt: row.endedAt,
    updatedAt: row.updatedAt,
    viewerCanManage,
    landing: row.landing ?? null,
    shipSummary: row.shipSummary ?? null,
  }
}
