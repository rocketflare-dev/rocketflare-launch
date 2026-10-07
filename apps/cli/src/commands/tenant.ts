/**
 * `launch tenant show|set|ls|settings [set]` and `launch me show|set|prefs [set]` (issue #6) —
 * Settings → General and the profile menu, over `/api/tenant`, `/api/tenant/settings`,
 * `/api/tenants` and `/api/me`.
 *
 * - `tenant show` — the active organisation; `tenant set --name|--slug|--data` (admins; the slug
 *   is the owner's). `tenant ls` — every organisation the key's person belongs to, with their role.
 * - `tenant settings` — timezone, notifications and the app's settings bag; `settings set
 *   --timezone --notifications on|off --data <json|@file|->` (the bag is shallow-merged by the
 *   server).
 * - `me show` — your profile and your preferences here; `me set --name --avatar-url --data`;
 *   `me prefs` and `me prefs set key=value… | --data` (values are JSON when they parse, strings
 *   otherwise; shallow-merged).
 *
 * Every body is validated with the shared contract before it is sent (exit 1 listing the issues).
 * Deleting an organisation stays in the browser: it is single-tenant-disabled here and asks for the
 * slug to be retyped, which is the web page's job.
 */
import { tenantSummarySchema, userSchema } from '@launch/shared/auth'
import {
  tenantSettingsSchema,
  updateTenantSettingsRequestSchema,
} from '@launch/shared/tenant-settings'
import { tenantSchema, updateTenantRequestSchema } from '@launch/shared/tenants'
import {
  meResponseSchema,
  tenantUserSettingsSchema,
  updateProfileRequestSchema,
  updateTenantUserSettingsRequestSchema,
} from '@launch/shared/user-settings'
import chalk from 'chalk'
import type { Command } from 'commander'
import { z } from 'zod'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type InputSeams, parseBody, readDataObject } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'

const tenantListSchema = z.array(tenantSummarySchema)

function kv(rows: Array<[string, unknown]>): string {
  const width = Math.max(...rows.map(([k]) => k.length))
  return rows
    .map(
      ([k, v]) => `${chalk.dim(k.padEnd(width))}  ${typeof v === 'string' ? v : JSON.stringify(v)}`
    )
    .join('\n')
}

// ---- tenant ----------------------------------------------------------------------------------

export async function runTenantShow(ctx: CommandContext) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/tenant', {
    schema: tenantSchema,
  })
  ctx.out.data(raw, () =>
    kv([
      ['Name', data.name],
      ['Slug', data.slug],
      ['Status', data.status],
      ['Created', formatDate(data.createdAt)],
      ['Id', data.id],
    ])
  )
}

export async function runTenantSet(
  ctx: CommandContext,
  options: { name?: string; slug?: string; data?: string } & InputSeams
) {
  const base = (await readDataObject(options.data, options)) ?? {}
  const body = parseBody(updateTenantRequestSchema, {
    ...base,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.slug !== undefined ? { slug: options.slug } : {}),
  })
  const { data, raw } = await requireClient(ctx).request('PATCH', '/api/tenant', {
    schema: tenantSchema,
    body,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} Saved: ${data.name} (${data.slug}).`)
}

export async function runTenantsList(ctx: CommandContext) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/tenants', {
    schema: tenantListSchema,
  })
  ctx.out.data(raw, () =>
    renderTable(data, [
      { header: '', value: t => (t.id === ctx.config.tenantId ? chalk.cyan('*') : ' ') },
      { header: 'Organisation', value: t => t.name },
      { header: 'Slug', value: t => t.slug },
      { header: 'Your role', value: t => t.role },
      { header: 'Id', value: t => t.id },
    ])
  )
  if (data.length > 1)
    ctx.log.hint('A key belongs to one organisation: `login` again to work in another.')
}

export async function runTenantSettingsShow(ctx: CommandContext) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/tenant/settings', {
    schema: tenantSettingsSchema,
  })
  ctx.out.data(raw, () =>
    kv([
      ['Timezone', data.timezone],
      ['Notifications', data.notificationsEnabled ? 'on' : 'off'],
      ['Settings', data.settings],
      ['Updated', formatDate(data.updatedAt)],
    ])
  )
}

export interface TenantSettingsSetOptions extends InputSeams {
  timezone?: string
  notifications?: string
  data?: string
}

function onOff(value: string): boolean {
  if (/^(on|true|yes)$/i.test(value)) return true
  if (/^(off|false|no)$/i.test(value)) return false
  throw new CliError('--notifications must be on or off')
}

export async function runTenantSettingsSet(ctx: CommandContext, options: TenantSettingsSetOptions) {
  const base = (await readDataObject(options.data, options)) ?? {}
  const body = parseBody(updateTenantSettingsRequestSchema, {
    ...base,
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
    ...(options.notifications !== undefined
      ? { notificationsEnabled: onOff(options.notifications) }
      : {}),
  })
  if (Object.keys(body).length === 0)
    throw new CliError('Nothing to change', {
      hint: 'Pass --timezone, --notifications or --data.',
    })
  const { raw } = await requireClient(ctx).request('PATCH', '/api/tenant/settings', {
    schema: tenantSettingsSchema,
    body,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} Settings saved.`)
}

// ---- me --------------------------------------------------------------------------------------

export async function runMeShow(ctx: CommandContext) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/me', {
    schema: meResponseSchema,
  })
  ctx.out.data(raw, () =>
    kv([
      ['Name', data.name],
      ['Email', data.email],
      ['Avatar', data.avatarUrl ?? '-'],
      ['Preferences', data.preferences],
      ['Id', data.id],
    ])
  )
}

export async function runMeSet(
  ctx: CommandContext,
  options: { name?: string; avatarUrl?: string; data?: string } & InputSeams
) {
  const base = (await readDataObject(options.data, options)) ?? {}
  const body = parseBody(updateProfileRequestSchema, {
    ...base,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.avatarUrl !== undefined
      ? { avatarUrl: options.avatarUrl === '' ? null : options.avatarUrl }
      : {}),
  })
  const { data, raw } = await requireClient(ctx).request('PATCH', '/api/me', {
    schema: userSchema,
    body,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} Saved your profile (${data.name}).`)
}

export async function runMePrefs(ctx: CommandContext) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/me/preferences', {
    schema: tenantUserSettingsSchema,
  })
  ctx.out.data(raw, () =>
    Object.keys(data.preferences).length === 0
      ? 'No preferences set in this organisation.'
      : kv(Object.entries(data.preferences))
  )
}

/** `key=value` → `{ key: value }`, the value JSON when it parses (`true`, `3`, `"x"`) else text. */
export function pairsToObject(pairs: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at < 1) throw new CliError(`"${pair}" is not key=value`)
    const raw = pair.slice(at + 1)
    let value: unknown = raw
    try {
      value = JSON.parse(raw)
    } catch {
      // plain text
    }
    out[pair.slice(0, at)] = value
  }
  return out
}

export async function runMePrefsSet(
  ctx: CommandContext,
  pairs: string[],
  options: { data?: string } & InputSeams = {}
) {
  const data = await readDataObject(options.data, options)
  const body = parseBody(
    updateTenantUserSettingsRequestSchema,
    data ?? { preferences: pairsToObject(pairs) }
  )
  if (data && pairs.length) body.preferences = { ...body.preferences, ...pairsToObject(pairs) }
  if (Object.keys(body.preferences).length === 0)
    throw new CliError('Nothing to change', { hint: 'Pass key=value pairs or --data.' })
  const { raw } = await requireClient(ctx).request('PATCH', '/api/me/preferences', {
    schema: tenantUserSettingsSchema,
    body,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} Preferences saved.`)
}

// ---- registration ----------------------------------------------------------------------------

export function registerTenantCommands(program: Command, action: ActionWrapper): void {
  const tenant = program.command('tenant').description('the active organisation (changes: admin+)')
  tenant.command('show').description('name, slug and status').action(action(runTenantShow))
  tenant
    .command('set')
    .description('rename the organisation, or change its slug (owners)')
    .option('--name <name>', 'new name')
    .option('--slug <slug>', 'new slug')
    .option('--data <json|@file|->', 'a JSON body: { name?, slug? } — the flags override it')
    .action(action((ctx, cmd) => runTenantSet(ctx, cmd.opts())))
  tenant
    .command('ls')
    .description('every organisation you belong to, with your role (* = this key’s)')
    .action(action(runTenantsList))
  const settings = tenant
    .command('settings')
    .description('timezone, notifications and app settings')
    .action(action(runTenantSettingsShow))
  settings
    .command('set')
    .description('change settings (admins); --data is merged under the flags')
    .option('--timezone <tz>', 'an IANA timezone, e.g. Europe/London')
    .option('--notifications <on|off>', 'email notifications for the organisation')
    .option('--data <json|@file|->', 'a JSON body: { timezone?, notificationsEnabled?, settings? }')
    .action(action((ctx, cmd) => runTenantSettingsSet(ctx, cmd.opts())))

  const me = program.command('me').description('your own profile and preferences')
  me.command('show').description('your profile and preferences here').action(action(runMeShow))
  me.command('set')
    .description('change your name or avatar URL ("" clears the avatar)')
    .option('--name <name>', 'your display name')
    .option('--avatar-url <url>', 'an image URL')
    .option('--data <json|@file|->', 'a JSON body: { name?, avatarUrl? } — the flags override it')
    .action(action((ctx, cmd) => runMeSet(ctx, cmd.opts())))
  const prefs = me
    .command('prefs')
    .description('your preferences in this organisation')
    .action(action(runMePrefs))
  prefs
    .command('set [pairs...]')
    .description('set preferences: key=value (JSON values allowed), merged into the stored ones')
    .option('--data <json|@file|->', 'a JSON body: { preferences: {…} }')
    .action(action((ctx, cmd) => runMePrefsSet(ctx, cmd.args as string[], cmd.opts())))
}
