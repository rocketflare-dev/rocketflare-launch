/**
 * Launch setup contracts (spec/03, spec/04): the platform credentials Launch holds sealed in
 * `admin_credentials`, the payload each kind accepts, the check result every vendor probe
 * returns, and the non-secret settings in `launch_settings`. A credential VALUE never appears in a
 * response schema here — `credentialStatusSchema` is deliberately value-free.
 *
 * Slice 1c owns this file and adds the setup API contracts beside what is here.
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
