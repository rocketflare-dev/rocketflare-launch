/**
 * `launch login [--server <name|url>] [--name <server>]` — browser handoff → API key stored under a
 * named server (profile) (D26). The name, unless `--name` gives one: the selected server when its
 * URL is the one being signed in to, else the server already registered at that URL, else
 * `default` for the very first one, else one derived from the host (`localhost:3001` →
 * `localhost-3001`). Signing in to the same server again refreshes its credentials; the first
 * server becomes the default. `--admin` asks for an admin-scoped key (platform administrators only;
 * it also reaches `/api/admin` and `/api/platform`, 30 days) and stores it as `<server>-admin`.
 */
import { loginFlow } from '../auth'
import {
  assertProfileName,
  type CliConfig,
  DEFAULT_PROFILE_NAME,
  normalizeUrl,
  profileForUrl,
  profileNameForUrl,
  type ResolvedConfig,
} from '../config'
import type { CommandContext } from '../context'

export interface LoginCommandOptions {
  /** `--name <server>` */
  name?: string
  /** `--admin`: an admin-scoped key, stored under `<server>-admin` unless `--name` says otherwise. */
  admin?: boolean
}

/** Where a login goes: the URL to sign in at and the server name to store it under. Pure. */
export function loginTarget(
  resolved: ResolvedConfig,
  config: CliConfig,
  name?: string
): { serverUrl: string; profile: string } {
  const urlIsExplicit = resolved.serverUrlSource === 'flag' || resolved.serverUrlSource === 'env'
  if (name !== undefined) {
    assertProfileName(name)
    const existing = config.profiles[name]
    // `login --name prod` signs in to prod's own URL unless a URL was given on purpose.
    const serverUrl = existing && !urlIsExplicit ? existing.serverUrl : resolved.serverUrl
    return { serverUrl: normalizeUrl(serverUrl), profile: name }
  }
  const serverUrl = normalizeUrl(resolved.serverUrl)
  const selected = resolved.profile ? config.profiles[resolved.profile] : undefined
  if (resolved.profile && selected && normalizeUrl(selected.serverUrl) === serverUrl) {
    return { serverUrl, profile: resolved.profile }
  }
  const names = Object.keys(config.profiles)
  const profile =
    profileForUrl(config, serverUrl) ??
    (names.length === 0 ? DEFAULT_PROFILE_NAME : profileNameForUrl(serverUrl, names))
  return { serverUrl, profile }
}

/**
 * Where an admin key goes when `--name` is not given: beside the ordinary login, never over it, so
 * everyday commands keep using the tenant key and `--server prod-admin` is a deliberate choice. Pure.
 */
export function adminProfileName(profile: string): string {
  return profile.endsWith('-admin') ? profile : `${profile}-admin`
}

export async function runLogin(
  ctx: CommandContext,
  options: LoginCommandOptions = {}
): Promise<void> {
  const target = loginTarget(ctx.config, await ctx.store.load(), options.name)
  const result = await loginFlow({
    serverUrl: target.serverUrl,
    profile: options.admin && !options.name ? adminProfileName(target.profile) : target.profile,
    admin: options.admin,
    store: ctx.store,
    log: ctx.log,
    open: ctx.open,
    fetch: ctx.fetch,
  })
  if (ctx.json) ctx.out.data(result, () => '')
}
