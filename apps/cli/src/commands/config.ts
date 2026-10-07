/**
 * `launch config get [key] | set <key> <value> | path` — on the SELECTED server (profile); the
 * API key is only ever printed redacted (D26).
 */
import { CONFIG_KEYS, type ConfigKey, DEFAULT_PROFILE_NAME, redactKey } from '../config'
import type { CommandContext } from '../context'
import { CliError } from '../errors'
import { formatJson } from '../utils/output'

function assertKey(key: string): ConfigKey {
  if ((CONFIG_KEYS as readonly string[]).includes(key)) return key as ConfigKey
  throw new CliError(`Unknown config key "${key}"`, {
    hint: `Valid keys: ${CONFIG_KEYS.join(', ')}`,
  })
}

export async function runConfigGet(ctx: CommandContext, key?: string): Promise<void> {
  const config = await ctx.store.load()
  const name = ctx.config.profile
  const profile = name ? config.profiles[name] : undefined
  const view = {
    profile: name ?? null,
    defaultProfile: config.defaultProfile ?? null,
    ...(profile ?? {}),
    ...(profile?.apiKey ? { apiKey: redactKey(profile.apiKey) } : {}),
  }
  if (key === undefined) {
    ctx.out.data(view, () => formatJson(view))
    return
  }
  const value = profile?.[assertKey(key)]
  const shown = key === 'apiKey' && typeof value === 'string' ? redactKey(value) : value
  ctx.out.data({ profile: name ?? null, [key]: shown ?? null }, () =>
    shown === undefined ? '' : String(shown)
  )
}

export async function runConfigSet(ctx: CommandContext, key: string, value: string): Promise<void> {
  const field = assertKey(key)
  if (field === 'serverUrl') {
    try {
      new URL(value)
    } catch {
      throw new CliError(`"${value}" is not a valid URL`)
    }
  }
  const config = await ctx.store.load()
  // An empty file gets its first server; a bare `--server <url>` with no stored server has none.
  const name =
    ctx.config.profile ??
    (Object.keys(config.profiles).length === 0 ? DEFAULT_PROFILE_NAME : undefined)
  if (!name) {
    throw new CliError(`No stored server at ${ctx.config.serverUrl}`, {
      hint: `Add it first: \`${ctx.binName} servers add <name> ${ctx.config.serverUrl}\`.`,
    })
  }
  if (!config.profiles[name] && field !== 'serverUrl') {
    throw new CliError(`Server "${name}" has no URL yet`, {
      hint: `Set it first: \`${ctx.binName} config set serverUrl <url>\`.`,
    })
  }
  const stored = field === 'serverUrl' ? value.replace(/\/+$/, '') : value
  await ctx.store.updateProfile(name, { [field]: stored })
  ctx.log.success(`${name}: ${field} = ${field === 'apiKey' ? redactKey(stored) : stored}`)
}

export async function runConfigPath(ctx: CommandContext): Promise<void> {
  ctx.out.data({ path: ctx.store.file, dir: ctx.store.dir }, () => ctx.store.file)
}
