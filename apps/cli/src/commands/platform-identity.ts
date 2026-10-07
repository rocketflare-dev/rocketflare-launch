/**
 * `launch platform oidc …` and `launch platform access-requests …` (issue #6) — the Identity
 * page's signing keys and the sign-up review queue, over `/api/platform/oidc` and
 * `/api/platform/access-requests` (platform administrators; an admin key — `launch login --admin`).
 *
 * - `oidc keys` — the issuer, its discovery and JWKS URLs and every signing key (kids, statuses
 *   and dates; never key material). `oidc rotate` asks first, then the published `next` key starts
 *   signing.
 * - `access-requests list [--status] [--q]`; `access-requests approve <id>` joins an organisation
 *   (`--tenant <id>`, default the one this profile is logged into; `--role`, default member) or,
 *   multi-organisation only, mints a new one (`--new-org <name> [--slug]`);
 *   `access-requests reject <id> [--reason]`. Both POST `decideAccessRequestSchema`, validated first.
 */
import {
  accessRequestListQuerySchema,
  accessRequestSchema,
  decideAccessRequestSchema,
} from '@launch/shared/access-requests'
import { oidcKeysResponseSchema, oidcRotateResponseSchema } from '@launch/shared/launch-oidc'
import { paginatedResponse } from '@launch/shared/pagination'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type ConfirmOptions, confirmAction, parseBody } from '../utils/input'
import { formatDate, formatPagination, renderTable } from '../utils/output'
import { withAdminKey } from './admin-key'

const accessRequestsPageSchema = paginatedResponse(accessRequestSchema)
const accessRequestDecidePath = (id: string) => `/api/platform/access-requests/${id}/decide`

// ---- OIDC signing keys ---------------------------------------------------------------------

export async function runPlatformOidcKeys(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', '/api/platform/oidc/keys', { schema: oidcKeysResponseSchema })
  )
  ctx.out.data(raw, () =>
    [
      `Issuer     ${data.issuer}`,
      `Discovery  ${data.discoveryUrl}`,
      `JWKS       ${data.jwksUrl}`,
      '',
      data.keys.length === 0
        ? chalk.dim('No signing keys yet')
        : renderTable(data.keys, [
            { header: 'Kid', value: k => k.kid },
            { header: 'Alg', value: k => k.alg },
            { header: 'Status', value: k => k.status },
            { header: 'Published', value: k => (k.published ? 'yes' : '') },
            { header: 'Activated', value: k => formatDate(k.activatedAt) },
            { header: 'Retires', value: k => formatDate(k.retireAfter) },
          ]),
    ].join('\n')
  )
}

export async function runPlatformOidcRotate(
  ctx: CommandContext,
  options: ConfirmOptions = {}
): Promise<void> {
  if (
    !(await confirmAction(
      'Rotate the signing key? The published next key starts signing now. The current key keeps verifying the tokens it already signed until they expire, so no one is signed out.',
      options
    ))
  ) {
    ctx.log.info('Nothing changed.')
    return
  }
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('POST', '/api/platform/oidc/keys/rotate', { schema: oidcRotateResponseSchema })
  )
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Signing key rotated`,
      `Signing now  ${data.active.kid}`,
      `Retiring     ${data.retiring ? `${data.retiring.kid} (until ${formatDate(data.retiring.retireAfter)})` : '-'}`,
      `Next         ${data.next.kid}`,
    ].join('\n')
  )
}

// ---- access requests -----------------------------------------------------------------------

export interface AccessRequestsListOptions {
  status?: string
  q?: string
  page?: string
  pageSize?: string
}

export async function runPlatformAccessRequestsList(
  ctx: CommandContext,
  options: AccessRequestsListOptions = {}
): Promise<void> {
  const query = parseBody(
    accessRequestListQuerySchema,
    { status: options.status, q: options.q, page: options.page, pageSize: options.pageSize },
    'filters'
  )
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', '/api/platform/access-requests', {
      schema: accessRequestsPageSchema,
      query,
    })
  )
  ctx.out.data(raw, () =>
    data.items.length === 0
      ? 'No access requests.'
      : [
          renderTable(data.items, [
            { header: 'Email', value: r => r.email },
            { header: 'Status', value: r => r.status },
            { header: 'Organisation', value: r => r.requestedTenantName ?? '' },
            { header: 'Message', value: r => (r.message ?? '').slice(0, 60) },
            { header: 'Requested', value: r => formatDate(r.createdAt) },
            { header: 'Id', value: r => r.id },
          ]),
          formatPagination(data.pagination),
        ].join('\n')
  )
}

export interface AccessRequestApproveOptions {
  tenant?: string
  role?: string
  newOrg?: string
  slug?: string
}

async function decide(ctx: CommandContext, id: string, body: unknown, verb: string) {
  const decision = parseBody(decideAccessRequestSchema, body, 'decision')
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('POST', accessRequestDecidePath(id), {
      schema: accessRequestSchema,
      body: decision,
    })
  )
  ctx.out.data(raw, () => `${chalk.green('✓')} Request ${verb}: ${data.email}`)
}

export async function runPlatformAccessRequestApprove(
  ctx: CommandContext,
  id: string,
  options: AccessRequestApproveOptions = {}
): Promise<void> {
  if (options.newOrg !== undefined) {
    if (options.tenant !== undefined || options.role !== undefined) {
      throw new CliError('--new-org mints an organisation: drop --tenant and --role')
    }
    return decide(
      ctx,
      id,
      {
        decision: 'approve',
        approve: { mode: 'new_org', name: options.newOrg, slug: options.slug },
      },
      'approved'
    )
  }
  const tenantId = options.tenant ?? ctx.config.tenantId
  if (!tenantId) {
    throw new CliError('Which organisation? Pass --tenant <id> (or --new-org <name>)')
  }
  return decide(
    ctx,
    id,
    { decision: 'approve', approve: { mode: 'join', tenantId, role: options.role } },
    'approved'
  )
}

export async function runPlatformAccessRequestReject(
  ctx: CommandContext,
  id: string,
  options: { reason?: string } = {}
): Promise<void> {
  return decide(ctx, id, { decision: 'reject', reason: options.reason }, 'rejected')
}

// ---- registration --------------------------------------------------------------------------

export function registerPlatformIdentityCommands(platform: Command, action: ActionWrapper): void {
  const oidc = platform.command('oidc').description("Launch's OIDC issuer: signing keys")
  oidc
    .command('keys')
    .description('the issuer and its signing keys (never key material)')
    .action(action(ctx => runPlatformOidcKeys(ctx)))
  oidc
    .command('rotate')
    .description('start signing with the published next key')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action((ctx, cmd) => runPlatformOidcRotate(ctx, cmd.opts<ConfirmOptions>())))

  const requests = platform
    .command('access-requests')
    .description('the sign-up review queue (SIGNUP_MODE=approval)')
  requests
    .command('list')
    .description('access requests, newest first')
    .option('--status <status>', 'pending, approved or rejected')
    .option('--q <text>', 'search email')
    .option('--page <n>', 'page number')
    .option('--page-size <n>', 'rows per page (max 200)')
    .action(
      action((ctx, cmd) =>
        runPlatformAccessRequestsList(ctx, cmd.opts<AccessRequestsListOptions>())
      )
    )
  requests
    .command('approve <id>')
    .description('let them in: join an organisation, or mint a new one')
    .option('--tenant <id>', 'the organisation to join (default: the one you are logged into)')
    .option('--role <role>', 'member (default), admin or owner')
    .option('--new-org <name>', 'mint a new organisation instead (multi-organisation only)')
    .option('--slug <slug>', 'the new organisation slug')
    .action(
      action((ctx, cmd) =>
        runPlatformAccessRequestApprove(
          ctx,
          cmd.args[0] as string,
          cmd.opts<AccessRequestApproveOptions>()
        )
      )
    )
  requests
    .command('reject <id>')
    .description('turn the request down')
    .option('--reason <text>', 'why (kept with the request)')
    .action(
      action((ctx, cmd) =>
        runPlatformAccessRequestReject(ctx, cmd.args[0] as string, cmd.opts<{ reason?: string }>())
      )
    )
}
