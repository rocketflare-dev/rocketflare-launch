/**
 * The chat half of `/api/sessions` (Launch P3, slice 3c), mounted by `routes/sessions.ts` with
 * `sessionsRouter.route('/', sessionChatRouter)`, behind the `/api/sessions` mount's
 * `authMiddleware`. Every route resolves the session with `getVisibleSession`
 * (`services/sessions/access.ts`): another person's session, or another tenant's, is a 404.
 *
 * - `POST /:id/turns` `sessionTurnRequestSchema` → 202 `sessionDetailResponseSchema`: stores
 *   `pending_message` (and `pending_model` when `model` switches it — 400 `model_not_offered` for
 *   one the runtime does not offer — and `pending_attachments`: the `attachments` ids, each found
 *   under the session's R2 prefix first, else 400 `attachment_not_found`; 503
 *   `storage_not_configured` without `FILES`) and wakes the Workflow (`wakeOrRestart` — a lost instance is
 *   restarted). While a turn is `working` the message waits behind it (`mode: 'queue'`) or stops
 *   it (`mode: 'interrupt'`: `cancel_requested_at` in the same write) — and then, as for
 *   `/cancel`, the turn is reconciled instead of woken (its step is mid-turn; a stale heartbeat
 *   means it is gone, and the salvage closes the turn so the message runs next). 409
 *   `turn_in_progress` while a message already waits, 409 `session_budget_exhausted` when `blocked`, 409
 *   `session_not_active` once it is shipping or over; 409 `session_credential_owner_only` from
 *   anyone but the owner of a session on a personal account (§18.22); 503
 *   `sessions_not_configured` without the Workflow binding, before any write. 403
 *   `upgrade_session_read_only` on a kit upgrade session, first: nobody steers one.
 * - `POST /:id/cancel` → `sessionCancelResponseSchema` (`cancel_requested_at`; the turn polls it
 *   and kills the process — or a waiting message is withdrawn); 409 `no_turn_in_progress`. A
 *   running turn whose heartbeat is stale (`SESSION_CANCEL_STALL_MS`: its turn step is gone, so
 *   nothing would ever read the cancel) is reconciled AT ONCE: the dead instance is terminated and
 *   a fresh one's `salvage` step stops the process, saves the work and closes the turn
 *   (`reconcile.ts`) — the route itself runs nothing in the sandbox.
 * - `POST /:id/queued/withdraw` → `sessionDetailResponseSchema`: takes the waiting message back
 *   (`pending_message`, its sender, `pending_model` and `pending_attachments`) — while a turn runs too, which `/cancel`
 *   cannot (it stops the turn); 409 `nothing_queued` when nothing waits. Same checks as `/turns`
 *   (a kit upgrade's waiting message is Launch's prompt: 403 `upgrade_session_read_only`).
 * - `GET /:id/agui/stream[?afterSeq=]` — the AG-UI read stream over `session_events`
 *   (`services/sessions/session-stream.ts`, the four rules of `services/agents/run-stream.ts`).
 * - `GET /:id/events[?afterSeq=]` → `sessionEventsResponseSchema`.
 * - `POST /:id/budget` `extendBudgetSchema` (`{extraUsd, reason?}`) →
 *   `extendBudgetResponseSchema` (the session plus `approvalId`): from P4 a `session.budget`
 *   approval (plan §4c, `budget-request.ts`), opened (or joined) in the creator's name. When the
 *   caller is an eligible approver other than the creator their approval is recorded in the same
 *   call — 200, the cap already raised
 *   (`session.budget.extended`) and a `blocked` session under both caps `ready` and woken;
 *   otherwise 202 and the request waits in the approvals inbox (the creator's own ask always does).
 *
 * Routes write request columns and wake the Workflow; they never run a turn.
 */
import {
  type ExtendBudgetResponse,
  extendBudgetSchema,
  SESSION_REALTIME_ENTITY,
  type SessionDetailResponse,
  type SessionEventsResponse,
  sessionEventsQuerySchema,
  sessionTurnRequestSchema,
} from '@launch/shared/launch-sessions'
import { guardPermission } from '../middleware/permissions'
import { approvalViewerOf } from '../services/approvals/types'
import { auditActor } from '../services/launch/audit'
import { nudge, realtimeEvent } from '../services/realtime'
import { getVisibleSession, sessionViewerOf } from '../services/sessions/access'
import { requireSessionStorage, resolveSessionAttachments } from '../services/sessions/attachments'
import { requestBudgetExtension } from '../services/sessions/budget-request'
import {
  assertCredentialOwner,
  assertTakesMessages,
  requestCancel,
  requestTurn,
  requireSessionWorkflow,
  toSessionDetail,
  withdrawQueued,
} from '../services/sessions/chat'
import { listSessionEvents, toSessionEvent } from '../services/sessions/event-log'
import { wakeOrRestart } from '../services/sessions/lifecycle'
import { reconcileSessionSafely } from '../services/sessions/reconcile'
import { streamSessionAgui } from '../services/sessions/session-stream'
import type { AppContext } from '../types'
import { ValidationError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { approvalDepsOf } from './approvals'

export const sessionChatRouter = createRouter()

/** The most rows `GET /:id/events` returns at once; page on with `nextSeq`. */
const EVENTS_PAGE = 500

/** The session the caller may see (else the SAME 404 as a missing one), and who they are. */
async function visibleSession(c: AppContext, opts: { readOnly?: boolean } = {}) {
  const ctx = withAuthAndDb(c)
  const viewer = sessionViewerOf(ctx.auth)
  const row = await getVisibleSession(ctx.db, ctx.tenantId, uuidParam(c, 'id'), viewer, opts)
  return { ...ctx, viewer, row }
}

function changed(c: AppContext, tenantId: string, sessionId: string) {
  const { realtime } = withAuthAndDb(c)
  nudge(
    realtime,
    realtimeEvent('entity.changed', tenantId, { entity: SESSION_REALTIME_ENTITY, id: sessionId })
  )
}

// ---- POST /api/sessions/:id/turns ----------------------------------------------------------------

/**
 * Send a message to a coding session: queue it behind a running turn, interrupt the running turn,
 * or wake the session to run it now. Requires `update Session`. 400 `model_not_offered` or
 * `attachment_not_found`; 403 `upgrade_session_read_only` on a kit upgrade session; 409
 * `turn_in_progress`, `session_budget_exhausted`, `session_not_active` or
 * `session_credential_owner_only`; 503 `sessions_not_configured` or `storage_not_configured`.
 */
sessionChatRouter.post('/:id/turns', validate('json', sessionTurnRequestSchema), async c => {
  guardPermission(c, 'update', 'Session')
  const { db, tenantId, logger, realtime, user, row } = await visibleSession(c)
  // A kit upgrade takes no person's message (403), before any lookup or write.
  assertTakesMessages(row)
  const workflow = requireSessionWorkflow(c.env)
  const { message, model, mode, attachments: ids } = c.req.valid('json')
  // The images must be this session's: looked up under its own prefix, never trusted by id.
  const attachments = ids.length
    ? await resolveSessionAttachments(requireSessionStorage(c.env), row.id, ids)
    : []
  // §18.22: the sender is recorded, and a personal-account session takes only its owner's turns.
  const updated = await requestTurn(
    db,
    row,
    { message, model, mode, attachments },
    new Date(),
    user.id
  )
  if (updated.status === 'working') {
    // Behind a running turn: its step reads the cancel (an interrupt) within 2 s, and the loop's
    // next inspect runs the message. A stale heartbeat means that step is gone — reconcile now,
    // exactly as `/cancel` does, rather than wake (and maybe restart) an instance mid-turn.
    await reconcileSessionSafely(db, c.env, updated, { logger, realtime })
    changed(c, tenantId, updated.id)
    return c.json<SessionDetailResponse>({ session: toSessionDetail(updated, true) }, 202)
  }
  // A lost instance (a `wrangler dev` reload, retention) is restarted from the row.
  const woken = await wakeOrRestart(db, workflow, updated, logger)
  changed(c, tenantId, woken.id)
  return c.json<SessionDetailResponse>({ session: toSessionDetail(woken, true) }, 202)
})

// ---- POST /api/sessions/:id/queued/withdraw ------------------------------------------------------

/**
 * Withdraw a session's waiting message before it runs. Requires `update Session`. 403
 * `upgrade_session_read_only` on a kit upgrade session; 409 `nothing_queued` when nothing waits.
 */
sessionChatRouter.post('/:id/queued/withdraw', async c => {
  guardPermission(c, 'update', 'Session')
  const { db, tenantId, user, row } = await visibleSession(c)
  // The same checks as `/turns`: a kit upgrade's waiting message is Launch's own (403), and on a
  // personal account only its owner's messages wait.
  assertTakesMessages(row)
  assertCredentialOwner(row, user.id)
  const updated = await withdrawQueued(db, row)
  changed(c, tenantId, row.id)
  return c.json<SessionDetailResponse>({ session: toSessionDetail(updated, true) })
})

// ---- POST /api/sessions/:id/cancel ---------------------------------------------------------------

/**
 * Cancel a session's running turn, or withdraw a message waiting behind one. Requires `update
 * Session`. 409 `no_turn_in_progress`.
 */
sessionChatRouter.post('/:id/cancel', async c => {
  guardPermission(c, 'update', 'Session')
  const { db, tenantId, logger, realtime, row } = await visibleSession(c)
  const result = await requestCancel(db, row)
  if (result.cancelled === 'running') {
    // A live turn step polls the cancel within 2 s. When the turn's heartbeat is already stale
    // its step is gone and nothing would read it: the reconcile acts now (a fresh heartbeat costs
    // nothing — no Workflow call is made).
    await reconcileSessionSafely(db, c.env, result.row, { logger, realtime })
  }
  changed(c, tenantId, row.id)
  return c.json({ cancelRequested: true as const })
})

// ---- GET /api/sessions/:id/events ----------------------------------------------------------------

/**
 * Page a session's durable event log from `afterSeq`, up to 500 rows at a time. Requires `read
 * Session`; a pending merge's reviewer may read it too.
 */
sessionChatRouter.get('/:id/events', validate('query', sessionEventsQuerySchema), async c => {
  guardPermission(c, 'read', 'Session')
  // Issue #5: a pending merge's reviewer reads the log too (`access.ts`).
  const { db, tenantId, row } = await visibleSession(c, { readOnly: true })
  const afterSeq = c.req.valid('query').afterSeq ?? 0
  const rows = await listSessionEvents(db, tenantId, row.id, afterSeq, EVENTS_PAGE)
  return c.json<SessionEventsResponse>({
    items: rows.map(toSessionEvent),
    nextSeq: rows.at(-1)?.seq ?? afterSeq,
  })
})

// ---- GET /api/sessions/:id/agui/stream -----------------------------------------------------------

/**
 * GET on purpose, like the run stream: a third-party AG-UI client can point a bare `EventSource`
 * at it, which is the only reason `Last-Event-ID` is honoured. **`?afterSeq=` wins when both are
 * present**; a garbage explicit cursor is a 400, a garbage header is ignored. Everything that can
 * fail is JSON and happens here, before the first frame.
 */
sessionChatRouter.get('/:id/agui/stream', async c => {
  guardPermission(c, 'read', 'Session')
  const { row } = await visibleSession(c, { readOnly: true })
  return streamSessionAgui(c, row, resolveStreamCursor(c))
})

function resolveStreamCursor(c: AppContext): number {
  const explicit = c.req.query('afterSeq')
  if (explicit !== undefined) {
    const value = Number(explicit)
    if (!Number.isInteger(value) || value < 0) {
      throw new ValidationError(
        [{ path: ['afterSeq'], message: 'afterSeq must be a non-negative integer' }],
        'Invalid cursor'
      )
    }
    return value
  }
  const header = Number(c.req.header('Last-Event-ID'))
  return Number.isInteger(header) && header >= 0 ? header : 0
}

// ---- POST /api/sessions/:id/budget ---------------------------------------------------------------

/**
 * Ask to raise a session's budget cap, opening (or joining) a `session.budget` approval in the
 * creator's name. Requires `update Session`. When the caller is an eligible approver other than
 * the creator, their approval is recorded in the same call (200, cap already raised); otherwise
 * 202 and it waits in the approvals inbox.
 */
sessionChatRouter.post('/:id/budget', validate('json', extendBudgetSchema), async c => {
  guardPermission(c, 'update', 'Session')
  const { tenantId, auth, row } = await visibleSession(c)
  const { extraUsd, reason } = c.req.valid('json')
  const result = await requestBudgetExtension(approvalDepsOf(c), {
    session: row,
    caller: approvalViewerOf({ ...auth, tenantId }),
    extraUsd,
    reason,
    actor: auditActor(c),
  })
  changed(c, tenantId, row.id)
  const body: ExtendBudgetResponse = {
    session: toSessionDetail(result.session, true),
    approvalId: result.request.id,
  }
  return c.json(body, result.request.status === 'approved' ? 200 : 202)
})
