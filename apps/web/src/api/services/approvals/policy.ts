/**
 * Approval policies (Launch P4, plan §1.5) — slice 4b builds it.
 *
 * - `resolvePolicy`: the first `approval_policies` row of app scope, then the app's owner group,
 *   then tenant, else the kind's `defaultPolicy()` — snapshotted onto the request at open.
 * - `eligibleApprovers`: the user ids who may decide `request` NOW — the app's owners
 *   (`isAppOwner`, `memberGroupIds` from `services/oidc/policy.ts`), the organisation's admins
 *   (`isGlobalAdmin` / admin roles), `groupIds` members, `userIds`, the kind's `eligibleExtra` —
 *   minus the excluded set unless `allowSelfApproval`.
 * - `canDecide`: one viewer against one request → `{ canDecide, whyNot }`.
 */
import type { ApprovalKind, ApprovalPolicy, ApprovalWhyNot } from '@launch/shared/launch-approvals'
import type { Database } from '../../../db/client'
import type { ApprovalRequestRow } from '../../../db/schema'
import { type ApprovalViewer, NotWiredError } from './types'

export async function resolvePolicy(
  _db: Database,
  _tenantId: string,
  _kind: ApprovalKind,
  _appId: string | null
): Promise<ApprovalPolicy> {
  throw new NotWiredError('approvals.resolvePolicy', '4b')
}

export async function eligibleApprovers(
  _db: Database,
  _request: ApprovalRequestRow
): Promise<string[]> {
  throw new NotWiredError('approvals.eligibleApprovers', '4b')
}

export async function canDecide(
  _db: Database,
  _request: ApprovalRequestRow,
  _viewer: ApprovalViewer
): Promise<{ canDecide: boolean; whyNot: ApprovalWhyNot | null }> {
  throw new NotWiredError('approvals.canDecide', '4b')
}
