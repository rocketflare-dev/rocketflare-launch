/**
 * An app's coding sessions under `/api/apps` (Launch P3, slice 3b), mounted by `routes/apps.ts`
 * with `appsRouter.route('/', appSessionsRouter)` BEFORE its own `/:slug` routes, behind the
 * `/api/apps` mount's `authMiddleware`:
 *
 * - `POST /:id/sessions` `createSessionRequestSchema` → 202 `sessionDetailResponseSchema`
 *   (`create Session` on an app the caller can read): the policy snapshot, 409
 *   `sessions_paused` while drained, 409 `session_limit` at `maxConcurrentPerApp`, 409
 *   `session_budget_exhausted` over the app's month, 503 `sessions_not_configured` without
 *   `SESSION_WORKFLOW` — every refusal before any write; then the row, audit `session.created` and
 *   `SESSION_WORKFLOW.create({ id, params })`.
 * - `GET /:id/sessions[?scope=active|all]` → `sessionListResponseSchema` (members see their own;
 *   the app's owners and admins see all of the app's).
 *
 * From 3a it registers nothing.
 */
import { createRouter } from '../utils/routes/router'

export const appSessionsRouter = createRouter()
