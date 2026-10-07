/**
 * `/api/sessions` (Launch P3, spec/07) — one coding session by id, behind `authMiddleware` at the
 * mount. Three files share the prefix so the slices that build them never edit the same one:
 *
 * - this file (slice 3b, the lifecycle): `GET /:id` → `sessionDetailResponseSchema` (`read
 *   Session` + `getVisibleSession`) and `POST /:id/resume` → 202;
 * - `session-chat.ts` (slice 3c): turns, cancel, the event log, the AG-UI stream, the budget;
 * - `session-ship.ts` (slice 3d): ship, end, the preview grant, the PR;
 * - `session-attachments.ts`: a message's images (upload, and the bytes for the transcript).
 *
 * Starting a session is `POST /api/apps/:id/sessions` (`routes/app-sessions.ts`), and the drain is
 * `/api/admin/sessions` (`routes/admin-sessions.ts`). Routes START work — they write the request
 * columns and wake the `SessionWorkflow` (`SESSION_WAKE_EVENT`); the Workflow does it. A missing
 * `SESSION_WORKFLOW` binding is a 503 `sessions_not_configured` before any row is written.
 *
 * The sub-routers are mounted FIRST: Hono matches in registration order, and a `/:id` route
 * here must never shadow `/:id/turns` there.
 */
import { guardPermission } from '../middleware/permissions'
import { getSessionFor, getSessionRow, sessionViewerOf } from '../services/sessions/access'
import { toSessionDetail } from '../services/sessions/chat'
import { requestAction } from '../services/sessions/lifecycle'
import { reconcileSessionSafely } from '../services/sessions/reconcile'
import type { AppContext } from '../types'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { sessionAttachmentsRouter } from './session-attachments'
import { sessionChatRouter } from './session-chat'
import { sessionShipRouter } from './session-ship'

export const sessionsRouter = createRouter()

sessionsRouter.route('/', sessionChatRouter)
sessionsRouter.route('/', sessionShipRouter)
sessionsRouter.route('/', sessionAttachmentsRouter)

/** The session if the caller may see it (else the SAME 404 as a missing one), with the context. */
async function visibleSession(c: AppContext, action: 'read' | 'update') {
  const auth = guardPermission(c, action, 'Session')
  const ctx = withAuthAndDb(c)
  // Issue #5: a pending merge's reviewer may READ the session, never drive it (`access.ts`).
  const { row: session, canManage } = await getSessionFor(
    ctx.db,
    ctx.tenantId,
    uuidParam(c, 'id'),
    sessionViewerOf(auth),
    { readOnly: action === 'read' }
  )
  return { ...ctx, session, canManage }
}

/**
 * Return a coding session's detail, reconciling a boot or turn whose Workflow died under it
 * first. Requires `read Session`; a pending merge's reviewer may read but not drive it.
 */
sessionsRouter.get('/:id', async c => {
  const { db, logger, realtime, session, canManage } = await visibleSession(c, 'read')
  // A boot or turn whose Workflow died under it is settled here, throttled (`reconcile.ts`): a
  // quiet session costs one compare-and-set per window, a fresh one nothing. An idle session
  // whose Workflow's timer died is brought back when someone who drives it opens it; a reader
  // (a merge's reviewer) only leaves it asleep.
  const reconciled = await reconcileSessionSafely(db, c.env, session, {
    logger,
    realtime,
    overdueIdle: canManage ? 'resume' : 'suspend',
  })
  const current =
    reconciled.outcome === 'settled'
      ? await getSessionRow(db, session.tenantId, session.id)
      : session
  // The creator, the app's owners and admins drive it; a merge's reviewer only reads it.
  return c.json({ session: toSessionDetail(current, canManage) })
})

/** Resume a suspended session: `requested_action = 'resume'` + a wake → 202. */
sessionsRouter.post('/:id/resume', async c => {
  const { db, session, realtime, logger } = await visibleSession(c, 'update')
  const row = await requestAction(db, c.env, session, 'resume', { realtime, logger })
  return c.json({ session: toSessionDetail(row, true) }, 202)
})
