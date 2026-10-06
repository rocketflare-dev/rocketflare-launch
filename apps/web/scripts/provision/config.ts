/**
 * Shared plumbing for `scripts/provision.ts`: paths, the instance file (`launch.deploy.env` at the
 * repo root — answers, tokens and the generated `OAUTH_ENCRYPTION_KEY`; `process.env` wins over it,
 * which is how CI or a one-off run overrides a value), the git-ignored instance state
 * (`.launch/state.json` — the NON-secret ids provisioning created and the facts it discovered), the
 * redacting logger and a child-process runner whose output is redacted before it is echoed.
 *
 * `LAUNCH_DEPLOY_FILE` points at another instance's file (relative to where `pnpm` was started):
 * `launch.staging.deploy.env` keeps its state in `.launch/state.staging.json` and its GitHub App
 * key in `.launch/github-app.staging.pem`, so two instances never share an id. Nothing here reads
 * `.dev.vars` — that file is loaded into the Worker by `wrangler dev`, so account-level tokens
 * must never live there.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEPLOY_FILE_BASENAME,
  LEGACY_PROVISION_ENV_BASENAME,
  missingTokenHint,
  parseEnvFile,
  REDACT_EXEMPT_KEYS,
  type ResolvedToken,
  resolveToken,
  secretValuesOf,
  upsertEnvFile,
} from './env-file'
import { type Instance, instanceTagOf, REQUIRED_TOKEN_KEYS, readInstance } from './instance'
import { redact, registerSecrets } from './redact'
import {
  CLOUDFLARE_TOKEN_SCOPES,
  cloudflareTokenTemplateUrl,
  MANUAL_SCOPES,
} from './token-template'

/** apps/web — resolved from this file, never from `process.cwd()`. */
export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const ROOT_DIR = path.resolve(WEB_DIR, '../..')

/**
 * `LAUNCH_DEPLOY_FILE` relative to where the person ran `pnpm` (`INIT_CWD`, which pnpm sets — the
 * script itself runs in apps/web), else `<root>/launch.deploy.env`.
 */
export function resolveDeployFile(
  override: string | undefined,
  cwd: string,
  root: string = ROOT_DIR
): string {
  const v = override?.trim()
  if (!v) return path.join(root, DEPLOY_FILE_BASENAME)
  return path.resolve(cwd, v)
}

export const DEPLOY_FILE = resolveDeployFile(
  process.env.LAUNCH_DEPLOY_FILE,
  process.env.INIT_CWD || ROOT_DIR
)
/** The token reader's name for the same file (`tokens.ts` writes it). */
export const TOKEN_FILE = DEPLOY_FILE
export const TOKEN_FILE_EXAMPLE = path.join(ROOT_DIR, `${DEPLOY_FILE_BASENAME}.example`)
/** How the file is shown in messages: relative to the repo when it is inside it. */
export const TOKEN_FILE_LABEL = (() => {
  const rel = path.relative(ROOT_DIR, DEPLOY_FILE)
  return rel && !rel.startsWith('..') ? rel : DEPLOY_FILE
})()
/** The pre-instance token file; never read, only detected so `check` can say "move it". */
export const LEGACY_TOKEN_FILE = path.join(WEB_DIR, LEGACY_PROVISION_ENV_BASENAME)

export const INSTANCE_TAG = instanceTagOf(DEPLOY_FILE)
export const STATE_DIR = path.join(ROOT_DIR, '.launch')
export const STATE_FILE = path.join(
  STATE_DIR,
  INSTANCE_TAG ? `state.${INSTANCE_TAG}.json` : 'state.json'
)
export const STATE_FILE_LABEL = path.relative(ROOT_DIR, STATE_FILE)
/** Where `github-app` writes the PEM, relative to the repo root (the value it puts in the file). */
export const DEFAULT_GITHUB_APP_PEM = path.join(
  '.launch',
  INSTANCE_TAG ? `github-app.${INSTANCE_TAG}.pem` : 'github-app.pem'
)

/** The committed template every instance is rendered from, and the rendered (git-ignored) file. */
export const TEMPLATE_TOML = path.join(WEB_DIR, 'wrangler.toml')
export const DEPLOY_TOML_BASENAME = 'wrangler.deploy.toml'
export const DEPLOY_TOML = path.join(WEB_DIR, DEPLOY_TOML_BASENAME)

/**
 * Every wrangler call for the instance targets the RENDERED config (`render` writes it next to
 * the template, so `main`, `assets` and the container `image` resolve as they do there).
 */
export const wranglerConfigArgs = (): string[] => ['-c', DEPLOY_TOML_BASENAME]

// ---- tokens -------------------------------------------------------------------------------

export const TOKEN_HELP: Record<string, { url: string; scopes: string }> = {
  CLOUDFLARE_API_TOKEN: {
    url: cloudflareTokenTemplateUrl(),
    scopes: `an ACCOUNT-owned token (Manage Account → API Tokens) with ${CLOUDFLARE_TOKEN_SCOPES.join('; ')} — the link pre-fills all but ${MANUAL_SCOPES.join(' and ')}`,
  },
  CLOUDFLARE_ACCOUNT_ID: {
    url: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages (the id is in the right-hand column / the URL)',
    scopes: 'the 32-hex account id — optional when the token sees exactly one account',
  },
  NEON_API_KEY: {
    url: 'https://console.neon.tech/app/settings/api-keys',
    scopes:
      "an ORGANIZATION API key (Launch creates every app's Neon project with it; a personal key needs NEON_ORG_ID)",
  },
  RESEND_API_KEY: {
    url: 'https://resend.com/api-keys',
    scopes: "Full access (creates the domain, mints the Worker's sending key and every app's)",
  },
}

/** The three account tokens; `--skip-email` drops Resend. */
export const REQUIRED_TOKENS = REQUIRED_TOKEN_KEYS

/** Optional Worker secrets copied from the instance file (or the environment) by `secrets`. */
export const OPTIONAL_WORKER_SECRETS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'OIDC_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'EMBEDDINGS_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  // Issue #19: written by the `github-app` phase from GitHub's manifest conversion.
  'GITHUB_WEBHOOK_SECRET',
] as const

let tokenFileMemo: Record<string, string> | undefined

/**
 * The instance file, parsed once per process (`reloadTokenFile()` after writing it). A file that
 * is readable by the group or the world gets ONE warning and is still used. Every value it yields
 * is registered with `redact()` so it can never be echoed, whatever its shape — except the answers
 * and identifiers in `REDACT_EXEMPT_KEYS` (domain, host, account id, admin email…), which `check`
 * prints.
 */
export function readTokenFile(): Record<string, string> {
  if (tokenFileMemo) return tokenFileMemo
  tokenFileMemo = {}
  if (!fs.existsSync(TOKEN_FILE)) return tokenFileMemo
  if (process.platform !== 'win32') {
    const mode = fs.statSync(TOKEN_FILE).mode & 0o777
    if (mode & 0o077)
      warn(
        `${TOKEN_FILE_LABEL} is mode ${mode.toString(8).padStart(4, '0')} — it holds tokens; run \`chmod 600 ${TOKEN_FILE_LABEL}\``
      )
  }
  tokenFileMemo = parseEnvFile(fs.readFileSync(TOKEN_FILE, 'utf8'))
  registerSecrets(secretValuesOf(tokenFileMemo))
  return tokenFileMemo
}

export function reloadTokenFile(): void {
  tokenFileMemo = undefined
}

/** Where a value comes from: the process environment (CI) beats the file; empty counts as unset. */
export function tokenSource(name: string): ResolvedToken | undefined {
  const resolved = resolveToken(name, process.env, readTokenFile())
  if (resolved && !REDACT_EXEMPT_KEYS.has(name)) registerSecrets([resolved.value])
  return resolved
}

export function token(name: string): string | undefined {
  return tokenSource(name)?.value
}

/** The standard "missing token" sentence: the instance file, `pnpm provision tokens`, or an export. */
export function tokenHint(name: string): string {
  return missingTokenHint(name, TOKEN_HELP[name], TOKEN_FILE_LABEL)
}

export function requireToken(name: string): string {
  const v = token(name)
  if (!v) throw new ProvisionError(tokenHint(name), 2)
  return v
}

/**
 * Set `KEY=value` lines in the instance file — how a GENERATED value (the OAuth encryption key,
 * the GitHub App id) gets into the one place the operator backs up. Comments and every other line
 * are preserved; a missing file is seeded from the example so its guidance comes along. Written to
 * a temporary file and renamed over the original, mode 0600, so an interrupted write can never
 * leave the file — and the key in it — half written.
 */
export function writeDeployFileValues(updates: Record<string, string>): void {
  const current = fs.existsSync(DEPLOY_FILE)
    ? fs.readFileSync(DEPLOY_FILE, 'utf8')
    : fs.existsSync(TOKEN_FILE_EXAMPLE)
      ? fs.readFileSync(TOKEN_FILE_EXAMPLE, 'utf8')
      : ''
  const next = upsertEnvFile(current, updates)
  const tmp = `${DEPLOY_FILE}.tmp-${process.pid}`
  fs.writeFileSync(tmp, next, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, DEPLOY_FILE)
  for (const [k, v] of Object.entries(updates)) if (!REDACT_EXEMPT_KEYS.has(k)) registerSecrets([v])
  reloadTokenFile()
}

export function writeDeployFileValue(key: string, value: string): void {
  writeDeployFileValues({ [key]: value })
}

// ---- the instance -------------------------------------------------------------------------

/** The validated answers; exit 2 naming every missing or wrong key (never a secret value). */
export function requireInstance(): Instance {
  const { instance, missing, invalid } = readInstance(token)
  if (instance) return instance
  const lines = [...missing.map(k => `${k} is not set`), ...invalid]
  throw new ProvisionError(
    `${TOKEN_FILE_LABEL}: ${lines.join('; ')}${fs.existsSync(DEPLOY_FILE) ? '' : ` — the file does not exist: cp ${DEPLOY_FILE_BASENAME}.example ${TOKEN_FILE_LABEL} and fill it in`}`,
    2
  )
}

/** The Cloudflare account: the file's `CLOUDFLARE_ACCOUNT_ID`, else the one `check` discovered. */
export function accountId(): string | undefined {
  return token('CLOUDFLARE_ACCOUNT_ID') ?? readState().cloudflare?.accountId
}

// ---- errors -------------------------------------------------------------------------------

export class ProvisionError extends Error {
  constructor(
    message: string,
    public exitCode = 1
  ) {
    super(message)
  }
}

// ---- state --------------------------------------------------------------------------------

/**
 * What provisioning created and discovered for ONE instance — ids and facts, never a secret. The
 * committed tomls never hold any of it; `render` reads it to write `wrangler.deploy.toml`.
 */
export interface InstanceState {
  /** The answers the resources below were created for, so a changed name is noticed. */
  instance?: { name?: string; domain?: string; host?: string }
  cloudflare?: {
    accountId?: string
    accountName?: string
    zoneId?: string
    zoneName?: string
    /** binding → KV namespace id (`RATE_LIMIT_KV` and any plugin's). */
    kv?: Record<string, string>
    /** zone name → zone id, one per zone a host or the sending domain resolved to. */
    zones?: Record<string, string>
  }
  neon?: {
    projectId?: string
    orgId?: string
    branchId?: string
    host?: string
    database?: string
    role?: string
    region?: string
  }
  resend?: { domainId?: string; domainName?: string; region?: string }
  githubApp?: { slug?: string; htmlUrl?: string; owner?: string }
  deploy?: { containersHash?: string; version?: string; at?: string }
}

const SECRET_SHAPE = /postgres(ql)?:\/\/|\bre_|\bnapi_|PRIVATE KEY|[0-9a-f]{40,}/i

export function readState(): InstanceState {
  if (!fs.existsSync(STATE_FILE)) return {}
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as InstanceState
  } catch {
    return {}
  }
}

export function writeState(patch: InstanceState): InstanceState {
  const merged = deepMerge(readState(), patch as Record<string, any>)
  const json = JSON.stringify(merged, null, 2)
  // Belt and braces: the state holds ids and facts only. Refuse to persist anything secret-shaped.
  if (SECRET_SHAPE.test(json))
    throw new ProvisionError(`refusing to write a secret-shaped value to ${STATE_FILE_LABEL}`)
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(STATE_FILE, `${json}\n`)
  return merged
}

function deepMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): T {
  const out: Record<string, any> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object')
      out[k] = deepMerge(out[k], v)
    else out[k] = v
  }
  return out as T
}

// ---- logging ------------------------------------------------------------------------------

export const log = (msg: string): void => {
  console.log(redact(msg))
}
export const warn = (msg: string): void => {
  console.error(redact(`warning: ${msg}`))
}
export const verifyLine = (msg: string): void => {
  console.log(redact(`Verify: ${msg}`))
}
export const heading = (msg: string): void => {
  console.log(`\n== ${redact(msg)}`)
}

// ---- child processes ----------------------------------------------------------------------

export interface RunOptions {
  cwd?: string
  /** Extra environment for the child — how a connection string reaches a script without a log. */
  env?: Record<string, string | undefined>
  /** Piped to the child's stdin (secrets travel this way, never as arguments). */
  stdin?: string
  /** Echo the child's (redacted) output live. Default true; false = capture silently. */
  echo?: boolean
  /** Return instead of throwing on a non-zero exit. */
  allowFailure?: boolean
}

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

/** Run a command, streaming redacted output; the raw (unredacted) capture is returned to the caller. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const echo = opts.echo ?? true
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? WEB_DIR,
      env: { ...process.env, ...opts.env },
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString()
      stdout += s
      if (echo) process.stdout.write(redact(s))
    })
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr += s
      if (echo) process.stderr.write(redact(s))
    })
    child.on('error', reject)
    child.on('close', code => {
      const status = code ?? 1
      if (status !== 0 && !opts.allowFailure) {
        reject(
          new ProvisionError(
            `${cmd} ${args.map(a => redact(a)).join(' ')} exited ${status}${echo ? '' : `\n${redact(stderr || stdout).trim()}`}`
          )
        )
        return
      }
      resolve({ status, stdout, stderr })
    })
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin)
    }
  })
}

/** Synchronous capture for cheap lookups (`git config user.email`, `docker info`). */
export function capture(cmd: string, args: string[], cwd = WEB_DIR): string | undefined {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: process.env })
  if (r.status !== 0) return undefined
  return r.stdout.trim()
}

/** `pnpm exec wrangler …` inside apps/web — never at the workspace root (docs/DEPLOY.md). */
export function wrangler(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run('pnpm', ['exec', 'wrangler', ...args], {
    ...opts,
    cwd: WEB_DIR,
    env: {
      CLOUDFLARE_API_TOKEN: token('CLOUDFLARE_API_TOKEN'),
      CLOUDFLARE_ACCOUNT_ID: accountId(),
      ...opts.env,
    },
  })
}

/** `https://app.example.com` → `example.com` (last two labels; a public-suffix table is not worth a dependency). */
export function apexOf(hostOrUrl: string): string {
  const host = hostOrUrl.replace(/^https?:\/\//, '').split('/')[0]
  const labels = host.split('.')
  return labels.length <= 2 ? host : labels.slice(-2).join('.')
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
