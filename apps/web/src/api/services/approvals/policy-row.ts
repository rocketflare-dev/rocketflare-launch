/**
 * The `approval_policies` row lookup — a LEAF of `policy.ts`, which re-exports everything here.
 *
 * Why a leaf: `policy.ts` imports the kind registry (`kinds/index.ts`, a record built at module
 * scope), and the kinds import the launch services. Issue #5's `services/launch/ship-settings.ts`
 * is read by `services/launch/apps.ts` (the app detail's `shipReviewSetBy`), so importing
 * `policy.ts` from there closes a cycle through the registry and one kind evaluates `undefined`
 * (a 500 at the first `kindHandler`, not a compile error). This file imports the schema only.
 *
 * Every query names the tenant.
 */
import {
  type ApprovalKind,
  type ApprovalPolicy,
  type ApprovalPolicyRow,
  approvalPolicySchema,
} from '@launch/shared/launch-approvals'
import { and, eq, isNull, or } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type ApprovalPolicyRecord, approvalPolicies, apps } from '../../../db/schema'

export function toPolicy(row: ApprovalPolicyRecord): ApprovalPolicy {
  return approvalPolicySchema.parse({
    approvers: row.approvers,
    minApprovals: row.minApprovals,
    allowSelfApproval: row.allowSelfApproval,
    expiresAfterMinutes: row.expiresAfterMinutes,
    autoApproveRole: row.autoApproveRole,
  })
}

export function toPolicyRow(row: ApprovalPolicyRecord): ApprovalPolicyRow {
  return {
    ...toPolicy(row),
    id: row.id,
    kind: row.kind,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** The policy row that governs a kind, and the policy it holds. */
export interface FoundPolicyRow {
  row: ApprovalPolicyRow
  policy: ApprovalPolicy
}

/**
 * The `approval_policies` row that governs `kind` here — app scope first, then the app's owner
 * group, then tenant — or null when only the code default applies. `resolvePolicy` is this plus the
 * default; issue #5's `session.merge` reads it directly, because THERE a row means an admin decided
 * and the app's own review setting gives way (`services/launch/ship-settings.ts`).
 *
 * `app` is an id (its owner group is then read, tenant-first), the two columns when the caller
 * already holds the row, or null for a tenant-wide question.
 */
export async function findPolicyRow(
  db: Database,
  tenantId: string,
  kind: ApprovalKind,
  app: string | { id: string; ownerGroupId: string | null } | null
): Promise<FoundPolicyRow | null> {
  let appId: string | null = null
  let ownerGroupId: string | null = null
  if (typeof app === 'string') {
    appId = app
    const [row] = await db
      .select({ ownerGroupId: apps.ownerGroupId })
      .from(apps)
      .where(and(eq(apps.tenantId, tenantId), eq(apps.id, app)))
    ownerGroupId = row?.ownerGroupId ?? null
  } else if (app) {
    appId = app.id
    ownerGroupId = app.ownerGroupId
  }
  const scopes = [and(eq(approvalPolicies.scopeType, 'tenant'), isNull(approvalPolicies.scopeId))]
  if (appId) {
    scopes.push(and(eq(approvalPolicies.scopeType, 'app'), eq(approvalPolicies.scopeId, appId)))
  }
  if (ownerGroupId) {
    scopes.push(
      and(eq(approvalPolicies.scopeType, 'group'), eq(approvalPolicies.scopeId, ownerGroupId))
    )
  }
  const rows = await db
    .select()
    .from(approvalPolicies)
    .where(
      and(eq(approvalPolicies.tenantId, tenantId), eq(approvalPolicies.kind, kind), or(...scopes))
    )
  for (const scope of ['app', 'group', 'tenant'] as const) {
    const row = rows.find(r => r.scopeType === scope)
    if (row) return { row: toPolicyRow(row), policy: toPolicy(row) }
  }
  return null
}
