/**
 * Approval notifications (Launch P4, plan §1.13).
 *
 * - In app: `notifyMany` to the eligible approvers (`approval_requested`) and to the requester
 *   (`approval_decided`, `approval_expired`) — the types in `APPROVAL_NOTIFICATION_TYPES`, each with
 *   `data: { approvalId, kind }`, linked to `approvalPath(id)` by `notificationLink`.
 * - Realtime: `entity.changed { entity: APPROVAL_REALTIME_ENTITY, id }` to the people a change
 *   concerns (`nudgeApproval`), so the inbox, the badge and the request's page refetch.
 * - Email: an `email.send` job per recipient (`email.ts` beside this file), to approvers on open
 *   and to the requester on a decision.
 *
 * Every function is best-effort after commit: a notification that fails is logged and never undoes
 * a decision (the row and its audit are the truth; the bell and the email are nudges).
 */
import {
  APPROVAL_NOTIFICATION_TYPES,
  APPROVAL_REALTIME_ENTITY,
  type ApprovalNotificationType,
  isBuiltApprovalKind,
} from '@launch/shared/launch-approvals'
import { and, eq, inArray } from 'drizzle-orm'
import type { ApprovalRequestRow } from '../../../db/schema'
import { approvalDecisions, users } from '../../../db/schema'
import { enqueueJobs } from '../jobs'
import { notifyMany } from '../notifications'
import { nudgeUsers, realtimeEvent } from '../realtime'
import { approvalDecidedEmail, approvalRequestedEmail } from './email'
import { kindHandler } from './kinds'
import type { ApprovalDeps } from './types'

/** The request's one-line title, from its kind (a kind without a handler falls back to its name). */
export function approvalTitle(request: ApprovalRequestRow): string {
  if (!isBuiltApprovalKind(request.kind)) return request.kind
  try {
    return kindHandler(request.kind).describe(request)
  } catch {
    return request.kind
  }
}

async function best(deps: ApprovalDeps, what: string, fn: () => Promise<void>) {
  try {
    await fn()
  } catch (err) {
    deps.logger.warn({ err, what }, 'approvals: a notification failed (the decision stands)')
  }
}

async function emailsOf(deps: ApprovalDeps, userIds: readonly string[]) {
  if (userIds.length === 0) return []
  return deps.db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(inArray(users.id, [...userIds]))
}

/** Who asked, for an email: their name, or the CI label. */
async function requesterLabel(deps: ApprovalDeps, request: ApprovalRequestRow): Promise<string> {
  if (request.requestedByUserId) {
    const [who] = await emailsOf(deps, [request.requestedByUserId])
    if (who) return who.name || who.email
  }
  return request.requestedByLabel ?? 'Someone'
}

async function inApp(
  deps: ApprovalDeps,
  request: ApprovalRequestRow,
  userIds: readonly string[],
  type: ApprovalNotificationType,
  title: string,
  body: string | null
) {
  await notifyMany(
    deps.db,
    [...userIds],
    {
      tenantId: request.tenantId,
      type,
      title,
      body,
      data: { approvalId: request.id, kind: request.kind },
    },
    deps.realtime
  )
}

/**
 * The realtime nudge for a request that changed. Everyone it concerns: the approvers, the
 * requester, and whoever decided (their inbox and badge move too).
 */
export async function nudgeApproval(
  deps: ApprovalDeps,
  request: ApprovalRequestRow,
  userIds: readonly string[]
): Promise<void> {
  await best(deps, 'nudge', async () => {
    const decided = await deps.db
      .select({ userId: approvalDecisions.userId })
      .from(approvalDecisions)
      .where(
        and(
          eq(approvalDecisions.tenantId, request.tenantId),
          eq(approvalDecisions.requestId, request.id)
        )
      )
    const who = new Set([...userIds, ...decided.map(d => d.userId)])
    if (request.requestedByUserId) who.add(request.requestedByUserId)
    nudgeUsers(
      deps.realtime,
      [...who],
      realtimeEvent('entity.changed', request.tenantId, {
        entity: APPROVAL_REALTIME_ENTITY,
        id: request.id,
      })
    )
  })
}

async function enqueueEmails(
  deps: ApprovalDeps,
  messages: Array<{ to: string; subject: string; html: string; text: string; link?: string }>,
  request: ApprovalRequestRow,
  reason: string
) {
  if (messages.length === 0) return
  if (!deps.env.JOBS_QUEUE) {
    deps.logger.warn({ approvalId: request.id }, 'approvals: no JOBS_QUEUE, emails not sent')
    return
  }
  await enqueueJobs(
    deps.env.JOBS_QUEUE,
    messages.map(m => ({
      type: 'email.send' as const,
      payload: { ...m, tenantId: request.tenantId, reason },
    }))
  )
}

/** A request opened: each eligible approver gets a notification and an email. */
export async function notifyRequested(
  deps: ApprovalDeps,
  request: ApprovalRequestRow,
  approverIds: readonly string[]
): Promise<void> {
  const title = approvalTitle(request)
  await best(deps, 'requested.in_app', async () => {
    await inApp(
      deps,
      request,
      approverIds,
      APPROVAL_NOTIFICATION_TYPES.requested,
      `Approval needed: ${title}`,
      request.reason
    )
  })
  await best(deps, 'requested.email', async () => {
    const requester = await requesterLabel(deps, request)
    const recipients = await emailsOf(deps, approverIds)
    await enqueueEmails(
      deps,
      recipients.map(r =>
        approvalRequestedEmail(deps.cfg, r.email, {
          approvalId: request.id,
          title,
          requester,
          reason: request.reason,
        })
      ),
      request,
      APPROVAL_NOTIFICATION_TYPES.requested
    )
  })
  await nudgeApproval(deps, request, approverIds)
}

/** Approved or rejected: the requester hears (a CI requester has nobody to tell). */
export async function notifyDecided(
  deps: ApprovalDeps,
  request: ApprovalRequestRow,
  comment: string | null = null
): Promise<void> {
  const requester = request.requestedByUserId
  if (!requester || (request.status !== 'approved' && request.status !== 'rejected')) return
  const status = request.status
  const title = approvalTitle(request)
  await best(deps, 'decided.in_app', async () => {
    await inApp(
      deps,
      request,
      [requester],
      APPROVAL_NOTIFICATION_TYPES.decided,
      `${status === 'approved' ? 'Approved' : 'Rejected'}: ${title}`,
      comment
    )
  })
  await best(deps, 'decided.email', async () => {
    const [who] = await emailsOf(deps, [requester])
    if (!who) return
    await enqueueEmails(
      deps,
      [
        approvalDecidedEmail(deps.cfg, who.email, {
          approvalId: request.id,
          title,
          status,
          comment,
        }),
      ],
      request,
      APPROVAL_NOTIFICATION_TYPES.decided
    )
  })
}

/** Expired with nobody deciding: the requester hears in app. */
export async function notifyExpired(
  deps: ApprovalDeps,
  request: ApprovalRequestRow
): Promise<void> {
  if (!request.requestedByUserId) return
  const requester = request.requestedByUserId
  await best(deps, 'expired.in_app', async () => {
    await inApp(
      deps,
      request,
      [requester],
      APPROVAL_NOTIFICATION_TYPES.expired,
      `Expired: ${approvalTitle(request)}`,
      'Nobody decided in time. Ask again if it is still needed.'
    )
  })
}

/**
 * Approved, but its effect could not be carried out after the last retry. The requester and
 * whoever approved hear — through `approval_decided`, so the bell links to the request, whose page
 * shows `applyError`.
 */
export async function notifyApplyFailed(
  deps: ApprovalDeps,
  request: ApprovalRequestRow
): Promise<void> {
  await best(deps, 'apply_failed.in_app', async () => {
    const deciders = await deps.db
      .select({ userId: approvalDecisions.userId })
      .from(approvalDecisions)
      .where(
        and(
          eq(approvalDecisions.tenantId, request.tenantId),
          eq(approvalDecisions.requestId, request.id)
        )
      )
    const who = new Set(deciders.map(d => d.userId))
    if (request.requestedByUserId) who.add(request.requestedByUserId)
    await inApp(
      deps,
      request,
      [...who],
      APPROVAL_NOTIFICATION_TYPES.decided,
      `Approved but not applied: ${approvalTitle(request)}`,
      request.applyError
    )
  })
}
