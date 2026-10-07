/**
 * CLI config (D26): `~/.launch/config.json` (dir 0700, file 0600) holding named SERVERS (profiles)
 * — each a server URL plus, once signed in, its API key, tenant and user — and which one is the
 * default. An agent can talk to local dev and production from one shell: `--profile <name>`,
 * `--server <name|url>` or `LAUNCH_PROFILE` pick one per command without re-logging in.
 *
 * A pre-profiles file (flat `serverUrl`/`apiKey`/`tenantId`/`tenantName`/`user`) still loads: it is
 * presented IN MEMORY as one profile named `default`, and the next save writes the new shape only.
 * Env overrides for CI: `LAUNCH_API_KEY`, `LAUNCH_URL`, and `LAUNCH_CONFIG_DIR` to relocate the
 * directory. ADAPTING renames the `LAUNCH_` prefix and `.launch` dir here — these constants are the
 * only place they live.
 */
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { CliError } from './errors'
import { BIN_NAME } from './package-info'

export const ENV_PREFIX = 'LAUNCH'
export const CONFIG_DIR_NAME = '.launch'
export const CONFIG_FILE_NAME = 'config.json'
/** The kit's local `wrangler dev` port; a real app sets its production URL here. */
export const DEFAULT_SERVER_URL = 'http://localhost:3001'
/** The profile a legacy flat file migrates into, and the first login's name. */
export const DEFAULT_PROFILE_NAME = 'default'

export const ENV = {
  apiKey: `${ENV_PREFIX}_API_KEY`,
  url: `${ENV_PREFIX}_URL`,
  profile: `${ENV_PREFIX}_PROFILE`,
  configDir: `${ENV_PREFIX}_CONFIG_DIR`,
  debug: `${ENV_PREFIX}_DEBUG`,
  banner: `${ENV_PREFIX}_BANNER`,
} as const

/** What the Rocketflare header reads from the environment (`utils/banner.ts`). */
export function bannerEnv(env: Env = process.env): {
  banner?: string
  ci: boolean
  noColor: boolean
} {
  return {
    banner: env[ENV.banner],
    ci: Boolean(env.CI),
    noColor: env.NO_COLOR !== undefined && env.NO_COLOR !== '',
  }
}

const userSchema = z.object({ email: z.string().optional(), name: z.string().optional() })

/** One named server. `serverUrl` is required; the rest is written by `login`. */
export const profileSchema = z.object({
  serverUrl: z.string().url(),
  apiKey: z.string().min(1).optional(),
  tenantId: z.string().optional(),
  tenantName: z.string().optional(),
  user: userSchema.optional(),
})
export type Profile = z.infer<typeof profileSchema>

/** Profile names: what `--profile`/`--server` accept — never mistakable for a URL. */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/**
 * The file as it may be on disk: the profiles shape, or the legacy flat fields (or, briefly,
 * both — the profiles win). `load()` normalises it to `CliConfig`.
 */
export const cliConfigFileSchema = z.object({
  defaultProfile: z.string().optional(),
  profiles: z.record(z.string(), profileSchema).optional(),
  // Legacy (pre-profiles) flat fields — read, migrated, never written.
  serverUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  tenantId: z.string().optional(),
  tenantName: z.string().optional(),
  user: userSchema.optional(),
})
export type CliConfigFile = z.infer<typeof cliConfigFileSchema>

/** The normalised config: what `load()` returns and `save()` writes. */
export interface CliConfig {
  defaultProfile?: string
  profiles: Record<string, Profile>
}

/** Keys `config get|set` may touch on the active profile. `apiKey` is always printed redacted. */
export const CONFIG_KEYS = ['serverUrl', 'apiKey', 'tenantId', 'tenantName'] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

export type Env = Record<string, string | undefined>

export function resolveConfigDir(env: Env = process.env): string {
  return env[ENV.configDir] ?? join(env.HOME ?? homedir(), CONFIG_DIR_NAME)
}

export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/** True for a value `--server` should treat as a URL rather than a profile name. */
export function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

/** Present any file shape as the profiles shape (in memory; nothing is written). */
export function migrateConfig(file: CliConfigFile): CliConfig {
  const profiles = { ...(file.profiles ?? {}) }
  let defaultProfile = file.defaultProfile
  if (Object.keys(profiles).length === 0 && file.serverUrl) {
    profiles[DEFAULT_PROFILE_NAME] = stripUndefined({
      serverUrl: normalizeUrl(file.serverUrl),
      apiKey: file.apiKey,
      tenantId: file.tenantId,
      tenantName: file.tenantName,
      user: file.user,
    })
    defaultProfile ??= DEFAULT_PROFILE_NAME
  } else if (Object.keys(profiles).length === 0 && file.apiKey) {
    // A key with no URL was the old default server's.
    profiles[DEFAULT_PROFILE_NAME] = stripUndefined({
      serverUrl: DEFAULT_SERVER_URL,
      apiKey: file.apiKey,
      tenantId: file.tenantId,
      tenantName: file.tenantName,
      user: file.user,
    })
    defaultProfile ??= DEFAULT_PROFILE_NAME
  }
  if (defaultProfile && !profiles[defaultProfile]) defaultProfile = undefined
  return defaultProfile ? { defaultProfile, profiles } : { profiles }
}

/** The name `login` gives a new server: its host, `.`/`:` → `-` (`localhost:3001` → `localhost-3001`). */
export function profileNameForUrl(url: string, taken: readonly string[] = []): string {
  let base: string
  try {
    base = new URL(url).host
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/[^a-z0-9]+/g, '-')
  } catch {
    base = 'server'
  }
  base = base.replace(/^-+|-+$/g, '').slice(0, 56) || 'server'
  if (!taken.includes(base)) return base
  for (let i = 2; ; i += 1) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`
}

export function assertProfileName(name: string): string {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new CliError(`"${name}" is not a valid server name`, {
      hint: 'Use letters, digits, ".", "_" or "-" (up to 63 characters), starting with a letter or digit.',
    })
  }
  return name
}

export function unknownProfileError(name: string, config: CliConfig): CliError {
  const known = Object.keys(config.profiles).sort()
  return new CliError(`Unknown server "${name}"`, {
    hint: known.length
      ? `Known servers: ${known.join(', ')}. Add one with \`${BIN_NAME} servers add <name> <url>\`.`
      : `No servers are configured yet. Run \`${BIN_NAME} login --server <url>\` or \`${BIN_NAME} servers add <name> <url>\`.`,
  })
}

/** The first profile (by name) whose server URL is `url`. */
export function profileForUrl(config: CliConfig, url: string): string | undefined {
  const target = normalizeUrl(url)
  return Object.keys(config.profiles)
    .sort()
    .find(name => normalizeUrl(config.profiles[name]?.serverUrl ?? '') === target)
}

export interface ResolvedConfig {
  /** The selected profile, or undefined when no profile applies (a bare `--server <url>`, empty file). */
  profile?: string
  /**
   * How it was selected: `flag` (`--profile`, or `--server <name>`) · `server-url` (`--server <url>`
   * or `LAUNCH_URL` matched its URL) · `env` (`LAUNCH_PROFILE`) · `default` (`defaultProfile`) ·
   * `none`.
   */
  profileSource: 'flag' | 'server-url' | 'env' | 'default' | 'none'
  serverUrl: string
  serverUrlSource: 'flag' | 'env' | 'config' | 'default'
  apiKey?: string
  apiKeySource: 'env' | 'config' | 'none'
  tenantId?: string
  tenantName?: string
  user?: Profile['user']
}

export interface ResolveOverrides {
  /** `--server <value>`: a profile name, or a URL. */
  serverUrl?: string
  /** `--profile <name>` */
  profile?: string
}

export interface ConfigStore {
  readonly dir: string
  readonly file: string
  /** The normalised config (a legacy file is migrated in memory). */
  load(): Promise<CliConfig>
  /** Write the profiles shape (a legacy-shaped argument is migrated first). */
  save(config: CliConfig | CliConfigFile): Promise<void>
  /** Merge `patch` into profile `name` (created when missing; the first profile becomes the default). */
  updateProfile(name: string, patch: Partial<Profile>): Promise<CliConfig>
  /** Remove a profile's key, tenant and user; keep its URL. Returns false when it had no key. */
  clearCredentials(name: string): Promise<boolean>
  /** Delete the file entirely. */
  clear(): Promise<void>
  /** Merge file + env + `--profile`/`--server` into what a command should use. */
  resolve(overrides?: ResolveOverrides): Promise<ResolvedConfig>
}

export function createConfigStore(options: { dir?: string; env?: Env } = {}): ConfigStore {
  const env = options.env ?? process.env
  const dir = options.dir ?? resolveConfigDir(env)
  const file = join(dir, CONFIG_FILE_NAME)

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
  }

  async function load(): Promise<CliConfig> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {} }
      throw error
    }
    const parsed = cliConfigFileSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(
        `Config file ${file} is invalid: ${issue?.path.join('.') || 'root'}: ${issue?.message}`
      )
    }
    return migrateConfig(parsed.data)
  }

  async function save(config: CliConfig | CliConfigFile): Promise<void> {
    const parsed = cliConfigFileSchema.parse(config)
    const next = migrateConfig(parsed)
    await ensureDir()
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    // `mode` only applies on creation; tighten an existing file too.
    await chmod(file, 0o600)
  }

  return {
    dir,
    file,
    load,
    save,
    async updateProfile(name, patch) {
      assertProfileName(name)
      const config = await load()
      const current = config.profiles[name]
      const serverUrl = patch.serverUrl ?? current?.serverUrl
      if (!serverUrl) throw new CliError(`Server "${name}" needs a URL`)
      const merged = stripUndefined({ ...current, ...patch, serverUrl: normalizeUrl(serverUrl) })
      const next: CliConfig = {
        ...config,
        profiles: { ...config.profiles, [name]: merged },
      }
      if (!next.defaultProfile) next.defaultProfile = name
      await save(next)
      return next
    },
    async clearCredentials(name) {
      const config = await load()
      const profile = config.profiles[name]
      if (!profile?.apiKey) return false
      config.profiles[name] = { serverUrl: profile.serverUrl }
      await save(config)
      return true
    },
    async clear() {
      await rm(file, { force: true })
    },
    async resolve(overrides = {}) {
      const config = await load()
      const envUrl = env[ENV.url]
      const envKey = env[ENV.apiKey]
      const envProfile = env[ENV.profile]
      const need = (name: string) => {
        if (!config.profiles[name]) throw unknownProfileError(name, config)
        return name
      }

      let profile: string | undefined
      let profileSource: ResolvedConfig['profileSource'] = 'none'
      let urlOverride: [string, 'flag' | 'env'] | undefined
      if (overrides.profile !== undefined && overrides.serverUrl !== undefined) {
        throw new CliError('Use --profile or --server, not both', {
          hint: '`--server` takes a server name too: `--server <name>`.',
        })
      }
      if (overrides.profile !== undefined) {
        profile = need(overrides.profile)
        profileSource = 'flag'
      } else if (overrides.serverUrl !== undefined) {
        if (config.profiles[overrides.serverUrl]) {
          profile = overrides.serverUrl
          profileSource = 'flag'
        } else if (looksLikeUrl(overrides.serverUrl)) {
          urlOverride = [overrides.serverUrl, 'flag']
        } else {
          throw unknownProfileError(overrides.serverUrl, config)
        }
      } else if (envUrl) {
        urlOverride = [envUrl, 'env']
      } else if (envProfile) {
        profile = need(envProfile)
        profileSource = 'env'
      } else if (config.defaultProfile) {
        profile = config.defaultProfile
        profileSource = 'default'
      }
      // A URL alone uses the credentials of the server registered at that URL — a key is only
      // ever sent to the server it was issued by.
      if (urlOverride) {
        profile = profileForUrl(config, urlOverride[0])
        profileSource = profile ? 'server-url' : 'none'
      }

      const stored = profile ? config.profiles[profile] : undefined
      const [serverUrl, serverUrlSource]: [string, ResolvedConfig['serverUrlSource']] = urlOverride
        ? urlOverride
        : stored
          ? [stored.serverUrl, 'config']
          : [DEFAULT_SERVER_URL, 'default']
      const [apiKey, apiKeySource]: [string | undefined, ResolvedConfig['apiKeySource']] = envKey
        ? [envKey, 'env']
        : stored?.apiKey
          ? [stored.apiKey, 'config']
          : [undefined, 'none']
      return {
        profile,
        profileSource,
        serverUrl: normalizeUrl(serverUrl),
        serverUrlSource,
        apiKey,
        apiKeySource,
        tenantId: stored?.tenantId,
        tenantName: stored?.tenantName,
        user: stored?.user,
      }
    },
  }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/** File mode bits (e.g. `0o600`) or null when the path does not exist. */
export async function fileMode(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o777
  } catch {
    return null
  }
}

/** Characters shown of a key: `launch_` (7) + 4 — never the full secret. `launch_ab12…` */
export const REDACTED_KEY_CHARS = 11

/** Show only the key prefix — never the full secret. `launch_ab12…` */
export function redactKey(key: string | undefined): string {
  if (!key) return '-'
  return key.length <= REDACTED_KEY_CHARS ? '****' : `${key.slice(0, REDACTED_KEY_CHARS)}…`
}

/** A copy of a profile safe to print: the key is redacted. */
export function redactProfile<T extends { apiKey?: string }>(profile: T): T {
  return profile.apiKey ? { ...profile, apiKey: redactKey(profile.apiKey) } : profile
}

/** A copy of the whole config safe to print: every key redacted. */
export function redactConfig(config: CliConfig): CliConfig {
  return {
    ...config,
    profiles: Object.fromEntries(
      Object.entries(config.profiles).map(([name, profile]) => [name, redactProfile(profile)])
    ),
  }
}
