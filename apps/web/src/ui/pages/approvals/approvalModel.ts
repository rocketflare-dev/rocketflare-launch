/**
 * Everything the approvals inbox and a request's page SAY, decided here and nowhere else — pure,
 * so the wording is unit-tested (`tests/config/approval-model.test.ts`) and the inbox row, the
 * page heading and the panel can never describe one request three ways.
 *
 * - `approvalSummary(req)` — what is being approved, in plain words, per kind (an exhaustive
 *   `switch` over the shared union: a new kind is a type error until it has a sentence);
 * - `requesterName(req, viewerId)` — "You", the person, "GitHub: octocat" for a CI-opened request;
 * - `whyNotSentence(whyNot, detail)` — the ONE sentence a person who may not decide reads instead
 *   of a disabled button;
 * - `approversSentence(approvers, groupNames)` — who may decide, from the policy snapshot;
 * - `progressLabel`, `STATUS_BADGE`, `KIND_LABELS`, `policyExpiryLabel`.
 */
import {
  type ApprovalApprovers,
  type ApprovalDetail,
  type ApprovalKind,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalStatus,
  type ApprovalWhyNot,
  type AutoApproveRole,
  BUILT_APPROVAL_KINDS,
} from '@launch/shared/launch-approvals'

/** Short names for a filter, a badge, a policy row. */
export const KIND_LABELS: Record<ApprovalKind, string> = {
  'app.create': 'New app',
  'app.access': 'App access',
  'deploy.production': 'Production deploy',
  'session.budget': 'Session budget',
  'grant.request': 'Grant',
  'config.change': 'Config change',
  'app.teardown': 'App teardown',
}

/** What each kind MEANS, for the policies page. */
export const KIND_DESCRIPTIONS: Record<ApprovalKind, string> = {
  'app.create': 'Somebody asks Launch to create a new app.',
  'app.access': 'Somebody asks to sign in to an app its policy does not let them into.',
  'deploy.production': 'A release is promoted, or a build asks to deploy, to production.',
  'session.budget': 'A coding session has spent its budget and asks for more.',
  'grant.request': 'Somebody asks for a grant on an app.',
  'config.change': 'Somebody changes an app’s configuration.',
  'app.teardown': 'Somebody asks to archive an app and delete its resources.',
}

/** The kinds a filter or a policy page offers: the four P4 builds. */
export const FILTER_KINDS = BUILT_APPROVAL_KINDS

/** Status → the `.status-badge` vocabulary in `index.css`, and the word shown. */
export const STATUS_BADGE: Record<ApprovalStatus, { tone: string; label: string }> = {
  pending: { tone: 'awaiting-review', label: 'Waiting' },
  approved: { tone: 'approved', label: 'Approved' },
  rejected: { tone: 'rejected', label: 'Rejected' },
  expired: { tone: 'expired', label: 'Expired' },
  cancelled: { tone: 'archived', label: 'Cancelled' },
}

function usd(value: number): string {
  return `$${value.toFixed(2).replace(/\.00$/, '')}`
}

function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null
}

type SummaryInput = Pick<ApprovalRequest, 'context' | 'app' | 'requester' | 'requestedByLabel'>

/** The app's name as the request carries it, else a neutral phrase. */
function appName(req: Pick<ApprovalRequest, 'app'>): string {
  return req.app?.displayName ?? 'an app'
}

/** What is being approved, in one plain sentence. */
export function approvalSummary(req: SummaryInput): string {
  const context = req.context
  switch (context.kind) {
    case 'app.create':
      return `Create the app “${context.displayName}”`
    case 'app.access':
      return `Let ${personName(req.requester) ?? 'someone'} sign in to ${appName(req)}`
    case 'deploy.production': {
      const what = context.version ?? context.tag ?? shortSha(context.sha)
      return what
        ? `Deploy ${appName(req)} ${what} to production`
        : `Deploy ${appName(req)} to production`
    }
    case 'session.budget':
      return `Add ${usd(context.extraUsd)} to ${
        context.sessionTitle ? `the session “${context.sessionTitle}”` : 'a coding session'
      } on ${appName(req)}`
    case 'grant.request':
    case 'config.change':
    case 'app.teardown':
      return context.description
  }
}

function personName(person: ApprovalRequest['requester']): string | null {
  if (!person) return null
  return person.name?.trim() || person.email
}

/** Who asked: "You", the person, "GitHub: octocat" (a CI job), or "Launch". */
export function requesterName(
  req: Pick<ApprovalRequest, 'requester' | 'requestedByUserId' | 'requestedByLabel'>,
  viewerId: string | null | undefined
): string {
  if (viewerId && req.requestedByUserId === viewerId) return 'You'
  const person = personName(req.requester)
  if (person) return person
  const label = req.requestedByLabel
  if (label?.startsWith('github:')) return `GitHub: ${label.slice('github:'.length)}`
  return label ?? 'Launch'
}

/** "1 of 2 approvals". */
export function progressLabel(req: Pick<ApprovalRequest, 'approvals' | 'requiredApprovals'>) {
  const noun = req.requiredApprovals === 1 ? 'approval' : 'approvals'
  return `${Math.min(req.approvals, req.requiredApprovals)} of ${req.requiredApprovals} ${noun}`
}

/** "a", "b or c", "a, b or c". */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`
}

/**
 * Who may decide, in words, from the policy snapshot. Group names are resolved by the caller when
 * the reader may list groups; otherwise a count stands in (a member cannot read every group).
 */
export function approversSentence(
  approvers: ApprovalApprovers,
  groupNames: ReadonlyMap<string, string> = new Map()
): string {
  const parts: string[] = []
  if (approvers.appOwners) parts.push('the app’s owners')
  if (approvers.admins) parts.push('the organisation’s admins')
  const named = approvers.groupIds.map(id => groupNames.get(id)).filter(Boolean) as string[]
  const unnamed = approvers.groupIds.length - named.length
  for (const name of named) parts.push(`members of ${name}`)
  if (unnamed > 0) parts.push(unnamed === 1 ? 'members of one team' : `members of ${unnamed} teams`)
  if (approvers.userIds.length > 0) {
    parts.push(
      approvers.userIds.length === 1
        ? 'one named person'
        : `${approvers.userIds.length} named people`
    )
  }
  return parts.length ? orList(parts) : 'nobody (the policy names no approvers)'
}

/**
 * The one sentence a person who may NOT decide reads instead of the buttons. Null when they may,
 * or when the request is settled (the status says it).
 */
export function whyNotSentence(
  whyNot: ApprovalWhyNot | null,
  detail: Pick<ApprovalDetail, 'policy' | 'status'>,
  groupNames?: ReadonlyMap<string, string>
): string | null {
  switch (whyNot) {
    case null:
    case 'not_pending':
      return null
    case 'already_decided':
      return 'You have already decided this request. It is waiting for the other approvals.'
    case 'self_approval':
      return 'You can’t approve a request you asked for or are part of — someone else has to.'
    case 'not_an_approver':
      return `Waiting for ${approversSentence(detail.policy.approvers, groupNames)} to decide.`
  }
}

const AUTO_ROLE_LABELS: Record<AutoApproveRole, string> = {
  member: 'any member',
  admin: 'an admin or owner',
  owner: 'an owner',
}

export function autoApproveLabel(role: AutoApproveRole | null): string {
  return role ? `When ${AUTO_ROLE_LABELS[role]} asks` : 'Never'
}

const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR

/** "after 7 days", "after 36 hours", "never". */
export function policyExpiryLabel(minutes: number | null): string {
  if (minutes === null) return 'never'
  if (minutes % MINUTES_PER_DAY === 0) {
    const days = minutes / MINUTES_PER_DAY
    return `after ${days} day${days === 1 ? '' : 's'}`
  }
  if (minutes % MINUTES_PER_HOUR === 0) {
    const hours = minutes / MINUTES_PER_HOUR
    return `after ${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `after ${minutes} minutes`
}

/** One line for a policy: "1 approval from the app's owners · expires after 7 days". */
export function policySentence(
  policy: ApprovalPolicy,
  groupNames?: ReadonlyMap<string, string>
): string {
  const noun = policy.minApprovals === 1 ? 'approval' : 'approvals'
  return `${policy.minApprovals} ${noun} from ${approversSentence(policy.approvers, groupNames)}`
}

/** The inbox's "when": expiry for a waiting request, the decision time otherwise. */
export function isSettled(status: ApprovalStatus): boolean {
  return status !== 'pending'
}
