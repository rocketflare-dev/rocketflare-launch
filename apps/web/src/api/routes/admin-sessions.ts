/**
 * `/api/admin/sessions` (Launch P3, slice 3b) — behind `globalAdminMiddleware` at the mount, like
 * every `/api/admin/*` route: coding sessions are platform capacity (containers, `max_instances`,
 * one image), so draining them is the operator's act, not an organisation's.
 *
 * - `GET /` `sessionListQuerySchema` → `adminSessionListResponseSchema` (live sessions across the
 *   deployment, with `paused`).
 * - `POST /drain` → `drainResponseSchema`: sets `launch_settings.sessions_paused` (new sessions
 *   409) and asks every live session to suspend. `docs/DEPLOY.md` makes this a REQUIRED step
 *   before any deploy that touches the session image or `[[containers]]`.
 * - `POST /undrain` → `drainResponseSchema`: clears it; people resume their sessions.
 *
 * Audited `sessions.drained` / `sessions.undrained`. From 3a it registers nothing.
 */
import { createRouter } from '../utils/routes/router'

export const adminSessionsRouter = createRouter()
