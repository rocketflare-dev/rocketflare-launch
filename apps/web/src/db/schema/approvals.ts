/**
 * The approvals engine's tables (Launch P4, spec/08, `docs/plans/p4-approvals.md` §2): one
 * `approval_requests` row per thing a second person must approve, the append-only
 * `approval_decisions` each person makes on it, and the `approval_policies` that say who those
 * people are.
 *
 * Decisions worth stating:
 *
 * - **Text columns typed by shared closed sets, not pg enums** (`APPROVAL_KINDS`, …, the
 *   `agent_run_interrupts` pattern): P5/P6 add kinds, and a contract change should not need an
 *   enum migration that a later statement in the same migration cannot use.
 * - **A request leaves `pending` exactly once, by compare-and-set** (`SELECT … FOR UPDATE` in the
 *   decide transaction), and **the partial unique index on the pending subject makes `open`
 *   idempotent**: asking twice while one is open finds the open one. The app is part of that key
 *   because an `app.access` request's subject is the PERSON — one person may ask for two apps.
 * - **The policy is snapshotted onto the request at open** (`policy`, `required_approvals`,
 *   `excluded_user_ids`), so editing a policy never changes a request already in flight.
 * - **`applied_at` is the compare-and-set of the after-commit vendor effects** (`applyAfter`), and
 *   `apply_error` / `apply_attempts` are what the `approvals.sweep` cron retries on.
 * - **`approval_decisions` is append-only by the database** — the `audit_events` trigger function
 *   is attached (appended to the P4 migration) and the app role loses UPDATE/DELETE/TRUNCATE
 *   (`APPEND_ONLY_TABLES`). `user_id` has no FK, as in `audit_events`: deleting a person never
 *   rewrites who decided; `user_email` is copied at write time.
 */
import {
  APPROVAL_DECISIONS,
  APPROVAL_KINDS,
  APPROVAL_POLICY_SCOPES,
  APPROVAL_STATUSES,
  APPROVAL_SUBJECT_TYPES,
  type ApprovalApprovers,
  type ApprovalContext,
  type ApprovalPolicy,
  AUTO_APPROVE_ROLES,
} from '@launch/shared/launch-approvals'
import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { apps } from './apps'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    kind: text('kind', { enum: APPROVAL_KINDS }).notNull(),
    /** The app the request concerns; every built kind has one. Deleting the app deletes it. */
    appId: uuid('app_id').references(() => apps.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type', { enum: APPROVAL_SUBJECT_TYPES }).notNull(),
    /** The subject's id (a uuid for every built kind, kept as text for the ones to come). */
    subjectId: text('subject_id').notNull(),
    status: text('status', { enum: APPROVAL_STATUSES }).notNull().default('pending'),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** `github:<actor>` for a request a CI job opened (no Launch user behind it). */
    requestedByLabel: text('requested_by_label'),
    reason: text('reason'),
    /** What the inbox shows to decide — `approvalContextSchema`, one shape per kind. */
    context: jsonb('context').$type<ApprovalContext>().notNull(),
    /** The resolved policy, snapshotted at open. */
    policy: jsonb('policy').$type<ApprovalPolicy>().notNull(),
    requiredApprovals: integer('required_approvals').notNull().default(1),
    /**
     * Who may NOT decide, snapshotted at open: the requester, whoever clicked Release or Promote,
     * and the creators of the sessions whose PRs are in the release (plan §1.6). User ids.
     */
    excludedUserIds: jsonb('excluded_user_ids').$type<string[]>().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Set (compare-and-set) when `applyAfter` succeeded; null on an approved row = owed. */
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    applyError: text('apply_error'),
    applyAttempts: integer('apply_attempts').notNull().default(0),
    ...timestamps(),
  },
  table => [
    // One OPEN request per subject: `open` is an idempotent insert against this.
    uniqueIndex('approval_requests_pending_subject_idx')
      .on(table.tenantId, table.kind, table.subjectType, table.subjectId, table.appId)
      .where(sql`${table.status} = 'pending'`),
    // The inbox and the sweep, newest first.
    index('approval_requests_tenant_status_created_idx').on(
      table.tenantId,
      table.status,
      table.createdAt.desc()
    ),
    // An app's approvals (the app page, the release chain).
    index('approval_requests_tenant_app_created_idx').on(
      table.tenantId,
      table.appId,
      table.createdAt.desc()
    ),
    check('approval_requests_required_approvals_check', sql`${table.requiredApprovals} >= 1`),
    tenantIsolation('approval_requests'),
  ]
)

export const approvalDecisions = pgTable(
  'approval_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    requestId: uuid('request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    /** No FK — see the header. */
    userId: uuid('user_id').notNull(),
    userEmail: text('user_email').notNull(),
    decision: text('decision', { enum: APPROVAL_DECISIONS }).notNull(),
    comment: text('comment'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    // One decision per person per request: a second is 409 `already_decided`.
    unique('approval_decisions_request_user_key').on(table.requestId, table.userId),
    index('approval_decisions_tenant_request_idx').on(table.tenantId, table.requestId),
    check('approval_decisions_comment_length', sql`char_length(${table.comment}) <= 1000`),
    tenantIsolation('approval_decisions'),
  ]
)

export const approvalPolicies = pgTable(
  'approval_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    kind: text('kind', { enum: APPROVAL_KINDS }).notNull(),
    scopeType: text('scope_type', { enum: APPROVAL_POLICY_SCOPES }).notNull(),
    /** A group id or an app id; null at `tenant` scope. Plain uuid: the scope row may go. */
    scopeId: uuid('scope_id'),
    approvers: jsonb('approvers').$type<ApprovalApprovers>().notNull(),
    minApprovals: integer('min_approvals').notNull().default(1),
    allowSelfApproval: boolean('allow_self_approval').notNull().default(false),
    expiresAfterMinutes: integer('expires_after_minutes'),
    autoApproveRole: text('auto_approve_role', { enum: AUTO_APPROVE_ROLES }),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  table => [
    // One policy per kind per scope; NULLS NOT DISTINCT so there is one tenant-scope row.
    unique('approval_policies_scope_key')
      .on(table.tenantId, table.kind, table.scopeType, table.scopeId)
      .nullsNotDistinct(),
    check('approval_policies_min_approvals_check', sql`${table.minApprovals} >= 1`),
    tenantIsolation('approval_policies'),
  ]
)

export const approvalRequestsRelations = relations(approvalRequests, ({ one, many }) => ({
  tenant: one(tenants, { fields: [approvalRequests.tenantId], references: [tenants.id] }),
  app: one(apps, { fields: [approvalRequests.appId], references: [apps.id] }),
  requestedBy: one(users, {
    fields: [approvalRequests.requestedByUserId],
    references: [users.id],
  }),
  decisions: many(approvalDecisions),
}))

export const approvalDecisionsRelations = relations(approvalDecisions, ({ one }) => ({
  request: one(approvalRequests, {
    fields: [approvalDecisions.requestId],
    references: [approvalRequests.id],
  }),
}))

export const approvalPoliciesRelations = relations(approvalPolicies, ({ one }) => ({
  tenant: one(tenants, { fields: [approvalPolicies.tenantId], references: [tenants.id] }),
}))

export type ApprovalRequestRow = typeof approvalRequests.$inferSelect
export type NewApprovalRequestRow = typeof approvalRequests.$inferInsert
export type ApprovalDecisionRow = typeof approvalDecisions.$inferSelect
export type NewApprovalDecisionRow = typeof approvalDecisions.$inferInsert
export type ApprovalPolicyRecord = typeof approvalPolicies.$inferSelect
export type NewApprovalPolicyRecord = typeof approvalPolicies.$inferInsert
