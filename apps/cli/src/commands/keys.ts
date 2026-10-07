/**
 * `launch keys ls|create|revoke` — the organisation's API keys (Settings → API keys, admin+), over
 * `/api/keys`.
 *
 * `ls` shows prefixes only, as everywhere. `create` is the ONE place the CLI prints a full key: the
 * server shows the plaintext exactly once, in its answer, so the command writes it to stdout (with
 * `--json`, inside the body) and warns on stderr that it will never be shown again. `revoke` asks
 * first — "Requests using it stop working immediately" — and says so louder when the key is the
 * one this CLI is signed in with.
 */
import {
  type ApiKey,
  apiKeyScopeSchema,
  apiKeysListResponseSchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
} from '@launch/shared/api-keys'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type ConfirmOptions, confirmConsequence, parseBody, positiveInt } from '../utils/input'
import { formatDate, formatPagination, renderTable } from '../utils/output'
import { pickOne } from './org-common'

const keyPath = (id: string) => `/api/keys/${encodeURIComponent(id)}`

function keyState(key: ApiKey, now = Date.now()): string {
  if (key.revokedAt) return 'revoked'
  if (key.expiresAt && key.expiresAt.getTime() < now) return 'expired'
  return 'active'
}

export async function runKeysList(
  ctx: CommandContext,
  options: { page?: number; pageSize?: number } = {}
) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/keys', {
    schema: apiKeysListResponseSchema,
    query: { page: options.page, pageSize: options.pageSize },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Name', value: k => k.name },
      { header: 'Key', value: k => `${k.keyPrefix}…` },
      { header: 'Scopes', value: k => k.scopes.join(',') },
      { header: 'State', value: k => keyState(k) },
      { header: 'Last used', value: k => (k.lastUsedAt ? formatDate(k.lastUsedAt) : 'never') },
      { header: 'Expires', value: k => (k.expiresAt ? formatDate(k.expiresAt) : 'never') },
      { header: 'Id', value: k => k.id },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

/** `30d` → that many days from now; anything else is handed to the contract as a date. */
export function expiresAtFrom(value: string | undefined, now = new Date()): string | undefined {
  if (value === undefined) return undefined
  const days = /^(\d+)d$/.exec(value.trim())
  if (days) return new Date(now.getTime() + Number(days[1]) * 86_400_000).toISOString()
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    throw new CliError(`--expires must be a date or a number of days like 30d, not "${value}"`)
  return date.toISOString()
}

export interface KeysCreateOptions {
  scopes?: string
  expires?: string
}

export async function runKeysCreate(
  ctx: CommandContext,
  name: string,
  options: KeysCreateOptions = {}
) {
  const body = parseBody(createApiKeyRequestSchema, {
    name,
    ...(options.scopes ? { scopes: options.scopes.split(',').map(s => s.trim()) } : {}),
    ...(options.expires ? { expiresAt: expiresAtFrom(options.expires) } : {}),
  })
  const { data, raw } = await requireClient(ctx).request('POST', '/api/keys', {
    schema: createApiKeyResponseSchema,
    body,
  })
  ctx.log.warn('Copy it now — this is the only time it will be shown.')
  ctx.out.data(raw, () => data.key)
  ctx.log.hint(
    `"${data.name}" · ${data.scopes.join(',')} · ${data.expiresAt ? `expires ${formatDate(data.expiresAt)}` : 'never expires'} · id ${data.id}`
  )
}

export async function runKeysRevoke(ctx: CommandContext, ref: string, options: ConfirmOptions) {
  const list = await requireClient(ctx).get('/api/keys', {
    schema: apiKeysListResponseSchema,
    query: { pageSize: 200 },
  })
  const key = pickOne(list.items, ref, {
    noun: 'API key',
    listHint: `${ctx.binName} keys ls`,
    names: k => [k.name, k.keyPrefix],
  })
  if (key.revokedAt) throw new CliError(`"${key.name}" is already revoked`)
  const own = Boolean(ctx.config.apiKey?.startsWith(key.keyPrefix))
  const consequence = own
    ? 'This is the key this CLI is signed in with: every command stops working until you log in again.'
    : 'Requests using it stop working immediately.'
  if (
    !(await confirmConsequence(
      ctx,
      options,
      `Revoke "${key.name}" (${key.keyPrefix}…)?`,
      consequence
    ))
  )
    return
  await requireClient(ctx).request('DELETE', keyPath(key.id))
  ctx.out.data({ revoked: key.id }, () => `${chalk.green('✓')} Revoked "${key.name}".`)
}

export function registerKeysCommands(program: Command, action: ActionWrapper): void {
  const keys = program.command('keys').description("the organisation's API keys (admin+)")
  keys
    .command('ls')
    .description('list API keys (prefixes only)')
    .option('--page <n>', 'page number', positiveInt('--page'))
    .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
    .action(action((ctx, cmd) => runKeysList(ctx, cmd.opts())))
  keys
    .command('create <name>')
    .description('create a key and print it ONCE to stdout')
    .option(
      '--scopes <list>',
      `comma-separated: ${apiKeyScopeSchema.options.join(', ')} (default read,write)`
    )
    .option('--expires <when>', 'a date, or a number of days like 30d (default: never)')
    .action(action((ctx, cmd) => runKeysCreate(ctx, cmd.args[0] ?? '', cmd.opts())))
  keys
    .command('revoke <key>')
    .description('revoke a key (id, id prefix, name or key prefix)')
    .option('-y, --yes', 'do not ask first')
    .action(action((ctx, cmd) => runKeysRevoke(ctx, cmd.args[0] ?? '', cmd.opts())))
}
