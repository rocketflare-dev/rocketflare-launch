/**
 * The chat half of `/api/sessions` (Launch P3, slice 3c), mounted by `routes/sessions.ts` with
 * `sessionsRouter.route('/', sessionChatRouter)`, behind the `/api/sessions` mount's
 * `authMiddleware`. Every route resolves the session with `getVisibleSession`
 * (`services/sessions/access.ts`): another person's session, or another tenant's, is a 404.
 *
 * - `POST /:id/turns` `sessionTurnRequestSchema` → 202 `sessionDetailResponseSchema`: stores
 *   `pending_message` and wakes the Workflow (`wakeOrRestart` — a lost instance is restarted); 409 `turn_in_progress` while
 *   one is pending or `working`, 409 `session_budget_exhausted` when `blocked`, 409
 *   `session_not_active` once it is shipping or over; 503 `sessions_not_configured` without the
 *   Workflow binding, before any write.
 * - `POST /:id/cancel` → `sessionCancelResponseSchema` (`cancel_requested_at`; the turn polls it
 *   and kills the process — or a waiting message is withdrawn); 409 `no_turn_in_progress`.
 * - `GET /:id/agui/stream[?afterSeq=]` — the AG-UI read stream over `session_events`
 *   (`services/sessions/session-stream.ts`, the four rules of `services/agents/run-stream.ts`).
 * - `GET /:id/events[?afterSeq=]` → `sessionEventsResponseSchema`.
 * - `POST /:id/budget` `extendBudgetSchema` (`{extraUsd, reason?}`) → `sessionDetailResponseSchema`
 *   plus `approvalId`: from P4 a `session.budget` approval (plan §4c, `budget-request.ts`), opened
 *   (or joined) in the creator's name. When the caller is an eligible approver other than the
 *   creator their approval is recorded in the same call — 200, the cap already raised
 *   (`session.budget.extended`) and a `blocked` session under both caps `ready` and woken;
 *   otherwise 202 and the request waits in the approvals inbox (the creator's own ask always does).
 *
 * Routes write request columns and wake the Workflow; they never run a turn.
 */
import {
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
import { requestBudgetExtension } from '../services/sessions/budget-request'
import {
  requestCancel,
  requestTurn,
  requireSessionWorkflow,
  toSessionDetail,
} from '../services/sessions/chat'
import { listSessionEvents, toSessionEvent } from '../services/sessions/event-log'
import { wakeOrRestart } from '../services/sessions/lifecycle'
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
async function visibleSession(c: AppContext) {
  const ctx = withAuthAndDb(c)
  const viewer = sessionViewerOf(ctx.auth)
  const row = await getVisibleSession(ctx.db, ctx.tenantId, uuidParam(c, 'id'), viewer)
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

sessionChatRouter.post('/:id/turns', validate('json', sessionTurnRequestSchema), async c => {
  guardPermission(c, 'update', 'Session')
  const { db, tenantId, logger, row } = await visibleSession(c)
  const workflow = requireSessionWorkflow(c.env)
  const { message } = c.req.valid('json')
  const updated = await requestTurn(db, row, message)
  // A lost instance (a `wrangler dev` reload, retention) is restarted from the row.
  const woken = await wakeOrRestart(db, workflow, updated, logger)
  changed(c, tenantId, woken.id)
  return c.json<SessionDetailResponse>({ session: toSessionDetail(woken, true) }, 202)
})

// ---- POST /api/sessions/:id/cancel ---------------------------------------------------------------

sessionChatRouter.post('/:id/cancel', async c => {
  guardPermission(c, 'update', 'Session')
  const { db, tenantId, row } = await visibleSession(c)
  await requestCancel(db, row)
  changed(c, tenantId, row.id)
  return c.json({ cancelRequested: true as const })
})

// ---- GET /api/sessions/:id/events ----------------------------------------------------------------

sessionChatRouter.get('/:id/events', validate('query', sessionEventsQuerySchema), async c => {
  guardPermission(c, 'read', 'Session')
  const { db, tenantId, row } = await visibleSession(c)
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
  const { row } = await visibleSession(c)
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
  const approved = result.request.status === 'approved'
  // `approvalId` rides beside the P3 body; `sessionDetailResponseSchema` has no field for it yet.
  return c.json(
    { session: toSessionDetail(result.session, true), approvalId: result.request.id },
    approved ? 200 : 202
  )
})
