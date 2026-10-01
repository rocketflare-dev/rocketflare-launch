/**
 * Issue #5: an app's ship settings and the review rule they resolve to
 * (`docs/plans/i5-ship-to-staging.md` §1.10–§1.11). `apps.ship_settings` says where a session's
 * Ship ends (`staging` | `pr`) and who reviews the merge (`none` | `app_owners` | `groups`); an
 * admin `approval_policies` row for `session.merge` (app, group or tenant scope) wins over it and
 * makes review mandatory (decision §0.3 — this relaxes P4 §1.5, "only admins shape a gate", for
 * this one kind).
 *
 * - `reviewPolicyFor`: what a landing's review is — read by `ship.pr` (slice S2) when it snapshots
 *   the landing, and passed as `OpenApprovalInput.policy` to the `session.merge` request.
 * - `shipReviewSetByFor`: `policy` when such a row exists — the detail's `shipReviewSetBy`, which
 *   the UI reads to show the review setting read-only.
 * - `updateShipSettings`: `PUT /api/apps/:id/ship-settings` (the route checks `mayDeployApp`).
 *
 * Every query names the tenant.
 */
import { type ApprovalPolicy, SESSION_MERGE_EXPIRY_HOURS } from '@launch/shared/launch-approvals'
import {
  type AppShipSettings,
  type PutAppShipSettingsRequest,
  resolveAppShipSettings,
  type ShipReviewSetBy,
} from '@launch/shared/launch-apps'
import type { LandingReviewMode } from '@launch/shared/launch-sessions'
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type AppRow, apps, groups } from '../../../db/schema'
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/core/errors'
// The leaf, not `approvals/policy`: `apps.ts` imports this module, and `policy.ts` reaches the kind
// registry, whose kinds import `apps.ts` back (`policy-row.ts` says why that cycle matters).
import { findPolicyRow } from '../approvals/policy-row'
import { type AuditActor, recordAudit } from './audit'

/** The app's columns the review rule reads. */
export type ShipReviewApp = Pick<AppRow, 'id' | 'ownerGroupId' | 'shipSettings'>

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

/** 409 code: the review half of the settings is an admin policy's, not the app's. */
export const SHIP_REVIEW_SET_BY_POLICY = 'ship_review_set_by_policy'

/** The app setting's policy: one approval, never the author's own, two days, never automatic. */
function appReviewPolicy(approvers: Partial<ApprovalPolicy['approvers']>): ApprovalPolicy {
  return {
    approvers: { appOwners: false, admins: false, groupIds: [], userIds: [], ...approvers },
    minApprovals: 1,
    allowSelfApproval: false,
    expiresAfterMinutes: SESSION_MERGE_EXPIRY_HOURS * 60,
    autoApproveRole: null,
  }
}

/** The ids among `groupIds` that are still this tenant's groups. */
async function liveGroupIds(
  db: Database,
  tenantId: string,
  groupIds: readonly string[]
): Promise<string[]> {
  if (groupIds.length === 0) return []
  const rows = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), inArray(groups.id, [...groupIds])))
  const live = new Set(rows.map(r => r.id))
  return groupIds.filter(id => live.has(id))
}

/**
 * The review rule for `app` (plan §1.11): a `session.merge` policy row (`findPolicyRow`, app →
 * owner group → tenant) → required, `setBy: 'policy'`, the row's policy as it stands. Otherwise
 * the app's `review.mode`: `none` → not required, `app_owners` → `{approvers:{appOwners:true}}`,
 * `groups` → `{approvers:{groupIds}}`, each N=1, no self-approval, 48 h, no auto-approve.
 *
 * A `groups` setting whose teams have all been deleted since falls back to the app's owners: a
 * merge nobody can approve would hold the session (and its Neon branch) for 48 h for nothing.
 */
export async function reviewPolicyFor(
  db: Database,
  tenantId: string,
  app: ShipReviewApp
): Promise<ShipReviewPolicy> {
  const row = await findPolicyRow(db, tenantId, 'session.merge', app)
  if (row) return { required: true, setBy: 'policy', mode: 'policy', policy: row.policy }
  const { review } = resolveAppShipSettings(app.shipSettings)
  switch (review.mode) {
    case 'none':
      return { required: false, setBy: 'app', mode: 'none', policy: null }
    case 'app_owners':
      return {
        required: true,
        setBy: 'app',
        mode: 'app_owners',
        policy: appReviewPolicy({ appOwners: true }),
      }
    case 'groups': {
      const groupIds = await liveGroupIds(db, tenantId, review.groupIds)
      return {
        required: true,
        setBy: 'app',
        mode: 'groups',
        policy: appReviewPolicy(groupIds.length > 0 ? { groupIds } : { appOwners: true }),
      }
    }
  }
}

/** `policy` when an admin `session.merge` row governs the app's review; else `app`. */
export async function shipReviewSetByFor(
  db: Database,
  tenantId: string,
  app: Pick<AppRow, 'id' | 'ownerGroupId'>
): Promise<ShipReviewSetBy> {
  return (await findPolicyRow(db, tenantId, 'session.merge', app)) ? 'policy' : 'app'
}

/** The stored shape: `groupIds` deduplicated, and empty unless the mode is `groups`. */
function normalise(input: PutAppShipSettingsRequest): AppShipSettings {
  const groupIds = input.review.mode === 'groups' ? [...new Set(input.review.groupIds)] : []
  return { sessionShip: input.sessionShip, review: { mode: input.review.mode, groupIds } }
}

function sameReview(a: AppShipSettings['review'], b: AppShipSettings['review']): boolean {
  if (a.mode !== b.mode) return false
  const left = [...a.groupIds].sort()
  const right = [...b.groupIds].sort()
  return left.length === right.length && left.every((id, i) => id === right[i])
}

/**
 * `PUT /api/apps/:id/ship-settings` — the route has already checked the caller is one of the app's
 * owners or an admin (`mayDeployApp`). The whole settings object is replaced, in one transaction
 * with its `app.ship_settings.updated` audit (`before` / `after`, both resolved).
 *
 * Refused: a team that is not this organisation's (400 `unknown_group`), and a change to the
 * REVIEW while an admin `session.merge` policy governs it (409 `ship_review_set_by_policy`) — the
 * ship mode may still change, so the UI sends the read-only review back as it found it.
 */
export async function updateShipSettings(
  db: Database,
  tenantId: string,
  app: AppRow,
  input: PutAppShipSettingsRequest,
  actor: AuditActor
): Promise<AppRow> {
  const before = resolveAppShipSettings(app.shipSettings)
  const after = normalise(input)
  if (after.review.groupIds.length > 0) {
    const live = await liveGroupIds(db, tenantId, after.review.groupIds)
    if (live.length !== after.review.groupIds.length) {
      throw new BadRequestError('No such team in this organisation', 'unknown_group')
    }
  }
  if (
    !sameReview(before.review, after.review) &&
    (await shipReviewSetByFor(db, tenantId, app)) === 'policy'
  ) {
    throw new ConflictError(
      'An admin approval policy for session merges decides who reviews this app; change it in Approval policies',
      SHIP_REVIEW_SET_BY_POLICY
    )
  }
  return db.transaction(async tx => {
    const [row] = await tx
      .update(apps)
      .set({ shipSettings: after, updatedAt: new Date() })
      .where(and(eq(apps.tenantId, tenantId), eq(apps.id, app.id)))
      .returning()
    if (!row) throw new NotFoundError('App not found', 'app_not_found')
    await recordAudit(tx, {
      tenantId,
      ...actor,
      action: 'app.ship_settings.updated',
      targetType: 'App',
      targetId: app.id,
      appId: app.id,
      summary: { before, after },
    })
    return row
  })
}
