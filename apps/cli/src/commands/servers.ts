/**
 * `launch servers ls|use|add|rm|rename` — the named servers (profiles) in `~/.launch/config.json`.
 * One shell can talk to local dev and production without re-logging in: `--profile <name>`,
 * `--server <name>` or `LAUNCH_PROFILE` pick one per command, `servers use` changes the default.
 * Keys are only ever shown as their prefix.
 */
import chalk from 'chalk'
import type { Command } from 'commander'
import {
  assertProfileName,
  type CliConfig,
  looksLikeUrl,
  normalizeUrl,
  type Profile,
  redactKey,
  unknownProfileError,
} from '../config'
import type { CommandContext } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { type ConfirmOptions, confirmConsequence } from '../utils/input'
import { renderTable } from '../utils/output'

/** `prod · https://launch.example.com` — or just the URL when no stored server applies. */
export function serverLabel(ctx: CommandContext): string {
  return ctx.config.profile
    ? `${ctx.config.profile} ${chalk.dim('·')} ${ctx.config.serverUrl}`
    : ctx.config.serverUrl
}

function requireProfile(config: CliConfig, name: string): Profile {
  const profile = config.profiles[name]
  if (!profile) throw unknownProfileError(name, config)
  return profile
}

function parseUrl(value: string): string {
  if (!looksLikeUrl(value)) throw new CliError(`"${value}" is not a valid URL`)
  try {
    new URL(value)
  } catch {
    throw new CliError(`"${value}" is not a valid URL`)
  }
  return normalizeUrl(value)
}

export interface ServerRow {
  name: string
  serverUrl: string
  default: boolean
  active: boolean
  tenantName: string | null
  tenantId: string | null
  user: string | null
  apiKey: string | null
}

export async function runServersList(ctx: CommandContext): Promise<void> {
  const config = await ctx.store.load()
  const rows: ServerRow[] = Object.entries(config.profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, profile]) => ({
      name,
      serverUrl: profile.serverUrl,
      default: name === config.defaultProfile,
      active: name === ctx.config.profile,
      tenantName: profile.tenantName ?? null,
      tenantId: profile.tenantId ?? null,
      user: profile.user?.email ?? null,
      apiKey: profile.apiKey ? redactKey(profile.apiKey) : null,
    }))
  ctx.out.data(
    {
      defaultProfile: config.defaultProfile ?? null,
      active: ctx.config.profile ?? null,
      servers: rows,
    },
    () => {
      if (rows.length === 0) {
        return chalk.dim(
          `(no servers) — \`${ctx.binName} login --server <url>\` or \`${ctx.binName} servers add <name> <url>\``
        )
      }
      const table = renderTable(rows, [
        { header: ' ', value: r => (r.default ? '*' : ' ') },
        { header: 'NAME', value: r => (r.active ? chalk.bold(`${r.name} (active)`) : r.name) },
        { header: 'URL', value: r => r.serverUrl },
        { header: 'TENANT', value: r => r.tenantName ?? r.tenantId },
        { header: 'USER', value: r => r.user },
        { header: 'KEY', value: r => r.apiKey ?? chalk.dim('not signed in') },
      ])
      return `${table}\n${chalk.dim('* default · active = what this command used (--profile, --server, LAUNCH_PROFILE)')}`
    }
  )
}

export async function runServersUse(ctx: CommandContext, name: string): Promise<void> {
  const config = await ctx.store.load()
  requireProfile(config, name)
  await ctx.store.save({ ...config, defaultProfile: name })
  ctx.log.success(`Default server is now "${name}" (${config.profiles[name]?.serverUrl})`)
  if (ctx.out.json) ctx.out.data({ defaultProfile: name }, () => '')
}

export async function runServersAdd(ctx: CommandContext, name: string, url: string): Promise<void> {
  assertProfileName(name)
  const serverUrl = parseUrl(url)
  const config = await ctx.store.load()
  if (config.profiles[name]) {
    throw new CliError(`Server "${name}" already exists (${config.profiles[name]?.serverUrl})`, {
      hint: `Remove it first (\`${ctx.binName} servers rm ${name}\`) or pick another name.`,
    })
  }
  const next = await ctx.store.updateProfile(name, { serverUrl })
  ctx.log.success(
    `Added "${name}" → ${serverUrl}${next.defaultProfile === name ? ' (default)' : ''}`
  )
  ctx.log.hint(`Sign in with \`${ctx.binName} login --server ${name}\`.`)
  if (ctx.out.json) ctx.out.data({ name, serverUrl }, () => '')
}

export async function runServersRemove(
  ctx: CommandContext,
  name: string,
  options: ConfirmOptions = {}
): Promise<void> {
  const config = await ctx.store.load()
  requireProfile(config, name)
  if (
    !(await confirmConsequence(
      ctx,
      options,
      `Forget server "${name}"?`,
      `Its stored API key is deleted from this machine; \`login --server ${name}\` signs in again.`
    ))
  )
    return
  const { [name]: _removed, ...profiles } = config.profiles
  let defaultProfile = config.defaultProfile
  if (defaultProfile === name) defaultProfile = Object.keys(profiles).sort()[0]
  await ctx.store.save({ profiles, ...(defaultProfile ? { defaultProfile } : {}) })
  ctx.log.success(`Removed "${name}" and its stored credentials`)
  if (config.defaultProfile === name) {
    ctx.log.hint(
      defaultProfile ? `Default server is now "${defaultProfile}".` : 'No servers are left.'
    )
  }
  if (ctx.out.json)
    ctx.out.data({ removed: name, defaultProfile: defaultProfile ?? null }, () => '')
}

export async function runServersRename(
  ctx: CommandContext,
  from: string,
  to: string
): Promise<void> {
  assertProfileName(to)
  const config = await ctx.store.load()
  const profile = requireProfile(config, from)
  if (from === to) return
  if (config.profiles[to]) throw new CliError(`Server "${to}" already exists`)
  // Rebuild in order so the file keeps its shape; only the one key changes.
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([name, value]) =>
      name === from ? [to, profile] : [name, value]
    )
  )
  const defaultProfile = config.defaultProfile === from ? to : config.defaultProfile
  await ctx.store.save({ profiles, ...(defaultProfile ? { defaultProfile } : {}) })
  ctx.log.success(`Renamed "${from}" → "${to}"`)
  if (ctx.out.json) ctx.out.data({ from, to }, () => '')
}

export function registerServersCommands(program: Command, action: ActionWrapper): void {
  const servers = program
    .command('servers')
    .description(
      'named servers (profiles) — pick one with --profile, --server <name> or LAUNCH_PROFILE'
    )
  servers
    .command('ls', { isDefault: true })
    .alias('list')
    .description('list the stored servers (* default, keys redacted)')
    .action(action(runServersList))
  servers
    .command('use <name>')
    .description('make a server the default')
    .action(action((ctx, cmd) => runServersUse(ctx, cmd.args[0] ?? '')))
  servers
    .command('add <name> <url>')
    .description('register a server to sign in to later (`login --server <name>`)')
    .action(action((ctx, cmd) => runServersAdd(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '')))
  servers
    .command('rm <name>')
    .alias('remove')
    .description('forget a server and its stored credentials (asks first)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action((ctx, cmd) => runServersRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
  servers
    .command('rename <old> <new>')
    .description('rename a server')
    .action(action((ctx, cmd) => runServersRename(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '')))
}
