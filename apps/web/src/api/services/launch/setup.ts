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
 * **What is deliberately NOT probed.** Cloudflare write scope: nothing proves "can create a Worker"
 * short of creating one, so it is reported as a standing `warning` ("write scope unverified") rather
 * than a green light the check did not earn.
 */
import {
  CREDENTIAL_KINDS,
  type CredentialCheck,
  type CredentialCheckStatus,
  type CredentialKind,
  type CredentialMetadata,
  type CredentialPayload,
  LAUNCH_SETTING_KEYS,
  type LaunchSettingKey,
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
import { NeonApiError, NeonClient } from './neon'
import { ResendApiError, ResendClient } from './resend'

/** What every vendor call takes, so tests hand in a fake and nothing reaches the network. */
export interface VendorOptions {
  fetch?: typeof fetch
}

export interface CheckOutcome {
  checks: CredentialCheck[]
  metadata: CredentialMetadata
  settings: Partial<Record<LaunchSettingKey, string>>
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

export async function checkCloudflare(
  secret: CredentialPayload<'cloudflare_api_token'>,
  settings: Partial<SetupSettings>,
  opts: VendorOptions = {}
): Promise<CheckOutcome> {
  const secrets = [secret.apiToken]
  const checks: CredentialCheck[] = []
  const metadata: CredentialMetadata = {}
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

  checks.push(...(await checkZone(cf, accountId, domain, metadata, secrets)))

  checks.push(
    warn(
      'token.write',
      'Write permissions',
      'Write scope unverified: Launch cannot prove it may create Workers, KV, Queues, R2, DNS or routes without creating one. Check the token has Workers Scripts, KV, Queues, R2 and Workflows (Edit) on the account and DNS + Workers Routes (Edit) on the zone.'
    )
  )
  return { checks, metadata, settings: {} }
}

/** The zone probes (spec/04): in this account, a proxied `*` record, routes readable. */
async function checkZone(
  cf: CloudflareClient,
  accountId: string,
  domain: string | null | undefined,
  metadata: CredentialMetadata,
  secrets: readonly string[]
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

  const wildcard = `*.${domain}`
  try {
    const records = await cf.listDnsRecords(zone.id, wildcard)
    const proxied = records.find(r => r.proxied)
    out.push(
      proxied
        ? ok('zone.wildcard', 'Proxied wildcard DNS record', `${proxied.type} ${wildcard}`)
        : records.length > 0
          ? fail(
              'zone.wildcard',
              'Proxied wildcard DNS record',
              `${wildcard} exists but is DNS-only; turn the proxy on so Worker routes answer.`
            )
          : fail(
              'zone.wildcard',
              'Proxied wildcard DNS record',
              `No ${wildcard} record. Add a proxied AAAA ${wildcard} → 100:: record.`
            )
    )
  } catch (err) {
    out.push(
      fail('zone.wildcard', 'Proxied wildcard DNS record', errorDetail(err, 'Cloudflare', secrets))
    )
  }

  try {
    const routes = await cf.listWorkerRoutes(zone.id)
    out.push(ok('zone.routes', 'Worker routes readable', `${routes.length} of 1,000 routes in use`))
  } catch (err) {
    out.push(fail('zone.routes', 'Worker routes readable', errorDetail(err, 'Cloudflare', secrets)))
  }
  return out
}

// ---- Neon ------------------------------------------------------------------------------------

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
  try {
    const projects = await neon.listProjects({ limit: 1, orgId })
    checks.push(ok('projects.list', 'Projects readable'))
    if (!orgId && projects[0]?.org_id) {
      orgId = projects[0].org_id
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

  try {
    const regions = await neon.listRegions(orgId)
    const pinned = settings.neon_region_id
    if (pinned) {
      checks.push(
        regions.some(r => r.region_id === pinned)
          ? ok('region', 'Region pinned', pinned)
          : fail(
              'region',
              'Region pinned',
              `${pinned} is not available to this org. Available: ${regions.map(r => r.region_id).join(', ') || 'none'}.`
            )
      )
    } else {
      // S3: the implicit default moves between creates, so pin whatever it is today, once.
      const fallback = regions.find(r => r.default) ?? regions[0]
      if (fallback) {
        discovered.neon_region_id = fallback.region_id
        checks.push(
          warn(
            'region',
            'Region pinned',
            `Pinned ${fallback.region_id} (Neon's current default). Change it before the first app if your apps belong elsewhere.`
          )
        )
      } else {
        checks.push(fail('region', 'Region pinned', 'Neon listed no regions for this org.'))
      }
    }
  } catch (err) {
    checks.push(fail('region', 'Region pinned', errorDetail(err, 'Neon', secrets)))
  }
  return { checks, metadata, settings: discovered }
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
export const REQUIRED_GITHUB_PERMISSIONS = [
  'administration',
  'contents',
  'workflows',
  'pull_requests',
  'actions',
  'environments',
  'actions_variables',
  'deployments',
] as const

const PERMISSION_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 }

/** Required permissions the installation holds below `write`. */
export function missingGitHubPermissions(granted: GitHubPermissions): string[] {
  return REQUIRED_GITHUB_PERMISSIONS.filter(
    p => (PERMISSION_RANK[granted[p] ?? ''] ?? 0) < PERMISSION_RANK.write
  )
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
  checks.push(
    missing.length === 0
      ? ok('permissions', 'Required permissions (write)')
      : fail(
          'permissions',
          'Required permissions (write)',
          `Missing write on: ${missing.join(', ')}. Grant them in the app's settings, then accept the new permissions on the installation.`
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

/** Run `kind`'s probes against its stored value; store the result. 404 when none is set. */
export async function runCredentialCheck(
  db: Database,
  cfg: AppConfig,
  kind: CredentialKind,
  userId: string | null,
  opts: VendorOptions = {}
): Promise<{ status: CredentialCheckStatus; checks: CredentialCheck[] }> {
  const stored = await getCredential(db, cfg, kind)
  if (!stored) throw new NotFoundError(`No ${kind} credential is set`, 'credential_not_set')
  const settings = await readSettings(db)
  const outcome = await probe(kind, stored.secret, settings, opts)
  for (const [key, value] of Object.entries(outcome.settings)) {
    await putSetting(db, key as LaunchSettingKey, value, userId)
  }
  const status =
    (await recordCheck(db, kind, outcome.checks, outcome.metadata)) ??
    overallCheckStatus(outcome.checks)
  return { status, checks: outcome.checks }
}

function probe(
  kind: CredentialKind,
  secret: CredentialPayload,
  settings: Partial<SetupSettings>,
  opts: VendorOptions
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
  }
}

// ---- settings and overview -------------------------------------------------------------------

/** Every setting, `null` when unset (string values only — that is all the wizard writes). */
export async function readSettings(db: Database): Promise<SetupSettings> {
  const stored = await getSettings(db)
  return Object.fromEntries(
    LAUNCH_SETTING_KEYS.map(key => {
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
  for (const key of LAUNCH_SETTING_KEYS) {
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
  identity: SetupIdentity
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
  return (['domain', 'cloudflare', 'neon', 'resend', 'github', 'identity'] as const).map(id => {
    if (id === 'domain') return { id, status: domainStep() }
    if (id === 'identity') return { id, status: worst(identity.checks.map(c => c.status)) }
    const kind = STEP_KINDS[id]
    return { id, status: kind ? credentialStep(kind) : 'todo' }
  })
}

export async function setupOverview(db: Database, cfg: AppConfig): Promise<SetupOverview> {
  const [settings, credentials] = await Promise.all([readSettings(db), setupCredentials(db)])
  const identity = identityStatus(cfg)
  return {
    steps: stepStatuses(settings, credentials, identity),
    settings,
    effectiveNotificationsDomain: notificationsDomainOf(settings),
    credentials: CREDENTIAL_KINDS.map(kind => {
      const found = credentials.find(c => c.kind === kind)
      if (!found) throw new Error(`credentialStatus returned no row for ${kind}`)
      return found
    }),
    identity,
  }
}
