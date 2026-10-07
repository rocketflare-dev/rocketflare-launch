/**
 * `launch policies ls|set|rm` — approval policies (Settings → Approvals, Launch P4), over
 * `/api/approval-policies`; `manage ApprovalPolicy` (the organisation's admins) at every scope.
 *
 * - `ls [--kind] [--scope tenant|group|app] [--scope-id]` — the rows, then each kind's code default
 *   the rows override (`--json`: `{ items, defaults }`).
 * - `set <kind> [--group <group> | --app <slug>]` — upsert the policy at that scope. Flags edit ONE
 *   field each, on top of the row already at that scope (or the default when there is none), so
 *   `policies set deploy.production --min 2` keeps everything else; `--data <json|@file|->` is a
 *   whole or partial body, applied under the flags. The result is validated with
 *   `putApprovalPolicySchema` before it is sent. Turning on "approve automatically for members"
 *   asks first, in the page's words.
 * - `rm <id>` — remove a row (id or prefix); asks first: requests made from now on follow the next
 *   scope out, and requests already open keep the policy they were opened with.
 */
import {
  APPROVAL_KINDS,
  APPROVAL_POLICY_SCOPES,
  type ApprovalKind,
  type ApprovalPolicyRow,
  AUTO_APPROVE_ROLES,
  approvalPolicyListResponseSchema,
  approvalPolicyRowSchema,
  putApprovalPolicySchema,
} from '@launch/shared/launch-approvals'
import { appDetailSchema } from '@launch/shared/launch-apps'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import {
  type ConfirmOptions,
  confirmConsequence,
  type InputSeams,
  oneOf,
  parseBody,
  readDataObject,
} from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { describeApprovers } from './approvals'
import { findGroup } from './groups-write'
import { findMember } from './members'
import { pickOne } from './org-common'

/** The page's names for each kind (`approvalModel.ts` `KIND_LABELS`). */
export const KIND_LABELS: Record<ApprovalKind, string> = {
  'app.create': 'New app',
  'app.access': 'App access',
  'deploy.production': 'Production deploy',
  'session.budget': 'Session budget',
  'grant.request': 'Secret access',
  'config.change': 'Config change',
  'app.teardown': 'App teardown',
  'session.merge': 'Session merge',
}

const policyPath = (id: string) => `/api/approval-policies/${encodeURIComponent(id)}`

function expiryWords(minutes: number | null): string {
  if (minutes === null) return 'never'
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function scopeWords(row: Pick<ApprovalPolicyRow, 'scopeType' | 'scopeId'>): string {
  return row.scopeType === 'tenant'
    ? 'organisation'
    : `${row.scopeType} ${row.scopeId?.slice(0, 8)}`
}

export interface PoliciesListOptions {
  kind?: ApprovalKind
  scope?: string
  scopeId?: string
}

export async function runPoliciesList(ctx: CommandContext, options: PoliciesListOptions = {}) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/approval-policies', {
    schema: approvalPolicyListResponseSchema,
    query: { kind: options.kind, scopeType: options.scope, scopeId: options.scopeId },
  })
  ctx.out.data(raw, () => {
    const rows = renderTable(data.items, [
      { header: 'Kind', value: r => KIND_LABELS[r.kind] },
      { header: 'Scope', value: r => scopeWords(r) },
      { header: 'Approvals', value: r => String(r.minApprovals) },
      { header: 'From', value: r => describeApprovers(r, r.kind) },
      { header: 'Auto-approve', value: r => r.autoApproveRole ?? 'never' },
      { header: 'Expires', value: r => expiryWords(r.expiresAfterMinutes) },
      { header: 'Updated', value: r => formatDate(r.updatedAt) },
      { header: 'Id', value: r => r.id },
    ])
    const kinds = (Object.keys(data.defaults) as ApprovalKind[]).filter(
      k => !options.kind || k === options.kind
    )
    const defaults = renderTable(
      kinds.map(k => ({ kind: k, policy: data.defaults[k] })),
      [
        { header: 'Default for', value: d => `${KIND_LABELS[d.kind]} (${d.kind})` },
        { header: 'Approvals', value: d => String(d.policy?.minApprovals ?? '') },
        { header: 'From', value: d => (d.policy ? describeApprovers(d.policy, d.kind) : '') },
        { header: 'Auto-approve', value: d => d.policy?.autoApproveRole ?? 'never' },
        {
          header: 'Expires',
          value: d => (d.policy ? expiryWords(d.policy.expiresAfterMinutes) : ''),
        },
      ]
    )
    return `${data.items.length ? rows : chalk.dim('Every kind uses Launch’s defaults.')}\n\n${defaults}`
  })
}

export interface PoliciesSetOptions extends ConfirmOptions, InputSeams {
  group?: string
  app?: string
  admins?: boolean
  appOwners?: boolean
  approverGroups?: string
  approvers?: string
  min?: number
  selfApproval?: boolean
  expires?: string
  autoApprove?: string
  data?: string
}

/** `90` (minutes), `12h`, `7d` or `never` → minutes or null. */
export function expiresMinutes(value: string): number | null {
  const v = value.trim().toLowerCase()
  if (v === 'never') return null
  const m = /^(\d+)([mhd]?)$/.exec(v)
  if (!m) throw new CliError(`--expires must be minutes, 12h, 7d or never — not "${value}"`)
  const n = Number(m[1])
  return m[2] === 'd' ? n * 1440 : m[2] === 'h' ? n * 60 : n
}

const csv = (value: string | undefined) =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)

export async function runPoliciesSet(
  ctx: CommandContext,
  kind: string,
  options: PoliciesSetOptions
) {
  if (!(APPROVAL_KINDS as readonly string[]).includes(kind))
    throw new CliError(`Unknown kind "${kind}"`, { hint: `One of: ${APPROVAL_KINDS.join(', ')}` })
  const k = kind as ApprovalKind
  if (options.group && options.app) throw new CliError('Give --group or --app, not both')
  const client = requireClient(ctx)

  let scopeType: 'tenant' | 'group' | 'app' = 'tenant'
  let scopeId: string | null = null
  if (options.group) {
    scopeType = 'group'
    scopeId = (await findGroup(ctx, options.group)).id
  } else if (options.app) {
    scopeType = 'app'
    scopeId = (
      await client.get(`/api/apps/${encodeURIComponent(options.app)}`, { schema: appDetailSchema })
    ).id
  }

  const list = await client.get('/api/approval-policies', {
    schema: approvalPolicyListResponseSchema,
    query: { kind: k, scopeType, scopeId: scopeId ?? undefined },
  })
  const existing = list.items.find(
    r => r.kind === k && r.scopeType === scopeType && r.scopeId === scopeId
  )
  const current = existing ?? list.defaults[k]
  const data = (await readDataObject(options.data, options)) ?? {}

  const approvers = {
    ...current?.approvers,
    ...(data.approvers as object | undefined),
  } as Record<string, unknown>
  if (options.admins !== undefined) approvers.admins = options.admins
  if (options.appOwners !== undefined) approvers.appOwners = options.appOwners
  const groupRefs = csv(options.approverGroups)
  if (groupRefs) {
    const ids: string[] = []
    for (const g of groupRefs) ids.push((await findGroup(ctx, g)).id)
    approvers.groupIds = ids
  }
  const userRefs = csv(options.approvers)
  if (userRefs) {
    const ids: string[] = []
    for (const u of userRefs) ids.push((await findMember(ctx, u)).userId)
    approvers.userIds = ids
  }

  const body = parseBody(putApprovalPolicySchema, {
    minApprovals: current?.minApprovals,
    allowSelfApproval: current?.allowSelfApproval,
    expiresAfterMinutes: current?.expiresAfterMinutes,
    autoApproveRole: current?.autoApproveRole,
    ...data,
    approvers,
    kind: k,
    scopeType,
    scopeId,
    ...(options.min !== undefined ? { minApprovals: options.min } : {}),
    ...(options.selfApproval !== undefined ? { allowSelfApproval: options.selfApproval } : {}),
    ...(options.expires !== undefined
      ? { expiresAfterMinutes: expiresMinutes(options.expires) }
      : {}),
    ...(options.autoApprove !== undefined
      ? { autoApproveRole: options.autoApprove === 'never' ? null : options.autoApprove }
      : {}),
  })

  if (body.autoApproveRole === 'member' && current?.autoApproveRole !== 'member') {
    const ok = await confirmConsequence(
      ctx,
      options,
      `Approve every ${KIND_LABELS[k].toLowerCase()} request at once?`,
      'Nobody is asked: every request made from now on is approved as soon as it is made (still recorded, decided by Launch).'
    )
    if (!ok) return
  }

  const { data: row, raw } = await client.request('PUT', '/api/approval-policies', {
    schema: approvalPolicyRowSchema,
    body,
  })
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} ${KIND_LABELS[row.kind]} at ${scopeWords(row)} scope: ${row.minApprovals} approval(s) from ${describeApprovers(row, row.kind)}.`,
      chalk.dim('Requests already open keep the policy they were opened with.'),
    ].join('\n')
  )
}

export async function runPoliciesRemove(ctx: CommandContext, ref: string, options: ConfirmOptions) {
  const client = requireClient(ctx)
  const list = await client.get('/api/approval-policies', {
    schema: approvalPolicyListResponseSchema,
  })
  const row = pickOne(list.items, ref, {
    noun: 'policy',
    listHint: `${ctx.binName} policies ls`,
  })
  const next =
    row.scopeType === 'tenant'
      ? 'Launch’s default'
      : row.scopeType === 'app'
        ? 'the app’s team, or the organisation'
        : 'the organisation'
  const question =
    row.scopeType === 'tenant'
      ? `Go back to the default for ${KIND_LABELS[row.kind]}?`
      : `Remove this ${KIND_LABELS[row.kind]} override (${scopeWords(row)})?`
  if (
    !(await confirmConsequence(
      ctx,
      options,
      question,
      `Requests made from now on follow ${next} policy. Requests already open keep the policy they were opened with.`
    ))
  )
    return
  await client.request('DELETE', policyPath(row.id))
  ctx.out.data({ removed: row.id }, () => `${chalk.green('✓')} Removed.`)
}

export function registerPoliciesCommands(program: Command, action: ActionWrapper): void {
  const policies = program
    .command('policies')
    .description('who approves which kind of request (admin+)')
  policies
    .command('ls')
    .description('policy rows, then the defaults they override')
    .option('--kind <kind>', APPROVAL_KINDS.join(' | '), oneOf('--kind', APPROVAL_KINDS))
    .option(
      '--scope <scope>',
      APPROVAL_POLICY_SCOPES.join(' | '),
      oneOf('--scope', APPROVAL_POLICY_SCOPES)
    )
    .option('--scope-id <id>', 'the group or app id')
    .action(action((ctx, cmd) => runPoliciesList(ctx, cmd.opts())))
  policies
    .command('set <kind>')
    .description('set the policy for a kind (organisation-wide, or for --group / --app)')
    .option('--group <group>', 'override for an owner team (group id or name)')
    .option('--app <slug>', 'override for one app')
    .option('--admins', "the organisation's admins approve")
    .option('--no-admins', 'the admins do not approve')
    .option('--app-owners', "the app's owners approve")
    .option('--no-app-owners', 'the app owners do not approve')
    .option(
      '--approver-groups <groups>',
      'comma-separated groups whose members approve ("" = none)'
    )
    .option('--approvers <users>', 'comma-separated people who approve, ids or emails ("" = none)')
    .option('--min <n>', 'approvals needed (1–10)', (v: string) => Number(v))
    .option('--self-approval', 'the requester may approve their own request')
    .option('--no-self-approval', 'the requester may not (the default)')
    .option('--expires <after>', 'minutes, 12h, 7d, or never')
    .option(
      '--auto-approve <role>',
      `${AUTO_APPROVE_ROLES.join(' | ')} | never — requesters at or above it are approved at once`,
      oneOf('--auto-approve', [...AUTO_APPROVE_ROLES, 'never'] as const)
    )
    .option('--data <json|@file|->', 'a policy body (approvers, minApprovals…), under the flags')
    .option('-y, --yes', 'do not ask before approving automatically')
    .action(action((ctx, cmd) => runPoliciesSet(ctx, cmd.args[0] ?? '', cmd.opts())))
  policies
    .command('rm <id>')
    .description('remove a policy row (id or prefix) — the next scope out applies')
    .option('-y, --yes', 'do not ask first')
    .action(action((ctx, cmd) => runPoliciesRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
}
