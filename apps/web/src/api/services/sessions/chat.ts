/**
 * The chat routes' writes (Launch P3, slice 3c): a route never RUNS a turn, it writes a request
 * column on the row and wakes the session's Workflow (`SESSION_WAKE_EVENT`), which re-reads the
 * row — the row is the truth and the wake carries nothing.
 *
 * - `requestTurn`: stores `pending_message` with a compare-and-set that also IS the 409 — one
 *   message may wait at a time (`turn_in_progress` when the slot is full); a `blocked` session is
 *   `session_budget_exhausted`. A message to a `suspended` session also asks for a `resume`, so
 *   the Workflow boots again and then runs it; one sent while the session is still booting waits
 *   for `ready`. **While a turn is `working`** the message is QUEUED (`mode: 'queue'`, it runs when
 *   the turn ends — the loop's next `inspect` finds it) or INTERRUPTS (`mode: 'interrupt'`): the
 *   same UPDATE also sets `cancel_requested_at` when the row is still `working`, so the stop and
 *   the message cannot be split by a race. The turn's watcher kills the process within 2 s plus
 *   the 5 s kill grace, the turn ends `turn.interrupted { cancelled }` with the message untouched,
 *   and it runs next with `--resume`.
 * - A message may carry images (`attachments`, the ids `POST /:id/attachments` returned, already
 *   resolved under the session's R2 prefix by the route): stored as `pending_attachments` beside
 *   the text, which may then be empty — `pending_message` is `''`, never null, for an image-only
 *   message, because NULL is what "nothing waits" means. Cleared everywhere the text is.
 * - `withdrawQueued`: drops the waiting message (and its sender, model and images) — the only way to take
 *   one back while a turn runs; 409 `nothing_queued` when the slot is empty.
 * - A message may switch the model (`model`): one the session's runtime offers
 *   (`AGENT_RUNTIME_MODELS`) and the pricing table can price, else 400 `model_not_offered`. A
 *   different one is stored as `pending_model` beside the message; the turn's claim moves it onto
 *   `policy.model`, the one model the proxy lets through.
 * - `requestCancel`: a `working` turn gets `cancel_requested_at` (the turn polls it and kills the
 *   process); a message still waiting is simply withdrawn. Nothing to cancel is 409
 *   `no_turn_in_progress`.
 * - `wakeSession`: `SESSION_WORKFLOW.get(instance).sendEvent(...)`. A lost wake is logged, not
 *   thrown — the request is already on the row, and the Workflow's idle wait re-reads it.
 * - `toSessionDetail`: the row as `sessionSchema` — no token, no sealed column, no preview token.
 * - §18.22: the sender is recorded (`pending_message_user_id`) so the turn's `user.message` names
 *   who wrote it; a session on a personal account takes messages only from its owner
 *   (`assertCredentialOwner`, 409 `session_credential_owner_only`).
 */
import {
  AGENT_RUNTIME_LABELS,
  AGENT_RUNTIME_MODELS,
  isPricedRuntimeModel,
} from '@launch/shared/launch-agents'
import {
  resolveSessionPolicy,
  SESSION_WAKE_EVENT,
  type Session,
  type SessionAttachment,
  type SessionStatus,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type SessionRow, sessions } from '../../../db/schema'
import type { AppBindings } from '../../types'
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../utils/core/errors'
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
  'working',
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
  if (row.pendingMessage !== null) {
    return new ConflictError(
      'A message is already waiting to run. Withdraw it, or wait for it to start.',
      'turn_in_progress'
    )
  }
  return new ConflictError(`This session is ${row.status}`, 'session_not_active')
}

/**
 * §18.22: a session on a personal account takes turns (and ships) only from that account's owner —
 * its creator. 409 `session_credential_owner_only` for anyone else; they can still read and end it.
 */
export function assertCredentialOwner(
  row: Pick<SessionRow, 'credentialSource' | 'createdByUserId'>,
  userId: string | null | undefined
): void {
  if (row.credentialSource === 'user' && (!userId || userId !== row.createdByUserId)) {
    throw new ConflictError(
      'This session uses its creator’s own AI account; only they can send it messages or ship it.',
      'session_credential_owner_only'
    )
  }
}

/**
 * The model a message asked for, as `pending_model`: null when it asked for none or for the one
 * the session already runs; 400 `model_not_offered` when the runtime does not offer it or it has
 * no price (a session's budget is money, so an unpriced model could never be held to one).
 */
export function pendingModelFor(
  row: Pick<SessionRow, 'runtime' | 'policy'>,
  model: string | undefined
): string | null {
  if (model === undefined || model === resolveSessionPolicy(row.policy).model) return null
  const runtime = row.runtime ?? 'claude_code'
  if (!AGENT_RUNTIME_MODELS[runtime].includes(model) || !isPricedRuntimeModel(runtime, model)) {
    throw new BadRequestError(
      `${model} is not a model ${AGENT_RUNTIME_LABELS[runtime]} sessions offer`,
      'model_not_offered'
    )
  }
  return model
}

/** What `POST /:id/turns` asks for. */
export interface TurnRequest {
  message: string
  /** Switch the session to this model from this turn on (see the header). */
  model?: string
  /** While a turn runs: wait for it (`queue`, the default) or stop it (`interrupt`). */
  mode?: 'queue' | 'interrupt'
  /** Its images, already found under the session's prefix (`resolveSessionAttachments`). */
  attachments?: readonly SessionAttachment[]
}

/** Store the next message (see the header) from `userId`. Returns the updated row. */
export async function requestTurn(
  db: Database,
  row: SessionRow,
  request: TurnRequest,
  now: Date = new Date(),
  /** Who sent it (§18.22): recorded for the turn's `user.message`, and checked on a `user` session. */
  userId: string | null = null
): Promise<SessionRow> {
  if (userId !== null) assertCredentialOwner(row, userId)
  const pendingModel = pendingModelFor(row, request.model)
  if (!(TURN_ACCEPTING_STATUSES as readonly SessionStatus[]).includes(row.status)) {
    throw turnConflict(row)
  }
  const [updated] = await db
    .update(sessions)
    .set({
      pendingMessage: request.message,
      pendingMessageUserId: userId,
      pendingModel,
      pendingAttachments: request.attachments?.length ? [...request.attachments] : null,
      // Interrupt: the stop is asked for in the SAME write as the message, and only of a turn
      // that is still running (read from the row, not from what the route saw).
      ...(request.mode === 'interrupt'
        ? {
            cancelRequestedAt: sql`case when ${sessions.status} = 'working'
              then ${now.toISOString()}::timestamptz else ${sessions.cancelRequestedAt} end`,
          }
        : {}),
      // A suspended session has no sandbox: ask for the resume that will run it.
      ...(row.status === 'suspended' && !row.requestedAction
        ? { requestedAction: 'resume' as const }
        : {}),
      // A running turn's `last_activity_at` is its HEARTBEAT (`reconcile.ts`): a message queued
      // behind it must not make a dead turn look alive.
      lastActivityAt: sql`case when ${sessions.status} = 'working'
        then ${sessions.lastActivityAt} else ${now.toISOString()}::timestamptz end`,
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
    .set({
      pendingMessage: null,
      pendingMessageUserId: null,
      pendingModel: null,
      pendingAttachments: null,
      updatedAt: now,
    })
    .where(and(scope, isNotNull(sessions.pendingMessage)))
    .returning()
  if (withdrawn) return { row: withdrawn, cancelled: 'withdrawn' }
  throw new ConflictError('There is no turn to cancel', 'no_turn_in_progress')
}

/** Take back the waiting message (see the header). Returns the updated row. */
export async function withdrawQueued(
  db: Database,
  row: SessionRow,
  now: Date = new Date()
): Promise<SessionRow> {
  const [withdrawn] = await db
    .update(sessions)
    .set({
      pendingMessage: null,
      pendingMessageUserId: null,
      pendingModel: null,
      pendingAttachments: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessions.tenantId, row.tenantId),
        eq(sessions.id, row.id),
        isNotNull(sessions.pendingMessage)
      )
    )
    .returning()
  if (!withdrawn)
    throw new ConflictError('There is no waiting message to withdraw', 'nothing_queued')
  return withdrawn
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
    queuedMessage: row.pendingMessage,
    queuedAttachments: row.pendingAttachments ?? [],
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
    runtime: row.runtime ?? 'claude_code',
    credentialSource: row.credentialSource ?? 'platform',
    credentialOwnerUserId: row.credentialSource === 'user' ? row.createdByUserId : null,
  }
}
