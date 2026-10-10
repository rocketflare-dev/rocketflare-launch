/**
 * `launch kits …` (D36 K1) — the kit catalogue over `/api/platform/kits` (platform
 * administrators; an admin key — `launch login --admin`). The same actions as Platform → Kits:
 *
 * - `kits ls` — every kit, the default first: slug, repo@pin, check status, apps.
 * - `kits show <kit>` — one kit (slug or id): its pin, the problems the last check found, and
 *   the manifest's essentials (`--json` prints the whole manifest snapshot).
 * - `kits add <owner/name> --tag|--commit|--latest [--slug --name --description]` — register; the
 *   pin is resolved and the kit checked server-side. A kit that FAILS the check is still stored;
 *   its problems are printed and the command exits 1, so a script notices.
 * - `kits check <kit>` — re-read and re-check at the current pin (failed → exit 1).
 * - `kits pin <kit> --tag|--commit|--latest` — re-pin, checked at the new pin.
 * - `kits default <kit>` — the kit new apps are cut from.
 * - `kits rm <kit>` (asks first) — refused for the default and for a kit apps were made from.
 *
 * Every body is validated with the route's shared schema before any request; every refusal is
 * the server's sentence (409/404/422 → exit 1).
 */
import {
  type Kit,
  type KitDetail,
  kitAddRequestSchema,
  kitDetailSchema,
  kitListResponseSchema,
  kitPinRequestSchema,
  kitRemoveResponseSchema,
} from '@launch/shared/kits'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type ConfirmOptions, confirmAction, parseBody } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { withAdminKey } from './admin-key'

const kitPath = (kit: string) => `/api/platform/kits/${encodeURIComponent(kit)}`

/** `owner/name@tag` (or the short commit), Follow latest and the code default called out. */
export function kitPinLine(kit: Pick<Kit, 'pin' | 'pinIsCodeDefault'>): string {
  const at = kit.pin.tag ?? kit.pin.commit.slice(0, 7)
  const follow = kit.pin.follow === 'latest' ? ', following the latest release' : ''
  return `${kit.pin.repo}@${at}${follow}${kit.pinIsCodeDefault ? " (Launch's default)" : ''}`
}

function statusWord(status: Kit['status']): string {
  if (status === 'verified') return chalk.green('verified')
  if (status === 'failed') return chalk.red('failed')
  return chalk.dim('not checked')
}

function detailLines(kit: KitDetail): string[] {
  const lines = [
    `${chalk.bold(kit.name)} (${kit.slug})${kit.isDefault ? chalk.cyan('  default') : ''}`,
    ...(kit.description ? [kit.description] : []),
    `Pin       ${kitPinLine(kit)}`,
    `Status    ${statusWord(kit.status)}${kit.checkedAt ? ` · checked ${formatDate(kit.checkedAt)}` : ''}`,
    `Manifest  ${kit.manifestSource === 'fallback' ? "Launch's built-in Rocketflare manifest" : kit.manifestSource === 'repo' ? `launch.kit.json (schema ${kit.contractVersion})` : chalk.dim('not read yet')}`,
    `Apps      ${kit.appCount}`,
  ]
  if (kit.latestCheck?.error)
    lines.push(chalk.yellow(`Last lookup failed: ${kit.latestCheck.error}`))
  if (kit.problems.length > 0) {
    lines.push(
      '',
      chalk.red(`Problems (${kit.problems.length}):`),
      ...kit.problems.map(p => `  ! ${p}`)
    )
  }
  return lines
}

/** After printing: a failed check is exit 1, so a script notices. */
function failIfFailed(kit: Kit): void {
  if (kit.status === 'failed') {
    throw new CliError(`${kit.slug}: the kit does not conform`, {
      hint: 'The problems above say why; fix the kit, then `launch kits check`.',
    })
  }
}

export interface KitPinOptions {
  tag?: string
  commit?: string
  latest?: boolean
}

/** `--tag|--commit|--latest` → the shared pin request (exactly one). */
function pinRequest(options: KitPinOptions): unknown {
  const chosen = [options.tag !== undefined, options.commit !== undefined, Boolean(options.latest)]
  if (chosen.filter(Boolean).length !== 1) {
    throw new CliError('Pass exactly one of --tag <tag>, --commit <sha|branch> or --latest')
  }
  return options.latest
    ? { kind: 'latest' }
    : options.tag !== undefined
      ? { kind: 'tag', tag: options.tag }
      : { kind: 'commit', ref: options.commit }
}

export async function runKitsList(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', '/api/platform/kits', { schema: kitListResponseSchema })
  )
  ctx.out.data(raw, () =>
    renderTable(data.kits, [
      { header: 'Kit', value: k => `${k.slug}${k.isDefault ? chalk.cyan(' *') : ''}` },
      { header: 'Pin', value: k => kitPinLine(k) },
      { header: 'Status', value: k => statusWord(k.status) },
      { header: 'Apps', value: k => String(k.appCount) },
    ])
  )
}

export async function runKitsShow(ctx: CommandContext, kit: string): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', kitPath(kit), { schema: kitDetailSchema })
  )
  ctx.out.data(raw, () => detailLines(data).join('\n'))
}

export interface KitsAddOptions extends KitPinOptions {
  slug?: string
  name?: string
  description?: string
}

export async function runKitsAdd(
  ctx: CommandContext,
  repo: string,
  options: KitsAddOptions = {}
): Promise<void> {
  const body = parseBody(
    kitAddRequestSchema,
    {
      repo,
      pin: pinRequest(options),
      slug: options.slug,
      name: options.name,
      description: options.description,
    },
    'kit'
  )
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('POST', '/api/platform/kits', { schema: kitDetailSchema, body })
  )
  ctx.out.data(raw, () => [`${chalk.green('✓')} Registered`, ...detailLines(data)].join('\n'))
  failIfFailed(data)
}

export async function runKitsCheck(ctx: CommandContext, kit: string): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('POST', `${kitPath(kit)}/check`, { schema: kitDetailSchema })
  )
  ctx.out.data(raw, () => [`${chalk.green('✓')} Checked`, ...detailLines(data)].join('\n'))
  failIfFailed(data)
}

export async function runKitsPin(
  ctx: CommandContext,
  kit: string,
  options: KitPinOptions = {}
): Promise<void> {
  const body = parseBody(kitPinRequestSchema, pinRequest(options), 'kit pin')
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('PUT', `${kitPath(kit)}/pin`, { schema: kitDetailSchema, body })
  )
  ctx.out.data(raw, () => [`${chalk.green('✓')} Pinned`, ...detailLines(data)].join('\n'))
  failIfFailed(data)
}

export async function runKitsDefault(ctx: CommandContext, kit: string): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('PUT', `${kitPath(kit)}/default`, { schema: kitDetailSchema })
  )
  ctx.out.data(
    raw,
    () => `${chalk.green('✓')} New apps are cut from ${data.name} (${kitPinLine(data)})`
  )
}

export async function runKitsRemove(
  ctx: CommandContext,
  kit: string,
  options: ConfirmOptions = {}
): Promise<void> {
  if (
    !(await confirmAction(
      `Remove the kit ${kit} from the catalogue? Its repo is not touched; it can be added again.`,
      options
    ))
  ) {
    ctx.log.info('Nothing changed.')
    return
  }
  const client = requireClient(ctx)
  const { raw } = await withAdminKey(ctx, () =>
    client.request('DELETE', kitPath(kit), { schema: kitRemoveResponseSchema })
  )
  ctx.out.data(raw, () => `${chalk.green('✓')} Removed ${kit}`)
}

export function registerKitsCommands(program: Command, action: ActionWrapper): void {
  const kits = program
    .command('kits')
    .description('the kits apps are built from (platform administrators; `login --admin`)')
  kits
    .command('ls')
    .description('every registered kit, the default first')
    .action(action(ctx => runKitsList(ctx)))
  kits
    .command('show <kit>')
    .description('one kit (slug or id): its pin, check result and manifest')
    .action(action((ctx, cmd) => runKitsShow(ctx, cmd.args[0] as string)))
  kits
    .command('add <repo>')
    .description('register a kit repo (owner/name), resolved and checked')
    .option('--tag <tag>', 'a release tag')
    .option('--commit <ref>', 'a commit SHA or a branch name')
    .option('--latest', 'follow the newest release')
    .option('--slug <slug>', "the catalogue key (default: the manifest's kit.id)")
    .option('--name <name>', "the display name (default: the manifest's kit.name)")
    .option('--description <text>', 'a one-line description')
    .action(
      action((ctx, cmd) => runKitsAdd(ctx, cmd.args[0] as string, cmd.opts<KitsAddOptions>()))
    )
  kits
    .command('check <kit>')
    .description('re-read the manifest and re-run the conformance check at the pin')
    .action(action((ctx, cmd) => runKitsCheck(ctx, cmd.args[0] as string)))
  kits
    .command('pin <kit>')
    .description('pin a release tag, a commit or branch, or follow the latest release')
    .option('--tag <tag>', 'a release tag')
    .option('--commit <ref>', 'a commit SHA or a branch name')
    .option('--latest', 'follow the newest release')
    .action(action((ctx, cmd) => runKitsPin(ctx, cmd.args[0] as string, cmd.opts<KitPinOptions>())))
  kits
    .command('default <kit>')
    .description('make it the kit new apps are cut from')
    .action(action((ctx, cmd) => runKitsDefault(ctx, cmd.args[0] as string)))
  kits
    .command('rm <kit>')
    .description('remove a kit (never the default, never one apps were made from)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(
      action((ctx, cmd) => runKitsRemove(ctx, cmd.args[0] as string, cmd.opts<ConfirmOptions>()))
    )
}
