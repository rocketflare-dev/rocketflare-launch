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
 */
import { createSessionRequestSchema, sessionListQuerySchema } from '@launch/shared/launch-sessions'
import { guardPermission } from '../middleware/permissions'
import { getAppRow, mayDeployApp } from '../services/launch/apps'
import { auditActor } from '../services/launch/audit'
import { sessionViewerOf } from '../services/sessions/access'
import { toSessionDetail } from '../services/sessions/chat'
import { createSession, listAppSessions } from '../services/sessions/lifecycle'
import { toSessionSummary } from '../services/sessions/views'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const appSessionsRouter = createRouter()

appSessionsRouter.post('/:id/sessions', validate('json', createSessionRequestSchema), async c => {
  guardPermission(c, 'read', 'App')
  guardPermission(c, 'create', 'Session')
  const { db, tenantId, user, realtime } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  const session = await createSession(db, c.env, {
    tenantId,
    app,
    userId: user.id,
    request: c.req.valid('json'),
    actor: auditActor(c),
    realtime,
  })
  return c.json({ session: toSessionDetail(session, true) }, 202)
})

appSessionsRouter.get('/:id/sessions', validate('query', sessionListQuerySchema), async c => {
  guardPermission(c, 'read', 'App')
  const auth = guardPermission(c, 'read', 'Session')
  const { db, tenantId, user } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  const viewer = sessionViewerOf(auth)
  // The app's owners and admins see every session on it; anyone else their own.
  const seesAll = await mayDeployApp(db, tenantId, app, viewer)
  const rows = await listAppSessions(db, tenantId, app.id, {
    scope: c.req.valid('query').scope,
    onlyCreatedBy: seesAll ? null : user.id,
  })
  return c.json({ items: rows.map(toSessionSummary) })
})
