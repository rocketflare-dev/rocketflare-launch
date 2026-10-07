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
 * Audited `sessions.drained` / `sessions.undrained` (in each organisation that had a live session,
 * and in the operator's own).
 */
import { sessionListQuerySchema } from '@launch/shared/launch-sessions'
import { auditActor } from '../services/launch/audit'
import {
  drainSessions,
  listAllSessions,
  sessionsPaused,
  undrainSessions,
} from '../services/sessions/lifecycle'
import { toAdminSession } from '../services/sessions/views'
import { withAuth } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const adminSessionsRouter = createRouter()

/** List every live coding session across the deployment, and whether new sessions are paused. */
adminSessionsRouter.get('/', validate('query', sessionListQuerySchema), async c => {
  const { db } = withAuth(c)
  const rows = await listAllSessions(db, c.req.valid('query').scope)
  return c.json({
    items: rows.map(r => toAdminSession(r.session, r.appSlug)),
    paused: await sessionsPaused(db),
  })
})

/**
 * Pause new coding sessions and ask every live session to suspend, ahead of a deploy that touches
 * the session image or `[[containers]]`. Audits `sessions.drained` in each affected organisation.
 */
adminSessionsRouter.post('/drain', async c => {
  const { db, user, tenantId, logger } = withAuth(c)
  return c.json(
    await drainSessions(db, c.env, {
      actor: auditActor(c),
      actorTenantId: tenantId,
      userId: user.id,
      logger,
    })
  )
})

/** Clear the session pause so people can resume their coding sessions. Audits `sessions.undrained`. */
adminSessionsRouter.post('/undrain', async c => {
  const { db, tenantId } = withAuth(c)
  return c.json(await undrainSessions(db, { actor: auditActor(c), actorTenantId: tenantId }))
})
