/**
 * One deployed instance, as `launch.deploy.env` describes it — pure, so the `config` test project
 * covers every default and every refusal. `config.ts` does the I/O and hands `readInstance` a
 * getter (environment first, then the file).
 *
 * The answers and their defaults:
 *
 *   LAUNCH_DOMAIN        required   the Cloudflare zone apps live under (`rocketflare.dev`)
 *   LAUNCH_HOST          launch.<domain>   where Launch itself is served (a Worker custom domain)
 *   LAUNCH_NAME          launch     the Worker name AND the prefix of every account-scoped resource
 *                                   (`<name>-jobs`, `<name>-files`, `<name>-agent-run`, `<NAME>_RATE_LIMIT`)
 *                                   — the default reproduces the committed template's names exactly;
 *                                   a different one lets two instances share a Cloudflare account
 *   LAUNCH_ADMIN_EMAILS  required   comma-separated; the first is the organisation's owner
 *                                   (BOOTSTRAP_ADMIN_EMAILS on the Worker)
 *   LAUNCH_GITHUB_ORG    required   the GitHub organization Launch's apps live in
 *   NEON_REGION          aws-eu-central-1   the instance's own Neon project, and the region pinned
 *                                   for every app's
 *   NEON_ORG_ID          optional   only for a personal Neon key that belongs to several orgs
 *   EMAIL_DOMAIN         notifications.<domain>   the Resend sending domain (spec/04's default)
 *   EMAIL_REGION         us-east-1  the Resend region
 *   GITHUB_APP_NAME      "<App name> <org>"   the name `pnpm provision github-app` proposes
 */

export const DEFAULT_LAUNCH_NAME = 'launch'
export const DEFAULT_NEON_REGION = 'aws-eu-central-1'
export const DEFAULT_EMAIL_REGION = 'us-east-1'
/** The `[vars] APP_NAME` the template ships; the email From name and the GitHub App's. */
export const DEFAULT_APP_DISPLAY_NAME = 'Launch'

export interface Instance {
  domain: string
  host: string
  name: string
  appUrl: string
  adminEmails: string[]
  githubOrg: string
  neonRegion: string
  neonOrgId?: string
  emailDomain: string
  emailRegion: string
  /** `https://{label}.<domain>` — coding sessions' preview origins (SESSION_PREVIEW_URL). */
  previewUrl: string
  githubAppName: string
}

/** The answers `check` insists on before it touches the network. */
export const REQUIRED_INSTANCE_KEYS = [
  'LAUNCH_DOMAIN',
  'LAUNCH_ADMIN_EMAILS',
  'LAUNCH_GITHUB_ORG',
] as const

/** The account tokens provisioning acts with (Resend only without `--skip-email`). */
export const REQUIRED_TOKEN_KEYS = [
  'CLOUDFLARE_API_TOKEN',
  'NEON_API_KEY',
  'RESEND_API_KEY',
] as const

/** Written by `pnpm provision github-app`; `setup` needs both. */
export const GITHUB_APP_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE'] as const

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const WORKER_NAME = /^[a-z][a-z0-9-]{0,39}$/
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NEON_REGION_ID = /^[a-z]+-[a-z0-9-]+$/

export type Getter = (key: string) => string | undefined

export interface InstanceReading {
  instance?: Instance
  /** Required keys with no value. */
  missing: string[]
  /** Keys with a value that cannot be right — one sentence each, the value only when it is an answer. */
  invalid: string[]
}

const clean = (v: string | undefined) => v?.trim() || undefined
const host = (v: string | undefined) =>
  clean(v)
    ?.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')

/** Read and validate the answers. Never throws: `check` reports every problem at once. */
export function readInstance(get: Getter): InstanceReading {
  const missing = REQUIRED_INSTANCE_KEYS.filter(k => !clean(get(k)))
  const invalid: string[] = []

  const domain = host(get('LAUNCH_DOMAIN'))
  if (domain && !HOSTNAME.test(domain))
    invalid.push(`LAUNCH_DOMAIN "${domain}" is not a domain name (e.g. example.com)`)

  const hostName = host(get('LAUNCH_HOST')) ?? (domain ? `launch.${domain}` : undefined)
  if (hostName && domain) {
    if (!HOSTNAME.test(hostName)) invalid.push(`LAUNCH_HOST "${hostName}" is not a hostname`)
    else if (!hostName.endsWith(`.${domain}`))
      invalid.push(
        `LAUNCH_HOST "${hostName}" must be a subdomain of LAUNCH_DOMAIN ${domain} (the wildcard route and the custom domain share its zone)`
      )
  }

  const name = clean(get('LAUNCH_NAME'))?.toLowerCase() ?? DEFAULT_LAUNCH_NAME
  if (!WORKER_NAME.test(name))
    invalid.push(
      `LAUNCH_NAME "${name}" must be lower-case letters, digits and hyphens, starting with a letter (max 40)`
    )

  const adminEmails = (clean(get('LAUNCH_ADMIN_EMAILS')) ?? '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
  for (const e of adminEmails)
    if (!EMAIL.test(e))
      invalid.push(`LAUNCH_ADMIN_EMAILS has "${e}", which is not an email address`)

  const githubOrg = clean(get('LAUNCH_GITHUB_ORG'))
  if (githubOrg && !GITHUB_LOGIN.test(githubOrg))
    invalid.push(`LAUNCH_GITHUB_ORG "${githubOrg}" is not a GitHub organization login`)

  const neonRegion = clean(get('NEON_REGION')) ?? DEFAULT_NEON_REGION
  if (!NEON_REGION_ID.test(neonRegion))
    invalid.push(`NEON_REGION "${neonRegion}" is not a Neon region id (e.g. aws-eu-central-1)`)

  const emailDomain = host(get('EMAIL_DOMAIN')) ?? (domain ? `notifications.${domain}` : undefined)
  if (emailDomain && !HOSTNAME.test(emailDomain))
    invalid.push(`EMAIL_DOMAIN "${emailDomain}" is not a domain name`)

  const neonOrgId = clean(get('NEON_ORG_ID'))
  if (neonOrgId && !/^org-[a-z0-9-]+$/.test(neonOrgId))
    invalid.push(`NEON_ORG_ID "${neonOrgId}" is not a Neon organization id (org-…)`)

  if (missing.length || invalid.length || !domain || !hostName || !githubOrg || !emailDomain)
    return { missing, invalid }

  return {
    missing,
    invalid,
    instance: {
      domain,
      host: hostName,
      name,
      appUrl: `https://${hostName}`,
      adminEmails,
      githubOrg,
      neonRegion,
      ...(neonOrgId ? { neonOrgId } : {}),
      emailDomain,
      emailRegion: clean(get('EMAIL_REGION')) ?? DEFAULT_EMAIL_REGION,
      previewUrl: `https://{label}.${domain}`,
      githubAppName: (
        clean(get('GITHUB_APP_NAME')) ?? `${DEFAULT_APP_DISPLAY_NAME} ${githubOrg}`
      ).slice(0, 34),
    },
  }
}

/** `<NAME>` upper-cased with `-` → `_`: the KV namespace spelling (`LAUNCH_RATE_LIMIT`). */
export const toUpperName = (name: string): string => name.toUpperCase().replace(/-/g, '_')

/**
 * The account-scoped resources an instance named `name` CREATES before its first deploy. With the
 * default name these are exactly the committed template's (`launch-jobs`, `launch-files`,
 * `LAUNCH_RATE_LIMIT`), so the first instance on an account looks like the kit always did.
 */
export function instanceResourceNames(name: string) {
  return {
    kv: `${toUpperName(name)}_RATE_LIMIT`,
    queue: `${name}-jobs`,
    bucket: `${name}-files`,
  }
}

/**
 * `launch.deploy.env` → '' (the default instance); `launch.staging.deploy.env` → `staging`;
 * any other file name → its base name without `.env`. The tag keeps a second instance's state and
 * GitHub App key apart from the first's (`.launch/state.staging.json`).
 */
export function instanceTagOf(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file
  if (base === 'launch.deploy.env') return ''
  const m = /^launch\.(.+)\.deploy\.env$/.exec(base)
  const tag = (m ? m[1] : base.replace(/\.env$/, '')).replace(/[^A-Za-z0-9_-]/g, '-')
  return tag || 'instance'
}
