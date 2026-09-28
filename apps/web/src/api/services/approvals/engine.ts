/**
 * The approvals engine (Launch P4, plan §1.2–§1.4). Generic: it knows nothing about apps or
 * deploys, and everything kind-specific is a `KindHandler` method (`kinds/index.ts`).
 *
 * - `open`: resolve the policy (`policy.ts`) and snapshot it with the excluded set and the expiry;
 *   auto-approve when `autoApproveRole` is met (still a row, decided by `system`, audited, its
 *   `applyInTx` in the same transaction); otherwise an idempotent insert against the
 *   pending-subject index (asking twice finds the open request); audit `approval.requested`; notify
 *   the eligible approvers (`notify.ts`).
 * - `decide`: ONE transaction — `SELECT … FOR UPDATE` the row, eligibility and the excluded set
 *   (`canDecide`, evaluated NOW), insert the decision (unique `(request_id, user_id)` → 409
 *   `already_decided`), one reject vetoes and N approvals approve, `applyInTx`, audit
 *   `approval.decided` (+ `approval.approved|rejected`). Two approvers racing serialise on the row
 *   lock: the second finds it closed → 409 `not_pending`. After commit: `applyAfter`, then the
 *   requester is told.
 * - `applyAfter` runs after commit and is owed until `applied_at` is set. Each attempt is claimed
 *   by incrementing `apply_attempts` (a compare-and-set on `applied_at IS NULL` and the attempt
 *   count; the sweep's claim also needs the row untouched for `APPLY_RETRY_BACKOFF_MS`, so two
 *   sweeps, or a sweep and a slow first attempt, never run it twice at once). A failure records
 *   `apply_error`; the fifth failed attempt audits `approval.apply_failed` and notifies.
 * - `cancel` (the requester or an admin), `expire` (the sweep, a compare-and-set on `pending` and
 *   `expires_at`), both then the kind's `onClosed`.
 * - `list(box)`, `detail`, `count`: a request the viewer may not see (`canSee`) is the same 404 as
 *   a missing one, and never appears in a list.
 *
 * Every query names the tenant. Every transition is audited with `approval_id`.
 */
import {
  APPROVAL_ERROR_CODES,
  APPROVAL_MAX_APPLY_ATTEMPTS,
  type ApprovalDetail,
  type ApprovalRequest,
  type ApprovalWhyNot,
  type BuiltApprovalKind,
  meetsAutoApproveRole,
} from '@launch/shared/launch-approvals'
import { and, desc, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type ApprovalRequestRow,
  approvalDecisions,
  approvalRequests,
  apps,
  users,
} from '../../../db/schema'
import { ConflictError, ForbiddenError, NotFoundError } from '../../utils/core/errors'
import { type AuditActor, recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import { kindHandler } from './kinds'
import {
  notifyApplyFailed,
  notifyDecided,
  notifyExpired,
  notifyRequested,
  nudgeApproval,
} from './notify'
import {
  canDecide,
  canSee,
  eligibleApprovers,
  excludedFrom,
  isNamedApprover,
  resolvePolicy,
  type ViewerScope,
  viewerScopeOf,
} from './policy'
import type {
  ApprovalClosedStatus,
  ApprovalDeps,
  ApprovalViewer,
  CancelApprovalInput,
  DecideApprovalInput,
  ListApprovalsInput,
  OpenApprovalInput,
  OpenApprovalResult,
} from './types'

/** The sweep retries an owed `applyAfter` only when the row has been quiet this long. */
export const APPLY_RETRY_BACKOFF_MS = 4 * 60 * 1000

/** `apply_error` is a sentence for a person, not a stack. */
const APPLY_ERROR_MAX = 1000

/** Pending rows the `mine` box scans before filtering by eligibility in code. */
const MINE_SCAN_LIMIT = 500

const nowOf = (deps: Pick<ApprovalDeps, 'now'>) => deps.now?.() ?? new Date()

/** The transaction as the `Database` every helper takes (the kit's cast, `services/access.ts`). */
function inTransaction<T>(db: Database, fn: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async tx => fn(tx as unknown as Database))
}

function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.slice(0, APPLY_ERROR_MAX)
}

/** The 403 or 409 a refused decision answers with. */
function refusal(whyNot: ApprovalWhyNot): Error {
  switch (whyNot) {
    case 'not_pending':
      return new ConflictError(
        'This request has already been decided',
        APPROVAL_ERROR_CODES.notPending
      )
    case 'already_decided':
      return new ConflictError(
        'You have already decided this request',
        APPROVAL_ERROR_CODES.alreadyDecided
      )
    case 'self_approval':
      return new ForbiddenError(
        'You cannot decide a request you raised or authored',
        APPROVAL_ERROR_CODES.selfApproval
      )
    case 'not_an_approver':
      return new ForbiddenError(
        'You are not an approver for this request',
        APPROVAL_ERROR_CODES.notAnApprover
      )
  }
}

async function findRequest(
  db: Database,
  tenantId: string,
  requestId: string,
  lock = false
): Promise<ApprovalRequestRow | null> {
  const query = db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, requestId)))
  const [row] = lock ? await query.for('update') : await query
  return row ?? null
}

async function findPendingFor(db: Database, input: OpenApprovalInput) {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, input.tenantId),
        eq(approvalRequests.kind, input.kind),
        eq(approvalRequests.subjectType, input.subject.type),
        eq(approvalRequests.subjectId, input.subject.id),
        input.appId ? eq(approvalRequests.appId, input.appId) : isNull(approvalRequests.appId),
        eq(approvalRequests.status, 'pending')
      )
    )
  return row ?? null
}

async function deciderIds(db: Database, request: ApprovalRequestRow): Promise<string[]> {
  const rows = await db
    .select({ userId: approvalDecisions.userId })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.tenantId, request.tenantId),
        eq(approvalDecisions.requestId, request.id)
      )
    )
  return rows.map(r => r.userId)
}

/** Best-effort after commit: the kind's reaction to a request closing without approval. */
async function closed(
  deps: ApprovalDeps,
  request: ApprovalRequestRow,
  status: ApprovalClosedStatus
) {
  const handler = kindHandler(request.kind)
  if (!handler.onClosed) return
  try {
    await handler.onClosed(request, status, deps)
  } catch (err) {
    deps.logger.error(
      { err, approvalId: request.id, status },
      'approvals: onClosed failed (the request stays closed)'
    )
  }
}

// ---- open --------------------------------------------------------------------------------------

/**
 * Generic in the kind so a caller's `OpenApprovalInput<'deploy.production'>` is accepted as is
 * (`ApprovalContextOf<K>` is a conditional type, which makes the input invariant in `K`).
 */
export async function open<K extends BuiltApprovalKind>(
  deps: ApprovalDeps,
  typed: OpenApprovalInput<K>
): Promise<OpenApprovalResult> {
  const input = typed as unknown as OpenApprovalInput
  const handler = kindHandler(input.kind)
  const existing = await findPendingFor(deps.db, input)
  if (existing) return { request: existing, created: false, autoApproved: false }

  const now = nowOf(deps)
  const policy = await resolvePolicy(deps.db, input.tenantId, input.kind, input.appId)
  const requester = 'userId' in input.requester ? input.requester : null
  const autoApproved = Boolean(
    requester?.role &&
      policy.autoApproveRole &&
      meetsAutoApproveRole(requester.role, policy.autoApproveRole)
  )
  const excluded = [
    ...new Set([...(requester ? [requester.userId] : []), ...(input.excludedUserIds ?? [])]),
  ]
  let expiresAt = policy.expiresAfterMinutes
    ? new Date(now.getTime() + policy.expiresAfterMinutes * 60_000)
    : null
  if (input.expiresNoLaterThan && (!expiresAt || input.expiresNoLaterThan < expiresAt)) {
    expiresAt = input.expiresNoLaterThan
  }
  const actor: AuditActor =
    input.actor ??
    (requester
      ? {
          ...SYSTEM_ACTOR,
          actorType: 'user',
          actorUserId: requester.userId,
          actorEmail: requester.email,
        }
      : SYSTEM_ACTOR)

  const inserted = await inTransaction(deps.db, async tx => {
    const [row] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: input.tenantId,
        kind: input.kind,
        appId: input.appId,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        status: autoApproved ? 'approved' : 'pending',
        requestedByUserId: requester?.userId ?? null,
        requestedByLabel: 'label' in input.requester ? input.requester.label : null,
        reason: input.reason ?? null,
        context: input.context,
        policy,
        requiredApprovals: policy.minApprovals,
        excludedUserIds: excluded,
        expiresAt: autoApproved ? null : expiresAt,
        decidedAt: autoApproved ? now : null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) return null
    await recordAudit(tx, {
      tenantId: input.tenantId,
      ...actor,
      action: 'approval.requested',
      targetType: input.subject.type,
      targetId: input.subject.id,
      appId: input.appId,
      approvalId: row.id,
      summary: {
        after: {
          kind: input.kind,
          requiredApprovals: row.requiredApprovals,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          ...(row.requestedByLabel ? { requestedBy: row.requestedByLabel } : {}),
        },
      },
    })
    if (autoApproved) {
      await handler.applyInTx(tx, row, { ...deps, db: tx })
      await recordAudit(tx, {
        tenantId: input.tenantId,
        ...SYSTEM_ACTOR,
        action: 'approval.approved',
        targetType: input.subject.type,
        targetId: input.subject.id,
        appId: input.appId,
        approvalId: row.id,
        summary: {
          before: { status: 'pending' },
          after: {
            status: 'approved',
            decidedBy: 'system',
            autoApproveRole: policy.autoApproveRole,
          },
        },
      })
    }
    return row
  })

  if (!inserted) {
    // Another open for the same subject won the pending index between our read and our insert.
    const winner = await findPendingFor(deps.db, input)
    if (!winner) throw new Error('approval_requests: neither inserted nor found')
    return { request: winner, created: false, autoApproved: false }
  }
  if (autoApproved) {
    await runApplyAfter(deps, inserted)
    const request = (await findRequest(deps.db, input.tenantId, inserted.id)) ?? inserted
    await nudgeApproval(deps, request, [])
    return { request, created: true, autoApproved: true }
  }
  const approvers = await eligibleApprovers(deps.db, inserted)
  await notifyRequested(deps, inserted, approvers)
  return { request: inserted, created: true, autoApproved: false }
}

// ---- decide ------------------------------------------------------------------------------------

export async function decide(
  deps: ApprovalDeps,
  input: DecideApprovalInput
): Promise<ApprovalDetail> {
  const { viewer } = input
  const now = nowOf(deps)
  const scope = await viewerScopeOf(deps.db, viewer)
  const comment = input.comment?.trim() ? input.comment.trim() : null

  const outcome = await inTransaction(deps.db, async tx => {
    const row = await findRequest(tx, viewer.tenantId, input.requestId, true)
    if (!row || !(await canSee(tx, row, scope, await deciderIds(tx, row)))) {
      throw new NotFoundError('Approval request not found')
    }
    const verdict = await canDecide(tx, row, viewer, scope)
    if (!verdict.canDecide && verdict.whyNot) throw refusal(verdict.whyNot)

    const [decision] = await tx
      .insert(approvalDecisions)
      .values({
        tenantId: row.tenantId,
        requestId: row.id,
        userId: viewer.userId,
        userEmail: viewer.email,
        decision: input.decision,
        comment,
        at: now,
      })
      .onConflictDoNothing()
      .returning()
    if (!decision) throw refusal('already_decided')

    const [{ approvals } = { approvals: 0 }] = await tx
      .select({ approvals: sql<number>`count(*)::int` })
      .from(approvalDecisions)
      .where(
        and(
          eq(approvalDecisions.tenantId, row.tenantId),
          eq(approvalDecisions.requestId, row.id),
          eq(approvalDecisions.decision, 'approve')
        )
      )
    const status =
      input.decision === 'reject'
        ? 'rejected'
        : approvals >= row.requiredApprovals
          ? 'approved'
          : 'pending'

    let request = row
    if (status !== 'pending') {
      const [updated] = await tx
        .update(approvalRequests)
        .set({ status, decidedAt: now, updatedAt: now })
        .where(
          and(
            eq(approvalRequests.tenantId, row.tenantId),
            eq(approvalRequests.id, row.id),
            eq(approvalRequests.status, 'pending')
          )
        )
        .returning()
      if (!updated) throw refusal('not_pending')
      request = updated
      if (status === 'approved') {
        await kindHandler(request.kind).applyInTx(tx, request, { ...deps, db: tx })
      }
    }

    const target = {
      tenantId: row.tenantId,
      ...input.actor,
      targetType: row.subjectType,
      targetId: row.subjectId,
      appId: row.appId,
      approvalId: row.id,
    }
    await recordAudit(tx, {
      ...target,
      action: 'approval.decided',
      summary: {
        after: {
          decision: input.decision,
          approvals,
          requiredApprovals: row.requiredApprovals,
          ...(comment ? { comment } : {}),
        },
      },
    })
    if (status !== 'pending') {
      await recordAudit(tx, {
        ...target,
        action: status === 'approved' ? 'approval.approved' : 'approval.rejected',
        summary: { before: { status: 'pending' }, after: { status } },
      })
    }
    return { request, status }
  })

  const { request, status } = outcome
  if (status === 'approved') await runApplyAfter(deps, request)
  if (status === 'rejected') await closed(deps, request, 'rejected')
  if (status !== 'pending') {
    const latest = (await findRequest(deps.db, request.tenantId, request.id)) ?? request
    await notifyDecided(deps, latest, comment)
    await nudgeApproval(deps, latest, await eligibleApprovers(deps.db, latest))
  } else {
    await nudgeApproval(deps, request, [])
  }
  return detail(deps, { requestId: request.id, viewer })
}

// ---- applyAfter and its retries -----------------------------------------------------------------

/**
 * One attempt at an approved request's owed `applyAfter`. The claim increments `apply_attempts` as
 * a compare-and-set on the row still being owed (and, for a retry, quiet since `quietSince`);
 * success sets `applied_at`, failure `apply_error` — and the last allowed failure gives up loudly.
 */
async function runApplyAfter(
  deps: ApprovalDeps,
  request: ApprovalRequestRow,
  quietSince?: Date
): Promise<'applied' | 'failed' | 'gave_up' | 'not_owed'> {
  const now = nowOf(deps)
  const owned = and(
    eq(approvalRequests.tenantId, request.tenantId),
    eq(approvalRequests.id, request.id)
  )
  const [claimed] = await deps.db
    .update(approvalRequests)
    .set({ applyAttempts: sql`${approvalRequests.applyAttempts} + 1`, updatedAt: now })
    .where(
      and(
        owned,
        eq(approvalRequests.status, 'approved'),
        isNull(approvalRequests.appliedAt),
        lt(approvalRequests.applyAttempts, APPROVAL_MAX_APPLY_ATTEMPTS),
        quietSince ? lte(approvalRequests.updatedAt, quietSince) : undefined
      )
    )
    .returning()
  if (!claimed) return 'not_owed'

  try {
    await kindHandler(claimed.kind).applyAfter(claimed, deps)
  } catch (err) {
    const applyError = errorMessage(err)
    deps.logger.warn(
      { err, approvalId: claimed.id, attempt: claimed.applyAttempts },
      'approvals: applyAfter failed'
    )
    const [failed] = await deps.db
      .update(approvalRequests)
      .set({ applyError, updatedAt: now })
      .where(and(owned, isNull(approvalRequests.appliedAt)))
      .returning()
    if (claimed.applyAttempts < APPROVAL_MAX_APPLY_ATTEMPTS) return 'failed'
    await recordAudit(deps.db, {
      tenantId: claimed.tenantId,
      ...SYSTEM_ACTOR,
      action: 'approval.apply_failed',
      targetType: claimed.subjectType,
      targetId: claimed.subjectId,
      appId: claimed.appId,
      approvalId: claimed.id,
      summary: { after: { attempts: claimed.applyAttempts, error: applyError } },
    })
    await notifyApplyFailed(deps, failed ?? { ...claimed, applyError })
    await nudgeApproval(deps, failed ?? claimed, [])
    return 'gave_up'
  }

  await deps.db
    .update(approvalRequests)
    .set({ appliedAt: now, applyError: null, updatedAt: now })
    .where(and(owned, isNull(approvalRequests.appliedAt)))
  return 'applied'
}

/** Retry an approved request's owed `applyAfter` (the sweep calls this). */
export async function retryApply(
  deps: ApprovalDeps,
  input: { tenantId: string; requestId: string }
): Promise<'applied' | 'failed' | 'gave_up' | 'not_owed'> {
  const row = await findRequest(deps.db, input.tenantId, input.requestId)
  if (!row) return 'not_owed'
  const quietSince = new Date(nowOf(deps).getTime() - APPLY_RETRY_BACKOFF_MS)
  return runApplyAfter(deps, row, quietSince)
}

// ---- cancel and expire -------------------------------------------------------------------------

export async function cancel(
  deps: ApprovalDeps,
  input: CancelApprovalInput
): Promise<ApprovalDetail> {
  const { viewer } = input
  const now = nowOf(deps)
  const scope = await viewerScopeOf(deps.db, viewer)
  const reason = input.reason?.trim() ? input.reason.trim() : null
  const request = await inTransaction(deps.db, async tx => {
    const row = await findRequest(tx, viewer.tenantId, input.requestId, true)
    if (!row || !(await canSee(tx, row, scope, await deciderIds(tx, row)))) {
      throw new NotFoundError('Approval request not found')
    }
    if (row.status !== 'pending') throw refusal('not_pending')
    if (row.requestedByUserId !== viewer.userId && !viewer.isAdmin) {
      throw new ForbiddenError('Only the requester or an admin can cancel this request')
    }
    const [updated] = await tx
      .update(approvalRequests)
      .set({ status: 'cancelled', decidedAt: now, updatedAt: now })
      .where(and(eq(approvalRequests.tenantId, row.tenantId), eq(approvalRequests.id, row.id)))
      .returning()
    if (!updated) throw refusal('not_pending')
    await recordAudit(tx, {
      tenantId: row.tenantId,
      ...input.actor,
      action: 'approval.cancelled',
      targetType: row.subjectType,
      targetId: row.subjectId,
      appId: row.appId,
      approvalId: row.id,
      summary: {
        before: { status: 'pending' },
        after: { status: 'cancelled', ...(reason ? { reason } : {}) },
      },
    })
    return updated
  })
  await closed(deps, request, 'cancelled')
  await nudgeApproval(deps, request, await eligibleApprovers(deps.db, request))
  return detail(deps, { requestId: request.id, viewer })
}

/** Expire one pending request past its `expires_at` (the sweep calls this); null if not due. */
export async function expire(
  deps: ApprovalDeps,
  input: { tenantId: string; requestId: string }
): Promise<ApprovalRequestRow | null> {
  const now = nowOf(deps)
  const request = await inTransaction(deps.db, async tx => {
    const [row] = await tx
      .update(approvalRequests)
      .set({ status: 'expired', decidedAt: now, updatedAt: now })
      .where(
        and(
          eq(approvalRequests.tenantId, input.tenantId),
          eq(approvalRequests.id, input.requestId),
          eq(approvalRequests.status, 'pending'),
          lte(approvalRequests.expiresAt, now)
        )
      )
      .returning()
    if (!row) return null
    await recordAudit(tx, {
      tenantId: row.tenantId,
      ...SYSTEM_ACTOR,
      action: 'approval.expired',
      targetType: row.subjectType,
      targetId: row.subjectId,
      appId: row.appId,
      approvalId: row.id,
      summary: {
        before: { status: 'pending' },
        after: { status: 'expired', expiresAt: row.expiresAt?.toISOString() ?? null },
      },
    })
    return row
  })
  if (!request) return null
  await closed(deps, request, 'expired')
  await notifyExpired(deps, request)
  await nudgeApproval(deps, request, await eligibleApprovers(deps.db, request))
  return request
}

// ---- reads -------------------------------------------------------------------------------------

/** Rows → the wire shape, with the app, the requester and the approval count in three queries. */
async function toApprovalRequests(
  db: Database,
  tenantId: string,
  rows: ApprovalRequestRow[]
): Promise<ApprovalRequest[]> {
  if (rows.length === 0) return []
  const appIds = [...new Set(rows.flatMap(r => (r.appId ? [r.appId] : [])))]
  const userIds = [
    ...new Set(rows.flatMap(r => (r.requestedByUserId ? [r.requestedByUserId] : []))),
  ]
  const appRows =
    appIds.length === 0
      ? []
      : await db
          .select({ id: apps.id, slug: apps.slug, displayName: apps.displayName })
          .from(apps)
          .where(and(eq(apps.tenantId, tenantId), inArray(apps.id, appIds)))
  const people =
    userIds.length === 0
      ? []
      : await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, userIds))
  const counts = await db
    .select({ requestId: approvalDecisions.requestId, n: sql<number>`count(*)::int` })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.tenantId, tenantId),
        inArray(
          approvalDecisions.requestId,
          rows.map(r => r.id)
        ),
        eq(approvalDecisions.decision, 'approve')
      )
    )
    .groupBy(approvalDecisions.requestId)
  const appById = new Map(appRows.map(a => [a.id, a]))
  const personById = new Map(people.map(p => [p.id, p]))
  const countById = new Map(counts.map(c => [c.requestId, c.n]))
  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    appId: r.appId,
    app: (r.appId && appById.get(r.appId)) || null,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    requestedByUserId: r.requestedByUserId,
    requestedByLabel: r.requestedByLabel,
    requester: (r.requestedByUserId && personById.get(r.requestedByUserId)) || null,
    reason: r.reason,
    context: r.context,
    policy: r.policy,
    requiredApprovals: r.requiredApprovals,
    approvals: countById.get(r.id) ?? 0,
    expiresAt: r.expiresAt,
    decidedAt: r.decidedAt,
    appliedAt: r.appliedAt,
    applyError: r.applyError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}

/** Pending requests waiting on this viewer: eligible now, not excluded, not yet decided by them. */
async function waitingOn(
  db: Database,
  scope: ViewerScope,
  filters: { kind?: ApprovalRequestRow['kind']; appId?: string }
): Promise<ApprovalRequestRow[]> {
  const { viewer } = scope
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, viewer.tenantId),
        eq(approvalRequests.status, 'pending'),
        filters.kind ? eq(approvalRequests.kind, filters.kind) : undefined,
        filters.appId ? eq(approvalRequests.appId, filters.appId) : undefined
      )
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(MINE_SCAN_LIMIT)
  if (rows.length === 0) return []
  const decided = await db
    .select({ requestId: approvalDecisions.requestId })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.tenantId, viewer.tenantId),
        eq(approvalDecisions.userId, viewer.userId),
        inArray(
          approvalDecisions.requestId,
          rows.map(r => r.id)
        )
      )
    )
  const done = new Set(decided.map(d => d.requestId))
  const out: ApprovalRequestRow[] = []
  for (const row of rows) {
    if (done.has(row.id) || excludedFrom(row).has(viewer.userId)) continue
    if (await isNamedApprover(db, row, scope)) out.push(row)
  }
  return out
}

export async function list(
  deps: Pick<ApprovalDeps, 'db'>,
  input: ListApprovalsInput
): Promise<ApprovalRequest[]> {
  const { db } = deps
  const { viewer, query } = input
  const box = query.box === 'all' && !viewer.isAdmin ? 'mine' : query.box
  let rows: ApprovalRequestRow[]
  if (box === 'mine') {
    if (query.status && query.status !== 'pending') return []
    const scope = await viewerScopeOf(db, viewer)
    rows = (await waitingOn(db, scope, query)).slice(0, query.limit)
  } else {
    rows = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, viewer.tenantId),
          box === 'requested' ? eq(approvalRequests.requestedByUserId, viewer.userId) : undefined,
          query.status ? eq(approvalRequests.status, query.status) : undefined,
          query.kind ? eq(approvalRequests.kind, query.kind) : undefined,
          query.appId ? eq(approvalRequests.appId, query.appId) : undefined
        )
      )
      .orderBy(desc(approvalRequests.createdAt))
      .limit(query.limit)
  }
  return toApprovalRequests(db, viewer.tenantId, rows)
}

export async function detail(
  deps: Pick<ApprovalDeps, 'db'>,
  input: { requestId: string; viewer: ApprovalViewer }
): Promise<ApprovalDetail> {
  const { db } = deps
  const { viewer } = input
  const row = await findRequest(db, viewer.tenantId, input.requestId)
  if (!row) throw new NotFoundError('Approval request not found')
  const decisions = await db
    .select({
      id: approvalDecisions.id,
      requestId: approvalDecisions.requestId,
      userId: approvalDecisions.userId,
      userEmail: approvalDecisions.userEmail,
      userName: users.name,
      decision: approvalDecisions.decision,
      comment: approvalDecisions.comment,
      at: approvalDecisions.at,
    })
    .from(approvalDecisions)
    .leftJoin(users, eq(users.id, approvalDecisions.userId))
    .where(
      and(eq(approvalDecisions.tenantId, viewer.tenantId), eq(approvalDecisions.requestId, row.id))
    )
    .orderBy(approvalDecisions.at)
  const scope = await viewerScopeOf(db, viewer)
  if (
    !(await canSee(
      db,
      row,
      scope,
      decisions.map(d => d.userId)
    ))
  ) {
    throw new NotFoundError('Approval request not found')
  }
  const verdict = await canDecide(db, row, viewer, scope)
  const [request] = await toApprovalRequests(db, viewer.tenantId, [row])
  if (!request) throw new NotFoundError('Approval request not found')
  return {
    ...request,
    decisions: decisions.map(d => ({ ...d, userName: d.userName ?? null })),
    canDecide: verdict.canDecide,
    whyNot: verdict.whyNot,
    canCancel:
      row.status === 'pending' && (row.requestedByUserId === viewer.userId || viewer.isAdmin),
  }
}

/** Pending requests waiting on `viewer` — the nav badge. */
export async function count(
  deps: Pick<ApprovalDeps, 'db'>,
  input: { viewer: ApprovalViewer }
): Promise<number> {
  const scope = await viewerScopeOf(deps.db, input.viewer)
  return (await waitingOn(deps.db, scope, {})).length
}
