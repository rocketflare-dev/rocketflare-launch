/**
 * Who may see and drive a coding session (Launch P3, plan §1.6): **the creator, the app's owners
 * (a named owner or a member of its owner group) and the organisation's admins** — the same people
 * for viewing the chat, the preview, shipping, ending and extending the budget. `Session` in the
 * ability matrix only says a member may create and update sessions at all; WHICH ones is this
 * module, as `AgentRun`'s "own runs" is its route's filter.
 *
 * A session the caller may not see answers the SAME 404 as one that does not exist
 * (`session_not_found`), so a session id is never confirmed to someone outside it. Every lookup is
 * tenant-first. Shared by the three route files (`routes/sessions.ts`, `session-chat.ts`,
 * `session-ship.ts`) and the preview gateway, so no slice re-derives the rule.
 */
import type { AppAbility } from '@launch/shared/permissions'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { apps, type SessionRow, sessions } from '../../../db/schema'
import { NotFoundError } from '../../utils/core/errors'
import { type AppViewer, mayDeployApp } from '../launch/apps'

/** `AppViewer` with `isAdmin` meaning `manage Session`. */
export type SessionViewer = AppViewer

/** The viewer from an auth context's user, groups and ability. */
export function sessionViewerOf(auth: {
  user: { id: string }
  groups: readonly { id: string }[]
  ability: AppAbility
}): SessionViewer {
  return {
    userId: auth.user.id,
    groupIds: auth.groups.map(g => g.id),
    isAdmin: auth.ability.can('manage', 'Session'),
  }
}

/** The session row by id, tenant-first; 404 `session_not_found` otherwise. */
export async function getSessionRow(
  db: Database,
  tenantId: string,
  sessionId: string
): Promise<SessionRow> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)))
    .limit(1)
  if (!row) throw new NotFoundError('Session not found', 'session_not_found')
  return row
}

/** May `viewer` see — and drive — `session`: its creator, the app's owners, or an admin. */
export async function maySeeSession(
  db: Database,
  tenantId: string,
  session: Pick<SessionRow, 'appId' | 'createdByUserId'>,
  viewer: SessionViewer
): Promise<boolean> {
  if (viewer.isAdmin) return true
  if (session.createdByUserId && session.createdByUserId === viewer.userId) return true
  const [app] = await db
    .select({ id: apps.id, ownerGroupId: apps.ownerGroupId })
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, session.appId)))
    .limit(1)
  return app ? mayDeployApp(db, tenantId, app, { ...viewer, isAdmin: false }) : false
}

/** The session if `viewer` may see it; otherwise the SAME 404 as a missing one. */
export async function getVisibleSession(
  db: Database,
  tenantId: string,
  sessionId: string,
  viewer: SessionViewer
): Promise<SessionRow> {
  const row = await getSessionRow(db, tenantId, sessionId)
  if (!(await maySeeSession(db, tenantId, row, viewer))) {
    throw new NotFoundError('Session not found', 'session_not_found')
  }
  return row
}
