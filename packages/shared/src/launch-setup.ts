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
import {
  AGENT_RUNTIME_LABELS,
  AGENT_RUNTIMES,
  type AgentRuntimeId,
  agentRuntimeSchema,
  isPricedRuntimeModel,
  sessionCredentialModeSchema,
} from './launch-agents'
import { compareReleaseVersions, parseReleaseVersion } from './launch-releases'
import { runtimePolicySchema } from './launch-sessions'

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
 * - `template_pin` — `{ repo, tag?, commit, follow? }`, the kit a new app is cut from
 *   (`DEFAULT_TEMPLATE_PIN`): a release tag, an unreleased commit (no tag), or the newest release
 *   (`follow: 'latest'`, kept current by the five-minute cron). Set on Platform → Kit.
 * - `app_create_role` — the lowest tenant role that may create an app (`DEFAULT_APP_CREATE_ROLE`).
 *
 * And P3's two (`@launch/shared/launch-sessions`):
 *
 * - `session_policy` — the coding-session budgets and limits (`DEFAULT_SESSION_POLICY`), read
 *   through `resolveSessionPolicy` and snapshotted on each session at create. Its `runtimes` are
 *   the coding agents sessions may run (§18.22) — the Platform → Coding agents tab.
 * - `sessions_paused` — `true` while an operator has drained sessions for a deploy; new sessions
 *   answer 409 until it is cleared.
 * - `session_sandbox_host` — where a NEW session's container runs (`SESSION_SANDBOX_HOSTS`): this
 *   Worker's own containers (`local`, the default and the only choice deployed) or the remote
 *   sandbox host (`remote`, development only). The Platform → Coding agents tab's Session sandbox
 *   section; each session freezes it at create (`sessions.sandbox_host`).
 *
 * And two Launch writes itself:
 *
 * - `public_url_check` — the last "is `APP_URL` reachable from the internet" result
 *   (`publicUrlCheckSchema`), the cache `POST /api/apps` reads rather than probing every time.
 * - `template_pin_check` — the last "what is the kit's newest release" lookup a Follow latest pin
 *   made (`kitLatestCheckSchema`): when, what it found, and the error when GitHub failed.
 */
export const LAUNCH_SETTING_KEYS = [
  ...SETUP_SETTING_KEYS,
  'template_pin',
  'app_create_role',
  'session_policy',
  'sessions_paused',
  'session_sandbox_host',
  'public_url_check',
  'template_pin_check',
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
 * `follow: 'latest'` makes a release pin FOLLOW the repo's newest release (`latestKitTag`): the
 * five-minute cron (at most hourly) and the card's Check now move `tag`/`commit` when a newer release
 * appears. Between moves it is an ordinary release pin — the scaffold and the upgrade check read
 * `tag` and `commit` exactly as for a pinned tag; apps are never upgraded by the move, only shown
 * as behind. A follow pin always has a tag.
 *
 * A row stored before commit pins (always with a tag) or before `follow` existed parses unchanged.
 */
export const templatePinSchema = z
  .object({
    repo: kitRepoSchema,
    tag: z.string().trim().min(1).max(100).optional(),
    commit: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{40}$/, 'A full 40-character commit SHA'),
    follow: z.literal('latest').nullish(),
  })
  .refine(pin => !pin.follow || Boolean(pin.tag), {
    message: 'A pin that follows the latest release names its tag',
    path: ['tag'],
  })
export type TemplatePin = z.infer<typeof templatePinSchema>

/** Does this pin follow the kit's newest release (`follow: 'latest'`)? */
export function isFollowLatestPin(pin: { follow?: string | null }): boolean {
  return pin.follow === 'latest'
}

/**
 * The kit's newest RELEASE among `names`: the highest `X.Y.Z` tag by semver (a leading `v`
 * allowed). Pre-releases (`0.18.0-rc.1`) and any other tag are never "latest"; null when none is a
 * release. GitHub's own "latest release" is not used — the kit cuts tags, and a tag with no GitHub
 * Release must still count.
 */
export function latestKitTag(names: readonly string[]): string | null {
  let best: string | null = null
  for (const name of names) {
    if (!parseReleaseVersion(name.replace(/^v/, ''))) continue
    if (
      best === null ||
      compareReleaseVersions(name.replace(/^v/, ''), best.replace(/^v/, '')) > 0
    ) {
      best = name
    }
  }
  return best
}

/** Tag names newest release first (semver, descending); anything else after them, in order. */
export function sortKitTagsNewestFirst<T extends { name: string }>(tags: readonly T[]): T[] {
  const version = (t: T) =>
    parseReleaseVersion(t.name.replace(/^v/, '')) ? t.name.replace(/^v/, '') : null
  return tags
    .map((tag, index) => ({ tag, index }))
    .sort((a, b) => {
      const va = version(a.tag)
      const vb = version(b.tag)
      if (va && vb) return compareReleaseVersions(vb, va) || a.index - b.index
      if (va) return -1
      if (vb) return 1
      return a.index - b.index
    })
    .map(({ tag }) => tag)
}

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
 * - `{ kind: 'latest' }` — Follow latest: the repo's newest release (`latestKitTag`) resolved like
 *   a tag and stored with `follow: 'latest'`; 422 `kit_ref_not_found` when the repo has no release.
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
  z.object({ kind: z.literal('latest'), repo: kitRepoSchema.optional() }),
])
export type TemplatePinRequest = z.infer<typeof templatePinRequestSchema>

/**
 * `launch_settings.template_pin_check` — the last newest-release lookup for a Follow latest pin
 * (the cron's, Check now's, or choosing Follow latest). `latest` is the newest release found
 * (kept from the previous lookup when this one failed); `error` is why GitHub could not answer,
 * null on success. A failed lookup is retried on the next cron tick, a good one an hour later.
 */
export const kitLatestCheckSchema = z.object({
  repo: z.string(),
  checkedAt: z.coerce.date(),
  latest: z.string().nullable(),
  error: z.string().nullable(),
})
export type KitLatestCheck = z.infer<typeof kitLatestCheckSchema>

/** The kit pin as Platform → Kit sees it: what new apps use, and whether it is the code default. */
export const templatePinStatusSchema = z.object({
  pin: templatePinSchema,
  /** No `launch_settings.template_pin` row: `DEFAULT_TEMPLATE_PIN` applies. */
  isDefault: z.boolean(),
  default: templatePinSchema,
  /** The last newest-release lookup (`template_pin_check`) — shown while the pin follows latest. */
  latestCheck: kitLatestCheckSchema.nullable(),
})
export type TemplatePinStatus = z.infer<typeof templatePinStatusSchema>

/**
 * `GET /api/platform/setup/template-pin/tags[?repo=]` — the repo's tags, newest release first
 * (`sortKitTagsNewestFirst`), and which one Follow latest would pick (`latestKitTag`).
 */
export const kitTagsQuerySchema = z.object({ repo: kitRepoSchema.optional() })
export const kitTagsResponseSchema = z.object({
  repo: z.string(),
  tags: z.array(z.object({ name: z.string(), commit: z.string() })),
  latest: z.string().nullable(),
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

// ---- coding agents (§18.22) ---------------------------------------------------------------------

/**
 * The session image a runtime needs at least — documentation for the card, not a check: Launch
 * cannot see which image the `SessionSandbox` container was deployed with. Codex arrived in
 * `session-6`; Claude Code has been in every image.
 */
export const AGENT_RUNTIME_MIN_IMAGE: Record<AgentRuntimeId, string | null> = {
  claude_code: null,
  codex: 'session-6',
}

/** The platform credential a runtime's sessions on Launch's account spend. */
export const AGENT_RUNTIME_PLATFORM_KEY = {
  claude_code: 'anthropic_api_key',
  codex: 'openai_api_key',
} as const satisfies Record<AgentRuntimeId, CredentialKind>

/** One runtime's entry in `PUT /session-agents`: its model must have a price (budgets need one). */
function sessionAgentSettingSchema(runtime: AgentRuntimeId) {
  return runtimePolicySchema.refine(v => isPricedRuntimeModel(runtime, v.model), {
    path: ['model'],
    message: `Launch has no price for that model, so ${AGENT_RUNTIME_LABELS[runtime]} sessions could not be held to a budget`,
  })
}

/**
 * `PUT /api/platform/setup/session-agents` — any subset of the runtimes, each whole (`enabled`,
 * `model`, `credentialMode`). The server merges them into `session_policy.runtimes`, keeping the
 * policy's budgets and limits, and refuses a result with no runtime enabled (409
 * `session_agents_none_enabled`). It applies to NEW sessions: each session froze its policy.
 */
export const sessionAgentsUpdateSchema = z.object({
  runtimes: z
    .object(
      Object.fromEntries(AGENT_RUNTIMES.map(id => [id, sessionAgentSettingSchema(id)])) as Record<
        AgentRuntimeId,
        ReturnType<typeof sessionAgentSettingSchema>
      >
    )
    .partial()
    .strict()
    .refine(r => Object.keys(r).length > 0, 'Send at least one agent'),
})
export type SessionAgentsUpdate = z.infer<typeof sessionAgentsUpdateSchema>

/** 409 from `PUT /session-agents` when the result would leave no coding agent enabled. */
export const SESSION_AGENTS_NONE_ENABLED = 'session_agents_none_enabled'

/** One coding agent as the Setup page's card draws it. Never a credential value. */
export const sessionAgentStatusSchema = z.object({
  runtime: agentRuntimeSchema,
  label: z.string(),
  /** The personal account it can bill ("Claude subscription", "ChatGPT plan"). */
  accountLabel: z.string(),
  enabled: z.boolean(),
  model: z.string(),
  credentialMode: sessionCredentialModeSchema,
  /** No stored entry: the fail-closed code default applies. */
  isDefault: z.boolean(),
  /** The models the card offers (all priced), plus the current one when it is not among them. */
  models: z.array(z.string()),
  /**
   * The key its sessions on Launch's account spend: the sealed credential, else the Worker secret
   * (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), else none (`source` null).
   */
  platformKey: z.object({
    kind: z.enum(['anthropic_api_key', 'openai_api_key']),
    source: z.enum(['credential', 'secret']).nullable(),
  }),
  /** People with a personal account connected for it (any status). */
  connectedAccounts: z.number().int().nonnegative(),
  /** `AGENT_RUNTIME_MIN_IMAGE` — the session image it needs at least, or null. */
  minImage: z.string().nullable(),
})
export type SessionAgentStatus = z.infer<typeof sessionAgentStatusSchema>

export const sessionAgentsStatusSchema = z.object({ runtimes: z.array(sessionAgentStatusSchema) })
export type SessionAgentsStatus = z.infer<typeof sessionAgentsStatusSchema>

// ---- the session sandbox (where a session's container runs) -------------------------------------

/**
 * Where a session's CONTAINER runs — `launch_settings.session_sandbox_host`, frozen on each session
 * at create (`sessions.sandbox_host`):
 *
 * - `local` — this Worker's own `SESSION_SANDBOX` containers: Cloudflare's when deployed, local
 *   Docker under `wrangler dev`. The default, and the only choice outside development.
 * - `remote` — a real Cloudflare container in the SANDBOX HOST Worker (`launch-sandbox-dev`),
 *   reached through the `SANDBOX_HOST` remote service binding `pnpm dev` declares. Development
 *   only, and never with `SESSION_BACKEND=local` (a Cloudflare container cannot reach a laptop's
 *   git server).
 */
export const SESSION_SANDBOX_HOSTS = ['local', 'remote'] as const
export const sessionSandboxHostSchema = z.enum(SESSION_SANDBOX_HOSTS)
export type SessionSandboxHost = z.infer<typeof sessionSandboxHostSchema>

/** What the section calls each choice. */
export const SESSION_SANDBOX_HOST_LABELS: Record<SessionSandboxHost, string> = {
  local: "This Worker's containers",
  remote: 'Remote sandbox host',
}

/** `PUT /api/platform/setup/session-sandbox`. Applies to NEW sessions; running ones keep theirs. */
export const sessionSandboxUpdateSchema = z.object({ host: sessionSandboxHostSchema })
export type SessionSandboxUpdate = z.infer<typeof sessionSandboxUpdateSchema>

/** 409 from that PUT, and from creating a session, when the chosen host cannot run one now. */
export const SESSION_SANDBOX_UNAVAILABLE = 'session_sandbox_unavailable'

/** One choice as the section draws it: can this Worker use it right now, and if not, why. */
export const sessionSandboxOptionSchema = z.object({
  host: sessionSandboxHostSchema,
  label: z.string(),
  available: z.boolean(),
  /** A sentence saying why it cannot be used (null when it can). */
  reason: z.string().nullable(),
})
export type SessionSandboxOption = z.infer<typeof sessionSandboxOptionSchema>

export const sessionSandboxStatusSchema = z.object({
  /** What a new session gets: the stored setting, else the default. */
  host: sessionSandboxHostSchema,
  /** Nothing is stored: `host` is the default (or a leftover `.dev.vars` value, development only). */
  isDefault: z.boolean(),
  options: z.array(sessionSandboxOptionSchema),
})
export type SessionSandboxStatus = z.infer<typeof sessionSandboxStatusSchema>

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
  /** §18.22: the coding agents sessions may run (`session_policy.runtimes`), with readiness. */
  sessionAgents: sessionAgentsStatusSchema,
  /** Where a new session's container runs (`launch_settings.session_sandbox_host`), with availability. */
  sessionSandbox: sessionSandboxStatusSchema,
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
