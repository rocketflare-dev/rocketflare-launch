/**
 * `launch admin tenants …` and `launch admin users …` (issue #6) — the operator's view of every
 * organisation and every person on the deployment, over `/api/admin/tenants` and
 * `/api/admin/users` (global admins; an admin key — `launch login --admin`). Mirrors Settings →
 * Organisations / People and their wording.
 *
 * - `tenants list [--q] [--status]` (404 `tenancy_mode_single` in single mode — the one
 *   organisation is `tenants show <id>`), `tenants show <tenant>`, `tenants suspend <tenant>`
 *   (asks first: every member's API access stops) and `tenants reinstate <tenant>`.
 * - `users list [--q] [--tenant] [--filter]`, `users show <user>`, `users block <user>` (asks
 *   first: signed out everywhere), `users unblock <user>`, `users grant-admin <user>` and
 *   `users revoke-admin <user>` (both ask, saying what changes).
 *
 * A `<tenant>` is an id or a slug, a `<user>` an id or an email: anything but an id is looked up
 * through the list (exactly one match, or exit 1). "Enter as support" is not here: support mode pins
 * a BROWSER session's organisation, and a key has none (the server answers 400
 * `support_needs_session`).
 */
import {
  adminTenantDetailSchema,
  adminTenantListItemSchema,
  adminTenantListQuerySchema,
  adminUserDetailSchema,
  adminUserListItemSchema,
  adminUserListQuerySchema,
} from '@launch/shared/admin'
import { paginatedResponse } from '@launch/shared/pagination'
import chalk from 'chalk'
import type { Command } from 'commander'
import { z } from 'zod'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type ConfirmOptions, confirmAction, parseBody } from '../utils/input'
import { formatDate, formatPagination, renderTable } from '../utils/output'
import { withAdminKey } from './admin-key'

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const adminTenantsPageSchema = paginatedResponse(adminTenantListItemSchema)
const adminUsersPageSchema = paginatedResponse(adminUserListItemSchema)
const suspendResponseSchema = z.object({ id: z.string(), status: z.string() })
const blockResponseSchema = z.object({ id: z.string(), blockedAt: z.coerce.date().nullable() })
const globalAdminResponseSchema = z.object({ id: z.string(), isGlobalAdmin: z.boolean() })

const adminTenantPath = (id: string) => `/api/admin/tenants/${id}`
const adminUserPath = (id: string) => `/api/admin/users/${id}`

export interface ListPageOptions {
  page?: string
  pageSize?: string
}

// ---- tenants -------------------------------------------------------------------------------

export interface AdminTenantsListOptions extends ListPageOptions {
  q?: string
  status?: string
}

export async function runAdminTenantsList(
  ctx: CommandContext,
  options: AdminTenantsListOptions = {}
): Promise<void> {
  const query = parseBody(
    adminTenantListQuerySchema,
    { q: options.q, status: options.status, page: options.page, pageSize: options.pageSize },
    'filters'
  )
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', '/api/admin/tenants', { schema: adminTenantsPageSchema, query })
  )
  ctx.out.data(raw, () =>
    [
      renderTable(data.items, [
        { header: 'Organisation', value: t => t.name },
        { header: 'Slug', value: t => t.slug },
        {
          header: 'Status',
          value: t => (t.status === 'suspended' ? chalk.red(t.status) : t.status),
        },
        { header: 'Members', value: t => String(t.memberCount) },
        { header: 'Last active', value: t => formatDate(t.lastAccessedAt) },
        { header: 'Id', value: t => t.id },
      ]),
      formatPagination(data.pagination),
    ].join('\n')
  )
}

/** An id, or a slug looked up through the list (exactly one). */
export async function resolveTenantId(ctx: CommandContext, ref: string): Promise<string> {
  if (ID_RE.test(ref)) return ref
  const client = requireClient(ctx)
  const { data } = await withAdminKey(ctx, () =>
    client
      .request('GET', '/api/admin/tenants', {
        schema: adminTenantsPageSchema,
        query: { q: ref, pageSize: 200 },
      })
      .catch(error => {
        if ((error as { code?: string }).code === 'tenancy_mode_single') {
          throw new CliError(`Pass the organisation's id, not "${ref}"`, {
            hint: `A single-organisation deployment has no list to look a slug up in: ${ctx.binName} whoami shows the id.`,
          })
        }
        throw error
      })
  )
  const match = data.items.filter(t => t.slug === ref || t.name === ref)
  if (match.length === 1) return (match[0] as { id: string }).id
  throw new CliError(
    match.length === 0 ? `No organisation "${ref}"` : `"${ref}" matches several organisations`,
    { hint: `Pass its id (${ctx.binName} admin tenants list).` }
  )
}

export async function runAdminTenantsShow(ctx: CommandContext, ref: string): Promise<void> {
  const id = await resolveTenantId(ctx, ref)
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', adminTenantPath(id), { schema: adminTenantDetailSchema })
  )
  ctx.out.data(raw, () =>
    [
      `${chalk.bold(data.name)} (${data.slug}) — ${data.status === 'suspended' ? chalk.red('suspended') : 'active'}`,
      `Id            ${data.id}`,
      `Created       ${formatDate(data.createdAt)}`,
      `Last active   ${formatDate(data.lastAccessedAt)}`,
      `Your support access: ${data.supportAccess ? 'yes' : 'no'}`,
      '',
      `Members (${data.members.length})`,
      data.members.length === 0
        ? chalk.dim('No members')
        : renderTable(data.members, [
            { header: 'Name', value: m => m.name },
            { header: 'Email', value: m => m.email },
            { header: 'Role', value: m => m.role },
            { header: 'Global admin', value: m => (m.isGlobalAdmin ? 'yes' : '') },
            { header: 'Blocked', value: m => (m.blockedAt ? formatDate(m.blockedAt) : '') },
            { header: 'Joined', value: m => formatDate(m.joinedAt) },
          ]),
    ].join('\n')
  )
}

async function setSuspended(
  ctx: CommandContext,
  ref: string,
  suspended: boolean,
  options: ConfirmOptions
): Promise<void> {
  const id = await resolveTenantId(ctx, ref)
  if (
    suspended &&
    !(await confirmAction(
      `Suspend ${ref}? Every member's API access stops until it is reinstated.`,
      options
    ))
  ) {
    ctx.log.info('Nothing changed.')
    return
  }
  const client = requireClient(ctx)
  const { raw } = await withAdminKey(ctx, () =>
    client.request('POST', `${adminTenantPath(id)}/suspend`, {
      schema: suspendResponseSchema,
      body: { suspended },
    })
  )
  ctx.out.data(raw, () => (suspended ? 'Organisation suspended' : 'Organisation reinstated'))
}

export const runAdminTenantsSuspend = (ctx: CommandContext, ref: string, o: ConfirmOptions = {}) =>
  setSuspended(ctx, ref, true, o)
export const runAdminTenantsReinstate = (ctx: CommandContext, ref: string) =>
  setSuspended(ctx, ref, false, {})

// ---- users ---------------------------------------------------------------------------------

export interface AdminUsersListOptions extends ListPageOptions {
  q?: string
  tenant?: string
  filter?: string
}

export async function runAdminUsersList(
  ctx: CommandContext,
  options: AdminUsersListOptions = {}
): Promise<void> {
  const query = parseBody(
    adminUserListQuerySchema,
    {
      q: options.q,
      tenantId: options.tenant,
      filter: options.filter,
      page: options.page,
      pageSize: options.pageSize,
    },
    'filters'
  )
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', '/api/admin/users', { schema: adminUsersPageSchema, query })
  )
  ctx.out.data(raw, () =>
    [
      renderTable(data.items, [
        { header: 'Name', value: u => u.name },
        { header: 'Email', value: u => u.email },
        { header: 'Global admin', value: u => (u.isGlobalAdmin ? 'yes' : '') },
        { header: 'Blocked', value: u => (u.blockedAt ? chalk.red('blocked') : '') },
        { header: 'Orgs', value: u => String(u.tenantCount) },
        { header: 'Last sign-in', value: u => formatDate(u.lastLoginAt) },
        { header: 'Id', value: u => u.id },
      ]),
      formatPagination(data.pagination),
    ].join('\n')
  )
}

/** An id, or an email looked up through the list (exactly one). */
async function resolveUser(
  ctx: CommandContext,
  ref: string
): Promise<{ id: string; label: string }> {
  if (ID_RE.test(ref)) return { id: ref, label: ref }
  const client = requireClient(ctx)
  const { data } = await withAdminKey(ctx, () =>
    client.request('GET', '/api/admin/users', {
      schema: adminUsersPageSchema,
      query: { q: ref, pageSize: 200 },
    })
  )
  const match = data.items.filter(u => u.email.toLowerCase() === ref.toLowerCase())
  if (match.length === 1) {
    const user = match[0] as { id: string; name: string; email: string }
    return { id: user.id, label: `${user.name} <${user.email}>` }
  }
  throw new CliError(`No user with the email ${ref}`, {
    hint: `Pass their id (${ctx.binName} admin users list --q <text>).`,
  })
}

export async function runAdminUsersShow(ctx: CommandContext, ref: string): Promise<void> {
  const { id } = await resolveUser(ctx, ref)
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', adminUserPath(id), { schema: adminUserDetailSchema })
  )
  ctx.out.data(raw, () =>
    [
      `${chalk.bold(data.name)} <${data.email}>${data.isGlobalAdmin ? chalk.yellow('  global admin') : ''}${data.blockedAt ? chalk.red('  blocked') : ''}`,
      `Id            ${data.id}`,
      `Last sign-in  ${formatDate(data.lastLoginAt)}`,
      `Created       ${formatDate(data.createdAt)}`,
      `Sign-in       ${data.providers.length === 0 ? 'Email link only — no OAuth provider linked.' : data.providers.map(p => p.provider).join(', ')}`,
      '',
      `Organisations (${data.memberships.length})`,
      data.memberships.length === 0
        ? chalk.dim('Not a member of any organisation')
        : renderTable(data.memberships, [
            { header: 'Organisation', value: m => m.name },
            { header: 'Slug', value: m => m.slug },
            { header: 'Role', value: m => m.role },
            { header: 'Joined', value: m => formatDate(m.joinedAt) },
          ]),
    ].join('\n')
  )
}

async function setBlocked(
  ctx: CommandContext,
  ref: string,
  blocked: boolean,
  options: ConfirmOptions
): Promise<void> {
  const user = await resolveUser(ctx, ref)
  if (
    blocked &&
    !(await confirmAction(
      `Block ${user.label}? They are signed out everywhere and cannot sign in again until unblocked.`,
      options
    ))
  ) {
    ctx.log.info('Nothing changed.')
    return
  }
  const client = requireClient(ctx)
  const { raw } = await withAdminKey(ctx, () =>
    client.request('POST', `${adminUserPath(user.id)}/block`, {
      schema: blockResponseSchema,
      body: { blocked },
    })
  )
  ctx.out.data(raw, () => (blocked ? 'User blocked' : 'User unblocked'))
}

export const runAdminUsersBlock = (ctx: CommandContext, ref: string, o: ConfirmOptions = {}) =>
  setBlocked(ctx, ref, true, o)
export const runAdminUsersUnblock = (ctx: CommandContext, ref: string) =>
  setBlocked(ctx, ref, false, {})

async function setGlobalAdmin(
  ctx: CommandContext,
  ref: string,
  isGlobalAdmin: boolean,
  options: ConfirmOptions
): Promise<void> {
  const user = await resolveUser(ctx, ref)
  const question = isGlobalAdmin
    ? `Give ${user.label} access to every organisation on this deployment?`
    : `Remove ${user.label}'s global admin? They keep only their own organisations' roles, and any admin key they hold stops working.`
  if (!(await confirmAction(question, options))) {
    ctx.log.info('Nothing changed.')
    return
  }
  const client = requireClient(ctx)
  const { raw } = await withAdminKey(ctx, () =>
    client.request('POST', `${adminUserPath(user.id)}/global-admin`, {
      schema: globalAdminResponseSchema,
      body: { isGlobalAdmin },
    })
  )
  ctx.out.data(raw, () => (isGlobalAdmin ? 'Global admin granted' : 'Global admin removed'))
}

export const runAdminUsersGrantAdmin = (ctx: CommandContext, ref: string, o: ConfirmOptions = {}) =>
  setGlobalAdmin(ctx, ref, true, o)
export const runAdminUsersRevokeAdmin = (
  ctx: CommandContext,
  ref: string,
  o: ConfirmOptions = {}
) => setGlobalAdmin(ctx, ref, false, o)

// ---- registration --------------------------------------------------------------------------

const yesOption = ['-y, --yes', 'do not ask for confirmation'] as const

export function registerAdminOrgCommands(admin: Command, action: ActionWrapper): void {
  const tenants = admin
    .command('tenants')
    .alias('orgs')
    .description('every organisation on the deployment')
  tenants
    .command('list')
    .description('organisations (multi-organisation deployments)')
    .option('--q <text>', 'search name or slug')
    .option('--status <status>', 'active or suspended')
    .option('--page <n>', 'page number')
    .option('--page-size <n>', 'rows per page (max 200)')
    .action(action((ctx, cmd) => runAdminTenantsList(ctx, cmd.opts<AdminTenantsListOptions>())))
  tenants
    .command('show <tenant>')
    .description('one organisation and its members (id or slug)')
    .action(action((ctx, cmd) => runAdminTenantsShow(ctx, cmd.args[0] as string)))
  tenants
    .command('suspend <tenant>')
    .description("suspend an organisation: every member's API access stops")
    .option(...yesOption)
    .action(
      action((ctx, cmd) =>
        runAdminTenantsSuspend(ctx, cmd.args[0] as string, cmd.opts<ConfirmOptions>())
      )
    )
  tenants
    .command('reinstate <tenant>')
    .description('lift a suspension')
    .action(action((ctx, cmd) => runAdminTenantsReinstate(ctx, cmd.args[0] as string)))

  const users = admin.command('users').description('every person on the deployment')
  users
    .command('list')
    .description('people, newest first')
    .option('--q <text>', 'search name or email')
    .option('--tenant <id>', 'members of one organisation')
    .option('--filter <filter>', 'global_admin, blocked or no_tenant')
    .option('--page <n>', 'page number')
    .option('--page-size <n>', 'rows per page (max 200)')
    .action(action((ctx, cmd) => runAdminUsersList(ctx, cmd.opts<AdminUsersListOptions>())))
  users
    .command('show <user>')
    .description('one person: organisations and sign-in methods (id or email)')
    .action(action((ctx, cmd) => runAdminUsersShow(ctx, cmd.args[0] as string)))
  users
    .command('block <user>')
    .description('sign them out everywhere and refuse sign-in until unblocked')
    .option(...yesOption)
    .action(
      action((ctx, cmd) =>
        runAdminUsersBlock(ctx, cmd.args[0] as string, cmd.opts<ConfirmOptions>())
      )
    )
  users
    .command('unblock <user>')
    .description('let them sign in again')
    .action(action((ctx, cmd) => runAdminUsersUnblock(ctx, cmd.args[0] as string)))
  users
    .command('grant-admin <user>')
    .description('make them a global admin: access to every organisation')
    .option(...yesOption)
    .action(
      action((ctx, cmd) =>
        runAdminUsersGrantAdmin(ctx, cmd.args[0] as string, cmd.opts<ConfirmOptions>())
      )
    )
  users
    .command('revoke-admin <user>')
    .description('remove their global admin')
    .option(...yesOption)
    .action(
      action((ctx, cmd) =>
        runAdminUsersRevokeAdmin(ctx, cmd.args[0] as string, cmd.opts<ConfirmOptions>())
      )
    )
}
