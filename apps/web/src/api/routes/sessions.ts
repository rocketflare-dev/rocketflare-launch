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
import { createRouter } from '../utils/routes/router'
import { sessionChatRouter } from './session-chat'
import { sessionShipRouter } from './session-ship'

export const sessionsRouter = createRouter()

sessionsRouter.route('/', sessionChatRouter)
sessionsRouter.route('/', sessionShipRouter)
