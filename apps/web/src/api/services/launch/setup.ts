/**
 * The setup wizard's service (spec/03, spec/04): the probes behind every credential's status dots,
 * the page's overview, and the settings writes. Routes in `routes/setup.ts` stay thin over this.
 *
 * **Checks.** Each vendor has one `check*` function taking the secret, the settings and
 * `{ fetch }`, returning `{ checks: [{ id, label, status, detail }], metadata, settings }`:
 *
 * - `checks` — every probe, in order. `failed` is "Launch cannot work like this", `warning` is
 *   "Launch can work, but look". The worst probe is the credential's `last_check_status`.
 * - `metadata` — NON-secret facts a probe discovered (a token id, an installation id), merged into
 *   `admin_credentials.metadata` by `recordCheck`.
 * - `settings` — settings a probe discovered (the Neon org, the pinned region), written to
 *   `launch_settings` so the pipeline reads one place.
 *
 * A probe never throws out of its check: a vendor error becomes a `failed` probe whose detail is
 * the vendor's own message, passed through `scrub` so the secret can never echo back. A probe that
 * depends on an earlier one is skipped (not run) when that one failed, rather than piling on
 * failures that all mean the same thing.
 *
 * **Anthropic (P3)** is probed with `GET /v1/models`: the key works, and the session policy's
 * default model is one it can see. It has no setup STEP — coding sessions fall back to the
 * Worker's `ANTHROPIC_API_KEY` secret without it — so the wizard's dots never wait on it.
 * **OpenAI (§18.22-B)** the same way, for Codex's model (`DEFAULT_CODEX_MODEL`); also no step —
 * its card sits after the steps, and sessions fall back to `OPENAI_API_KEY`.
 *
 * **The one probe that WRITES.** A zone with no `*.<apps domain>` record at all gets a proxied
 * `AAAA * → 100::` created by the Cloudflare check (spike S2), reported `ok` ("Created …") and
 * returned as an `effects` entry the route audits `dns.wildcard.created`. Only
 * `runCredentialCheck` — the save and re-check actions — turns that on (`createWildcard`); the
 * overview never probes at all, so a page load cannot change a zone. An EXISTING record, even a
 * DNS-only one, is never touched: that is someone's decision, so the check explains it instead.
 * A second run finds the record it made and creates nothing, so the check stays idempotent.
 *
 * **Neon regions** never come from `GET /regions`, which refuses organization keys (404). A pinned
 * `neon_region_id` is checked against the static `NEON_REGIONS`; an unset one is learned from
 * where the org's projects already are, else pinned to `DEFAULT_NEON_REGION` with a warning.
 *
 * **What is deliberately NOT probed.** Cloudflare write scope: nothing proves "can create a Worker"
 * short of creating one, so it is reported as a standing `warning` ("write scope unverified") rather
 * than a green light the check did not earn.
 */

import { DEFAULT_CLAUDE_CODE_MODEL, DEFAULT_CODEX_MODEL } from '@launch/shared/launch-sessions'
import {
  CREDENTIAL_KINDS,
  type CredentialCheck,
  type CredentialCheckStatus,
  type CredentialKind,
  type CredentialMetadata,
  type CredentialPayload,
  DEFAULT_NEON_REGION,
  type LaunchSettingKey,
  NEON_REGIONS,
  neonRegionLabel,
  SETUP_SETTING_KEYS,
  type SetupCredential,
  type SetupIdentity,
  type SetupOverview,
  type SetupSettings,
  type SetupSettingsUpdate,
  type SetupStep,
  type SetupStepStatus,
} from '@launch/shared/launch-setup'
import { inArray } from 'drizzle-orm'
import { type AppConfig, hasOidc, isOidcOnly } from '../../../config'
import type { Database } from '../../../db/client'
import { users } from '../../../db/schema'
import { configuredProviders } from '../../auth/providers'
import { NotFoundError } from '../../utils/core/errors'
import { type SandboxHostBindings, sessionSandboxStatus } from '../sessions/sandbox-host'
import { CloudflareApiError, CloudflareClient } from './cloudflare'
import {
  credentialStatus,
  getCredential,
  getSettings,
  overallCheckStatus,
  putSetting,
  recordCheck,
} from './credentials'
import { GitHubApiError, type GitHubPermissions, getApp, listInstallations } from './github-app'
import { templatePinStatus } from './kit-pin'
import { NeonApiError, NeonClient, type NeonProject } from './neon'
import { publicUrlOverview } from './public-url'
import { ResendApiError, ResendClient } from './resend'
import { sessionAgentsStatus } from './session-agents'

/** What every vendor call takes, so tests hand in a fake and nothing reaches the network. */
export interface VendorOptions {
  fetch?: typeof fetch
}

/**
 * A change a check MADE upstream, for the route to audit — only ever the Cloudflare wildcard, and
 * only when the caller allowed it (`createWildcard`). `after` is non-secret by construction.
 */
export interface CheckEffect {
  action: 'dns.wildcard.created'
  targetType: 'Zone'
  targetId: string
  after: Record<string, unknown>
}

export interface CheckOutcome {
  checks: CredentialCheck[]
  metadata: CredentialMetadata
  settings: Partial<Record<LaunchSettingKey, string>>
  /** What the check changed upstream; absent (or empty) for a read-only one. */
  effects?: CheckEffect[]
}

// ---- helpers ---------------------------------------------------------------------------------

/** Remove every occurrence of `secrets` from vendor text before it is stored or returned. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]')
  }
  return out.slice(0, 500)
}

function errorDetail(err: unknown, vendor: string, secrets: readonly string[]): string {
  if (
    err instanceof CloudflareApiError ||
    err instanceof NeonApiError ||
    err instanceof ResendApiError ||
    err instanceof GitHubApiError
  ) {
    return scrub(`${vendor} ${err.status}: ${err.message}`, secrets)
  }
  const message = err instanceof Error ? err.message : String(err)
  return scrub(`Could not reach ${vendor}: ${message}`, secrets)
}

const ok = (id: string, label: string, detail?: string): CredentialCheck => ({
  id,
  label,
  status: 'ok',
  ...(detail ? { detail } : {}),
})
const warn = (id: string, label: string, detail: string): CredentialCheck => ({
  id,
  label,
  status: 'warning',
  detail,
})
const fail = (id: string, label: string, detail: string): CredentialCheck => ({
  id,
  label,
  status: 'failed',
  detail,
})

/** `notifications_domain`, or `notifications.<apps_domain>` (spec/04). */
export function notificationsDomainOf(settings: Partial<SetupSettings>): string | null {
  if (settings.notifications_domain) return settings.notifications_domain
  return settings.apps_domain ? `notifications.${settings.apps_domain}` : null
}

/** A short, non-reversible fingerprint of a secret, so a rotation is visible in the metadata. */
export async function fingerprint(secret: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(secret))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest.slice(0, 6), b => b.toString(16).padStart(2, '0')).join('')
}

// ---- Cloudflare ------------------------------------------------------------------------------

/** Account reads a per-app create needs (spec/06): Workers, KV, Queues, R2. */
const CLOUDFLARE_READ_PROBES = [
  { id: 'account.workers', label: 'Workers scripts readable', call: 'listWorkerScripts' },
  { id: 'account.kv', label: 'KV namespaces readable', call: 'listKvNamespaces' },
  { id: 'account.queues', label: 'Queues readable', call: 'listQueues' },
  { id: 'account.r2', label: 'R2 buckets readable', call: 'listR2Buckets' },
] as const

export interface CloudflareCheckOptions extends VendorOptions {
  /**
   * Create the proxied `AAAA * → 100::` record when the zone has no `*.<apps domain>` record at
   * all. Off by default: only the save and re-check actions (`runCredentialCheck`) pass it.
   */
  createWildcard?: boolean
}

export async function checkCloudflare(
  secret: CredentialPayload<'cloudflare_api_token'>,
  settings: Partial<SetupSettings>,
  opts: CloudflareCheckOptions = {}
): Promise<CheckOutcome> {
  const secrets = [secret.apiToken]
  const checks: CredentialCheck[] = []
  const metadata: CredentialMetadata = {}
  const effects: CheckEffect[] = []
  const accountId = settings.cloudflare_account_id
  const domain = settings.apps_domain
  const cf = new CloudflareClient(secret.apiToken, { fetch: opts.fetch })

  if (!accountId) {
    checks.push(
      fail('token.verify', 'Account token active', 'Set the Cloudflare account id first.')
    )
    return { checks, metadata, settings: {} }
  }
  metadata.accountId = accountId

  try {
    const verify = await cf.verifyAccountToken(accountId)
    metadata.tokenId = verify.id
    checks.push(
      verify.status === 'active'
        ? ok('token.verify', 'Account token active', `Token ${verify.id} in account ${accountId}`)
        : fail('token.verify', 'Account token active', `The token is ${verify.status}.`)
    )
  } catch (err) {
    checks.push(
      fail(
        'token.verify',
        'Account token active',
        `${errorDetail(err, 'Cloudflare', secrets)} — Launch needs an ACCOUNT-owned token for this account.`
      )
    )
    return { checks, metadata, settings: {} }
  }

  for (const probe of CLOUDFLARE_READ_PROBES) {
    try {
      const items = await cf[probe.call](accountId)
      checks.push(
        ok(
          probe.id,
          probe.label,
          probe.id === 'account.workers' ? `${items.length} of 500 Workers in use` : undefined
        )
      )
    } catch (err) {
      checks.push(fail(probe.id, probe.label, errorDetail(err, 'Cloudflare', secrets)))
    }
  }

  checks.push(
    ...(await checkZone(cf, accountId, domain, metadata, secrets, {
      createWildcard: opts.createWildcard ?? false,
      effects,
    }))
  )

  checks.push(
    warn(
      'token.write',
      'Write permissions',
      'Write scope unverified: Launch cannot prove it may create Workers, KV, Queues, R2, DNS or routes without creating one. Check the token has Workers Scripts, KV, Queues, R2 and Workflows (Edit) on the account and DNS + Workers Routes (Edit) on the zone.'
    )
  )
  return { checks, metadata, settings: {}, effects }
}

/** The zone probes (spec/04): in this account, a proxied `*` record, routes readable. */
async function checkZone(
  cf: CloudflareClient,
  accountId: string,
  domain: string | null | undefined,
  metadata: CredentialMetadata,
  secrets: readonly string[],
  wildcardOpts: { createWildcard: boolean; effects: CheckEffect[] }
): Promise<CredentialCheck[]> {
  const label = 'Apps zone in this account'
  if (!domain) return [fail('zone.account', label, 'Set the apps domain first.')]
  let zone: Awaited<ReturnType<CloudflareClient['findZone']>>
  try {
    zone = await cf.findZone(domain)
  } catch (err) {
    return [fail('zone.account', label, errorDetail(err, 'Cloudflare', secrets))]
  }
  if (!zone) {
    return [
      fail(
        'zone.account',
        label,
        `No zone ${domain} is visible to this token. Add the zone to account ${accountId}, or give the token Zone permissions on it.`
      ),
    ]
  }
  if (zone.account.id !== accountId) {
    return [
      fail(
        'zone.account',
        label,
        `Zone ${domain} is in account ${zone.account.id}, not ${accountId}. Worker routes can only point at Workers in the zone's own account.`
      ),
    ]
  }
  metadata.zoneId = zone.id
  const out: CredentialCheck[] = [ok('zone.account', label, `Zone ${zone.id} (${zone.status})`)]

  out.push(await checkWildcard(cf, zone.id, domain, secrets, wildcardOpts))

  try {
    const routes = await cf.listWorkerRoutes(zone.id)
    out.push(ok('zone.routes', 'Worker routes readable', `${routes.length} of 1,000 routes in use`))
  } catch (err) {
    out.push(fail('zone.routes', 'Worker routes readable', errorDetail(err, 'Cloudflare', secrets)))
  }
  return out
}

/** What Launch creates when the zone has no wildcard: the discard prefix, proxied (spike S2). */
const WILDCARD_RECORD = { type: 'AAAA', name: '*', content: '100::', proxied: true } as const

/**
 * `zone.wildcard`: a proxied `*.<domain>` passes; none at all is CREATED when the caller allows it
 * (see the header); a DNS-only one is left alone and fails with what to do about it.
 */
async function checkWildcard(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
  secrets: readonly string[],
  { createWildcard, effects }: { createWildcard: boolean; effects: CheckEffect[] }
): Promise<CredentialCheck> {
  const id = 'zone.wildcard'
  const label = 'Proxied wildcard DNS record'
  const wildcard = `*.${domain}`
  const wanted = `a proxied AAAA ${wildcard} → 100:: record`
  let records: Awaited<ReturnType<CloudflareClient['listDnsRecords']>>
  try {
    records = await cf.listDnsRecords(zoneId, wildcard)
  } catch (err) {
    return fail(id, label, errorDetail(err, 'Cloudflare', secrets))
  }
  const proxied = records.find(r => r.proxied)
  if (proxied) return ok(id, label, `${proxied.type} ${wildcard}`)
  const dnsOnly = records[0]
  if (dnsOnly) {
    return fail(
      id,
      label,
      `${wildcard} is a DNS-only ${dnsOnly.type} record (→ ${dnsOnly.content}), so requests never reach the Worker routes. Launch does not change a record it did not create: turn on its proxy (orange cloud) in the zone's DNS settings, or delete it and re-check so Launch creates ${wanted}.`
    )
  }
  if (!createWildcard) {
    return fail(id, label, `No ${wildcard} record. Save or re-check the token to create ${wanted}.`)
  }
  try {
    const created = await cf.createDnsRecord(zoneId, {
      ...WILDCARD_RECORD,
      comment: 'Launch: apps wildcard — Worker routes answer, not an origin',
    })
    effects.push({
      action: 'dns.wildcard.created',
      targetType: 'Zone',
      targetId: zoneId,
      after: {
        recordId: created.id,
        name: wildcard,
        type: 'AAAA',
        content: '100::',
        proxied: true,
      },
    })
    return ok(id, label, `Created proxied AAAA ${wildcard} → 100::`)
  } catch (err) {
    return fail(
      id,
      label,
      `${errorDetail(err, 'Cloudflare', secrets)} — Launch could not create ${wanted}. Give the token DNS Edit on the zone, or add the record yourself, then re-check.`
    )
  }
}

// ---- Neon ------------------------------------------------------------------------------------

/** How many projects the check reads: enough to see where the org's databases already live. */
const NEON_PROJECT_SAMPLE = 100

/** The `region_id` most of `projects` are in (the first seen wins a tie), or null for none. */
export function mostCommonRegion(
  projects: readonly Pick<NeonProject, 'region_id'>[]
): { regionId: string; count: number } | null {
  const counts = new Map<string, number>()
  for (const p of projects) {
    if (p.region_id) counts.set(p.region_id, (counts.get(p.region_id) ?? 0) + 1)
  }
  let best: { regionId: string; count: number } | null = null
  for (const [regionId, count] of counts) {
    if (!best || count > best.count) best = { regionId, count }
  }
  return best
}

export async function checkNeon(
  secret: CredentialPayload<'neon_org_api_key'>,
  settings: Partial<SetupSettings>,
  opts: VendorOptions = {}
): Promise<CheckOutcome> {
  const secrets = [secret.apiKey]
  const neon = new NeonClient(secret.apiKey, { fetch: opts.fetch })
  const checks: CredentialCheck[] = []
  const metadata: CredentialMetadata = {}
  const discovered: CheckOutcome['settings'] = {}

  let orgId = settings.neon_org_id ?? null
  let projects: NeonProject[]
  try {
    projects = await neon.listProjects({ limit: NEON_PROJECT_SAMPLE, orgId })
    checks.push(ok('projects.list', 'Projects readable'))
    const withOrg = projects.find(p => p.org_id)
    if (!orgId && withOrg?.org_id) {
      orgId = withOrg.org_id
      discovered.neon_org_id = orgId
    }
  } catch (err) {
    checks.push(fail('projects.list', 'Projects readable', errorDetail(err, 'Neon', secrets)))
    return { checks, metadata, settings: discovered }
  }

  if (orgId) {
    metadata.orgId = orgId
    checks.push(ok('org', 'Organization', orgId))
  } else {
    checks.push(
      warn(
        'org',
        'Organization',
        'The org has no projects to read its id from; enter the Neon organization id.'
      )
    )
  }

  checks.push(neonRegionCheck(settings.neon_region_id ?? null, projects, discovered))
  return { checks, metadata, settings: discovered }
}

/**
 * `region`: never from `GET /regions` (see the header). A pinned id Launch knows is `ok`; one it
 * does not is a `warning` — Neon adds regions, and it validates the id itself on the first create.
 * Unset, it pins where most of the org's projects are, else `DEFAULT_NEON_REGION`, and warns
 * either way so the admin looks before the first app (S3: the implicit default moves).
 */
function neonRegionCheck(
  pinned: string | null,
  projects: readonly NeonProject[],
  discovered: CheckOutcome['settings']
): CredentialCheck {
  const label = 'Region pinned'
  if (pinned) {
    const known = neonRegionLabel(pinned)
    return known
      ? ok('region', label, `${pinned} — ${known}`)
      : warn(
          'region',
          label,
          `${pinned} is not a Neon region id Launch recognises (${NEON_REGIONS.map(r => r.id).join(', ')}); Neon will validate it when the first project is created.`
        )
  }
  const common = mostCommonRegion(projects)
  const regionId = common?.regionId ?? DEFAULT_NEON_REGION
  discovered.neon_region_id = regionId
  const name = neonRegionLabel(regionId)
  const where = name ? `${regionId} (${name})` : regionId
  return warn(
    'region',
    label,
    common
      ? `Pinned ${where}, where ${common.count} of the org's ${projects.length} projects are. Change it before the first app if your apps belong elsewhere.`
      : `Pinned ${where}, Neon's default for new projects — the org has no project to learn a region from. Change it before the first app if your apps belong elsewhere.`
  )
}

// ---- Resend ----------------------------------------------------------------------------------

export async function checkResend(
  secret: CredentialPayload<'resend_api_key'>,
  settings: Partial<SetupSettings>,
  opts: VendorOptions = {}
): Promise<CheckOutcome> {
  const secrets = [secret.apiKey]
  const resend = new ResendClient(secret.apiKey, { fetch: opts.fetch })
  const checks: CredentialCheck[] = []
  const metadata: CredentialMetadata = {}

  try {
    await resend.listApiKeys()
    checks.push(ok('key.full_access', 'Full-access key'))
  } catch (err) {
    const restricted =
      err instanceof ResendApiError && (err.status === 401 || err.status === 403)
        ? ' — a sending-only key cannot mint per-app keys; Launch needs a full-access key.'
        : ''
    checks.push(
      fail(
        'key.full_access',
        'Full-access key',
        `${errorDetail(err, 'Resend', secrets)}${restricted}`
      )
    )
    return { checks, metadata, settings: {} }
  }

  const domain = notificationsDomainOf(settings)
  const label = 'Notifications domain verified'
  if (!domain) {
    checks.push(fail('domain.verified', label, 'Set the apps domain first.'))
    return { checks, metadata, settings: {} }
  }
  try {
    const found = (await resend.listDomains()).find(d => d.name === domain)
    if (!found) {
      checks.push(
        fail('domain.verified', label, `${domain} is not a Resend domain yet. Add and verify it.`)
      )
    } else {
      metadata.domainId = found.id
      metadata.domain = domain
      checks.push(
        found.status === 'verified'
          ? ok('domain.verified', label, domain)
          : found.status === 'pending' || found.status === 'not_started'
            ? warn('domain.verified', label, `${domain} is ${found.status}; verification pending.`)
            : fail('domain.verified', label, `${domain} is ${found.status}. Check its DNS records.`)
      )
    }
  } catch (err) {
    checks.push(fail('domain.verified', label, errorDetail(err, 'Resend', secrets)))
  }
  return { checks, metadata, settings: {} }
}

// ---- GitHub App ------------------------------------------------------------------------------

/**
 * The installation's required WRITE set (spec/03), by GitHub's permission keys. `actions_variables`
 * is the repository "Variables" permission S5 found missing (`LAUNCH_URL`).
 */
export const REQUIRED_GITHUB_WRITE_PERMISSIONS = [
  'administration',
  'contents',
  'workflows',
  'pull_requests',
  'actions',
  'environments',
  'actions_variables',
  'deployments',
  // Issue #9: a green ship posts the `launch/gate` check run on its head (and reads the runs).
  'checks',
] as const

/**
 * P3: what READ access coding sessions need on top — a session's PR is shipped when its CI is
 * green, which is the head commit's check runs (`checks`, write since issue #9) plus its combined
 * status (`statuses`).
 */
export const REQUIRED_GITHUB_READ_PERMISSIONS = ['statuses'] as const

/** Every required permission with the level it needs. */
export const REQUIRED_GITHUB_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>> = {
  ...Object.fromEntries(REQUIRED_GITHUB_WRITE_PERMISSIONS.map(p => [p, 'write'])),
  ...Object.fromEntries(REQUIRED_GITHUB_READ_PERMISSIONS.map(p => [p, 'read'])),
}

const PERMISSION_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 }

/** Required permissions the installation holds below the level each needs (write first, then read). */
export function missingGitHubPermissions(granted: GitHubPermissions): string[] {
  return Object.entries(REQUIRED_GITHUB_PERMISSIONS)
    .filter(([p, level]) => (PERMISSION_RANK[granted[p] ?? ''] ?? 0) < PERMISSION_RANK[level])
    .map(([p]) => p)
}

export async function checkGitHubApp(
  secret: CredentialPayload<'github_app'>,
  settings: Partial<SetupSettings>,
  opts: VendorOptions = {}
): Promise<CheckOutcome> {
  const secrets = [secret.privateKey]
  const checks: CredentialCheck[] = []
  const metadata: CredentialMetadata = { appId: secret.appId }

  try {
    const app = await getApp(secret, { fetch: opts.fetch })
    metadata.appSlug = app.slug
    checks.push(ok('app', 'App credentials', `${app.name} (${app.slug})`))
  } catch (err) {
    checks.push(fail('app', 'App credentials', errorDetail(err, 'GitHub', secrets)))
    return { checks, metadata, settings: {} }
  }

  const org = settings.github_org
  const label = 'Installed on the organization'
  if (!org) {
    checks.push(fail('installation', label, 'Set the GitHub organization first.'))
    return { checks, metadata, settings: {} }
  }
  let installation: Awaited<ReturnType<typeof listInstallations>>[number] | undefined
  try {
    installation = (await listInstallations(secret, { fetch: opts.fetch })).find(
      i => i.account?.login.toLowerCase() === org.toLowerCase()
    )
  } catch (err) {
    checks.push(fail('installation', label, errorDetail(err, 'GitHub', secrets)))
    return { checks, metadata, settings: {} }
  }
  if (!installation) {
    checks.push(
      fail('installation', label, `The app is not installed on ${org}. Install it there.`)
    )
    return { checks, metadata, settings: {} }
  }
  metadata.installationId = installation.id
  if (installation.suspended_at) {
    checks.push(fail('installation', label, `The installation on ${org} is suspended.`))
    return { checks, metadata, settings: {} }
  }
  checks.push(ok('installation', label, `Installation ${installation.id} on ${org}`))

  const missing = missingGitHubPermissions(installation.permissions ?? {})
  const missingWrite = missing.filter(p => REQUIRED_GITHUB_PERMISSIONS[p] === 'write')
  const missingRead = missing.filter(p => REQUIRED_GITHUB_PERMISSIONS[p] === 'read')
  const gaps = [
    ...(missingWrite.length ? [`Missing write on: ${missingWrite.join(', ')}.`] : []),
    ...(missingRead.length ? [`Missing read on: ${missingRead.join(', ')}.`] : []),
  ]
  checks.push(
    missing.length === 0
      ? ok('permissions', 'Required permissions')
      : fail(
          'permissions',
          'Required permissions',
          `${gaps.join(' ')} Grant them in the app's settings, then accept the new permissions on the installation.`
        )
  )
  return { checks, metadata, settings: {} }
}

// ---- Anthropic (P3) --------------------------------------------------------------------------

export const ANTHROPIC_API_BASE = 'https://api.anthropic.com'
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * The key coding sessions spend: `GET /v1/models` proves it authenticates and lists what it may
 * call; Claude Code's own default model (`DEFAULT_CLAUDE_CODE_MODEL`) must be among them,
 * matched by prefix because Anthropic's ids carry dates (`claude-sonnet-4-5-20250929`). A model
 * this key cannot see is a `warning` — the policy may name another — and a refused key `failed`.
 */
export async function checkAnthropic(
  secret: CredentialPayload<'anthropic_api_key'>,
  _settings: Partial<SetupSettings>,
  opts: VendorOptions & { model?: string } = {}
): Promise<CheckOutcome> {
  const secrets = [secret.apiKey]
  const checks: CredentialCheck[] = []
  const metadata: CredentialMetadata = {}
  const doFetch = opts.fetch ?? fetch
  const model = opts.model ?? DEFAULT_CLAUDE_CODE_MODEL
  let ids: string[]
  try {
    const res = await doFetch(`${ANTHROPIC_API_BASE}/v1/models?limit=100`, {
      headers: {
        'x-api-key': secret.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => ({}))) as {
      data?: { id?: unknown }[]
      error?: { message?: unknown }
    }
    if (!res.ok) {
      const message =
        typeof body.error?.message === 'string' ? body.error.message : `Anthropic ${res.status}`
      checks.push(
        fail('key', 'API key accepted', scrub(`Anthropic ${res.status}: ${message}`, secrets))
      )
      return { checks, metadata, settings: {} }
    }
    ids = (body.data ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string')
  } catch (err) {
    checks.push(fail('key', 'API key accepted', errorDetail(err, 'Anthropic', secrets)))
    return { checks, metadata, settings: {} }
  }
  metadata.models = ids.length
  metadata.fingerprint = await fingerprint(secret.apiKey)
  checks.push(ok('key', 'API key accepted', `${ids.length} models visible`))
  checks.push(
    ids.some(id => id === model || id.startsWith(`${model}-`))
      ? ok('model', 'Session model available', model)
      : warn(
          'model',
          'Session model available',
          `${model} is not among the models this key can call. Change the session policy's model, or use a key that has it.`
        )
  )
  return { checks, metadata, settings: {} }
}

// ---- OpenAI (§18.22-B) -----------------------------------------------------------------------

export const OPENAI_API_BASE = 'https://api.openai.com'

/**
 * The key Codex sessions on Launch's account spend: `GET /v1/models` proves it authenticates and
 * lists what it may call; Codex's model (`DEFAULT_CODEX_MODEL`, or the caller's) must be among
 * them, exactly or as a dated id. A model this key cannot see is a `warning` — the policy may name
 * another — and a refused key `failed`.
 */
export async function checkOpenAi(
  secret: CredentialPayload<'openai_api_key'>,
  _settings: Partial<SetupSettings>,
  opts: VendorOptions & { model?: string } = {}
): Promise<CheckOutcome> {
  const secrets = [secret.apiKey]
  const checks: CredentialCheck[] = []
  const metadata: CredentialMetadata = {}
  const doFetch = opts.fetch ?? fetch
  const model = opts.model ?? DEFAULT_CODEX_MODEL
  let ids: string[]
  try {
    const res = await doFetch(`${OPENAI_API_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${secret.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => ({}))) as {
      data?: { id?: unknown }[]
      error?: { message?: unknown }
    }
    if (!res.ok) {
      const message =
        typeof body.error?.message === 'string' ? body.error.message : `OpenAI ${res.status}`
      checks.push(
        fail('key', 'API key accepted', scrub(`OpenAI ${res.status}: ${message}`, secrets))
      )
      return { checks, metadata, settings: {} }
    }
    ids = (body.data ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string')
  } catch (err) {
    checks.push(fail('key', 'API key accepted', errorDetail(err, 'OpenAI', secrets)))
    return { checks, metadata, settings: {} }
  }
  metadata.models = ids.length
  metadata.fingerprint = await fingerprint(secret.apiKey)
  checks.push(ok('key', 'API key accepted', `${ids.length} models visible`))
  checks.push(
    ids.some(id => id === model || id.startsWith(`${model}-`))
      ? ok('model', 'Codex model available', model)
      : warn(
          'model',
          'Codex model available',
          `${model} is not among the models this key can call. Change the session policy's Codex model, or use a key that has it.`
        )
  )
  return { checks, metadata, settings: {} }
}

// ---- identity (read-only) --------------------------------------------------------------------

export function identityStatus(cfg: AppConfig): SetupIdentity {
  const providers = configuredProviders(cfg)
  const oidc = hasOidc(cfg)
    ? {
        issuer: cfg.OIDC_ISSUER as string,
        clientId: cfg.OIDC_CLIENT_ID as string,
        label: cfg.OIDC_LABEL ?? null,
        hasClientSecret: Boolean(cfg.OIDC_CLIENT_SECRET),
      }
    : null
  const checks: CredentialCheck[] = []
  checks.push(
    providers.length > 0
      ? ok('providers', 'Single sign-on configured', providers.join(', '))
      : warn(
          'providers',
          'Single sign-on configured',
          'No SSO provider: people sign in by magic link only. Set GOOGLE_*, MICROSOFT_* or OIDC_* on the Worker.'
        )
  )
  if (oidc) {
    checks.push(
      oidc.hasClientSecret
        ? ok('oidc', 'OIDC client', `${oidc.issuer} → ${cfg.APP_URL}/auth/oidc/callback`)
        : warn('oidc', 'OIDC client', 'OIDC_CLIENT_SECRET is not set; most issuers require it.')
    )
  }
  return { providers, oidc, oidcOnly: isOidcOnly(cfg), checks }
}

// ---- running a check -------------------------------------------------------------------------

/**
 * Run `kind`'s probes against its stored value; store the result. 404 when none is set. Only the
 * save and re-check actions call this, so it is the one place a probe may WRITE upstream (the
 * Cloudflare wildcard); what it wrote comes back as `effects` for the caller to audit.
 */
export async function runCredentialCheck(
  db: Database,
  cfg: AppConfig,
  kind: CredentialKind,
  userId: string | null,
  opts: VendorOptions = {}
): Promise<{ status: CredentialCheckStatus; checks: CredentialCheck[]; effects: CheckEffect[] }> {
  const stored = await getCredential(db, cfg, kind)
  if (!stored) throw new NotFoundError(`No ${kind} credential is set`, 'credential_not_set')
  const settings = await readSettings(db)
  const outcome = await probe(kind, stored.secret, settings, { ...opts, createWildcard: true })
  for (const [key, value] of Object.entries(outcome.settings)) {
    await putSetting(db, key as LaunchSettingKey, value, userId)
  }
  const status =
    (await recordCheck(db, kind, outcome.checks, outcome.metadata)) ??
    overallCheckStatus(outcome.checks)
  return { status, checks: outcome.checks, effects: outcome.effects ?? [] }
}

function probe(
  kind: CredentialKind,
  secret: CredentialPayload,
  settings: Partial<SetupSettings>,
  opts: CloudflareCheckOptions
): Promise<CheckOutcome> {
  switch (kind) {
    case 'cloudflare_api_token':
      return checkCloudflare(secret as CredentialPayload<typeof kind>, settings, opts)
    case 'neon_org_api_key':
      return checkNeon(secret as CredentialPayload<typeof kind>, settings, opts)
    case 'resend_api_key':
      return checkResend(secret as CredentialPayload<typeof kind>, settings, opts)
    case 'github_app':
      return checkGitHubApp(secret as CredentialPayload<typeof kind>, settings, opts)
    case 'anthropic_api_key':
      return checkAnthropic(secret as CredentialPayload<typeof kind>, settings, opts)
    case 'openai_api_key':
      return checkOpenAi(secret as CredentialPayload<typeof kind>, settings, opts)
  }
}

// ---- settings and overview -------------------------------------------------------------------

/** Every setting, `null` when unset (string values only — that is all the wizard writes). */
export async function readSettings(db: Database): Promise<SetupSettings> {
  const stored = await getSettings(db)
  return Object.fromEntries(
    SETUP_SETTING_KEYS.map(key => {
      const value = stored[key]
      return [key, typeof value === 'string' ? value : null]
    })
  ) as SetupSettings
}

/**
 * Apply a settings patch. Returns what actually changed, `{ key: { before, after } }`, for the
 * `setting.changed` audit row — values are non-secret by construction.
 */
export async function updateSettings(
  db: Database,
  patch: SetupSettingsUpdate,
  userId: string | null
): Promise<Record<string, { before: string | null; after: string | null }>> {
  const before = await readSettings(db)
  const changed: Record<string, { before: string | null; after: string | null }> = {}
  for (const key of SETUP_SETTING_KEYS) {
    if (!(key in patch)) continue
    const after = patch[key] ?? null
    if (after === before[key]) continue
    await putSetting(db, key, after, userId)
    changed[key] = { before: before[key], after }
  }
  return changed
}

/** The credential statuses, each with the email of whoever set it. */
export async function setupCredentials(db: Database): Promise<SetupCredential[]> {
  const statuses = await credentialStatus(db)
  const ids = [...new Set(statuses.map(s => s.setByUserId).filter((id): id is string => !!id))]
  const emails = new Map<string, string>()
  if (ids.length > 0) {
    const rows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, ids))
    for (const row of rows) emails.set(row.id, row.email)
  }
  return statuses.map(s => ({
    ...s,
    setByEmail: s.setByUserId ? (emails.get(s.setByUserId) ?? null) : null,
  }))
}

export async function setupCredential(
  db: Database,
  kind: CredentialKind
): Promise<SetupCredential> {
  const all = await setupCredentials(db)
  const found = all.find(c => c.kind === kind)
  if (!found) throw new Error(`credentialStatus returned no row for ${kind}`)
  return found
}

const STEP_KINDS: Partial<Record<SetupStep['id'], CredentialKind>> = {
  cloudflare: 'cloudflare_api_token',
  neon: 'neon_org_api_key',
  resend: 'resend_api_key',
  github: 'github_app',
}

function worst(statuses: readonly CredentialCheckStatus[]): CredentialCheckStatus {
  return overallCheckStatus(statuses.map(status => ({ id: '', label: '', status })))
}

/** Each step's dot, from the settings and the stored check results (never a fresh probe). */
export function stepStatuses(
  settings: SetupSettings,
  credentials: readonly SetupCredential[],
  identity: SetupIdentity,
  publicUrl: { status: CredentialCheckStatus | null } = { status: null }
): SetupStep[] {
  const byKind = new Map(credentials.map(c => [c.kind, c]))
  const credentialStep = (kind: CredentialKind): SetupStepStatus => {
    const c = byKind.get(kind)
    if (!c?.set) return 'todo'
    return c.lastCheckStatus ?? 'unchecked'
  }
  const domainStep = (): SetupStepStatus => {
    if (!settings.apps_domain || !settings.cloudflare_account_id) return 'todo'
    const zoneChecks = (byKind.get('cloudflare_api_token')?.lastCheck ?? []).filter(c =>
      c.id.startsWith('zone.')
    )
    return zoneChecks.length > 0 ? worst(zoneChecks.map(c => c.status)) : 'unchecked'
  }
  const steps = [
    'domain',
    'cloudflare',
    'neon',
    'resend',
    'github',
    'identity',
    'public_url',
  ] as const
  return steps.map(id => {
    if (id === 'domain') return { id, status: domainStep() }
    if (id === 'public_url') return { id, status: publicUrl.status ?? 'unchecked' }
    if (id === 'identity') return { id, status: worst(identity.checks.map(c => c.status)) }
    const kind = STEP_KINDS[id]
    return { id, status: kind ? credentialStep(kind) : 'todo' }
  })
}

/**
 * Everything the Settings pages over the setup API render (Connections, Coding agents, Kit
 * version). `tenantId` is the organisation the admin acts for (the session's, else the
 * deployment's one) — only the Coding agents card's count of connected
 * personal accounts reads it; without one that count is 0.
 */
export async function setupOverview(
  db: Database,
  cfg: AppConfig,
  tenantId: string | null = null,
  /** The Worker's bindings — what the Session sandbox section's availability is read from. */
  env?: SandboxHostBindings
): Promise<SetupOverview> {
  const [settings, credentials, publicUrl, templatePin, sessionSandbox] = await Promise.all([
    readSettings(db),
    setupCredentials(db),
    publicUrlOverview(db, cfg),
    templatePinStatus(db),
    sessionSandboxStatus(db, env, cfg),
  ])
  const sessionAgents = await sessionAgentsStatus(db, cfg, credentials, tenantId)
  const identity = identityStatus(cfg)
  return {
    steps: stepStatuses(settings, credentials, identity, publicUrl),
    publicUrl,
    settings,
    effectiveNotificationsDomain: notificationsDomainOf(settings),
    credentials: CREDENTIAL_KINDS.map(kind => {
      const found = credentials.find(c => c.kind === kind)
      if (!found) throw new Error(`credentialStatus returned no row for ${kind}`)
      return found
    }),
    identity,
    templatePin,
    sessionAgents,
    sessionSandbox,
  }
}
