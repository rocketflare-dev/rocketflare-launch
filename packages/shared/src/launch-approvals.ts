/**
 * Launch P4 contracts: the approvals engine (spec/08, `docs/plans/p4-approvals.md`). One generic
 * engine decides every request a second person must approve; each KIND is a handler on the server
 * (`api/services/approvals/kinds/*`). Everything the API, the UI and the CLI say about one is here:
 *
 * - the closed sets the text columns are typed by (`APPROVAL_KINDS`, `APPROVAL_STATUSES`,
 *   `APPROVAL_SUBJECT_TYPES`, `APPROVAL_POLICY_SCOPES`, `APPROVAL_DECISIONS`) — text columns, not pg
 *   enums, so adding a kind in P5/P6 needs no enum migration (the `agent_run_interrupts` pattern);
 * - the policy (`approvalPolicySchema`) and its code defaults (`DEFAULT_APPROVAL_POLICIES`, plan
 *   §1.7), snapshotted onto each request when it opens;
 * - `approvalContextSchema` — what the inbox shows to decide, a discriminated union per kind;
 * - the request, detail, decision and policy bodies of `/api/approvals` and
 *   `/api/approval-policies`;
 * - the realtime entity, the notification types and the error codes every slice answers with.
 *
 * `config.change` and `app.teardown` are NAMED (spec/08's table) but not built: no handler, no
 * route opens one (P6). `BUILT_APPROVAL_KINDS` is the five that are — P5 (`docs/plans/p5-grants.md`
 * §1.7–§1.9) added `grant.request`, its `grant` subject and `grantRequestContextSchema`.
 *
 * Slice 4a owned this file, and 5a its P5 lines; every other slice imports from it and never edits it.
 */
import { z } from 'zod'
import { appEnvironmentNameSchema, healthStatusSchema } from './launch-apps'
import { releasePrSchema } from './launch-releases'
import { DEFAULT_SESSION_POLICY } from './launch-sessions'

// ---- closed sets -------------------------------------------------------------------------------

/** Every kind spec/08 names. Append-only: the value is stored in `approval_requests.kind`. */
export const APPROVAL_KINDS = [
  'app.create',
  'app.access',
  'deploy.production',
  'session.budget',
  'grant.request',
  'config.change',
  'app.teardown',
] as const
export const approvalKindSchema = z.enum(APPROVAL_KINDS)
export type ApprovalKind = z.infer<typeof approvalKindSchema>

/** The kinds with a handler (P4's four, P5's `grant.request`). The kind registry is keyed by these. */
export const BUILT_APPROVAL_KINDS = [
  'app.create',
  'app.access',
  'deploy.production',
  'session.budget',
  'grant.request',
] as const satisfies readonly ApprovalKind[]
export type BuiltApprovalKind = (typeof BUILT_APPROVAL_KINDS)[number]

export function isBuiltApprovalKind(kind: string): kind is BuiltApprovalKind {
  return (BUILT_APPROVAL_KINDS as readonly string[]).includes(kind)
}

/**
 * A request leaves `pending` exactly once, by compare-and-set: approved (N approvals), rejected
 * (one reject vetoes), expired (the sweep), or cancelled (the requester or an admin).
 */
export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
] as const
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES)
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>

export const TERMINAL_APPROVAL_STATUSES = [
  'approved',
  'rejected',
  'expired',
  'cancelled',
] as const satisfies readonly ApprovalStatus[]

/**
 * What an approval is ABOUT — `(kind, subject_type, subject_id)` is unique while pending. P5's
 * `grant` is one `app_grants` row (one app × resource × environment, plan §1.7).
 */
export const APPROVAL_SUBJECT_TYPES = [
  'app',
  'user',
  'release',
  'deploy_ticket',
  'session',
  'grant',
] as const
export const approvalSubjectTypeSchema = z.enum(APPROVAL_SUBJECT_TYPES)
export type ApprovalSubjectType = z.infer<typeof approvalSubjectTypeSchema>

export const APPROVAL_DECISIONS = ['approve', 'reject'] as const
export const approvalDecisionValueSchema = z.enum(APPROVAL_DECISIONS)
export type ApprovalDecisionValue = z.infer<typeof approvalDecisionValueSchema>

/** Where a policy row applies. Resolution: app → the app's owner group → tenant → code default. */
export const APPROVAL_POLICY_SCOPES = ['tenant', 'group', 'app'] as const
export const approvalPolicyScopeSchema = z.enum(APPROVAL_POLICY_SCOPES)
export type ApprovalPolicyScope = z.infer<typeof approvalPolicyScopeSchema>

/** A requester at or above this tenant role is auto-approved (still a row, decided by `system`). */
export const AUTO_APPROVE_ROLES = ['member', 'admin', 'owner'] as const
export const autoApproveRoleSchema = z.enum(AUTO_APPROVE_ROLES)
export type AutoApproveRole = z.infer<typeof autoApproveRoleSchema>

/**
 * Whether a tenant role meets `required`. `support` (platform staff inside a tenant) ranks with
 * `admin`, as in the ability matrix and `meetsAppCreateRole`.
 */
export function meetsAutoApproveRole(role: string, required: AutoApproveRole): boolean {
  const rank: Record<string, number> = { owner: 3, admin: 2, support: 2, member: 1 }
  return (rank[role] ?? 0) >= rank[required]
}

/** `applyAfter` is retried by the sweep until this many attempts, then `approval.apply_failed`. */
export const APPROVAL_MAX_APPLY_ATTEMPTS = 5

/** `comment` on a decision, and `reason` on a request. */
export const APPROVAL_COMMENT_MAX = 1000

/** `requested_by_label` for a request a CI job opened (no Launch user): `github:<actor>`. */
export function githubRequesterLabel(actor: string): string {
  return `github:${actor}`
}

// ---- policy ------------------------------------------------------------------------------------

/** Who may decide. Evaluated at DECIDE time (owners and group membership now, not at open). */
export const approvalApproversSchema = z.object({
  /** The app's named owners and its owner group's members. */
  appOwners: z.boolean().default(false),
  /** The organisation's owners and admins (and `support`). */
  admins: z.boolean().default(false),
  groupIds: z.array(z.string().uuid()).max(50).default([]),
  userIds: z.array(z.string().uuid()).max(100).default([]),
})
export type ApprovalApprovers = z.infer<typeof approvalApproversSchema>

const MINUTES_PER_DAY = 24 * 60

export const approvalPolicySchema = z.object({
  approvers: approvalApproversSchema,
  /** N: this many distinct approvals approve; one reject vetoes. */
  minApprovals: z.number().int().min(1).max(10).default(1),
  /** Off by default: the requester (and the excluded set) may not decide their own request. */
  allowSelfApproval: z.boolean().default(false),
  /** Null: never expires (only a subject with its own deadline, like a deploy ticket, should). */
  expiresAfterMinutes: z
    .number()
    .int()
    .min(5)
    .max(90 * MINUTES_PER_DAY)
    .nullable()
    .default(null),
  /** A requester at or above this role is auto-approved; null = never. */
  autoApproveRole: autoApproveRoleSchema.nullable().default(null),
})
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>

/**
 * The code defaults (plan §1.7). `app.create`'s `autoApproveRole` is overlaid at resolve time by
 * `launch_settings.app_create_role` (`?? 'admin'`), so members who got a 403 in P2 now ASK.
 * `session.budget` expires with the session's `suspendedExpiryHours`. `deploy.production` is
 * further capped by the ticket's own `expires_at` when the subject is a ticket.
 */
export const DEFAULT_APPROVAL_POLICIES: Record<ApprovalKind, ApprovalPolicy> = {
  'app.create': {
    approvers: { appOwners: false, admins: true, groupIds: [], userIds: [] },
    minApprovals: 1,
    allowSelfApproval: false,
    expiresAfterMinutes: 7 * MINUTES_PER_DAY,
    autoApproveRole: 'admin',
  },
  // Owners AND admins: in P1 an organisation admin decided any app's access requests.
  'app.access': {
    approvers: { appOwners: true, admins: true, groupIds: [], userIds: [] },
    minApprovals: 1,
    allowSelfApproval: false,
    expiresAfterMinutes: 14 * MINUTES_PER_DAY,
    autoApproveRole: null,
  },
  'deploy.production': {
    approvers: { appOwners: true, admins: true, groupIds: [], userIds: [] },
    minApprovals: 1,
    allowSelfApproval: false,
    expiresAfterMinutes: MINUTES_PER_DAY,
    autoApproveRole: null,
  },
  'session.budget': {
    approvers: { appOwners: true, admins: true, groupIds: [], userIds: [] },
    minApprovals: 1,
    allowSelfApproval: false,
    expiresAfterMinutes: DEFAULT_SESSION_POLICY.suspendedExpiryHours * 60,
    autoApproveRole: null,
  },
  // P5 (plan §1.8, spec/12 #9): the RESOURCE's owner group decides — they are the kind's
  // `eligibleExtra`, so neither the app's owners nor the admins approve by default, and both
  // environments need an approval. A resource's own `policies[env]` is snapshotted in place of
  // this (`OpenApprovalInput.policy`); staging self-serve is `autoApproveRole: 'member'` there.
  'grant.request': {
    approvers: { appOwners: false, admins: false, groupIds: [], userIds: [] },
    minApprovals: 1,
    allowSelfApproval: false,
    expiresAfterMinutes: 7 * MINUTES_PER_DAY,
    autoApproveRole: null,
  },
  // Named, not built (P6): defaults exist so the record is total and a policy row can be set.
  'config.change': {
    approvers: { appOwners: true, admins: false, groupIds: [], userIds: [] },
    minApprovals: 1,
    allowSelfApproval: false,
    expiresAfterMinutes: 7 * MINUTES_PER_DAY,
    autoApproveRole: null,
  },
  'app.teardown': {
    approvers: { appOwners: true, admins: true, groupIds: [], userIds: [] },
    minApprovals: 1,
    allowSelfApproval: false,
    expiresAfterMinutes: 7 * MINUTES_PER_DAY,
    autoApproveRole: null,
  },
}

// ---- context (what the inbox shows) ------------------------------------------------------------

export const appCreateContextSchema = z.object({
  kind: z.literal('app.create'),
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable().optional(),
  ownerGroupId: z.string().uuid().nullable(),
})

export const appAccessContextSchema = z.object({
  kind: z.literal('app.access'),
  userId: z.string().uuid(),
  /** What the person wrote on the request-access page. */
  message: z.string().nullable(),
})

/** A PR as the approver sees it: the release's record plus its CI at promote time. */
export const approvalPrSchema = releasePrSchema.extend({
  checks: z.enum(['passing', 'failing', 'pending', 'none']).nullable().optional(),
})

export const deployProductionContextSchema = z.object({
  kind: z.literal('deploy.production'),
  environment: appEnvironmentNameSchema.default('production'),
  version: z.string().nullable(),
  tag: z.string().nullable(),
  sha: z.string().nullable(),
  /** The ref the production run must carry (`refs/tags/X.Y.Z`, or the default branch). */
  ref: z.string().nullable(),
  compareUrl: z.string().url().nullable(),
  prs: z.array(approvalPrSchema).default([]),
  stagingHealth: healthStatusSchema.nullable(),
  stagingVersion: z.string().nullable(),
  /** A job-originated ticket: the GitHub run that is waiting, and who started it. */
  runUrl: z.string().url().nullable().optional(),
  actor: z.string().nullable().optional(),
})

export const sessionBudgetContextSchema = z.object({
  kind: z.literal('session.budget'),
  sessionId: z.string().uuid(),
  sessionTitle: z.string().nullable(),
  extraUsd: z.number().positive(),
  spentUsd: z.number().nonnegative(),
  capUsd: z.number().nonnegative(),
})

/** A shared resource's item kinds (`@launch/shared/launch-grants` re-exports them). */
export const GRANT_ITEM_KINDS = ['var', 'secret'] as const
export const grantItemKindSchema = z.enum(GRANT_ITEM_KINDS)
export type GrantItemKind = z.infer<typeof grantItemKindSchema>

/**
 * P5 (plan §1.7): an app asks to hold a shared resource in ONE environment. The subject is the
 * `app_grants` row; the approvers see what the app would receive (item names and kinds — never a
 * value), which of its plugins declared the need, and when the grant would lapse.
 */
export const grantRequestContextSchema = z.object({
  kind: z.literal('grant.request'),
  resourceId: z.string().uuid(),
  resourceName: z.string(),
  environment: appEnvironmentNameSchema,
  items: z.array(z.object({ key: z.string(), kind: grantItemKindSchema })),
  /** The plugin ids whose declared config matched this resource (`kit` for the kit's own). */
  declaredBy: z.array(z.string()).default([]),
  appSlug: z.string(),
  /** ISO timestamp (the context is jsonb, so a string both ways); null = never expires. */
  expiresAt: z.string().datetime({ offset: true }).nullable(),
})

/** The two named-but-unbuilt kinds carry a free description until P6 gives them a shape. */
const unbuiltContext = <K extends 'config.change' | 'app.teardown'>(kind: K) =>
  z.object({ kind: z.literal(kind), description: z.string().max(2000) })

export const approvalContextSchema = z.discriminatedUnion('kind', [
  appCreateContextSchema,
  appAccessContextSchema,
  deployProductionContextSchema,
  sessionBudgetContextSchema,
  grantRequestContextSchema,
  unbuiltContext('config.change'),
  unbuiltContext('app.teardown'),
])
export type ApprovalContext = z.infer<typeof approvalContextSchema>
/** The context of one kind: `ApprovalContextOf<'deploy.production'>`. */
export type ApprovalContextOf<K extends ApprovalKind> = Extract<ApprovalContext, { kind: K }>

// ---- why someone may not decide ----------------------------------------------------------------

/**
 * Why `canDecide` is false for this person — the panel's sentence, and the 403/409 `code` the
 * decide route answers with (`not_pending` and `already_decided` are 409s, the rest 403s).
 */
export const APPROVAL_WHY_NOT = [
  'not_pending',
  'not_an_approver',
  'self_approval',
  'already_decided',
] as const
export const approvalWhyNotSchema = z.enum(APPROVAL_WHY_NOT)
export type ApprovalWhyNot = z.infer<typeof approvalWhyNotSchema>

/** Error codes the approvals routes answer with (the `code` of the error envelope). */
export const APPROVAL_ERROR_CODES = {
  notAnApprover: 'not_an_approver',
  selfApproval: 'self_approval',
  alreadyDecided: 'already_decided',
  notPending: 'not_pending',
  /** A job-originated ticket is no longer pending: the run is gone, use Promote (plan §1.9). */
  deployRunGone: 'deploy_run_gone',
  /** A kind named in spec/08 that is not built yet (`config.change`, `app.teardown`). */
  kindNotBuilt: 'approval_kind_not_built',
} as const

// ---- responses ---------------------------------------------------------------------------------

/** At most this many eligible approvers are named on a request's detail. */
export const APPROVAL_ELIGIBLE_MAX = 25

const personRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string(),
})

export const approvalRequestSchema = z.object({
  id: z.string().uuid(),
  kind: approvalKindSchema,
  status: approvalStatusSchema,
  appId: z.string().uuid().nullable(),
  /** The app's slug and name for the inbox row; null for a request with no app. */
  app: z.object({ id: z.string().uuid(), slug: z.string(), displayName: z.string() }).nullable(),
  subjectType: approvalSubjectTypeSchema,
  subjectId: z.string(),
  requestedByUserId: z.string().uuid().nullable(),
  /** `github:<actor>` for a request CI opened; null when a Launch user asked. */
  requestedByLabel: z.string().nullable(),
  requester: personRefSchema.nullable(),
  reason: z.string().nullable(),
  context: approvalContextSchema,
  policy: approvalPolicySchema,
  requiredApprovals: z.number().int().positive(),
  /** Approvals recorded so far (N of `requiredApprovals`). */
  approvals: z.number().int().nonnegative(),
  expiresAt: z.coerce.date().nullable(),
  decidedAt: z.coerce.date().nullable(),
  appliedAt: z.coerce.date().nullable(),
  applyError: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>

/** One person's decision — append-only (`approval_decisions`). */
export const approvalDecisionSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  userId: z.string().uuid(),
  userEmail: z.string(),
  userName: z.string().nullable(),
  decision: approvalDecisionValueSchema,
  comment: z.string().nullable(),
  at: z.coerce.date(),
})
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>

/** `GET /api/approvals/:id` — the request, every decision, and whether THIS caller may decide. */
export const approvalDetailSchema = approvalRequestSchema.extend({
  decisions: z.array(approvalDecisionSchema),
  canDecide: z.boolean(),
  /** Null when `canDecide`; otherwise the reason, for the panel and the CLI. */
  whyNot: approvalWhyNotSchema.nullable(),
  /** The requester or an admin, while pending. */
  canCancel: z.boolean(),
  /**
   * While pending: the people who may still decide it now — eligible under the snapshotted policy,
   * not excluded, not yet decided — so the panel can NAME who it waits on. Capped at
   * `APPROVAL_ELIGIBLE_MAX`; empty once settled (the decisions say who decided). An empty list on a
   * pending request means nobody can approve it: the policy needs an admin's attention. Optional so
   * an answer without it still parses (readers then fall back to the policy's words).
   */
  eligible: z.array(personRefSchema).optional(),
})
export type ApprovalDetail = z.infer<typeof approvalDetailSchema>

// ---- requests ----------------------------------------------------------------------------------

/**
 * `GET /api/approvals` — `mine`: waiting on me (pending, I am eligible, I have not decided);
 * `requested`: I asked; `all`: every request in the organisation (admins; others get `mine`).
 */
export const APPROVAL_BOXES = ['mine', 'requested', 'all'] as const
export const approvalBoxSchema = z.enum(APPROVAL_BOXES)
export type ApprovalBox = z.infer<typeof approvalBoxSchema>

export const approvalListQuerySchema = z.object({
  box: approvalBoxSchema.default('mine'),
  status: approvalStatusSchema.optional(),
  kind: approvalKindSchema.optional(),
  appId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>

export const approvalListResponseSchema = z.object({ items: z.array(approvalRequestSchema) })
export type ApprovalListResponse = z.infer<typeof approvalListResponseSchema>

/** `GET /api/approvals/count` — the nav badge: pending requests waiting on the caller. */
export const approvalCountSchema = z.object({ count: z.number().int().nonnegative() })
export type ApprovalCount = z.infer<typeof approvalCountSchema>

/** `POST /api/approvals/:id/decide`. */
export const decideApprovalSchema = z.object({
  decision: approvalDecisionValueSchema,
  comment: z.string().trim().max(APPROVAL_COMMENT_MAX).optional(),
})
export type DecideApprovalRequest = z.infer<typeof decideApprovalSchema>

/** `POST /api/approvals/:id/cancel` — the requester or an admin. */
export const cancelApprovalSchema = z.object({
  reason: z.string().trim().max(APPROVAL_COMMENT_MAX).optional(),
})
export type CancelApprovalRequest = z.infer<typeof cancelApprovalSchema>

// ---- policies (admin) --------------------------------------------------------------------------

/** One `approval_policies` row. `scopeId` is null at `tenant` scope. */
export const approvalPolicyRowSchema = approvalPolicySchema.extend({
  id: z.string().uuid(),
  kind: approvalKindSchema,
  scopeType: approvalPolicyScopeSchema,
  scopeId: z.string().uuid().nullable(),
  updatedByUserId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type ApprovalPolicyRow = z.infer<typeof approvalPolicyRowSchema>

export const approvalPolicyListQuerySchema = z.object({
  kind: approvalKindSchema.optional(),
  scopeType: approvalPolicyScopeSchema.optional(),
  scopeId: z.string().uuid().optional(),
})
export type ApprovalPolicyListQuery = z.infer<typeof approvalPolicyListQuerySchema>

/** `GET /api/approval-policies` — the rows, plus the code defaults the UI shows beside them. */
export const approvalPolicyListResponseSchema = z.object({
  items: z.array(approvalPolicyRowSchema),
  defaults: z.record(approvalKindSchema, approvalPolicySchema),
})
export type ApprovalPolicyListResponse = z.infer<typeof approvalPolicyListResponseSchema>

/** `PUT /api/approval-policies` — upsert by `(kind, scopeType, scopeId)`. */
export const putApprovalPolicySchema = approvalPolicySchema
  .extend({
    kind: approvalKindSchema,
    scopeType: approvalPolicyScopeSchema,
    scopeId: z.string().uuid().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if ((value.scopeType === 'tenant') !== (value.scopeId === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'scopeId is required for a group or app policy, and must be null for tenant',
      })
    }
  })
export type PutApprovalPolicyRequest = z.infer<typeof putApprovalPolicySchema>

// ---- realtime and notifications ----------------------------------------------------------------

/**
 * The `entity.changed` entity every approval write nudges — and the root of the `approvals`
 * query-key family, so `invalidationsFor()` refreshes the inbox, the badge and a request's page
 * with no socket code in a hook (the `SESSION_REALTIME_ENTITY` pattern).
 */
export const APPROVAL_REALTIME_ENTITY = 'approval'

/**
 * The `notifications.type` values the engine writes; each carries `data: { approvalId, kind }`, and
 * `notificationLink` sends all three to `approvalPath(approvalId)`.
 */
export const APPROVAL_NOTIFICATION_TYPES = {
  /** To each eligible approver when a request opens. */
  requested: 'approval_requested',
  /** To the requester when it is approved or rejected. */
  decided: 'approval_decided',
  /** To the requester when it expires. */
  expired: 'approval_expired',
} as const
export type ApprovalNotificationType =
  (typeof APPROVAL_NOTIFICATION_TYPES)[keyof typeof APPROVAL_NOTIFICATION_TYPES]

/** The page a notification and an email link to. */
export function approvalPath(id: string): string {
  return `/approvals/${id}`
}
