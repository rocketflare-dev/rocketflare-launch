/**
 * The chat half of `/api/sessions` (Launch P3, slice 3c), mounted by `routes/sessions.ts` with
 * `sessionsRouter.route('/', sessionChatRouter)`, behind the `/api/sessions` mount's
 * `authMiddleware`. Every route resolves the session with `getVisibleSession`
 * (`services/sessions/access.ts`): another person's session, or another tenant's, is a 404.
 *
 * - `POST /:id/turns` `sessionTurnRequestSchema` → 202 `sessionDetailResponseSchema`: stores
 *   `pending_message` and wakes the Workflow (`SESSION_WAKE_EVENT`); 409 `turn_in_progress` while
 *   one is pending or `working`, 409 `session_budget_exhausted` when `blocked`.
 * - `POST /:id/cancel` → `sessionCancelResponseSchema` (`cancel_requested_at`; the turn polls it).
 * - `GET /:id/agui/stream[?afterSeq=]` — the AG-UI read stream over `session_events`, the four rules
 *   of `services/agents/run-stream.ts` (`streamDatabase`, id on the last frame, no `RUN_ERROR` for
 *   its own failure, nothing that costs a subrequest inside the loop).
 * - `GET /:id/events[?afterSeq=]` → `sessionEventsResponseSchema`.
 * - `POST /:id/budget` `extendBudgetSchema` → `sessionDetailResponseSchema` (owners and admins;
 *   audited `session.budget.extended`).
 *
 * From 3a it registers nothing: an unmatched path under `/api` is the catch-all's JSON 404.
 */
import { createRouter } from '../utils/routes/router'

export const sessionChatRouter = createRouter()
