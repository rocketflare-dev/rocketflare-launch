/**
 * Launch setup contracts (spec/03, spec/04): the platform credentials Launch holds sealed in
 * `admin_credentials`, the payload each kind accepts, the check result every vendor probe
 * returns, and the non-secret settings in `launch_settings`. A credential VALUE never appears in a
 * response schema here — `credentialStatusSchema` is deliberately value-free.
 *
 * Below the storage contracts are the setup API's own (`/api/platform/setup`): the settings body, the
 * overview every step renders from, and the result of a put or a check.
 */
import { z } from 'zod'

/** One row each in `admin_credentials` (`kind` is unique). Mirrors the pg enum — append-only. */
export const CREDENTIAL_KINDS = [
  'cloudflare_api_token',
  'neon_org_api_key',
  'resend_api_key',
  'github_app',
  /**
   * P3: the Anthropic key coding sessions spend. It never enters a sandbox — the model proxy
   * (`services/sessions/egress/anthropic.ts`) swaps it in for the sandbox's placeholder. Unset,
   * sessions fall back to the Worker's `ANTHROPIC_API_KEY` secret.
   */
  'anthropic_api_key',
  /**
   * §18.22: the OpenAI key Codex sessions on Launch's account spend — swapped in at the egress
   * like the Anthropic key, never in a sandbox. Its check and setup card are Stream B's
   * (`services/launch/setup.ts` answers "not checked" until then).
   */
  'openai_api_key',
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

/** An Anthropic API key (`sk-ant-…`); an admin key (`sk-ant-admin…`) cannot call the Messages API. */
export const anthropicCredentialSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .startsWith('sk-ant-')
    .refine(key => !key.startsWith('sk-ant-admin'), 'An API key, not an admin key'),
})

/** An OpenAI API key (`sk-…`, project keys `sk-proj-…`). */
export const openAiCredentialSchema = z.object({
  apiKey: z.string().trim().startsWith('sk-').min(20),
})

export const credentialPayloadSchemas = {
  cloudflare_api_token: cloudflareCredentialSchema,
  neon_org_api_key: neonCredentialSchema,
  resend_api_key: resendCredentialSchema,
  github_app: githubAppCredentialSchema,
  anthropic_api_key: anthropicCredentialSchema,
  openai_api_key: openAiCredentialSchema,
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

/**
 * The settings the setup wizard edits: plain strings, one field each on its cards. Every key here
 * is also a `LAUNCH_SETTING_KEYS` key.
 */
export const SETUP_SETTING_KEYS = [
  'apps_domain',
  'cloudflare_account_id',
  'neon_org_id',
  'neon_region_id',
  'notifications_domain',
  'github_org',
] as const
export const setupSettingKeySchema = z.enum(SETUP_SETTING_KEYS)
export type SetupSettingKey = z.infer<typeof setupSettingKeySchema>

/**
 * `launch_settings` keys — non-secret platform configuration, one row each. The wizard's strings,
 * plus two that the pipeline reads with a CODE default and nobody has to set (P2):
 *
 * - `template_pin` — `{ repo, tag?, commit }`, the kit a new app is cut from (`DEFAULT_TEMPLATE_PIN`):
 *   a release tag, or an unreleased commit (no tag). Set on the Setup page's Kit version card.
 * - `app_create_role` — the lowest tenant role that may create an app (`DEFAULT_APP_CREATE_ROLE`).
 *
 * And P3's two (`@launch/shared/launch-sessions`):
 *
 * - `session_policy` — the coding-session budgets and limits (`DEFAULT_SESSION_POLICY`), read
 *   through `resolveSessionPolicy` and snapshotted on each session at create.
 * - `sessions_paused` — `true` while an operator has drained sessions for a deploy; new sessions
 *   answer 409 until it is cleared.
 *
 * And one Launch writes itself:
 *
 * - `public_url_check` — the last "is `APP_URL` reachable from the internet" result
 *   (`publicUrlCheckSchema`), the cache `POST /api/apps` reads rather than probing every time.
 */
export const LAUNCH_SETTING_KEYS = [
  ...SETUP_SETTING_KEYS,
  'template_pin',
  'app_create_role',
  'session_policy',
  'sessions_paused',
  'public_url_check',
] as const
export const launchSettingKeySchema = z.enum(LAUNCH_SETTING_KEYS)
export type LaunchSettingKey = z.infer<typeof launchSettingKeySchema>

const kitRepoSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'owner/name')

/**
 * `launch_settings.template_pin` — the ONE source of the kit a new app is cut from (absent:
 * `DEFAULT_TEMPLATE_PIN`). Two kinds:
 *
 * - a **release pin** (`tag` set): the scaffold job clones `repo` at `tag` and refuses to go on
 *   unless the tag resolves to `commit` — a moved tag is a different kit.
 * - a **commit pin** (no `tag`): an unreleased commit on a branch, for trying a kit fix before it
 *   is released. The job fetches exactly `commit` and checks HEAD is it.
 *
 * A row stored before commit pins existed (always with a tag) parses unchanged.
 */
export const templatePinSchema = z.object({
  repo: kitRepoSchema,
  tag: z.string().trim().min(1).max(100).optional(),
  commit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{40}$/, 'A full 40-character commit SHA'),
})
export type TemplatePin = z.infer<typeof templatePinSchema>

/** A pin with no release tag: an unreleased commit. */
export function isCommitPin(pin: { tag?: string | null }): boolean {
  return !pin.tag
}

/** The short SHA a commit is shown by (7 characters, as git abbreviates). */
export function shortSha(commit: string): string {
  return commit.slice(0, 7)
}

/**
 * How a pin reads in a label ("kit <label>", "Re-scaffold from kit <label>"): the tag, or
 * `@<short sha>` for an unreleased commit.
 */
export function templatePinLabel(pin: { tag?: string | null; commit: string }): string {
  return pin.tag ? pin.tag : `@${shortSha(pin.commit)}`
}

/** The git ref a pin names — the tag, else the commit (`apps.template_ref`). */
export function templatePinRef(pin: { tag?: string | null; commit: string }): string {
  return pin.tag ? pin.tag : pin.commit
}

/**
 * `PUT /api/platform/setup/template-pin` — what the admin chose; the SERVER resolves it to a full
 * pin through GitHub (`repo` defaults to the current pin's):
 *
 * - `{ kind: 'tag', tag }` — a release; the tag is resolved to its commit (an annotated tag
 *   dereferenced), 422 `kit_ref_not_found` when the repo has no such tag.
 * - `{ kind: 'commit', ref }` — an unreleased commit: a SHA (7–40 hex) or a branch name (`main`
 *   is "latest main"), resolved to the full SHA; 422 `kit_ref_not_found` when it is not in the repo.
 */
export const templatePinRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tag'),
    repo: kitRepoSchema.optional(),
    tag: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'A tag name'),
  }),
  z.object({
    kind: z.literal('commit'),
    repo: kitRepoSchema.optional(),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'A commit SHA or a branch name'),
  }),
])
export type TemplatePinRequest = z.infer<typeof templatePinRequestSchema>

/** The kit pin as the Setup page sees it: what new apps use, and whether it is the code default. */
export const templatePinStatusSchema = z.object({
  pin: templatePinSchema,
  /** No `launch_settings.template_pin` row: `DEFAULT_TEMPLATE_PIN` applies. */
  isDefault: z.boolean(),
  default: templatePinSchema,
})
export type TemplatePinStatus = z.infer<typeof templatePinStatusSchema>

/** `GET /api/platform/setup/template-pin/tags[?repo=]` — the repo's recent tags, newest first. */
export const kitTagsQuerySchema = z.object({ repo: kitRepoSchema.optional() })
export const kitTagsResponseSchema = z.object({
  repo: z.string(),
  tags: z.array(z.object({ name: z.string(), commit: z.string() })),
})
export type KitTagsResponse = z.infer<typeof kitTagsResponseSchema>

/**
 * Rocketflare kit 0.16.0: 0.15.0 (the release P2 was built against) plus the rename fixes a
 * hyphenated slug needs: the evals script's identifiers (0.15.1), the API-key prefix, the
 * `rocketflare-dev/` references and the test Compose project (0.15.2); and CI a copy can pass —
 * the default-plugins gate kit-only, one gate per commit, the neon run fixed (0.15.3); the
 * deploy's parity step on a shallow checkout (0.15.4); migrations as a role without CREATEDB
 * (0.15.5); a magic link that opening does not spend (0.15.6); and `pnpm test:ephemeral` — the
 * suite on a throwaway Neon gate branch, no Docker — which Launch's ship gate runs (0.15.7,
 * issue #1); and the kit's own tests moved to `apps/web/tests/kit-only/`, which the rename deletes,
 * so a copy's gate no longer fails on the kit's version chain once the app releases (0.15.8); and
 * `pnpm gate` — lint, typecheck, test, build defined once, a copy's one CI job, with `pnpm test`
 * the one full run (on a Neon gate branch when `TEST_DATABASE_BRANCH` is set) and the kit's own
 * workflows (`kit.yml`, `plugin-ci.yml`, `notify-plugins.yml`) stripped by the rename — whose
 * steps Launch's ship gate runs (0.16.0, rocketflare-launch#2).
 */
export const DEFAULT_TEMPLATE_PIN: TemplatePin = {
  repo: 'rocketflare-dev/rocketflare',
  tag: '0.16.0',
  commit: 'bc89e0e3ca6f24bb778adcd181ee9f030243af16',
}

/**
 * `launch_settings.app_create_role`: the lowest tenant role that may create an app. `admin` (the
 * default) means admins and above — `manage App`; `member` opens it to everyone.
 */
export const APP_CREATE_ROLES = ['owner', 'admin', 'member'] as const
export const appCreateRoleSchema = z.enum(APP_CREATE_ROLES)
export type AppCreateRole = z.infer<typeof appCreateRoleSchema>
export const DEFAULT_APP_CREATE_ROLE: AppCreateRole = 'admin'

/**
 * Whether a tenant role meets `app_create_role`. `support` (platform staff inside a tenant) ranks
 * with `admin`, as it does in the ability matrix, where both `manage App`.
 */
export function meetsAppCreateRole(role: string, required: AppCreateRole): boolean {
  const rank: Record<string, number> = { owner: 3, admin: 2, support: 2, member: 1 }
  return (rank[role] ?? 0) >= rank[required]
}

/**
 * The wizard's setting VALUES, validated per key. Everything here is non-secret and may be shown, audited
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
} as const satisfies Record<SetupSettingKey, z.ZodTypeAny>

/**
 * The Neon regions a project can be created in (neon.com/docs/introduction/regions, checked
 * 2026-09-28). A static list because `GET /regions` answers an ORGANIZATION key — the only kind
 * Launch holds — with 404 "not allowed for organization API keys". The setup check validates a
 * pinned `neon_region_id` against it (an id missing here is a warning, not a failure: Neon itself
 * decides on the first create) and the wizard offers it as a select with a free-text fallback.
 */
export const NEON_REGIONS = [
  { id: 'aws-us-east-1', label: 'AWS US East (N. Virginia)' },
  { id: 'aws-us-east-2', label: 'AWS US East (Ohio)' },
  { id: 'aws-us-west-2', label: 'AWS US West (Oregon)' },
  { id: 'aws-eu-central-1', label: 'AWS Europe (Frankfurt)' },
  { id: 'aws-eu-west-2', label: 'AWS Europe (London)' },
  { id: 'aws-ap-southeast-1', label: 'AWS Asia Pacific (Singapore)' },
  { id: 'aws-ap-southeast-2', label: 'AWS Asia Pacific (Sydney)' },
  { id: 'aws-sa-east-1', label: 'AWS South America (São Paulo)' },
  { id: 'azure-eastus2', label: 'Azure East US 2 (Virginia)' },
  { id: 'azure-westus3', label: 'Azure West US 3 (Arizona)' },
  { id: 'azure-gwc', label: 'Azure Germany West Central (Frankfurt)' },
] as const

/**
 * What the setup check pins when nobody chose a region and the org has no project to learn one
 * from: Neon's own default for a new project (the console preselects it, and two of S3's four
 * unpinned creates landed there). The check says so with a warning, so the admin changes it
 * before the first app if their apps belong elsewhere.
 */
export const DEFAULT_NEON_REGION = 'aws-us-east-2'

export function neonRegionLabel(id: string): string | null {
  return NEON_REGIONS.find(r => r.id === id)?.label ?? null
}

/** `PUT /api/platform/setup/settings` — any subset of the keys; `null` clears one. */
export const setupSettingsUpdateSchema = z
  .object(
    Object.fromEntries(
      SETUP_SETTING_KEYS.map(key => [key, launchSettingValueSchemas[key].nullable().optional()])
    ) as {
      [K in SetupSettingKey]: z.ZodOptional<z.ZodNullable<(typeof launchSettingValueSchemas)[K]>>
    }
  )
  .strict()
  .refine(body => Object.keys(body).length > 0, 'Send at least one setting')
export type SetupSettingsUpdate = z.infer<typeof setupSettingsUpdateSchema>

/** Every setting, `null` when unset. */
export const setupSettingsSchema = z.object(
  Object.fromEntries(SETUP_SETTING_KEYS.map(key => [key, z.string().nullable()])) as {
    [K in SetupSettingKey]: z.ZodNullable<z.ZodString>
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
  'public_url',
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

// ---- the public URL -----------------------------------------------------------------------------

/**
 * "Is Launch reachable from the internet at its `APP_URL`?" — the scaffold and deploy jobs run on
 * GitHub's runners and call Launch back at `/ci/*`, so a launch from a Launch they cannot reach
 * dies on GitHub. `checks`: `url` (https, not localhost, a loopback/private/link-local address or
 * `.local`) then `probe` (Launch fetched its own `/ci/ping` through that URL and got its own proof
 * back). Stored as `launch_settings.public_url_check`; a result for another URL does not count.
 */
export const publicUrlCheckSchema = z.object({
  url: z.string(),
  status: credentialCheckStatusSchema,
  checks: credentialLastCheckSchema,
  checkedAt: z.coerce.date(),
})
export type PublicUrlCheck = z.infer<typeof publicUrlCheckSchema>

/** `GET /ci/ping?nonce=` — the nonce back, and an HMAC of it only this deployment can make. */
export const publicUrlPingQuerySchema = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, '16–128 URL-safe characters'),
})
export const publicUrlPingResponseSchema = z.object({ nonce: z.string(), proof: z.string() })
export type PublicUrlPingResponse = z.infer<typeof publicUrlPingResponseSchema>

/**
 * 409 from every route that would dispatch a CI job that calls Launch back (`POST /api/apps`, a
 * create run's retry, "Deploy to production") while the public-URL check is not passing.
 * `details` is `launchNotReachableDetailsSchema`: the URL and the probes that failed.
 */
export const LAUNCH_NOT_REACHABLE = 'launch_not_reachable'
export const launchNotReachableDetailsSchema = z.object({
  url: z.string(),
  checks: credentialLastCheckSchema,
})
export type LaunchNotReachableDetails = z.infer<typeof launchNotReachableDetailsSchema>

/** `POST /api/platform/setup/public-url/check` — probe now; the stored result. */
export const publicUrlCheckResponseSchema = publicUrlCheckSchema

/** `GET /api/platform/setup` — everything the page renders. Never a credential value. */
export const setupOverviewSchema = z.object({
  steps: z.array(setupStepSchema),
  settings: setupSettingsSchema,
  /** `notifications_domain`, or `notifications.<apps_domain>` when that is unset. */
  effectiveNotificationsDomain: z.string().nullable(),
  credentials: z.array(setupCredentialSchema),
  identity: setupIdentitySchema,
  /**
   * Launch's `APP_URL` and its reachability: the stored check when it is for this URL, else the
   * static half alone (`checkedAt` null — never probed from this page load).
   */
  publicUrl: z.object({
    url: z.string(),
    status: credentialCheckStatusSchema.nullable(),
    checks: credentialLastCheckSchema,
    checkedAt: z.coerce.date().nullable(),
  }),
  /** The kit new apps are cut from (`launch_settings.template_pin`, else the default). */
  templatePin: templatePinStatusSchema,
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
