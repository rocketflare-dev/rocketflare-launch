/**
 * `launch admin flags …` (issue #6, D30) — Settings → Feature flags from a terminal, over
 * `/api/admin/feature-flags` (global admins; an admin key — `launch login --admin`). `launch
 * features` is the caller's own answer; this is the operator's ROLLOUT state.
 *
 * - `flags list` — every flag: state, rollout, whether this deployment ships it at all
 *   (`FEATURES_ENABLED`, config moved by a redeploy) and how many organisations override it.
 * - `flags set <key> [--state off|on|rollout] [--percent 0-100] [--unit tenant|user]
 *   [--data <json|@file|->]` — PATCH, validated with `updateFeatureFlagRequestSchema` first. A
 *   single-organisation deployment counts a rollout in people (422 otherwise, the server's
 *   sentence).
 * - `flags overrides <key>`, `flags override <key> <tenant> --on|--off`, `flags clear <key>
 *   <tenant>` — per-organisation overrides; multi-organisation only (404 `tenancy_mode_single`).
 *
 * Keys come from the shared registry; an unknown key is the server's 404, exit 1.
 */
import {
  featureFlagListResponseSchema,
  featureFlagSchema,
  setTenantOverrideRequestSchema,
  tenantFeatureOverrideListResponseSchema,
  updateFeatureFlagRequestSchema,
} from '@launch/shared/features'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type InputSeams, parseBody, readDataArg } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { withAdminKey } from './admin-key'
import { resolveTenantId } from './admin-orgs'

const adminFlagPath = (key: string) => `/api/admin/feature-flags/${key}`

const STATE_HINTS: Record<string, string> = {
  off: 'Nobody, regardless of the percentage.',
  on: 'Everybody in every organisation.',
  rollout: 'The percentage, chosen deterministically.',
}

function rolloutWords(flag: { state: string; rolloutPercent: number; rolloutUnit: string }) {
  if (flag.state !== 'rollout') return flag.state
  return `rollout ${flag.rolloutPercent}% of ${flag.rolloutUnit === 'user' ? 'people' : 'organisations'}`
}

export async function runAdminFlagsList(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', '/api/admin/feature-flags', { schema: featureFlagListResponseSchema })
  )
  ctx.out.data(raw, () =>
    data.items.length === 0
      ? 'No feature flags'
      : renderTable(data.items, [
          { header: 'Flag', value: f => f.key },
          { header: 'Label', value: f => f.label },
          {
            header: 'State',
            value: f =>
              f.availableInEnvironment
                ? rolloutWords(f)
                : chalk.dim('off here (not in FEATURES_ENABLED)'),
          },
          { header: 'Overrides', value: f => (f.overrideCount ? String(f.overrideCount) : '') },
          { header: 'Updated', value: f => formatDate(f.updatedAt) },
        ])
  )
}

export interface AdminFlagSetOptions extends InputSeams {
  state?: string
  percent?: string
  unit?: string
  data?: string
}

export async function runAdminFlagsSet(
  ctx: CommandContext,
  key: string,
  options: AdminFlagSetOptions = {}
): Promise<void> {
  const base = options.data ? await readDataArg(options.data, options) : {}
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    throw new CliError('--data must be a JSON object')
  }
  const body: Record<string, unknown> = { ...base }
  if (options.state !== undefined) body.state = options.state
  if (options.percent !== undefined) body.rolloutPercent = Number(options.percent)
  if (options.unit !== undefined) body.rolloutUnit = options.unit
  const patch = parseBody(updateFeatureFlagRequestSchema, body, 'flag change')
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('PATCH', adminFlagPath(key), { schema: featureFlagSchema, body: patch })
  )
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} ${data.key}: ${rolloutWords(data)}`,
      chalk.dim(STATE_HINTS[data.state] ?? ''),
      ...(data.availableInEnvironment
        ? []
        : [chalk.yellow('This deployment does not ship it (FEATURES_ENABLED): off for everyone.')]),
    ].join('\n')
  )
}

export async function runAdminFlagsOverrides(ctx: CommandContext, key: string): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', `${adminFlagPath(key)}/overrides`, {
      schema: tenantFeatureOverrideListResponseSchema,
    })
  )
  ctx.out.data(raw, () =>
    data.items.length === 0
      ? `No organisation overrides ${key}.`
      : renderTable(data.items, [
          { header: 'Organisation', value: o => o.tenantName },
          { header: 'Override', value: o => (o.enabled ? 'on' : 'off') },
          { header: 'Updated', value: o => formatDate(o.updatedAt) },
          { header: 'Tenant id', value: o => o.tenantId },
        ])
  )
}

export interface AdminFlagOverrideOptions {
  on?: boolean
  off?: boolean
}

export async function runAdminFlagsOverride(
  ctx: CommandContext,
  key: string,
  tenant: string,
  options: AdminFlagOverrideOptions = {}
): Promise<void> {
  if (Boolean(options.on) === Boolean(options.off)) {
    throw new CliError('Pass exactly one of --on or --off')
  }
  const body = parseBody(setTenantOverrideRequestSchema, { enabled: Boolean(options.on) })
  const tenantId = await resolveTenantId(ctx, tenant)
  const client = requireClient(ctx)
  await withAdminKey(ctx, () =>
    client.request('PUT', `${adminFlagPath(key)}/overrides/${tenantId}`, { body })
  )
  ctx.out.data(
    { key, tenantId, enabled: body.enabled },
    () =>
      `${chalk.green('✓')} ${key} is ${body.enabled ? 'on' : 'off'} for ${tenant}, whatever the rollout says.`
  )
}

export async function runAdminFlagsClear(
  ctx: CommandContext,
  key: string,
  tenant: string
): Promise<void> {
  const tenantId = await resolveTenantId(ctx, tenant)
  const client = requireClient(ctx)
  await withAdminKey(ctx, () =>
    client.request('DELETE', `${adminFlagPath(key)}/overrides/${tenantId}`)
  )
  ctx.out.data(
    { key, tenantId, cleared: true },
    () => `${chalk.green('✓')} ${tenant} follows the rollout for ${key} again.`
  )
}

export function registerAdminFlagCommands(admin: Command, action: ActionWrapper): void {
  const flags = admin.command('flags').description('feature-flag rollout (D30)')
  flags
    .command('list')
    .description('every flag: state, rollout and overrides')
    .action(action(ctx => runAdminFlagsList(ctx)))
  flags
    .command('set <key>')
    .description('change a flag: state, rollout percentage, rollout unit')
    .option('--state <state>', 'off, on or rollout')
    .option('--percent <n>', 'rollout percentage, 0-100')
    .option('--unit <unit>', 'count the rollout in tenant (organisations) or user (people)')
    .option('--data <json|@file|->', 'the PATCH body: inline JSON, @file or - for stdin')
    .action(
      action((ctx, cmd) =>
        runAdminFlagsSet(ctx, cmd.args[0] as string, cmd.opts<AdminFlagSetOptions>())
      )
    )
  flags
    .command('overrides <key>')
    .description('organisations that override a flag (multi-organisation only)')
    .action(action((ctx, cmd) => runAdminFlagsOverrides(ctx, cmd.args[0] as string)))
  flags
    .command('override <key> <tenant>')
    .description('force a flag on or off for one organisation (id or slug)')
    .option('--on', 'on for this organisation')
    .option('--off', 'off for this organisation')
    .action(
      action((ctx, cmd) =>
        runAdminFlagsOverride(
          ctx,
          cmd.args[0] as string,
          cmd.args[1] as string,
          cmd.opts<AdminFlagOverrideOptions>()
        )
      )
    )
  flags
    .command('clear <key> <tenant>')
    .description('drop an organisation override: it follows the rollout again')
    .action(
      action((ctx, cmd) => runAdminFlagsClear(ctx, cmd.args[0] as string, cmd.args[1] as string))
    )
}
