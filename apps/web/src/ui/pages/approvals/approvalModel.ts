/**
 * Everything the approvals inbox and a request's page SAY, decided here and nowhere else — pure,
 * so the wording is unit-tested (`tests/config/approval-model.test.ts`) and the inbox row, the
 * page heading and the panel can never describe one request three ways.
 *
 * - `approvalSummary(req)` — what is being approved, in plain words, per kind (an exhaustive
 *   `switch` over the shared union: a new kind is a type error until it has a sentence);
 * - `requesterName(req, viewerId)` — "You", the person, "GitHub: octocat" for a CI-opened request;
 * - `whyNotSentence(whyNot, detail)` — the ONE sentence a person who may not decide reads instead
 *   of a disabled button, naming who it waits on (`waitingOn`, from the server's `eligible`);
 * - `approversSentence(approvers, groupNames, extra)` — who may decide, from the policy snapshot,
 *   plus whoever the kind's `eligibleExtra` adds (`extraApprovers`: a `grant.request` is decided
 *   by the RESOURCE's owner team, which no policy list names — "the IT Identity team");
 *   `requestApproversSentence(detail, groupNames, ownerTeam)` is the two together for one request;
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
  'grant.request': 'Shared config',
  'config.change': 'Config change',
  'app.teardown': 'App teardown',
}

/** What each kind MEANS, for the policies page. */
export const KIND_DESCRIPTIONS: Record<ApprovalKind, string> = {
  'app.create': 'Somebody asks Launch to create a new app.',
  'app.access': 'Somebody asks to sign in to an app its policy does not let them into.',
  'deploy.production': 'A release is promoted, or a build asks to deploy, to production.',
  'session.budget': 'A coding session has spent its budget and asks for more.',
  'grant.request':
    'An app asks to hold shared config in one environment; the resource’s owner team decides.',
  'config.change': 'Somebody changes an app’s configuration.',
  'app.teardown': 'Somebody asks to archive an app and delete its resources.',
}

/** The kinds a filter or a policy page offers: the built ones (P4's four and P5's grants). */
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
      return `Let ${appName(req)} hold ${context.resourceName} in ${context.environment}`
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
 * Who a kind's `eligibleExtra` makes an approver beyond the policy's own lists, in words — or null
 * when the kind adds nobody. P5 (plan §1.8): a `grant.request` is decided by the members of the
 * resource's OWNER group, which the policy never names (its default lists nobody at all), so
 * without this the page would say "nobody" about a request a whole team may approve. The team's
 * name comes from the resource when the reader could load it; otherwise a description stands in.
 */
export function extraApprovers(kind: ApprovalKind, ownerTeam?: string | null): string | null {
  switch (kind) {
    case 'grant.request':
      return ownerTeam ? `the ${ownerTeam} team` : 'the team that owns the shared config'
    default:
      return null
  }
}

/**
 * Who may decide, in words, from the policy snapshot. Group names are resolved by the caller when
 * the reader may list groups; otherwise a count stands in (a member cannot read every group).
 * `extra` (from `extraApprovers`) leads the sentence: for a kind that has one, it is who decides.
 */
export function approversSentence(
  approvers: ApprovalApprovers,
  groupNames: ReadonlyMap<string, string> = new Map(),
  extra: string | null = null
): string {
  const parts: string[] = []
  if (extra) parts.push(extra)
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

/** Who may decide ONE request: its policy snapshot plus whoever its kind adds. */
export function requestApproversSentence(
  detail: Pick<ApprovalDetail, 'kind' | 'policy'>,
  groupNames?: ReadonlyMap<string, string>,
  ownerTeam?: string | null
): string {
  return approversSentence(
    detail.policy.approvers,
    groupNames,
    extraApprovers(detail.kind, ownerTeam)
  )
}

/** How many eligible approvers a sentence names before "and N others". */
const NAMED_APPROVERS = 3

/**
 * Who a pending request waits on, by NAME when the server listed them (`detail.eligible`): "Alice,
 * Bob or Carol", "Alice, Bob or 4 others". Falls back to the policy's words when the list is absent
 * (an older answer), and says plainly when nobody at all can approve it.
 */
export function waitingOn(
  detail: Pick<ApprovalDetail, 'policy'> & {
    eligible?: ApprovalDetail['eligible']
    kind?: ApprovalKind
  },
  groupNames?: ReadonlyMap<string, string>
): { who: string; nobody: boolean } {
  const eligible = detail.eligible
  if (!eligible) {
    const extra = detail.kind ? extraApprovers(detail.kind) : null
    return { who: approversSentence(detail.policy.approvers, groupNames, extra), nobody: false }
  }
  if (eligible.length === 0) return { who: '', nobody: true }
  const names = eligible.map(p => p.name?.trim() || p.email)
  if (names.length <= NAMED_APPROVERS) return { who: orList(names), nobody: false }
  const rest = names.length - (NAMED_APPROVERS - 1)
  return {
    who: `${names.slice(0, NAMED_APPROVERS - 1).join(', ')} or ${rest} others`,
    nobody: false,
  }
}

const NOBODY_SENTENCE =
  'Nobody can approve this request: everyone the policy names is excluded or has already ' +
  'decided. An admin can change the policy in Settings → Approvals.'

/**
 * The one sentence a person who may NOT decide reads instead of the buttons. Null when they may,
 * or when the request is settled (the status says it).
 */
export function whyNotSentence(
  whyNot: ApprovalWhyNot | null,
  detail: Pick<ApprovalDetail, 'policy' | 'status'> & {
    eligible?: ApprovalDetail['eligible']
    kind?: ApprovalKind
  },
  groupNames?: ReadonlyMap<string, string>
): string | null {
  if (whyNot === null || whyNot === 'not_pending') return null
  const { who, nobody } = waitingOn(detail, groupNames)
  switch (whyNot) {
    case 'already_decided':
      return nobody
        ? 'You have already decided this request.'
        : `You have already decided this request. It is waiting for ${who}.`
    case 'self_approval':
      return nobody
        ? `You can’t approve a request you asked for or are part of. ${NOBODY_SENTENCE}`
        : `You can’t approve a request you asked for or are part of — someone else has to: ${who}.`
    case 'not_an_approver':
      return nobody ? NOBODY_SENTENCE : `Waiting for ${who} to decide.`
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

/**
 * One line for a policy: "1 approval from the app's owners". `extra` (from `extraApprovers`) names
 * whoever the kind adds — a `grant.request` policy row reads "from the team that owns the shared
 * config", not "from nobody".
 */
export function policySentence(
  policy: ApprovalPolicy,
  groupNames?: ReadonlyMap<string, string>,
  extra: string | null = null
): string {
  const noun = policy.minApprovals === 1 ? 'approval' : 'approvals'
  return `${policy.minApprovals} ${noun} from ${approversSentence(policy.approvers, groupNames, extra)}`
}

/** The inbox's "when": expiry for a waiting request, the decision time otherwise. */
export function isSettled(status: ApprovalStatus): boolean {
  return status !== 'pending'
}
