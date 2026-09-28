/**
 * `launch grants needs|ls|request|revoke <app>` — an app's shared config and grants (Launch P5,
 * plan §4 5f), over `/api/apps/:id/{config,grants}` and `@launch/shared/launch-grants`.
 *
 * - `needs <app>` — what the last scan found the app declares: each matched shared resource with
 *   its state per environment (held, pushing, requested, missing), and the keys nothing matches.
 * - `ls <app>` — every grant of the app, newest first.
 * - `request <app> <resource> --reason <text> [--env staging,production] [--expires <date>]` — one
 *   `grant.request` per environment (both by default), decided by the resource's OWNER team; prints
 *   each approval's page. The CLI never approves: the requester is excluded.
 * - `revoke <app> <grant>` — `<grant>` is a grant id, its first 8 characters, or the resource slug
 *   with `--env`. The secrets are removed from the app's Worker; the push carries it out.
 *
 * The app is addressed by slug (`GET /api/apps/:slug`), the resource by slug (the list every
 * member may read). Values never appear: an app's owners hold a grant, they never see inside it.
 *
 * Slice 5f owns this file. `cli.ts` calls `registerGrantsCommands(program, action)` once, after the
 * kit's own commands, so the slice adds its `program.command(...)` entries here and never edits
 * `cli.ts`.
 */
import {
  APP_ENVIRONMENT_NAMES,
  type AppEnvironmentName,
  appDetailSchema,
} from '@launch/shared/launch-apps'
import {
  type AppConfigMatch,
  type AppGrant,
  appConfigSchema,
  grantActionResponseSchema,
  requestGrantResponseSchema,
  requestGrantSchema,
  sharedResourceListResponseSchema,
} from '@launch/shared/launch-grants'
import chalk from 'chalk'
import { type Command, InvalidArgumentError } from 'commander'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { formatDate, renderTable } from '../utils/output'
import { approvalUrl } from './approvals'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const appApiPath = (appId: string) => `/api/apps/${encodeURIComponent(appId)}`

async function resolveApp(client: ApiClient, app: string) {
  if (!app.trim()) throw new CliError('Give an app slug')
  return client.get(appApiPath(app.trim()), { schema: appDetailSchema })
}

async function readConfig(client: ApiClient, appId: string) {
  return client.request('GET', `${appApiPath(appId)}/config`, { schema: appConfigSchema })
}

/** One environment's state of a matched resource, in a word. Pure. */
export function grantState(
  grant: Pick<AppGrant, 'status' | 'pushedVersion' | 'pushError'> | null
): string {
  if (!grant) return 'missing'
  switch (grant.status) {
    case 'requested':
      return 'requested'
    case 'revoking':
      return 'revoking'
    case 'active':
      if (grant.pushError) return 'push failed'
      return grant.pushedVersion === null ? 'pushing' : `held (v${grant.pushedVersion})`
    case 'revoked':
    case 'rejected':
    case 'expired':
      return `missing (${grant.status})`
  }
}

function matchLine(match: AppConfigMatch): string {
  const envs = APP_ENVIRONMENT_NAMES.map(env => `${env}: ${grantState(match.grants[env])}`)
  const archived = match.resource.archived ? chalk.dim(' (archived)') : ''
  return `${chalk.bold(match.resource.slug)}${archived}  ${envs.join('  ')}\n  ${chalk.dim(match.keys.join(', '))}`
}

export async function runGrantsNeeds(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data, raw } = await readConfig(client, detail.id)
  ctx.out.data(raw, () => {
    const lines: string[] = []
    if (!data.scan) lines.push(chalk.dim('Not scanned yet.'))
    else {
      const where = [data.scan.ref, data.scan.sha?.slice(0, 7)].filter(Boolean).join(' @ ')
      lines.push(chalk.dim(`Scanned ${where} on ${formatDate(data.scan.scannedAt)}`))
      if (data.scan.error) lines.push(chalk.yellow(`The last scan failed: ${data.scan.error}`))
    }
    if (data.matched.length === 0) lines.push('No declared key matches shared config.')
    else for (const match of data.matched) lines.push(matchLine(match))
    if (data.unmatched.length > 0)
      lines.push(
        '',
        `Keys no shared config matches: ${data.unmatched.join(', ')}`,
        chalk.dim('  Ask an admin to add them, or set them on the app yourself.')
      )
    if (data.needs.length > 0 && data.canRequest) {
      const first = data.matched.find(m => data.needs.includes(m.resource.id))
      lines.push(
        '',
        chalk.cyan(
          `Request it: ${ctx.binName} grants request ${detail.slug} ${first?.resource.slug ?? '<resource>'} --reason "…"`
        )
      )
    }
    return lines.join('\n')
  })
}

export async function runGrantsList(ctx: CommandContext, app: string): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data } = await readConfig(client, detail.id)
  ctx.out.data({ items: data.grants }, () =>
    renderTable(data.grants, [
      { header: 'Resource', value: g => g.resource.slug },
      { header: 'Env', value: g => g.environment },
      { header: 'Status', value: g => g.status },
      { header: 'Holds', value: g => (g.pushedVersion ? `v${g.pushedVersion}` : null) },
      { header: 'Lapses', value: g => (g.expiresAt ? formatDate(g.expiresAt) : 'never') },
      { header: 'Id', value: g => g.id },
    ])
  )
}

export interface GrantsRequestOptions {
  env?: AppEnvironmentName[]
  reason?: string
  expires?: string
}

export async function runGrantsRequest(
  ctx: CommandContext,
  app: string,
  resourceRef: string,
  options: GrantsRequestOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const wanted = resourceRef.trim()
  let resourceId = wanted
  if (!UUID.test(wanted)) {
    const list = await client.get('/api/shared-resources', {
      schema: sharedResourceListResponseSchema,
    })
    const match = list.items.find(r => r.slug === wanted)
    if (!match)
      throw new CliError(`No shared config "${wanted}"`, {
        hint: `List them with \`${ctx.binName} shared ls\`.`,
      })
    resourceId = match.id
  }
  const parsed = requestGrantSchema.safeParse({
    resourceId,
    environments: options.env?.length ? options.env : [...APP_ENVIRONMENT_NAMES],
    reason: options.reason ?? '',
    ...(options.expires ? { expiresAt: options.expires } : {}),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = String(issue?.path[0] ?? '')
    throw new CliError(
      field === 'reason'
        ? 'Say why the app needs it: --reason "…" (the owner team reads it)'
        : `Invalid ${field || 'request'}: ${issue?.message ?? 'check it'}`
    )
  }
  if (parsed.data.expiresAt && Number.isNaN(parsed.data.expiresAt.getTime()))
    throw new CliError('--expires is not a date (use YYYY-MM-DD)')

  const { data, raw } = await client.request('POST', `${appApiPath(detail.id)}/grants`, {
    schema: requestGrantResponseSchema,
    body: parsed.data,
  })
  ctx.out.data(raw, () => {
    const lines = [
      `${chalk.green('✓')} Asked for ${wanted} on ${detail.slug}. Its owner team decides.`,
    ]
    for (const grant of data.grants) {
      lines.push(
        grant.approvalId
          ? `  ${grant.environment}: ${grant.status} — ${approvalUrl(ctx, grant.approvalId)}`
          : `  ${grant.environment}: ${grant.status}`
      )
    }
    lines.push(chalk.dim(`  Follow it: ${ctx.binName} grants needs ${detail.slug}`))
    return lines.join('\n')
  })
}

export interface GrantsRevokeOptions {
  env?: AppEnvironmentName
  reason?: string
}

/** A grant by id, 8-character prefix, or resource slug (+ `--env` when it is held in both). */
export function findGrant(
  grants: readonly AppGrant[],
  ref: string,
  env?: AppEnvironmentName
): AppGrant {
  const wanted = ref.trim()
  const live = (g: AppGrant) => g.status === 'active' || g.status === 'requested'
  const byId = grants.filter(
    g => g.id === wanted || (wanted.length >= 8 && g.id.startsWith(wanted))
  )
  if (byId.length === 1 && byId[0]) return byId[0]
  if (byId.length > 1)
    throw new CliError(`"${wanted}" matches more than one grant; give more of the id`)
  const bySlug = grants.filter(
    g => g.resource.slug === wanted && live(g) && (!env || g.environment === env)
  )
  if (bySlug.length === 1 && bySlug[0]) return bySlug[0]
  if (bySlug.length > 1)
    throw new CliError(`The app holds ${wanted} in more than one environment`, {
      hint: 'Pass --env staging or --env production.',
    })
  throw new CliError(`No live grant "${wanted}" on this app`, {
    hint: 'List them with `launch grants ls <app>`.',
  })
}

export async function runGrantsRevoke(
  ctx: CommandContext,
  app: string,
  ref: string,
  options: GrantsRevokeOptions = {}
): Promise<void> {
  const client = requireClient(ctx)
  const detail = await resolveApp(client, app)
  const { data: config } = await readConfig(client, detail.id)
  const grant = findGrant(config.grants, ref, options.env)
  const reason = options.reason?.trim()
  const { data, raw } = await client.request(
    'DELETE',
    `${appApiPath(detail.id)}/grants/${encodeURIComponent(grant.id)}`,
    { schema: grantActionResponseSchema, body: reason ? { reason } : {} }
  )
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Revoking ${grant.resource.slug} on ${detail.slug} (${grant.environment}): ${data.grant.status}.`,
      chalk.dim('  Its secrets are being removed from the app’s Worker.'),
    ].join('\n')
  )
}

// ---- registration --------------------------------------------------------------------------

function envOption(value: string): AppEnvironmentName {
  if (!(APP_ENVIRONMENT_NAMES as readonly string[]).includes(value))
    throw new InvalidArgumentError(`--env must be one of ${APP_ENVIRONMENT_NAMES.join(', ')}`)
  return value as AppEnvironmentName
}

function envListOption(value: string): AppEnvironmentName[] {
  return value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .map(envOption)
}

export function registerGrantsCommands(program: Command, action: ActionWrapper): void {
  const grants = program
    .command('grants')
    .description('the shared config an app needs, and its grants')
  grants
    .command('needs <app>')
    .description('what the app declares, the shared config it matches, and what it still needs')
    .action(action((ctx, cmd) => runGrantsNeeds(ctx, cmd.args[0] ?? '')))
  grants
    .command('ls <app>')
    .description('every grant of the app')
    .action(action((ctx, cmd) => runGrantsList(ctx, cmd.args[0] ?? '')))
  grants
    .command('request <app> <resource>')
    .description('ask the resource’s owner team for it (one approval per environment)')
    .requiredOption('--reason <text>', 'why the app needs it — shown to the owner team')
    .option('--env <list>', 'staging,production (default both)', envListOption)
    .option('--expires <date>', 'when the grant lapses (YYYY-MM-DD)')
    .action(
      action((ctx, cmd) => runGrantsRequest(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts()))
    )
  grants
    .command('revoke <app> <grant>')
    .description('remove a grant (id, id prefix, or resource slug with --env)')
    .option('--env <env>', 'staging | production', envOption)
    .option('--reason <text>', 'recorded in the audit log')
    .action(
      action((ctx, cmd) => runGrantsRevoke(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts()))
    )
}
