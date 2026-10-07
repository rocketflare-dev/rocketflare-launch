/**
 * `launch members ls|set-role|rm|groups` and `launch invites ls|pending|send|resend|revoke` —
 * Settings → People from a terminal (issue #6), over `/api/members` and `/api/invitations`.
 *
 * A member is named by user id, id prefix or email (resolved from `GET /api/members`). Removing a
 * member, revoking an invitation and a `members groups` that takes groups away ask first and state
 * the consequence in the People page's words; `--yes` skips the prompt (and is required without a
 * terminal). `invites send` with one address is `POST /api/invitations`, with several the bulk
 * route, whose per-address results are printed. Every refusal is the server's sentence, exit 1; a
 * 403 exits 3.
 */
import { groupListResponseSchema, myGroupsSchema } from '@launch/shared/groups'
import { paginatedResponse } from '@launch/shared/pagination'
import {
  bulkInviteRequestSchema,
  bulkInviteResponseSchema,
  type Invitation,
  invitationSchema,
  inviteMemberRequestSchema,
  type Member,
  memberSchema,
  tenantRoleSchema,
  updateMemberRoleRequestSchema,
} from '@launch/shared/tenants'
import chalk from 'chalk'
import type { Command } from 'commander'
import { z } from 'zod'
import { type CommandContext, requireClient } from '../context'
import type { ActionWrapper } from '../plugins/types'
import {
  type ConfirmOptions,
  confirmConsequence,
  oneOf,
  parseBody,
  positiveInt,
} from '../utils/input'
import { formatDate, formatPagination, renderTable } from '../utils/output'
import { listWords, pickOne } from './org-common'

export const membersResponseSchema = paginatedResponse(memberSchema)
export const invitationsResponseSchema = paginatedResponse(invitationSchema)
export const pendingInvitationsSchema = z.object({ items: z.array(invitationSchema) })

const memberPath = (userId: string) => `/api/members/${encodeURIComponent(userId)}`
const invitationPath = (id: string) => `/api/invitations/${encodeURIComponent(id)}`

const ROLES = tenantRoleSchema.options

// ---- lookups ---------------------------------------------------------------------------------

/** Every member (the list is paged at 200; an organisation larger than that walks the pages). */
export async function allMembers(ctx: CommandContext): Promise<Member[]> {
  const client = requireClient(ctx)
  const out: Member[] = []
  for (let page = 1; page <= 50; page++) {
    const data = await client.get('/api/members', {
      schema: membersResponseSchema,
      query: { page, pageSize: 200 },
    })
    out.push(...data.items)
    if (page >= data.pagination.totalPages) break
  }
  return out
}

/** A member by user id, id prefix or email. */
export async function findMember(ctx: CommandContext, ref: string): Promise<Member> {
  const members = await allMembers(ctx)
  const rows = members.map(m => ({ ...m, id: m.userId }))
  return pickOne(rows, ref, {
    noun: 'member',
    listHint: `${ctx.binName} members ls`,
    names: m => [m.email],
  })
}

const who = (m: Pick<Member, 'name' | 'email'>) => (m.name ? `${m.name} <${m.email}>` : m.email)

// ---- members ---------------------------------------------------------------------------------

export interface PageOptions {
  page?: number
  pageSize?: number
}

export async function runMembersList(ctx: CommandContext, options: PageOptions = {}) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/members', {
    schema: membersResponseSchema,
    query: { page: options.page, pageSize: options.pageSize },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Email', value: m => m.email },
      { header: 'Name', value: m => m.name },
      { header: 'Role', value: m => m.role },
      { header: 'Groups', value: m => m.groups.map(g => g.name).join(', ') },
      { header: 'Last sign-in', value: m => (m.lastLoginAt ? formatDate(m.lastLoginAt) : 'never') },
      { header: 'User id', value: m => m.userId },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

export async function runMembersSetRole(ctx: CommandContext, ref: string, role: string) {
  const body = parseBody(updateMemberRoleRequestSchema, { role })
  const member = await findMember(ctx, ref)
  const { raw } = await requireClient(ctx).request('PATCH', memberPath(member.userId), {
    schema: z.object({ userId: z.string(), role: z.string() }),
    body,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} ${who(member)} is now ${body.role}.`)
}

export async function runMembersRemove(ctx: CommandContext, ref: string, options: ConfirmOptions) {
  const member = await findMember(ctx, ref)
  const org = ctx.config.tenantName ?? 'this organisation'
  if (
    !(await confirmConsequence(
      ctx,
      options,
      `Remove ${who(member)} from ${org}?`,
      'They lose access immediately.'
    ))
  )
    return
  await requireClient(ctx).request('DELETE', memberPath(member.userId))
  ctx.out.data(
    { removed: member.userId },
    () => `${chalk.green('✓')} Removed ${who(member)} from ${org}.`
  )
}

export interface MemberGroupsOptions extends ConfirmOptions {
  none?: boolean
}

/** `members groups <user> [groups…]`: show, or replace wholesale (`--none` clears them). */
export async function runMembersGroups(
  ctx: CommandContext,
  ref: string,
  groupRefs: string[],
  options: MemberGroupsOptions = {}
) {
  const member = await findMember(ctx, ref)
  if (groupRefs.length === 0 && !options.none) {
    ctx.out.data({ items: member.groups }, () =>
      member.groups.length === 0
        ? `${who(member)} is in no groups.`
        : renderTable(member.groups, [
            { header: 'Type', value: g => g.typeName },
            { header: 'Group', value: g => g.name },
            { header: 'Id', value: g => g.id },
          ])
    )
    return
  }
  const client = requireClient(ctx)
  const groups = await client.get('/api/groups', { schema: groupListResponseSchema })
  const wanted = groupRefs.map(g =>
    pickOne(groups.items, g, {
      noun: 'group',
      listHint: `${ctx.binName} groups list`,
      names: x => [x.name],
    })
  )
  const body = parseBody(z.object({ groupIds: z.array(z.string().uuid()) }), {
    groupIds: [...new Set(wanted.map(g => g.id))],
  })
  const leaving = member.groups.filter(g => !body.groupIds.includes(g.id))
  if (
    leaving.length > 0 &&
    !(await confirmConsequence(
      ctx,
      options,
      `Take ${who(member)} out of ${listWords(leaving.map(g => g.name))}?`,
      'They stop seeing what those groups were given (documents and dashboards shared with them).'
    ))
  )
    return
  const { data, raw } = await client.request('PUT', `/api/members/${member.userId}/groups`, {
    schema: myGroupsSchema,
    body,
  })
  ctx.out.data(
    raw,
    () =>
      `${chalk.green('✓')} ${who(member)}: ${
        data.items.length
          ? listWords(
              data.items.map(g => g.name),
              20
            )
          : 'no groups'
      }.`
  )
}

// ---- invitations -----------------------------------------------------------------------------

function inviteRows(items: readonly Invitation[], withOrg = false) {
  return renderTable(items, [
    ...(withOrg ? [{ header: 'Organisation', value: (i: Invitation) => i.tenantName ?? '' }] : []),
    { header: 'Email', value: i => i.email },
    { header: 'Role', value: i => i.role },
    { header: 'Status', value: i => i.status },
    { header: 'Invited by', value: i => i.invitedByName },
    { header: 'Expires', value: i => formatDate(i.expiresAt) },
    { header: 'Id', value: i => i.id },
  ])
}

export async function runInvitesList(ctx: CommandContext, options: PageOptions = {}) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/invitations', {
    schema: invitationsResponseSchema,
    query: { page: options.page, pageSize: options.pageSize },
  })
  ctx.out.data(raw, () =>
    data.items.length === 0 ? 'No pending invitations.' : inviteRows(data.items)
  )
  ctx.out.text(formatPagination(data.pagination))
}

/** Invitations addressed to YOUR email, in any organisation. */
export async function runInvitesPending(ctx: CommandContext) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/invitations/pending', {
    schema: pendingInvitationsSchema,
  })
  ctx.out.data(raw, () =>
    data.items.length === 0 ? 'No invitations are waiting for you.' : inviteRows(data.items, true)
  )
  if (data.items.length > 0)
    ctx.log.hint('Accept one from the link in its email (a browser sign-in).')
}

export async function runInvitesSend(
  ctx: CommandContext,
  emails: string[],
  options: { role?: string } = {}
) {
  const role = options.role ?? 'member'
  const client = requireClient(ctx)
  if (emails.length === 1) {
    const body = parseBody(inviteMemberRequestSchema, { email: emails[0], role })
    const { data, raw } = await client.request('POST', '/api/invitations', {
      schema: invitationSchema,
      body,
    })
    ctx.out.data(
      raw,
      () =>
        `${chalk.green('✓')} Invited ${data.email} as ${data.role} — the link expires ${formatDate(data.expiresAt)}.`
    )
    return
  }
  const body = parseBody(bulkInviteRequestSchema, { emails, role })
  const { data, raw } = await client.request('POST', '/api/invitations/bulk', {
    schema: bulkInviteResponseSchema,
    body,
  })
  ctx.out.data(raw, () =>
    renderTable(data.results, [
      { header: 'Email', value: r => r.email },
      {
        header: 'Result',
        value: r =>
          r.status === 'invited'
            ? chalk.green('invited')
            : r.status === 'skipped'
              ? chalk.yellow('skipped')
              : chalk.red('failed'),
      },
      { header: 'Why', value: r => r.reason ?? '' },
    ])
  )
}

async function findInvitation(ctx: CommandContext, ref: string): Promise<Invitation> {
  const data = await requireClient(ctx).get('/api/invitations', {
    schema: invitationsResponseSchema,
    query: { pageSize: 200 },
  })
  return pickOne(data.items, ref, {
    noun: 'invitation',
    listHint: `${ctx.binName} invites ls`,
    names: i => [i.email],
  })
}

export async function runInvitesResend(ctx: CommandContext, ref: string) {
  const invite = await findInvitation(ctx, ref)
  const { data, raw } = await requireClient(ctx).request(
    'POST',
    `/api/invitations/${invite.id}/resend`,
    { schema: invitationSchema }
  )
  ctx.out.data(
    raw,
    () =>
      `${chalk.green('✓')} Sent ${data.email} a new link — it expires ${formatDate(data.expiresAt)}.`
  )
}

export async function runInvitesRevoke(ctx: CommandContext, ref: string, options: ConfirmOptions) {
  const invite = await findInvitation(ctx, ref)
  if (
    !(await confirmConsequence(
      ctx,
      options,
      `Revoke the invitation to ${invite.email}?`,
      'Its link stops working; you can invite them again later.'
    ))
  )
    return
  await requireClient(ctx).request('DELETE', invitationPath(invite.id))
  ctx.out.data(
    { revoked: invite.id },
    () => `${chalk.green('✓')} Revoked the invitation to ${invite.email}.`
  )
}

// ---- registration ----------------------------------------------------------------------------

export function registerMembersCommands(program: Command, action: ActionWrapper): void {
  const members = program
    .command('members')
    .description('people in the active organisation (changes: admin+)')
  members
    .command('ls')
    .description('list members with their role and groups')
    .option('--page <n>', 'page number', positiveInt('--page'))
    .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
    .action(action((ctx, cmd) => runMembersList(ctx, cmd.opts())))
  members
    .command('set-role <user> <role>')
    .description(`change a member's role (${ROLES.join(' | ')}); <user> is an id or email`)
    .action(action((ctx, cmd) => runMembersSetRole(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '')))
  members
    .command('rm <user>')
    .description('remove a member from the organisation (they lose access immediately)')
    .option('-y, --yes', 'do not ask first')
    .action(action((ctx, cmd) => runMembersRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
  members
    .command('groups <user> [groups...]')
    .description("show a member's groups, or replace them with these (ids or names)")
    .option('--none', 'take them out of every group')
    .option('-y, --yes', 'do not ask before taking groups away')
    .action(
      action((ctx, cmd) =>
        runMembersGroups(ctx, cmd.args[0] ?? '', cmd.args.slice(1) as string[], cmd.opts())
      )
    )

  const invites = program
    .command('invites')
    .description('invitations to the active organisation (admin+)')
  invites
    .command('ls')
    .description('list pending invitations')
    .option('--page <n>', 'page number', positiveInt('--page'))
    .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
    .action(action((ctx, cmd) => runInvitesList(ctx, cmd.opts())))
  invites
    .command('pending')
    .description('invitations addressed to you, in any organisation')
    .action(action(ctx => runInvitesPending(ctx)))
  invites
    .command('send <emails...>')
    .description('invite one or more people by email (up to 100 at once)')
    .option('--role <role>', ROLES.join(' | '), oneOf('--role', ROLES))
    .action(action((ctx, cmd) => runInvitesSend(ctx, cmd.args as string[], cmd.opts())))
  invites
    .command('resend <invitation>')
    .description('send a fresh link (id, id prefix or email)')
    .action(action((ctx, cmd) => runInvitesResend(ctx, cmd.args[0] ?? '')))
  invites
    .command('revoke <invitation>')
    .description('revoke a pending invitation (id, id prefix or email)')
    .option('-y, --yes', 'do not ask first')
    .action(action((ctx, cmd) => runInvitesRevoke(ctx, cmd.args[0] ?? '', cmd.opts())))
}
