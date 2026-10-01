/**
 * Who may see and drive a coding session (Launch P3, plan §1.6): **the creator, the app's owners
 * (a named owner or a member of its owner group) and the organisation's admins** — the same people
 * for viewing the chat and the preview, sending messages, shipping and ending. **Extending the
 * budget is narrower: the app's owners and admins only** (plan §1.11 — the creator may see the cap
 * but not raise it; `POST /:id/budget` checks `mayDeployApp` on top of this). `Session` in the
 * ability matrix only says a member may create and update sessions at all; WHICH ones is this
 * module, as `AgentRun`'s "own runs" is its route's filter.
 *
 * Issue #5 (`docs/plans/i5-ship-to-staging.md` §1.12) adds a READ-ONLY grant: an eligible approver
 * of a PENDING `session.merge` request on the session (a member of a group the request's policy
 * names, or a user it names) may read it — the detail, the events and the stream, the preview
 * grant, the PR — to review what they are asked to merge; never send a turn, ship, end or extend.
 * `sessionAccessOf` answers `manage` / `review` / null; `getVisibleSession(…, { readOnly: true })`
 * is what the read routes pass. Everyone else, and a reviewer on a driving route, gets the 404.
 *
 * A session the caller may not see answers the SAME 404 as one that does not exist
 * (`session_not_found`), so a session id is never confirmed to someone outside it. Every lookup is
 * tenant-first. Shared by the three route files (`routes/sessions.ts`, `session-chat.ts`,
 * `session-ship.ts`) and the preview gateway, so no slice re-derives the rule.
 */
import type { ApprovalPolicy } from '@launch/shared/launch-approvals'
import type { AppAbility } from '@launch/shared/permissions'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { approvalRequests, apps, type SessionRow, sessions } from '../../../db/schema'
import { NotFoundError } from '../../utils/core/errors'
import { type AppViewer, mayDeployApp } from '../launch/apps'

/** `AppViewer` with `isAdmin` meaning `manage Session`. */
export type SessionViewer = AppViewer

/** `manage`: see and drive it (creator, app owners, admins); `review`: read it to approve its merge. */
export type SessionAccess = 'manage' | 'review'

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

/**
 * Issue #5: is `viewer` named by a PENDING `session.merge` request on `sessionId` — a member of
 * one of its policy's groups, or one of its users? (Its app owners and admins can see the session
 * anyway; the excluded set — the creator and the message writers — can too.)
 */
export async function mayReviewSession(
  db: Database,
  tenantId: string,
  sessionId: string,
  viewer: Pick<SessionViewer, 'userId' | 'groupIds'>
): Promise<boolean> {
  const rows = await db
    .select({ policy: approvalRequests.policy })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.kind, 'session.merge'),
        eq(approvalRequests.subjectType, 'session'),
        eq(approvalRequests.subjectId, sessionId),
        eq(approvalRequests.status, 'pending')
      )
    )
  return rows.some(({ policy }: { policy: ApprovalPolicy }) => {
    const { approvers } = policy
    return (
      approvers.userIds.includes(viewer.userId) ||
      approvers.groupIds.some(id => viewer.groupIds.includes(id))
    )
  })
}

/** What `viewer` may do with `session`: `manage`, `review` (read only), or nothing (null). */
export async function sessionAccessOf(
  db: Database,
  tenantId: string,
  session: Pick<SessionRow, 'id' | 'appId' | 'createdByUserId'>,
  viewer: SessionViewer
): Promise<SessionAccess | null> {
  if (await maySeeSession(db, tenantId, session, viewer)) return 'manage'
  if (await mayReviewSession(db, tenantId, session.id, viewer)) return 'review'
  return null
}

/**
 * The session if `viewer` may see it; otherwise the SAME 404 as a missing one. A reviewer
 * (`review` access) passes only with `readOnly` — the read routes; `canManage` says which it was.
 */
export async function getVisibleSession(
  db: Database,
  tenantId: string,
  sessionId: string,
  viewer: SessionViewer,
  opts: { readOnly?: boolean } = {}
): Promise<SessionRow> {
  return (await getSessionFor(db, tenantId, sessionId, viewer, opts)).row
}

/** {@link getVisibleSession}, with whether the viewer may also drive it (`viewerCanManage`). */
export async function getSessionFor(
  db: Database,
  tenantId: string,
  sessionId: string,
  viewer: SessionViewer,
  opts: { readOnly?: boolean } = {}
): Promise<{ row: SessionRow; canManage: boolean }> {
  const row = await getSessionRow(db, tenantId, sessionId)
  const access = await sessionAccessOf(db, tenantId, row, viewer)
  if (access === 'manage') return { row, canManage: true }
  if (access === 'review' && opts.readOnly) return { row, canManage: false }
  throw new NotFoundError('Session not found', 'session_not_found')
}
