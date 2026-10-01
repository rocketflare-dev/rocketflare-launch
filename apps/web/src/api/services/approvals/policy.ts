/**
 * Approval policies (Launch P4, plan §1.5) — who may decide a request, and how many must.
 *
 * - `resolvePolicy`: the first `approval_policies` row of app scope, then the app's owner group,
 *   then tenant (`findPolicyRow`), else the kind's `defaultPolicy()` — snapshotted onto the
 *   request at open, so an edit never changes a request already in flight.
 * - `eligibleApprovers`: the user ids who may decide `request` NOW — the app's owners
 *   (`app_owners` and the owner group's members, the same two sources `isAppOwner` reads), the
 *   organisation's admins (owner / admin / support), `groupIds` members, `userIds`, the kind's
 *   `eligibleExtra` — minus the excluded set unless `allowSelfApproval`. It is who gets NOTIFIED;
 *   `canDecide` is what GATES, and both read the same policy snapshot the same way.
 * - `canDecide`: one viewer against one request → `{ canDecide, whyNot }`. Eligibility is evaluated
 *   at decide time from the viewer (their role and groups on this request, their ownership read
 *   fresh), never from anything snapshotted at open (plan §1.3).
 * - `canSee`: who may read a request at all — anyone else gets the same 404 as a missing one.
 * - The admin surface (`listPolicies`, `putPolicy`, `removePolicy`) for `/api/approval-policies`.
 *   Only admins edit, at every scope: an app owner loosening their own gate defeats it. Issue #5's
 *   `session.merge` is the one kind an app's owners also shape — through the app's ship settings,
 *   over which an admin row here still wins (`services/launch/ship-settings.ts`).
 *
 * Every query names the tenant.
 */
import {
  APPROVAL_KINDS,
  type ApprovalKind,
  type ApprovalPolicy,
  type ApprovalPolicyListQuery,
  type ApprovalPolicyRow,
  type ApprovalWhyNot,
  DEFAULT_APPROVAL_POLICIES,
  isBuiltApprovalKind,
  type PutApprovalPolicyRequest,
} from '@launch/shared/launch-approvals'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import {
  type ApprovalRequestRow,
  appOwners,
  approvalDecisions,
  approvalPolicies,
  apps,
  groupMembers,
  groups,
  tenantUsers,
} from '../../../db/schema'
import { NotFoundError } from '../../utils/core/errors'
import { kindHandler } from './kinds'
import { findPolicyRow, toPolicy, toPolicyRow } from './policy-row'
import type { ApprovalViewer } from './types'

// The row lookup lives in a leaf (`policy-row.ts`: it imports no kind, so issue #5's ship settings
// can read it from the app detail without a cycle through the kind registry); re-exported here,
// beside `resolvePolicy`, so callers keep one module to import.
export { type FoundPolicyRow, findPolicyRow, toPolicyRow } from './policy-row'

/** The tenant roles the policy's `admins` means (support ranks with admin, as everywhere). */
const ADMIN_ROLES = ['owner', 'admin', 'support'] as const

// ---- resolution --------------------------------------------------------------------------------

/** The code default for `kind` in this tenant: the handler's (with its setting overlays) or the table. */
export async function defaultPolicyFor(
  db: Database,
  tenantId: string,
  kind: ApprovalKind
): Promise<ApprovalPolicy> {
  if (isBuiltApprovalKind(kind)) return kindHandler(kind).defaultPolicy(db, tenantId)
  return DEFAULT_APPROVAL_POLICIES[kind]
}

export async function resolvePolicy(
  db: Database,
  tenantId: string,
  kind: ApprovalKind,
  appId: string | null
): Promise<ApprovalPolicy> {
  const found = await findPolicyRow(db, tenantId, kind, appId)
  return found ? found.policy : defaultPolicyFor(db, tenantId, kind)
}

// ---- eligibility -------------------------------------------------------------------------------

/** The excluded set, unless the policy lets the requester (and the excluded) decide. */
export function excludedFrom(request: ApprovalRequestRow): Set<string> {
  if (request.policy.allowSelfApproval) return new Set()
  const out = new Set(request.excludedUserIds ?? [])
  if (request.requestedByUserId) out.add(request.requestedByUserId)
  return out
}

async function membersOfGroups(
  db: Database,
  tenantId: string,
  groupIds: readonly string[]
): Promise<string[]> {
  if (groupIds.length === 0) return []
  const rows = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.tenantId, tenantId), inArray(groupMembers.groupId, [...groupIds])))
  return rows.map(r => r.userId)
}

/** The app's named owners plus its owner group's members. */
async function appOwnerIds(db: Database, tenantId: string, appId: string): Promise<string[]> {
  const [app] = await db
    .select({ ownerGroupId: apps.ownerGroupId })
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
  if (!app) return []
  const named = await db
    .select({ userId: appOwners.userId })
    .from(appOwners)
    .where(and(eq(appOwners.tenantId, tenantId), eq(appOwners.appId, appId)))
  const viaGroup = app.ownerGroupId ? await membersOfGroups(db, tenantId, [app.ownerGroupId]) : []
  return [...named.map(r => r.userId), ...viaGroup]
}

/** The kind's extra approvers; a kind with no handler (never opened in P4) has none. */
async function extraApprovers(db: Database, request: ApprovalRequestRow): Promise<string[]> {
  if (!isBuiltApprovalKind(request.kind)) return []
  const handler = kindHandler(request.kind)
  return handler.eligibleExtra ? handler.eligibleExtra(db, request) : []
}

/**
 * Everyone the policy names, before the excluded set — members of this tenant only (a `userIds`
 * entry who has left, or a global admin with no membership, is nobody to notify).
 */
async function namedApprovers(db: Database, request: ApprovalRequestRow): Promise<string[]> {
  const { approvers } = request.policy
  const tenantId = request.tenantId
  const ids = new Set<string>()
  if (approvers.appOwners && request.appId) {
    for (const id of await appOwnerIds(db, tenantId, request.appId)) ids.add(id)
  }
  if (approvers.admins) {
    const rows = await db
      .select({ userId: tenantUsers.userId })
      .from(tenantUsers)
      .where(and(eq(tenantUsers.tenantId, tenantId), inArray(tenantUsers.role, [...ADMIN_ROLES])))
    for (const r of rows) ids.add(r.userId)
  }
  for (const id of await membersOfGroups(db, tenantId, approvers.groupIds)) ids.add(id)
  for (const id of approvers.userIds) ids.add(id)
  for (const id of await extraApprovers(db, request)) ids.add(id)
  if (ids.size === 0) return []
  const members = await db
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(and(eq(tenantUsers.tenantId, tenantId), inArray(tenantUsers.userId, [...ids])))
  return members.map(m => m.userId)
}

export async function eligibleApprovers(
  db: Database,
  request: ApprovalRequestRow
): Promise<string[]> {
  const excluded = excludedFrom(request)
  return (await namedApprovers(db, request)).filter(id => !excluded.has(id))
}

/**
 * What the engine knows about one viewer across many requests — read once per list, so the inbox
 * is not one ownership query per row.
 */
export interface ViewerScope {
  viewer: ApprovalViewer
  /** Apps the viewer owns (named, or through the owner group). */
  ownedAppIds: Set<string>
}

export async function viewerScopeOf(db: Database, viewer: ApprovalViewer): Promise<ViewerScope> {
  const named = await db
    .select({ appId: appOwners.appId })
    .from(appOwners)
    .where(and(eq(appOwners.tenantId, viewer.tenantId), eq(appOwners.userId, viewer.userId)))
  const viaGroup =
    viewer.groupIds.length === 0
      ? []
      : await db
          .select({ appId: apps.id })
          .from(apps)
          .where(
            and(eq(apps.tenantId, viewer.tenantId), inArray(apps.ownerGroupId, viewer.groupIds))
          )
  return { viewer, ownedAppIds: new Set([...named, ...viaGroup].map(r => r.appId)) }
}

/** Is the viewer one of the people the policy names (ignoring the excluded set)? */
export async function isNamedApprover(
  db: Database,
  request: ApprovalRequestRow,
  scope: ViewerScope
): Promise<boolean> {
  const { approvers } = request.policy
  const { viewer } = scope
  if (approvers.admins && viewer.isAdmin) return true
  if (approvers.appOwners && request.appId && scope.ownedAppIds.has(request.appId)) return true
  if (approvers.userIds.includes(viewer.userId)) return true
  if (approvers.groupIds.some(id => viewer.groupIds.includes(id))) return true
  return (await extraApprovers(db, request)).includes(viewer.userId)
}

async function hasDecided(db: Database, request: ApprovalRequestRow, userId: string) {
  const [row] = await db
    .select({ id: approvalDecisions.id })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.tenantId, request.tenantId),
        eq(approvalDecisions.requestId, request.id),
        eq(approvalDecisions.userId, userId)
      )
    )
  return Boolean(row)
}

/**
 * The order is the most useful sentence first: a closed request, then "you already decided", then
 * "this is your own request" (the requester and the excluded — the author is never an approver),
 * then "you are not an approver".
 */
export async function canDecide(
  db: Database,
  request: ApprovalRequestRow,
  viewer: ApprovalViewer,
  scope?: ViewerScope
): Promise<{ canDecide: boolean; whyNot: ApprovalWhyNot | null }> {
  const refuse = (whyNot: ApprovalWhyNot) => ({ canDecide: false, whyNot })
  if (request.status !== 'pending') return refuse('not_pending')
  if (await hasDecided(db, request, viewer.userId)) return refuse('already_decided')
  if (excludedFrom(request).has(viewer.userId)) return refuse('self_approval')
  const resolved = scope ?? (await viewerScopeOf(db, viewer))
  if (!(await isNamedApprover(db, request, resolved))) return refuse('not_an_approver')
  return { canDecide: true, whyNot: null }
}

/**
 * Who may READ a request: the organisation's admins, the requester, anyone on the excluded list (the
 * request is about their work), anyone who decided it, and anyone the policy names. Everyone else
 * gets the same 404 as a missing request.
 */
export async function canSee(
  db: Database,
  request: ApprovalRequestRow,
  scope: ViewerScope,
  decidedBy: readonly string[]
): Promise<boolean> {
  const { viewer } = scope
  if (viewer.isAdmin) return true
  if (request.requestedByUserId === viewer.userId) return true
  if ((request.excludedUserIds ?? []).includes(viewer.userId)) return true
  if (decidedBy.includes(viewer.userId)) return true
  return isNamedApprover(db, request, scope)
}

// ---- the admin surface -------------------------------------------------------------------------

export async function listPolicies(
  db: Database,
  tenantId: string,
  query: ApprovalPolicyListQuery
): Promise<{ items: ApprovalPolicyRow[]; defaults: Record<ApprovalKind, ApprovalPolicy> }> {
  const rows = await db
    .select()
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.tenantId, tenantId),
        query.kind ? eq(approvalPolicies.kind, query.kind) : undefined,
        query.scopeType ? eq(approvalPolicies.scopeType, query.scopeType) : undefined,
        query.scopeId ? eq(approvalPolicies.scopeId, query.scopeId) : undefined
      )
    )
    .orderBy(approvalPolicies.kind, approvalPolicies.scopeType, approvalPolicies.createdAt)
  const defaults = {} as Record<ApprovalKind, ApprovalPolicy>
  for (const kind of APPROVAL_KINDS) defaults[kind] = await defaultPolicyFor(db, tenantId, kind)
  return { items: rows.map(toPolicyRow), defaults }
}

/** A group or app scope must be this tenant's — 404 otherwise, as for any other tenant's row. */
async function assertScopeInTenant(
  db: Database,
  tenantId: string,
  input: PutApprovalPolicyRequest
) {
  if (input.scopeType === 'tenant' || !input.scopeId) return
  const table = input.scopeType === 'group' ? groups : apps
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), eq(table.id, input.scopeId)))
  if (!row)
    throw new NotFoundError(input.scopeType === 'group' ? 'Group not found' : 'App not found')
}

/** Upsert by `(kind, scopeType, scopeId)`; returns the row and what it replaced (for the audit). */
export async function putPolicy(
  db: Database,
  tenantId: string,
  input: PutApprovalPolicyRequest,
  updatedByUserId: string
): Promise<{ row: ApprovalPolicyRow; before: ApprovalPolicy | null }> {
  await assertScopeInTenant(db, tenantId, input)
  const scopeId = input.scopeType === 'tenant' ? null : input.scopeId
  const [existing] = await db
    .select()
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.tenantId, tenantId),
        eq(approvalPolicies.kind, input.kind),
        eq(approvalPolicies.scopeType, input.scopeType),
        scopeId ? eq(approvalPolicies.scopeId, scopeId) : isNull(approvalPolicies.scopeId)
      )
    )
  const values = {
    approvers: input.approvers,
    minApprovals: input.minApprovals,
    allowSelfApproval: input.allowSelfApproval,
    expiresAfterMinutes: input.expiresAfterMinutes,
    autoApproveRole: input.autoApproveRole,
    updatedByUserId,
    updatedAt: new Date(),
  }
  const [row] = await db
    .insert(approvalPolicies)
    .values({ tenantId, kind: input.kind, scopeType: input.scopeType, scopeId, ...values })
    .onConflictDoUpdate({
      target: [
        approvalPolicies.tenantId,
        approvalPolicies.kind,
        approvalPolicies.scopeType,
        approvalPolicies.scopeId,
      ],
      set: values,
    })
    .returning()
  if (!row) throw new Error('approval_policies upsert returned no row')
  return { row: toPolicyRow(row), before: existing ? toPolicy(existing) : null }
}

/** Remove one row; 404 when it is not this tenant's. */
export async function removePolicy(
  db: Database,
  tenantId: string,
  id: string
): Promise<ApprovalPolicyRow> {
  const [row] = await db
    .delete(approvalPolicies)
    .where(and(eq(approvalPolicies.tenantId, tenantId), eq(approvalPolicies.id, id)))
    .returning()
  if (!row) throw new NotFoundError('Approval policy not found')
  return toPolicyRow(row)
}
