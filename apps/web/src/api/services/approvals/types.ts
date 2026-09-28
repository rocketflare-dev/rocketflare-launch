/**
 * The approvals engine's shared vocabulary (Launch P4, `docs/plans/p4-approvals.md` §1.2): the
 * `KindHandler` every kind implements, the inputs and results of `engine.ts`, who is asking
 * (`ApprovalViewer`), and the dependencies an effect runs with. Slice 4a owns this file; the
 * engine (4b), the kinds (4c, 4d) and the sweep (4b) import from it and never edit it — a slice
 * that needs a change here stops and reports.
 *
 * The engine knows nothing about apps or deploys (spec/12 #16 keeps it liftable into a plugin):
 * everything kind-specific is a handler method.
 */
import type {
  ApprovalContextOf,
  ApprovalDecisionValue,
  ApprovalListQuery,
  ApprovalPolicy,
  ApprovalSubjectType,
  BuiltApprovalKind,
} from '@launch/shared/launch-approvals'
import type { MembershipRole } from '@launch/shared/tenants'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { ApprovalRequestRow } from '../../../db/schema'
import { isAdminLevel } from '../../middleware/permissions'
import type { AppBindings, AuthContext } from '../../types'
import type { Logger } from '../../utils/core/logger'
import type { AuditActor } from '../launch/audit'
import type { Realtime } from '../realtime'

// ---- errors ------------------------------------------------------------------------------------

/**
 * A piece of the engine a later P4 slice builds. Thrown by the 4a stubs so a call that arrives
 * too early fails by NAME rather than by `undefined is not a function` (the P3 pattern).
 */
export class NotWiredError extends Error {
  constructor(what: string, slice: '4b' | '4c' | '4d' | '4e') {
    super(`${what} is not wired yet (P4 slice ${slice}, docs/plans/p4-approvals.md)`)
    this.name = 'NotWiredError'
  }
}

// ---- who is asking -----------------------------------------------------------------------------

/**
 * The person looking at, deciding or cancelling a request — read from the auth context, never
 * from the body. Eligibility is evaluated NOW from these (owners and group membership at decide
 * time, plan §1.3), not from anything snapshotted at open.
 */
export interface ApprovalViewer {
  tenantId: string
  userId: string
  email: string
  role: MembershipRole | null
  /** Owner, admin, support or a global admin — the policy's `admins` and the `all` box. */
  isAdmin: boolean
  groupIds: string[]
}

/** The viewer of a request made with `auth` (a route's `withAuthAndDb(c).auth`). */
export function approvalViewerOf(auth: AuthContext & { tenantId: string }): ApprovalViewer {
  return {
    tenantId: auth.tenantId,
    userId: auth.user.id,
    email: auth.user.email,
    role: auth.tenantUser?.role ?? null,
    isAdmin: isAdminLevel(auth),
    groupIds: auth.groups.map(g => g.id),
  }
}

// ---- dependencies ------------------------------------------------------------------------------

/**
 * What an effect runs with. `applyInTx` gets the transaction as `db`; `applyAfter` and `onClosed`
 * run after commit on the caller's client (a route's, a cron's). Vendors are reached through
 * `fetch` (FakeCloud in tests), and a nudge through `realtime` (absent in a cron: no nudge).
 */
export interface ApprovalDeps {
  db: Database
  env: AppBindings
  cfg: AppConfig
  logger: Logger
  realtime?: Realtime
  fetch?: typeof fetch
  now?: () => Date
}

// ---- the engine's inputs and results -----------------------------------------------------------

/** Who opened the request: a Launch user (with their role, for auto-approve) or a CI job. */
export type ApprovalRequester =
  | { userId: string; email: string; role: MembershipRole | null }
  | { label: string }

export interface OpenApprovalInput<K extends BuiltApprovalKind = BuiltApprovalKind> {
  tenantId: string
  kind: K
  subject: { type: ApprovalSubjectType; id: string }
  appId: string | null
  requester: ApprovalRequester
  reason?: string | null
  context: ApprovalContextOf<K>
  /** Beyond the requester, who may not decide (plan §1.6). */
  excludedUserIds?: readonly string[]
  /** A hard deadline the policy's expiry may not outlive (a deploy ticket's `expires_at`). */
  expiresNoLaterThan?: Date | null
  /** Who clicked (for the audit row); defaults to the requester. */
  actor?: AuditActor
  /**
   * Launch P5 (plan §1.9): the policy to snapshot, in place of `resolvePolicy` — the grant service
   * passes `resource.policies[env] ?? resolvePolicy(…)`, because `resolvePolicy` knows only app,
   * group and tenant scopes. Absent: resolved as always.
   */
  policy?: ApprovalPolicy
}

export interface OpenApprovalResult {
  request: ApprovalRequestRow
  /** False when an open request for the same subject already existed (idempotent open). */
  created: boolean
  /** Auto-approved by `autoApproveRole` — still a row, decided by `system`, audited. */
  autoApproved: boolean
}

export interface DecideApprovalInput {
  requestId: string
  viewer: ApprovalViewer
  decision: ApprovalDecisionValue
  comment?: string | null
  actor: AuditActor
}

export interface CancelApprovalInput {
  requestId: string
  viewer: ApprovalViewer
  reason?: string | null
  actor: AuditActor
}

export interface ListApprovalsInput {
  viewer: ApprovalViewer
  query: ApprovalListQuery
}

/** How a request left `pending` without being approved — what `onClosed` is told. */
export type ApprovalClosedStatus = 'rejected' | 'expired' | 'cancelled'

// ---- the handler every kind implements ---------------------------------------------------------

export interface KindHandler<K extends BuiltApprovalKind = BuiltApprovalKind> {
  kind: K
  /**
   * The code default for this kind in this tenant — `DEFAULT_APPROVAL_POLICIES[kind]`, overlaid
   * where a setting says more (`app.create`: `launch_settings.app_create_role`). Policy rows
   * override it (`policy.ts`, app → owner group → tenant → this).
   */
  defaultPolicy(db: Database, tenantId: string): Promise<ApprovalPolicy>
  /** A one-line title for the inbox row, the notification and the email. */
  describe(request: ApprovalRequestRow): string
  /** Extra eligible approvers beyond the policy's (user ids) — e.g. a session's app owners. */
  eligibleExtra?(db: Database, request: ApprovalRequestRow): Promise<string[]>
  /**
   * Database effects of an APPROVAL, inside the decide transaction (a ticket compare-and-set, an
   * access grant, a budget extension). Throwing rolls the decision back.
   */
  applyInTx(tx: Database, request: ApprovalRequestRow, deps: ApprovalDeps): Promise<void>
  /**
   * Vendor effects of an approval, AFTER commit, guarded by `applied_at` as a compare-and-set
   * (publish a release, dispatch, start a Workflow, wake a session). Must be idempotent: a
   * failure is retried by `approvals.sweep` up to `APPROVAL_MAX_APPLY_ATTEMPTS` times.
   */
  applyAfter(request: ApprovalRequestRow, deps: ApprovalDeps): Promise<void>
  /** A rejection, expiry or cancellation — the release goes `rejected`, the app `archived`. */
  onClosed?(
    request: ApprovalRequestRow,
    status: ApprovalClosedStatus,
    deps: ApprovalDeps
  ): Promise<void>
}
