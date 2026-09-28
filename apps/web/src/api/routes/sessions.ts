/**
 * `/api/sessions` (Launch P3, spec/07) — one coding session by id, behind `authMiddleware` at the
 * mount. Three files share the prefix so the slices that build them never edit the same one:
 *
 * - this file (slice 3b, the lifecycle): `GET /:id` → `sessionDetailResponseSchema` (`read
 *   Session` + `getVisibleSession`) and `POST /:id/resume` → 202;
 * - `session-chat.ts` (slice 3c): turns, cancel, the event log, the AG-UI stream, the budget;
 * - `session-ship.ts` (slice 3d): ship, end, the preview grant, the PR.
 *
 * Starting a session is `POST /api/apps/:id/sessions` (`routes/app-sessions.ts`), and the drain is
 * `/api/admin/sessions` (`routes/admin-sessions.ts`). Routes START work — they write the request
 * columns and wake the `SessionWorkflow` (`SESSION_WAKE_EVENT`); the Workflow does it. A missing
 * `SESSION_WORKFLOW` binding is a 503 `sessions_not_configured` before any row is written.
 *
 * The two sub-routers are mounted FIRST: Hono matches in registration order, and a `/:id` route
 * here must never shadow `/:id/turns` there.
 */
import { guardPermission } from '../middleware/permissions'
import { getVisibleSession, sessionViewerOf } from '../services/sessions/access'
import { toSessionDetail } from '../services/sessions/chat'
import { requestAction } from '../services/sessions/lifecycle'
import type { AppContext } from '../types'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { sessionChatRouter } from './session-chat'
import { sessionShipRouter } from './session-ship'

export const sessionsRouter = createRouter()

sessionsRouter.route('/', sessionChatRouter)
sessionsRouter.route('/', sessionShipRouter)

/** The session if the caller may see it (else the SAME 404 as a missing one), with the context. */
async function visibleSession(c: AppContext, action: 'read' | 'update') {
  const auth = guardPermission(c, action, 'Session')
  const ctx = withAuthAndDb(c)
  const session = await getVisibleSession(
    ctx.db,
    ctx.tenantId,
    uuidParam(c, 'id'),
    sessionViewerOf(auth)
  )
  return { ...ctx, session }
}

sessionsRouter.get('/:id', async c => {
  const { session } = await visibleSession(c, 'read')
  // Visible means drivable: the creator, the app's owners and admins (`access.ts`).
  return c.json({ session: toSessionDetail(session, true) })
})

/** Resume a suspended session: `requested_action = 'resume'` + a wake → 202. */
sessionsRouter.post('/:id/resume', async c => {
  const { db, session, realtime, logger } = await visibleSession(c, 'update')
  const row = await requestAction(db, c.env, session, 'resume', { realtime, logger })
  return c.json({ session: toSessionDetail(row, true) }, 202)
})
