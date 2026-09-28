/**
 * `launch approvals ls|show|approve|reject` — the approvals inbox from a terminal (Launch P4, plan
 * §4f, D26), over the `/api/approvals` routes and `@launch/shared/launch-approvals`.
 *
 * - `ls [--box mine|requested|all] [--status] [--kind] [--app <slug>]` — the inbox; `mine` (waiting
 *   on me) is the default, as on the web page. `--app` resolves the slug to an id first.
 * - `show <id>` — what is being approved in plain words (one branch per kind, an exhaustive
 *   `switch`, so a new kind is a type error here until it has a sentence), the policy, N of M, every
 *   decision, and whether YOU may decide — with the reason when not.
 * - `approve <id> [--comment]` / `reject <id> [--comment]` — `POST /:id/decide`. A 409
 *   (`not_pending`, `already_decided`) is somebody else getting there first: it still exits 1, but
 *   with a sentence that says so and a pointer at `show`, not a raw envelope.
 *
 * Slice 4f owns this file. `cli.ts` calls `registerApprovalsCommands(program, action)` once, after
 * the kit's own commands, so this file adds its `program.command(...)` entries and never edits
 * `cli.ts` (the plugin `register` shape, `plugins/types.ts`).
 */

import {
  APPROVAL_BOXES,
  APPROVAL_ERROR_CODES,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  type ApprovalContext,
  type ApprovalDecisionValue,
  type ApprovalDetail,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalWhyNot,
  approvalDetailSchema,
  approvalListResponseSchema,
  approvalPath,
} from '@launch/shared/launch-approvals'
import { appDetailSchema } from '@launch/shared/launch-apps'
import chalk from 'chalk'
import { type Command, InvalidArgumentError } from 'commander'
import { type ApiResponse, CliApiError } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { formatDate, renderTable } from '../utils/output'

const approvalApiPath = (id: string) => `/api/approvals/${encodeURIComponent(id)}`

/** The web page for a request — what an approver opens to read the context in full. */
export function approvalUrl(ctx: CommandContext, id: string): string {
  return `${ctx.config.serverUrl.replace(/\/+$/, '')}${approvalPath(id)}`
}

// ---- words ---------------------------------------------------------------------------------

const KIND_LABELS: Record<ApprovalContext['kind'], string> = {
  'app.create': 'Create an app',
  'app.access': 'Access to an app',
  'deploy.production': 'Deploy to production',
  'session.budget': 'More session budget',
  'grant.request': 'A grant',
  'config.change': 'A configuration change',
  'app.teardown': 'Tear down an app',
}

/** Who asked: a person, or the GitHub actor for a request CI opened. */
export function requesterLabel(request: ApprovalRequest): string {
  if (request.requester) return request.requester.name ?? request.requester.email
  if (request.requestedByLabel) return request.requestedByLabel
  return 'someone'
}

const money = (usd: number) => `$${usd.toFixed(2)}`

/** One sentence per kind: what saying yes does. Pure, exhaustive. */
export function describeApproval(request: ApprovalRequest): string {
  const context = request.context
  const app = request.app ? request.app.displayName : 'an app'
  switch (context.kind) {
    case 'app.create':
      return `Create the app "${context.displayName}" (${context.slug}).`
    case 'app.access':
      return `Let ${requesterLabel(request)} sign in to ${app}.`
    case 'deploy.production': {
      const what = context.version
        ? `version ${context.version}`
        : context.sha
          ? `commit ${context.sha.slice(0, 7)}`
          : 'the default branch'
      return `Deploy ${what} of ${app} to production.`
    }
    case 'session.budget':
      return `Add ${money(context.extraUsd)} to the session "${context.sessionTitle ?? context.sessionId}" on ${app} (spent ${money(context.spentUsd)} of ${money(context.capUsd)}).`
    case 'grant.request':
    case 'config.change':
    case 'app.teardown':
      return context.description
    default: {
      const unreachable: never = context
      return String(unreachable)
    }
  }
}

/** The kind-specific lines under the summary (the deploy's PRs, staging's state). */
function contextLines(context: ApprovalContext): string[] {
  switch (context.kind) {
    case 'deploy.production': {
      const lines: string[] = []
      if (context.tag) lines.push(`Tag:      ${context.tag}`)
      if (context.ref) lines.push(`Ref:      ${context.ref}`)
      if (context.sha) lines.push(`Commit:   ${context.sha}`)
      if (context.stagingVersion || context.stagingHealth)
        lines.push(
          `Staging:  ${context.stagingVersion ?? 'unknown version'} (${context.stagingHealth ?? 'health unknown'})`
        )
      if (context.compareUrl) lines.push(`Changes:  ${context.compareUrl}`)
      if (context.runUrl) lines.push(`Run:      ${context.runUrl}`)
      if (context.prs.length > 0) {
        lines.push(`Pull requests (${context.prs.length}):`)
        for (const pr of context.prs) {
          const checks = pr.checks ? ` [${pr.checks}]` : ''
          lines.push(`  #${pr.number} ${pr.title}${pr.author ? ` — ${pr.author}` : ''}${checks}`)
        }
      }
      return lines
    }
    case 'app.create':
      return context.description ? [`About:    ${context.description}`] : []
    case 'app.access':
      return context.message ? [`Message:  ${context.message}`] : []
    case 'session.budget':
    case 'grant.request':
    case 'config.change':
    case 'app.teardown':
      return []
    default: {
      const unreachable: never = context
      return [String(unreachable)]
    }
  }
}

/** Who may decide, in words. */
export function describeApprovers(policy: ApprovalPolicy): string {
  const who: string[] = []
  if (policy.approvers.appOwners) who.push("the app's owners")
  if (policy.approvers.admins) who.push("the organisation's admins")
  if (policy.approvers.groupIds.length > 0) who.push(`${policy.approvers.groupIds.length} group(s)`)
  if (policy.approvers.userIds.length > 0) who.push(`${policy.approvers.userIds.length} person(s)`)
  const list = who.length > 0 ? who.join(', ') : 'nobody (check the policy)'
  const self = policy.allowSelfApproval ? '' : '; not the requester'
  return `${list}${self}`
}

const WHY_NOT: Record<ApprovalWhyNot, string> = {
  not_pending: 'It has already been decided.',
  not_an_approver: 'You are not one of its approvers.',
  self_approval: 'You asked for it (or authored what it ships), so someone else must decide.',
  already_decided: 'You have already decided.',
}

export function whyNotSentence(whyNot: ApprovalWhyNot | null): string {
  return whyNot ? WHY_NOT[whyNot] : 'You cannot decide this request.'
}

const statusColour = (status: ApprovalRequest['status']) =>
  status === 'approved'
    ? chalk.green(status)
    : status === 'pending'
      ? chalk.yellow(status)
      : status === 'rejected'
        ? chalk.red(status)
        : chalk.dim(status)

function renderDetail(ctx: CommandContext, detail: ApprovalDetail): string {
  const lines = [
    `${chalk.bold(KIND_LABELS[detail.kind])} — ${statusColour(detail.status)}`,
    describeApproval(detail),
    '',
    `Asked by: ${requesterLabel(detail)} on ${formatDate(detail.createdAt)}`,
  ]
  if (detail.reason) lines.push(`Reason:   ${detail.reason}`)
  if (detail.app) lines.push(`App:      ${detail.app.displayName} (${detail.app.slug})`)
  lines.push(...contextLines(detail.context))
  lines.push(
    `Progress: ${detail.approvals} of ${detail.requiredApprovals} approval${detail.requiredApprovals === 1 ? '' : 's'}`,
    `Who:      ${describeApprovers(detail.policy)}`
  )
  // While pending, the server names who it still waits on (`eligible`); an empty list means
  // nobody can approve it under the policy.
  if (detail.status === 'pending' && detail.eligible) {
    lines.push(
      detail.eligible.length > 0
        ? `Waiting:  ${detail.eligible.map(p => p.name ?? p.email).join(', ')}`
        : chalk.yellow('Waiting:  nobody can approve this — an admin must change the policy')
    )
  }
  if (detail.status === 'pending' && detail.expiresAt)
    lines.push(`Expires:  ${formatDate(detail.expiresAt)}`)
  if (detail.decidedAt) lines.push(`Decided:  ${formatDate(detail.decidedAt)}`)
  if (detail.applyError) lines.push(chalk.red(`Apply error: ${detail.applyError}`))
  if (detail.decisions.length > 0) {
    lines.push('Decisions:')
    for (const d of detail.decisions) {
      const mark = d.decision === 'approve' ? chalk.green('✓ approved') : chalk.red('✗ rejected')
      lines.push(
        `  ${mark} by ${d.userName ?? d.userEmail} ${chalk.dim(formatDate(d.at))}${d.comment ? ` — ${d.comment}` : ''}`
      )
    }
  }
  lines.push('')
  if (detail.canDecide)
    lines.push(
      chalk.cyan(
        `You can decide: ${ctx.binName} approvals approve ${detail.id}  |  ${ctx.binName} approvals reject ${detail.id}`
      )
    )
  else if (detail.status === 'pending') lines.push(chalk.dim(whyNotSentence(detail.whyNot)))
  lines.push(chalk.dim(approvalUrl(ctx, detail.id)))
  return lines.join('\n')
}

// ---- commands ------------------------------------------------------------------------------

export interface ApprovalsListOptions {
  box?: (typeof APPROVAL_BOXES)[number]
  status?: (typeof APPROVAL_STATUSES)[number]
  kind?: (typeof APPROVAL_KINDS)[number]
  app?: string
}

export async function runApprovalsList(
  ctx: CommandContext,
  options: ApprovalsListOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const appId = options.app
    ? (
        await client.get(`/api/apps/${encodeURIComponent(options.app)}`, {
          schema: appDetailSchema,
        })
      ).id
    : undefined
  const { data, raw } = await client.request('GET', '/api/approvals', {
    schema: approvalListResponseSchema,
    query: { box: options.box ?? 'mine', status: options.status, kind: options.kind, appId },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Id', value: r => r.id.slice(0, 8) },
      { header: 'Kind', value: r => r.kind },
      { header: 'App', value: r => r.app?.slug },
      { header: 'Status', value: r => r.status },
      { header: 'Approvals', value: r => `${r.approvals}/${r.requiredApprovals}` },
      { header: 'Requested by', value: r => requesterLabel(r) },
      { header: 'Expires', value: r => (r.status === 'pending' ? formatDate(r.expiresAt) : null) },
    ])
  )
}

/**
 * The list shows 8-character ids, so `show`/`approve`/`reject` accept a prefix: it is resolved
 * against the caller's own boxes (`mine`, then `requested`, then `all` — `all` answers `mine` for a
 * non-admin, which is harmless). A full uuid is used as is.
 */
async function resolveApprovalId(ctx: CommandContext, id: string): Promise<string> {
  const trimmed = id.trim()
  if (!trimmed) throw new CliError('Give an approval id')
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed))
    return trimmed
  const client = requireClient(ctx)
  const matches = new Set<string>()
  for (const box of APPROVAL_BOXES) {
    const list = await client.get('/api/approvals', {
      schema: approvalListResponseSchema,
      query: { box, limit: 200 },
    })
    for (const item of list.items)
      if (item.id.startsWith(trimmed.toLowerCase())) matches.add(item.id)
    if (matches.size > 0) break
  }
  if (matches.size === 1) return [...matches][0] as string
  if (matches.size > 1)
    throw new CliError(`"${trimmed}" matches more than one request — give more of the id`)
  throw new CliError(`No approval request matches "${trimmed}"`, {
    hint: `List them with \`${ctx.binName} approvals ls --box all\`.`,
  })
}

export async function runApprovalsShow(ctx: CommandContext, id: string): Promise<void> {
  const fullId = await resolveApprovalId(ctx, id)
  const { data, raw } = await requireClient(ctx).request('GET', approvalApiPath(fullId), {
    schema: approvalDetailSchema,
  })
  ctx.out.data(raw, () => renderDetail(ctx, data))
}

export async function runApprovalsDecide(
  ctx: CommandContext,
  id: string,
  decision: ApprovalDecisionValue,
  options: { comment?: string } = {}
): Promise<void> {
  const fullId = await resolveApprovalId(ctx, id)
  const comment = options.comment?.trim()
  let result: ApiResponse<ApprovalDetail>
  try {
    result = await requireClient(ctx).request('POST', `${approvalApiPath(fullId)}/decide`, {
      schema: approvalDetailSchema,
      body: { decision, ...(comment ? { comment } : {}) },
    })
  } catch (error) {
    // 409 is information: somebody else got there first (or you already did). Say so plainly.
    if (
      error instanceof CliApiError &&
      error.status === 409 &&
      (error.code === APPROVAL_ERROR_CODES.notPending ||
        error.code === APPROVAL_ERROR_CODES.alreadyDecided)
    ) {
      throw new CliError(
        error.code === APPROVAL_ERROR_CODES.alreadyDecided
          ? 'You have already decided this request.'
          : 'This request has already been decided — nothing was changed.',
        { hint: `See where it stands: \`${ctx.binName} approvals show ${fullId}\`.` }
      )
    }
    throw error
  }
  const detail = result.data
  ctx.out.data(result.raw, () => {
    const verb = decision === 'approve' ? chalk.green('✓ Approved') : chalk.red('✗ Rejected')
    const state =
      detail.status === 'pending'
        ? `${detail.approvals} of ${detail.requiredApprovals} approvals — still waiting on others.`
        : `The request is now ${detail.status}.`
    return `${verb}: ${describeApproval(detail)}\n  ${state}`
  })
}

// ---- registration --------------------------------------------------------------------------

function oneOf<T extends string>(flag: string, values: readonly T[]) {
  return (value: string): T => {
    if (!(values as readonly string[]).includes(value))
      throw new InvalidArgumentError(`${flag} must be one of ${values.join(', ')}`)
    return value as T
  }
}

export function registerApprovalsCommands(program: Command, action: ActionWrapper): void {
  const approvals = program
    .command('approvals')
    .description(
      'requests waiting on a decision — app creation, access, production deploys, budget'
    )
  approvals
    .command('ls')
    .description('list approval requests (default: the ones waiting on you)')
    .option('--box <box>', 'mine | requested | all (admins)', oneOf('--box', APPROVAL_BOXES))
    .option(
      '--status <status>',
      APPROVAL_STATUSES.join(' | '),
      oneOf('--status', APPROVAL_STATUSES)
    )
    .option('--kind <kind>', APPROVAL_KINDS.join(' | '), oneOf('--kind', APPROVAL_KINDS))
    .option('--app <slug>', 'only this app’s requests')
    .action(action((ctx, cmd) => runApprovalsList(ctx, cmd.opts())))
  approvals
    .command('show <id>')
    .description('what is being approved, who asked, the progress, and whether you may decide')
    .action(action((ctx, cmd) => runApprovalsShow(ctx, cmd.args[0] ?? '')))
  approvals
    .command('approve <id>')
    .description('approve a request')
    .option('--comment <text>', 'a note recorded with your decision')
    .action(action((ctx, cmd) => runApprovalsDecide(ctx, cmd.args[0] ?? '', 'approve', cmd.opts())))
  approvals
    .command('reject <id>')
    .description('reject a request (one rejection is final)')
    .option('--comment <text>', 'a note recorded with your decision')
    .action(action((ctx, cmd) => runApprovalsDecide(ctx, cmd.args[0] ?? '', 'reject', cmd.opts())))
}
