/**
 * The ship half of `/api/sessions` (Launch P3, slice 3d), mounted by `routes/sessions.ts` with
 * `sessionsRouter.route('/', sessionShipRouter)`, behind the `/api/sessions` mount's
 * `authMiddleware`. Every route resolves the session with `getVisibleSession`
 * (`services/sessions/access.ts`).
 *
 * - `POST /:id/ship` → 202 `sessionDetailResponseSchema`: `requested_action = 'ship'` + a wake;
 *   the Workflow runs the `session-ship` turn (gate, fix, `{ title, body }`), checkpoints and opens
 *   the PR.
 * - `POST /:id/end` → 202 `sessionDetailResponseSchema`: `requested_action = 'end'` + a wake.
 * - `POST /:id/preview-grant` → `previewGrantResponseSchema`: a 60 s HMAC grant for the iframe
 *   (`services/sessions/preview.ts`, served by `api/preview/gateway.ts`).
 * - `GET /:id/pr` → `sessionPrResponseSchema`, refreshing `pr_checks` when older than 30 s.
 *
 * From 3a it registers nothing.
 */
import { createRouter } from '../utils/routes/router'

export const sessionShipRouter = createRouter()
