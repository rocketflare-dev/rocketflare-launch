/**
 * `launch access …` — who may sign in to an app through Launch (spec/05), over `/api/app-access`.
 *
 * The requester's side (anyone signed in), keyed by the app's OIDC `client_id` — what the app's
 * sign-in sent them to Launch with:
 * - `check <clientId>` — which app it is and where you stand: allowed, pending, rejected, none.
 * - `request <clientId> [--message]` — ask the app's owners: opens (or joins) an `app.access`
 *   approval, decided in the approvals inbox (`launch approvals approve`).
 *
 * The owner's side (the app's owners and the organisation's admins; `<app>` is a slug or id —
 * anyone else gets the same 404 as a missing app):
 * - `policy <app> [company|restricted]` — read, or set. Restricting asks first: everyone not
 *   granted is turned away at sign-in.
 * - `grants <app>`, `grant <app> --group|--user|--email`, `ungrant <app> <grant>` (asks first —
 *   that group or person can no longer sign in while the app is restricted).
 * - `requests <app> [--status]` — the app's requests; their ids ARE approval ids.
 *
 * An app with no OIDC client yet answers 409 `oidc_client_missing` (exit 1) for everything but the
 * policy read. Deciding a request is `launch approvals approve|reject <id>`: the old
 * `POST /:app/requests/:id/decide` is gone (410) and has no command.
 */
import {
  APP_ACCESS_REQUEST_STATUSES,
  type AppAccessGrant,
  type AppAccessStanding,
  appAccessGrantListSchema,
  appAccessPolicySchema,
  appAccessRequestContextSchema,
  appAccessRequestListSchema,
  createAppAccessGrantSchema,
  createAppAccessRequestResponseSchema,
  createAppAccessRequestSchema,
  OIDC_ACCESS_POLICIES,
  updateAppAccessPolicySchema,
} from '@launch/shared/launch-oidc'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type ConfirmOptions, confirmConsequence, oneOf, parseBody } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { findGroup } from './groups-write'
import { pickOne } from './org-common'

const accessPath = (app: string) => `/api/app-access/${encodeURIComponent(app)}`

export function standingSentence(standing: AppAccessStanding, app: string): string {
  switch (standing) {
    case 'allowed':
      return `You can sign in to ${app}.`
    case 'pending':
      return `Your request to use ${app} is waiting for its owners.`
    case 'rejected':
      return `Your last request to use ${app} was turned down — you may ask again.`
    case 'none':
      return `You do not have access to ${app} yet.`
  }
}

// ---- the requester's side --------------------------------------------------------------------

export async function runAccessCheck(ctx: CommandContext, clientId: string) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/app-access/request-context', {
    schema: appAccessRequestContextSchema,
    query: { clientId },
  })
  ctx.out.data(raw, () => standingSentence(data.standing, data.app.displayName))
  if (data.standing === 'none' || data.standing === 'rejected')
    ctx.log.hint(`Ask its owners: ${ctx.binName} access request ${clientId} --message "…"`)
}

export async function runAccessRequest(
  ctx: CommandContext,
  clientId: string,
  options: { message?: string } = {}
) {
  const body = parseBody(createAppAccessRequestSchema, {
    clientId,
    ...(options.message ? { message: options.message } : {}),
  })
  const { data, raw } = await requireClient(ctx).request('POST', '/api/app-access/requests', {
    schema: createAppAccessRequestResponseSchema,
    body,
  })
  ctx.out.data(raw, () => {
    if (data.standing === 'allowed') return 'You already have access — nothing to ask.'
    const id = data.request?.id
    return `${chalk.green('✓')} Asked. The app’s owners decide it in their approvals inbox${id ? ` (request ${id.slice(0, 8)})` : ''}.`
  })
}

// ---- the owner's side ------------------------------------------------------------------------

function policyWords(policy: string | null): string {
  if (policy === 'company') return 'company — everyone in the organisation can sign in'
  if (policy === 'restricted') return 'restricted — only the groups and people granted access'
  return 'not set — the app has no sign-in client yet'
}

export async function runAccessPolicy(
  ctx: CommandContext,
  app: string,
  value: string | undefined,
  options: ConfirmOptions = {}
) {
  const client = requireClient(ctx)
  if (value === undefined) {
    const { data, raw } = await client.request(
      'GET',
      `/api/app-access/${encodeURIComponent(app)}/policy`,
      {
        schema: appAccessPolicySchema,
      }
    )
    ctx.out.data(raw, () =>
      [
        `${data.app.displayName}: ${policyWords(data.accessPolicy)}`,
        ...(data.clientId ? [chalk.dim(`client_id ${data.clientId}`)] : []),
      ].join('\n')
    )
    return
  }
  const body = parseBody(updateAppAccessPolicySchema, { accessPolicy: value })
  if (body.accessPolicy === 'restricted') {
    const grants = await client.get(`${accessPath(app)}/grants`, {
      schema: appAccessGrantListSchema,
    })
    const ok = await confirmConsequence(
      ctx,
      options,
      `Restrict who can sign in to ${app}?`,
      `Only the ${grants.items.length} group(s) and people granted access can sign in; everyone else in the organisation is turned away (they can ask).`
    )
    if (!ok) return
  }
  const { data, raw } = await client.request('PUT', `${accessPath(app)}/policy`, {
    schema: appAccessPolicySchema,
    body,
  })
  ctx.out.data(
    raw,
    () => `${chalk.green('✓')} ${data.app.displayName}: ${policyWords(data.accessPolicy)}`
  )
}

function grantRows(items: readonly AppAccessGrant[]) {
  return renderTable(items, [
    { header: 'Kind', value: g => g.kind },
    { header: 'Name', value: g => g.name },
    { header: 'Email', value: g => g.email },
    { header: 'Since', value: g => formatDate(g.createdAt) },
    { header: 'Id', value: g => g.id },
  ])
}

export async function runAccessGrants(ctx: CommandContext, app: string) {
  const { data, raw } = await requireClient(ctx).request('GET', `${accessPath(app)}/grants`, {
    schema: appAccessGrantListSchema,
  })
  ctx.out.data(raw, () => (data.items.length ? grantRows(data.items) : 'No grants.'))
}

export async function runAccessGrant(
  ctx: CommandContext,
  app: string,
  options: { group?: string; user?: string; email?: string }
) {
  const given = [options.group, options.user, options.email].filter(v => v !== undefined)
  if (given.length !== 1) throw new CliError('Give exactly one of --group, --user or --email')
  const body = parseBody(
    createAppAccessGrantSchema,
    options.group
      ? { groupId: (await findGroup(ctx, options.group)).id }
      : options.user
        ? { userId: options.user }
        : { email: options.email }
  )
  const { data, raw } = await requireClient(ctx).request('POST', `${accessPath(app)}/grants`, {
    schema: appAccessGrantListSchema,
    body,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} Granted.\n${grantRows(data.items)}`)
}

export async function runAccessUngrant(
  ctx: CommandContext,
  app: string,
  ref: string,
  options: ConfirmOptions = {}
) {
  const client = requireClient(ctx)
  const [grants, policy] = await Promise.all([
    client.get(`${accessPath(app)}/grants`, { schema: appAccessGrantListSchema }),
    client.get(`${accessPath(app)}/policy`, { schema: appAccessPolicySchema }),
  ])
  const grant = pickOne(grants.items, ref, {
    noun: 'grant',
    listHint: `${ctx.binName} access grants ${app}`,
    names: g => [g.name, g.email],
  })
  const consequence =
    policy.accessPolicy === 'restricted'
      ? `${grant.kind === 'group' ? `The members of ${grant.name}` : grant.name} can no longer sign in to ${policy.app.displayName}, unless another grant admits them.`
      : `${policy.app.displayName} is open to the whole organisation, so this changes nothing until it is restricted.`
  if (
    !(await confirmConsequence(ctx, options, `Remove ${grant.name}'s access grant?`, consequence))
  )
    return
  await client.request('DELETE', `/api/app-access/${encodeURIComponent(app)}/grants/${grant.id}`)
  ctx.out.data({ removed: grant.id }, () => `${chalk.green('✓')} Removed ${grant.name}'s grant.`)
}

export async function runAccessRequests(
  ctx: CommandContext,
  app: string,
  options: { status?: string } = {}
) {
  const { data, raw } = await requireClient(ctx).request('GET', `${accessPath(app)}/requests`, {
    schema: appAccessRequestListSchema,
    query: { status: options.status },
  })
  ctx.out.data(raw, () =>
    data.items.length === 0
      ? 'No access requests.'
      : renderTable(data.items, [
          { header: 'When', value: r => formatDate(r.createdAt) },
          { header: 'Who', value: r => `${r.userName} <${r.userEmail}>` },
          { header: 'Status', value: r => r.status },
          { header: 'Message', value: r => r.message?.slice(0, 60) ?? '' },
          { header: 'Approval', value: r => r.id },
        ])
  )
  if (data.items.some(r => r.status === 'pending'))
    ctx.log.hint(`Decide one: ${ctx.binName} approvals approve|reject <approval>`)
}

export function registerAccessCommands(program: Command, action: ActionWrapper): void {
  const access = program.command('access').description('who may sign in to an app through Launch')
  access
    .command('check <clientId>')
    .description('where you stand with an app (by its OIDC client_id)')
    .action(action((ctx, cmd) => runAccessCheck(ctx, cmd.args[0] ?? '')))
  access
    .command('request <clientId>')
    .description("ask an app's owners for access")
    .option('--message <text>', 'why you need it')
    .action(action((ctx, cmd) => runAccessRequest(ctx, cmd.args[0] ?? '', cmd.opts())))
  access
    .command('policy <app> [policy]')
    .description(`show or set an app's sign-in policy (${OIDC_ACCESS_POLICIES.join(' | ')})`)
    .option('-y, --yes', 'do not ask before restricting')
    .action(action((ctx, cmd) => runAccessPolicy(ctx, cmd.args[0] ?? '', cmd.args[1], cmd.opts())))
  access
    .command('grants <app>')
    .description('the groups and people granted access')
    .action(action((ctx, cmd) => runAccessGrants(ctx, cmd.args[0] ?? '')))
  access
    .command('grant <app>')
    .description('grant a group or a person access')
    .option('--group <group>', 'a group id or name')
    .option('--user <userId>', 'a user id')
    .option('--email <email>', "a member's email")
    .action(action((ctx, cmd) => runAccessGrant(ctx, cmd.args[0] ?? '', cmd.opts())))
  access
    .command('ungrant <app> <grant>')
    .description('remove a grant (id, prefix, group name or email)')
    .option('-y, --yes', 'do not ask first')
    .action(
      action((ctx, cmd) => runAccessUngrant(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts()))
    )
  access
    .command('requests <app>')
    .description('the app’s access requests (ids are approval ids)')
    .option(
      '--status <status>',
      APP_ACCESS_REQUEST_STATUSES.join(' | '),
      oneOf('--status', APP_ACCESS_REQUEST_STATUSES)
    )
    .action(action((ctx, cmd) => runAccessRequests(ctx, cmd.args[0] ?? '', cmd.opts())))
}
