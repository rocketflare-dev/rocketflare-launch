/**
 * Launch setup contracts (spec/03, spec/04): the platform credentials Launch holds sealed in
 * `admin_credentials`, the payload each kind accepts, the check result every vendor probe
 * returns, and the non-secret settings in `launch_settings`. A credential VALUE never appears in a
 * response schema here — `credentialStatusSchema` is deliberately value-free.
 *
 * Below the storage contracts are the setup API's own (`/api/admin/setup`): the settings body, the
 * overview every step renders from, and the result of a put or a check.
 */
import { z } from 'zod'

/** One row each in `admin_credentials` (`kind` is unique). Mirrors the pg enum — append-only. */
export const CREDENTIAL_KINDS = [
  'cloudflare_api_token',
  'neon_org_api_key',
  'resend_api_key',
  'github_app',
] as const
export const credentialKindSchema = z.enum(CREDENTIAL_KINDS)
export type CredentialKind = z.infer<typeof credentialKindSchema>

export const CREDENTIAL_CHECK_STATUSES = ['ok', 'warning', 'failed'] as const
export const credentialCheckStatusSchema = z.enum(CREDENTIAL_CHECK_STATUSES)
export type CredentialCheckStatus = z.infer<typeof credentialCheckStatusSchema>

/** One probe of a credential: `{ id: 'zone.account', label, status, detail }`. */
export const credentialCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: credentialCheckStatusSchema,
  detail: z.string().optional(),
})
export type CredentialCheck = z.infer<typeof credentialCheckSchema>

/** `admin_credentials.last_check` — every probe from the most recent run. */
export const credentialLastCheckSchema = z.array(credentialCheckSchema)
export type CredentialLastCheck = z.infer<typeof credentialLastCheckSchema>

/**
 * `admin_credentials.metadata` — non-secret facts only (account id, app id, installation id, a
 * fingerprint). Scalars, so nothing structured can smuggle a value in.
 */
export const credentialMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)
export type CredentialMetadata = z.infer<typeof credentialMetadataSchema>

/** The secret JSON each kind seals. Account ids, orgs and domains are SETTINGS, not secrets. */
export const cloudflareCredentialSchema = z.object({ apiToken: z.string().trim().min(20) })
export const neonCredentialSchema = z.object({ apiKey: z.string().trim().min(20) })
export const resendCredentialSchema = z.object({ apiKey: z.string().trim().startsWith('re_') })
export const githubAppCredentialSchema = z.object({
  appId: z.coerce.string().regex(/^\d+$/, 'The numeric GitHub App id'),
  /** The PEM GitHub issues (PKCS#1 `BEGIN RSA PRIVATE KEY`) or a PKCS#8 one. */
  privateKey: z.string().trim().includes('PRIVATE KEY'),
})

export const credentialPayloadSchemas = {
  cloudflare_api_token: cloudflareCredentialSchema,
  neon_org_api_key: neonCredentialSchema,
  resend_api_key: resendCredentialSchema,
  github_app: githubAppCredentialSchema,
} as const satisfies Record<CredentialKind, z.ZodTypeAny>

export type CredentialPayload<K extends CredentialKind = CredentialKind> = z.infer<
  (typeof credentialPayloadSchemas)[K]
>

/** What the API may say about a credential: whether, when, by whom, how it checked. No value. */
export const credentialStatusSchema = z.object({
  kind: credentialKindSchema,
  set: z.boolean(),
  setAt: z.coerce.date().nullable(),
  setByUserId: z.string().uuid().nullable(),
  rotatedAt: z.coerce.date().nullable(),
  metadata: credentialMetadataSchema,
  lastCheckStatus: credentialCheckStatusSchema.nullable(),
  lastCheck: credentialLastCheckSchema.nullable(),
  lastCheckedAt: z.coerce.date().nullable(),
})
export type CredentialStatus = z.infer<typeof credentialStatusSchema>

/** `launch_settings` keys — non-secret platform configuration, one row each. */
export const LAUNCH_SETTING_KEYS = [
  'apps_domain',
  'cloudflare_account_id',
  'neon_org_id',
  'neon_region_id',
  'notifications_domain',
  'github_org',
] as const
export const launchSettingKeySchema = z.enum(LAUNCH_SETTING_KEYS)
export type LaunchSettingKey = z.infer<typeof launchSettingKeySchema>

/**
 * Setting VALUES, validated per key. Everything here is non-secret and may be shown, audited
 * (`setting.changed` carries before and after) and logged.
 */
const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'A domain name, e.g. company-apps.com'
  )

export const launchSettingValueSchemas = {
  apps_domain: hostnameSchema,
  /** Cloudflare account ids are 32 lower-case hex characters. */
  cloudflare_account_id: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{32}$/, 'The 32-character Cloudflare account id'),
  /** `org-…`; discovered by the Neon check when not set by hand. */
  neon_org_id: z
    .string()
    .trim()
    .regex(/^org-[a-z0-9-]+$/, 'A Neon organization id, e.g. org-cool-sun-12345678'),
  /** Pinned once (S3: Neon's default region is not stable), e.g. `aws-us-east-2`. */
  neon_region_id: z
    .string()
    .trim()
    .regex(/^[a-z]+-[a-z0-9-]+$/, 'A Neon region id, e.g. aws-us-east-2'),
  /** Defaults to `notifications.<apps domain>` (spec/04) when unset. */
  notifications_domain: hostnameSchema,
  /** A GitHub organization login. */
  github_org: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'A GitHub organization login'),
} as const satisfies Record<LaunchSettingKey, z.ZodTypeAny>

/** `PUT /api/admin/setup/settings` — any subset of the keys; `null` clears one. */
export const setupSettingsUpdateSchema = z
  .object(
    Object.fromEntries(
      LAUNCH_SETTING_KEYS.map(key => [key, launchSettingValueSchemas[key].nullable().optional()])
    ) as {
      [K in LaunchSettingKey]: z.ZodOptional<z.ZodNullable<(typeof launchSettingValueSchemas)[K]>>
    }
  )
  .strict()
  .refine(body => Object.keys(body).length > 0, 'Send at least one setting')
export type SetupSettingsUpdate = z.infer<typeof setupSettingsUpdateSchema>

/** Every setting, `null` when unset. */
export const setupSettingsSchema = z.object(
  Object.fromEntries(LAUNCH_SETTING_KEYS.map(key => [key, z.string().nullable()])) as {
    [K in LaunchSettingKey]: z.ZodNullable<z.ZodString>
  }
)
export type SetupSettings = z.infer<typeof setupSettingsSchema>

/** A credential as the setup page sees it: the value-free status, plus who set it. */
export const setupCredentialSchema = credentialStatusSchema.extend({
  setByEmail: z.string().nullable(),
})
export type SetupCredential = z.infer<typeof setupCredentialSchema>

/** The wizard's steps, in order. `identity` is read-only: it reflects the Worker's `OIDC_*`. */
export const SETUP_STEP_IDS = [
  'domain',
  'cloudflare',
  'neon',
  'resend',
  'github',
  'identity',
] as const
export const setupStepIdSchema = z.enum(SETUP_STEP_IDS)
export type SetupStepId = z.infer<typeof setupStepIdSchema>

/**
 * A step's state for its dot: `todo` (nothing entered), `unchecked` (entered, never probed), or the
 * worst probe of its last check.
 */
export const SETUP_STEP_STATUSES = ['todo', 'unchecked', 'ok', 'warning', 'failed'] as const
export const setupStepStatusSchema = z.enum(SETUP_STEP_STATUSES)
export type SetupStepStatus = z.infer<typeof setupStepStatusSchema>

export const setupStepSchema = z.object({
  id: setupStepIdSchema,
  status: setupStepStatusSchema,
})
export type SetupStep = z.infer<typeof setupStepSchema>

/** Launch's own upstream sign-in (spec/05), read from the Worker's config — never a secret. */
export const setupIdentitySchema = z.object({
  providers: z.array(z.string()),
  oidc: z
    .object({
      issuer: z.string(),
      clientId: z.string(),
      label: z.string().nullable(),
      hasClientSecret: z.boolean(),
    })
    .nullable(),
  oidcOnly: z.boolean(),
  checks: credentialLastCheckSchema,
})
export type SetupIdentity = z.infer<typeof setupIdentitySchema>

/** `GET /api/admin/setup` — everything the page renders. Never a credential value. */
export const setupOverviewSchema = z.object({
  steps: z.array(setupStepSchema),
  settings: setupSettingsSchema,
  /** `notifications_domain`, or `notifications.<apps_domain>` when that is unset. */
  effectiveNotificationsDomain: z.string().nullable(),
  credentials: z.array(setupCredentialSchema),
  identity: setupIdentitySchema,
})
export type SetupOverview = z.infer<typeof setupOverviewSchema>

/** `PUT /credentials/:kind` and `POST /credentials/:kind/check` — the stored status and the probes. */
export const setupCheckResponseSchema = z.object({
  credential: setupCredentialSchema,
  status: credentialCheckStatusSchema,
  checks: credentialLastCheckSchema,
})
export type SetupCheckResponse = z.infer<typeof setupCheckResponseSchema>

/** `DELETE /credentials/:kind`. */
export const setupRemoveResponseSchema = z.object({ removed: z.literal(true) })
