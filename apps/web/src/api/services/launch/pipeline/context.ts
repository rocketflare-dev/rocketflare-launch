/**
 * What the create-an-app pipeline acts WITH (Launch P2): the platform settings (`launch_settings`)
 * and the four sealed credentials, resolved once per step into plain objects, plus the vendor
 * clients built from them.
 *
 * - **Loaded inside each step**, never carried between steps: a Workflow step result is persisted,
 *   and a credential must never be one. `loadPipelineVendors` unseals them for the step's lifetime.
 * - **Missing is not an error until it is used.** A teardown of a half-configured Launch still
 *   deletes what it can; `requireVendor` turns the absence into one sentence at the step that
 *   needed it.
 * - Tests hand a `PipelineVendors` in through the Workflow's `overrides` instead of storing
 *   credentials: `admin_credentials` has one row per kind for the whole database, and the setup
 *   suite owns it.
 */
import {
  type AppCreateRole,
  appCreateRoleSchema,
  DEFAULT_APP_CREATE_ROLE,
  DEFAULT_TEMPLATE_PIN,
  type TemplatePin,
  templatePinSchema,
} from '@launch/shared/launch-setup'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { ServiceUnavailableError } from '../../../utils/core/errors'
import { CloudflareClient } from '../cloudflare'
import { credentialStatus, getCredential, getSettings } from '../credentials'
import type { GitHubAppAuth } from '../github-app'
import { NeonClient } from '../neon'
import { ResendClient } from '../resend'

/** The non-secret settings the pipeline reads. `appsDomain` is the one it cannot start without. */
export interface PipelineSettings {
  appsDomain: string | null
  /** `notifications_domain`, else `notifications.<apps domain>`. */
  notificationsDomain: string | null
  templatePin: TemplatePin
  appCreateRole: AppCreateRole
  githubOrg: string | null
}

export interface PipelineVendors {
  settings: PipelineSettings
  cloudflare: { apiToken: string; accountId: string; zoneId: string | null } | null
  neon: { apiKey: string; orgId: string | null; regionId: string } | null
  resend: { apiKey: string; domainId: string | null } | null
  github: { auth: GitHubAppAuth; installationId: string | null; org: string } | null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function scalar(value: unknown): string | null {
  if (typeof value === 'number') return String(value)
  return text(value)
}

/** The settings alone — what `POST /api/apps` needs before any credential is touched. */
export async function loadPipelineSettings(db: Database): Promise<PipelineSettings> {
  const settings = await getSettings(db)
  const appsDomain = text(settings.apps_domain)
  const pin = templatePinSchema.safeParse(settings.template_pin)
  const role = appCreateRoleSchema.safeParse(settings.app_create_role)
  return {
    appsDomain,
    notificationsDomain:
      text(settings.notifications_domain) ?? (appsDomain ? `notifications.${appsDomain}` : null),
    templatePin: pin.success ? pin.data : DEFAULT_TEMPLATE_PIN,
    appCreateRole: role.success ? role.data : DEFAULT_APP_CREATE_ROLE,
    githubOrg: text(settings.github_org),
  }
}

/** Settings plus every credential that is set, unsealed. Server only; never a step result. */
export async function loadPipelineVendors(db: Database, cfg: AppConfig): Promise<PipelineVendors> {
  const [settings, raw, cloudflare, neon, resend, github] = await Promise.all([
    loadPipelineSettings(db),
    getSettings(db),
    getCredential(db, cfg, 'cloudflare_api_token'),
    getCredential(db, cfg, 'neon_org_api_key'),
    getCredential(db, cfg, 'resend_api_key'),
    getCredential(db, cfg, 'github_app'),
  ])
  const accountId = text(raw.cloudflare_account_id) ?? scalar(cloudflare?.metadata.accountId)
  const regionId = text(raw.neon_region_id)
  const org = settings.githubOrg
  return {
    settings,
    cloudflare:
      cloudflare && accountId
        ? {
            apiToken: cloudflare.secret.apiToken,
            accountId,
            zoneId: scalar(cloudflare.metadata.zoneId),
          }
        : null,
    neon:
      neon && regionId
        ? {
            apiKey: neon.secret.apiKey,
            orgId: text(raw.neon_org_id) ?? scalar(neon.metadata.orgId),
            regionId,
          }
        : null,
    resend: resend
      ? { apiKey: resend.secret.apiKey, domainId: scalar(resend.metadata.domainId) }
      : null,
    github:
      github && org
        ? {
            auth: github.secret,
            installationId:
              scalar(github.metadata.installationId) ?? scalar(github.metadata.installation_id),
            org,
          }
        : null,
  }
}

const SETUP_HINT: Record<'cloudflare' | 'neon' | 'resend' | 'github', string> = {
  cloudflare: 'Connect Cloudflare (token and account id) in Setup',
  neon: 'Connect Neon (key and pinned region) in Setup',
  resend: 'Connect Resend in Setup',
  github: 'Connect the GitHub App (and its organisation) in Setup',
}

/** The vendor's resolved credentials, or a 503 naming the Setup step to finish. */
export function requireVendor<K extends 'cloudflare' | 'neon' | 'resend' | 'github'>(
  vendors: PipelineVendors,
  kind: K
): NonNullable<PipelineVendors[K]> {
  const value = vendors[kind]
  if (!value) throw new ServiceUnavailableError(SETUP_HINT[kind], `${kind}_not_configured`)
  return value as NonNullable<PipelineVendors[K]>
}

/** The apps domain, or a 503 — every name and host is built from it. */
export function requireAppsDomain(settings: PipelineSettings): string {
  if (!settings.appsDomain) {
    throw new ServiceUnavailableError(
      'Set the apps domain in Setup first',
      'apps_domain_not_configured'
    )
  }
  return settings.appsDomain
}

/**
 * What `POST /api/apps` checks before it writes anything: the settings and the credentials a
 * launch cannot get past step 2 without (value-free — `credentialStatus` never unseals). Resend is
 * not among them: email is non-blocking. Returns the missing pieces, `[]` when ready.
 */
export async function missingSetup(db: Database, settings: PipelineSettings): Promise<string[]> {
  const [raw, credentials] = await Promise.all([getSettings(db), credentialStatus(db)])
  const set = new Set(credentials.filter(c => c.set).map(c => c.kind))
  const cloudflareAccount =
    text(raw.cloudflare_account_id) ??
    scalar(credentials.find(c => c.kind === 'cloudflare_api_token')?.metadata.accountId)
  return [
    settings.appsDomain ? null : 'the apps domain',
    set.has('cloudflare_api_token') && cloudflareAccount ? null : 'Cloudflare',
    set.has('neon_org_api_key') && text(raw.neon_region_id) ? null : 'Neon (key and region)',
    set.has('github_app') && settings.githubOrg ? null : 'the GitHub App (and organisation)',
  ].filter((m): m is string => m !== null)
}

export interface ClientOptions {
  /** Neon's 423 / operation-poll wait; tests pass one that resolves at once. */
  sleep?: (ms: number) => Promise<void>
}

export function cloudflareClient(vendors: PipelineVendors) {
  const cf = requireVendor(vendors, 'cloudflare')
  return { client: new CloudflareClient(cf.apiToken), accountId: cf.accountId, zoneId: cf.zoneId }
}

export function neonClient(vendors: PipelineVendors, opts: ClientOptions = {}) {
  const neon = requireVendor(vendors, 'neon')
  return {
    client: new NeonClient(neon.apiKey, opts.sleep ? { sleep: opts.sleep } : {}),
    orgId: neon.orgId,
    regionId: neon.regionId,
  }
}

export function resendClient(vendors: PipelineVendors) {
  const resend = requireVendor(vendors, 'resend')
  return { client: new ResendClient(resend.apiKey), domainId: resend.domainId }
}
