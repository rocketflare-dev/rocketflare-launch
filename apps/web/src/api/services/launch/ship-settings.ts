/**
 * Issue #5: an app's ship settings and the review rule they resolve to
 * (`docs/plans/i5-ship-to-staging.md` §1.10–§1.11). `apps.ship_settings` says where a session's
 * Ship ends (`staging` | `pr`) and who reviews the merge (`none` | `app_owners` | `groups`); an
 * admin `approval_policies` row for `session.merge` (app, group or tenant scope) wins over it and
 * makes review mandatory.
 *
 * S1 left a typed stub; slice S4 fills it (and owns this file, with `PUT /api/apps/:id/ship-settings`).
 */
import type { ApprovalPolicy } from '@launch/shared/launch-approvals'
import type { ShipReviewSetBy } from '@launch/shared/launch-apps'
import type { LandingReviewMode } from '@launch/shared/launch-sessions'
import type { Database } from '../../../db/client'
import type { AppRow } from '../../../db/schema'
import { NotWiredError } from '../i5-not-wired'

/** What a landing's review is, resolved when `ship.pr` snapshots it onto `sessions.landing`. */
export interface ShipReviewPolicy {
  /** False: nothing to open, CI green merges straight away. */
  required: boolean
  /** `policy` when an admin `session.merge` policy row decided it. */
  setBy: ShipReviewSetBy
  /** `landing.reviewMode`: the app's mode, or `policy`. */
  mode: LandingReviewMode
  /**
   * The policy to snapshot onto the `session.merge` request (`OpenApprovalInput.policy`): N=1, no
   * self-approval, 48 h, no auto-approve, with the approvers the mode or the policy row names.
   * Null when `required` is false.
   */
  policy: ApprovalPolicy | null
}

/**
 * The review rule for `app` — S4 fills it (plan §1.11): a `session.merge` policy row (`findPolicyRow`
 * beside `resolvePolicy`) → required, `setBy: 'policy'`; otherwise the app's `review.mode`:
 * `none` → not required, `app_owners` → `{approvers:{appOwners:true}}`, `groups` →
 * `{approvers:{groupIds}}`.
 */
export async function reviewPolicyFor(
  _db: Database,
  _tenantId: string,
  _app: Pick<AppRow, 'id' | 'ownerGroupId' | 'shipSettings'>
): Promise<ShipReviewPolicy> {
  throw new NotWiredError('reviewPolicyFor', 'S4')
}
