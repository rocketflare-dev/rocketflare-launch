/**
 * Launch app registry contracts (spec/06): the closed sets the `apps`, `app_environments`,
 * `app_health_checks` and `app_operations` tables are built from, and the shapes of their jsonb
 * columns. The pg enums in `apps/web/src/db/schema/app*.ts` mirror these lists — append-only.
 *
 * Slice 1d owns this file and adds the request/response contracts for `/api/apps` (import,
 * catalogue, detail, health, OIDC client registration) beside what is here.
 */
import { z } from 'zod'

/** `requested → provisioning → live → archived`, or `failed` (spec/06). */
export const APP_STATUSES = ['requested', 'provisioning', 'live', 'archived', 'failed'] as const
export const appStatusSchema = z.enum(APP_STATUSES)
export type AppStatus = z.infer<typeof appStatusSchema>

/** How the app arrived: registered from an existing repo (P1), or launched by the pipeline. */
export const APP_SOURCES = ['imported', 'created'] as const
export const appSourceSchema = z.enum(APP_SOURCES)
export type AppSource = z.infer<typeof appSourceSchema>

export const APP_ENVIRONMENT_NAMES = ['staging', 'production'] as const
export const appEnvironmentNameSchema = z.enum(APP_ENVIRONMENT_NAMES)
export type AppEnvironmentName = z.infer<typeof appEnvironmentNameSchema>

/** `up`: health and ready both 200. `degraded`: health 200, ready not. Otherwise `down`. */
export const HEALTH_STATUSES = ['unknown', 'up', 'degraded', 'down'] as const
export const healthStatusSchema = z.enum(HEALTH_STATUSES)
export type HealthStatus = z.infer<typeof healthStatusSchema>

export const APP_OPERATION_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const
export const appOperationStatusSchema = z.enum(APP_OPERATION_STATUSES)
export type AppOperationStatus = z.infer<typeof appOperationStatusSchema>

/**
 * The resource ids an environment's toml declares (spec/06: "resource ids are recorded when
 * created, never looked up by name later"). Every list is optional so an app that binds no queue
 * simply has none.
 */
export const appEnvironmentResourcesSchema = z.object({
  /** `title` is the account-scoped name Launch created it under (P2); an import has only the id. */
  kv: z
    .array(z.object({ binding: z.string(), id: z.string(), title: z.string().optional() }))
    .optional(),
  /** `id` is Cloudflare's `queue_id`, recorded when Launch created the queue (P2). */
  queues: z
    .array(z.object({ binding: z.string(), queue: z.string(), id: z.string().optional() }))
    .optional(),
  r2: z.array(z.object({ binding: z.string(), bucketName: z.string() })).optional(),
  durableObjects: z.array(z.object({ binding: z.string(), className: z.string() })).optional(),
  workflows: z
    .array(z.object({ binding: z.string(), name: z.string(), className: z.string() }))
    .optional(),
  hyperdrive: z.array(z.object({ binding: z.string(), id: z.string() })).optional(),
  /**
   * The queue consumers Launch registered on the Worker (P2: the Versions API does not create
   * them, so the pipeline does, and teardown deletes them by `consumerId`).
   */
  queueConsumers: z
    .array(
      z.object({
        queue: z.string(),
        queueId: z.string(),
        consumerId: z.string(),
        scriptName: z.string(),
      })
    )
    .optional(),
  /**
   * The newest Durable Object `[[migrations]]` tag the placeholder Worker applied (P2). A later
   * build carrying a newer tag is refused by the deploy gateway: the Versions API cannot apply it.
   */
  doMigrationTag: z.string().optional(),
})
export type AppEnvironmentResources = z.infer<typeof appEnvironmentResourcesSchema>

/** The Neon project an environment runs on. Ids only — a connection string is a secret. */
export const appEnvironmentNeonSchema = z
  .object({
    projectId: z.string(),
    branchId: z.string().optional(),
    databaseName: z.string().optional(),
    roleName: z.string().optional(),
    /** P2: owns database `app`; the deploy job migrates as it through a short-lived password. */
    migratorRole: z.string().optional(),
    /** P2: the Worker's role — `GRANT migrator TO app`, so it has the owner's rights (RLS inert). */
    appRole: z.string().optional(),
  })
  .passthrough()
export type AppEnvironmentNeon = z.infer<typeof appEnvironmentNeonSchema>

/** Cloudflare route / custom-domain ids an environment owns. */
export const appRouteIdsSchema = z.array(z.string())
export type AppRouteIds = z.infer<typeof appRouteIdsSchema>

/** What a pipeline step created, by kind — what makes retry and teardown exact (spec/06). */
export const appOperationExternalIdsSchema = z.record(z.string(), z.string())
export type AppOperationExternalIds = z.infer<typeof appOperationExternalIdsSchema>

// ---- Slugs (spec/04) ----------------------------------------------------------------------------

/**
 * Hostnames Launch or the apps domain already uses. The flat scheme puts slugs, `<slug>-staging`
 * and preview hosts in ONE label space (spec/04), so none of these may name an app.
 */
export const RESERVED_APP_SLUGS = [
  'launch',
  'notifications',
  'www',
  'api',
  'auth',
  'admin',
  'mail',
] as const

/**
 * Longest slug. Every resource is named after it with a suffix — `<slug>-staging` is a DNS label
 * (63 max), `<slug>-files-staging` an R2 bucket name (63 max) — so 40 leaves every suffix room.
 */
export const APP_SLUG_MAX_LENGTH = 40

/** Why `slug` cannot name an app, or null when it can — one sentence a person can act on. */
export function appSlugProblem(slug: string): string | null {
  if (slug.length === 0) return 'A slug is required'
  if (slug.length > APP_SLUG_MAX_LENGTH)
    return `A slug is at most ${APP_SLUG_MAX_LENGTH} characters`
  if (!/^[a-z]/.test(slug)) return 'A slug must start with a lower-case letter'
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    return 'A slug may contain only lower-case letters, digits and hyphens'
  }
  if (slug.endsWith('-')) return 'A slug may not end with a hyphen'
  if (slug.includes('--')) return 'A slug may not contain two hyphens in a row'
  if (slug.endsWith('-staging')) return 'A slug may not end in -staging (that is the staging host)'
  if ((RESERVED_APP_SLUGS as readonly string[]).includes(slug)) return `"${slug}" is reserved`
  return null
}

export const appSlugSchema = z.string().superRefine((slug, ctx) => {
  const problem = appSlugProblem(slug)
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
})

// ---- Import --------------------------------------------------------------------------------------

/** `owner/name`, in GitHub's own character set for each half. */
export const repoFullNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Use the form owner/name')

/** `POST /api/apps/import` — admins and above. */
export const importAppRequestSchema = z.object({
  repo: repoFullNameSchema,
  /** A branch, tag or commit; the repo's default branch when omitted. */
  ref: z.string().trim().min(1).max(255).optional(),
  ownerGroupId: z.string().uuid().optional(),
})
export type ImportAppRequest = z.infer<typeof importAppRequestSchema>

/**
 * An app's identity file, read leniently: `.rocketflare.json` (`app {slug, display, domain}`,
 * `kit {version, commit}`) or the `launch.plugins.json` shape (`app {…}`, `kitVersion`). Anything
 * else in it is kept and ignored.
 */
export const rocketflareManifestSchema = z
  .object({
    app: z
      .object({
        slug: z.string().optional(),
        display: z.string().optional(),
        domain: z.string().optional(),
      })
      .passthrough()
      .optional(),
    kit: z
      .object({ version: z.string().optional(), commit: z.string().optional() })
      .passthrough()
      .optional(),
    kitVersion: z.string().optional(),
  })
  .passthrough()
export type RocketflareManifest = z.infer<typeof rocketflareManifestSchema>

// ---- Wire shapes ---------------------------------------------------------------------------------

/** One environment as the catalogue shows it: where it is and how it last answered. */
export const appEnvironmentSummarySchema = z.object({
  id: z.string().uuid(),
  name: appEnvironmentNameSchema,
  url: z.string().nullable(),
  healthStatus: healthStatusSchema,
  healthCheckedAt: z.coerce.date().nullable(),
  healthChangedAt: z.coerce.date().nullable(),
  healthVersion: z.string().nullable(),
  healthLatencyMs: z.number().int().nullable(),
  healthError: z.string().nullable(),
})
export type AppEnvironmentSummary = z.infer<typeof appEnvironmentSummarySchema>

/** One environment on the detail page: the summary plus what it runs on. Ids, never secrets. */
export const appEnvironmentSchema = appEnvironmentSummarySchema.extend({
  workerName: z.string().nullable(),
  resources: appEnvironmentResourcesSchema,
  lastDeployVersion: z.string().nullable(),
  lastDeployAt: z.coerce.date().nullable(),
  lastDeployBy: z.string().nullable(),
})
export type AppEnvironment = z.infer<typeof appEnvironmentSchema>

export const appOwnerGroupSchema = z.object({ id: z.string().uuid(), name: z.string() })
export type AppOwnerGroup = z.infer<typeof appOwnerGroupSchema>

/** A catalogue row. */
export const appSummarySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  status: appStatusSchema,
  source: appSourceSchema,
  template: z.string(),
  templateVersion: z.string().nullable(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  ownerGroup: appOwnerGroupSchema.nullable(),
  /** Staging first, then production; an environment the app does not have is simply absent. */
  environments: z.array(appEnvironmentSummarySchema),
  createdAt: z.coerce.date(),
})
export type AppSummary = z.infer<typeof appSummarySchema>

// ---- Deploy progress -----------------------------------------------------------------------------

/**
 * The milestones of one deploy, in order, as the app overview's stepper shows them — each DERIVED
 * from its deploy ticket's columns (`deploy/progress.ts`), never stored:
 *
 * - `dispatched` — a run exists or was asked for: an approved pre-approval no run has claimed yet
 *   (Promote / "Deploy to production"), or a run's own ticket;
 * - `approved` — a run holds an approved ticket (staging by policy, production by an approval):
 *   the job builds, checks and uploads;
 * - `uploaded` — the build passed the binding check and is on Cloudflare as an undeployed version;
 * - `migrating` — the job was handed the migrator credential and runs its migrations;
 * - `activating` — `activate` began putting the version live;
 * - `done` — `activated_at`: the version is live (THE answer to "did it deploy").
 */
export const DEPLOY_STEPS = [
  'dispatched',
  'approved',
  'uploaded',
  'migrating',
  'activating',
  'done',
] as const
export const deployStepSchema = z.enum(DEPLOY_STEPS)
export type DeployStep = z.infer<typeof deployStepSchema>

/**
 * Where a deploy is now: one of the steps, `awaiting_approval` (a production run waiting on a
 * person — it has `dispatched` and waits before `approved`), or `failed` (refused, rejected,
 * expired, failed, closed without an activation, or its run ended early).
 */
export const DEPLOY_PHASES = [
  'awaiting_approval',
  'dispatched',
  'approved',
  'uploaded',
  'migrating',
  'activating',
  'done',
  'failed',
] as const
export const deployPhaseSchema = z.enum(DEPLOY_PHASES)
export type DeployPhase = z.infer<typeof deployPhaseSchema>

/** One deploy as the overview and the catalogue show it. Never a credential. */
export const deployProgressSchema = z.object({
  ticketId: z.string().uuid(),
  environment: appEnvironmentNameSchema,
  phase: deployPhaseSchema,
  /** The last milestone it reached — for a failed deploy, where it stopped (null: none). */
  reached: deployStepSchema.nullable(),
  /** Not `done` and not `failed`: the server still owes an answer, so a reader polls. */
  inProgress: z.boolean(),
  version: z.string().nullable(),
  sha: z.string().nullable(),
  ref: z.string().nullable(),
  actor: z.string().nullable(),
  /** The GitHub Actions run, once a run claimed the ticket. */
  runUrl: z.string().url().nullable(),
  /** Why it failed, in a sentence (the ticket's error, the refused bindings, the expiry). */
  error: z.string().nullable(),
  /** The `deploy.production` approval behind it, when one gates or gated it. */
  approvalId: z.string().uuid().nullable(),
  startedAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  activatedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
})
export type DeployProgress = z.infer<typeof deployProgressSchema>

/**
 * `GET /api/apps/:id/deploys/latest` — each environment's newest deploy (staging first), after the
 * read has polled the GitHub run of any in progress. An environment with none is absent.
 */
export const appDeployProgressResponseSchema = z.object({
  items: z.array(deployProgressSchema),
})
export type AppDeployProgressResponse = z.infer<typeof appDeployProgressResponseSchema>

/**
 * A catalogue row: the summary plus the app's latest deploy — an in-progress one when there is
 * one (the newest), else the newest of all; null for an app that never deployed.
 */
export const appCatalogueItemSchema = appSummarySchema.extend({
  latestDeploy: deployProgressSchema.nullable().default(null),
})
export type AppCatalogueItem = z.infer<typeof appCatalogueItemSchema>

/**
 * `GET /api/apps` — the whole catalogue, by name. It is one company's apps, so no paging.
 * `appsDomain` is `launch_settings.apps_domain` (null until Setup sets it): what a created app's
 * hosts end in, so the create form can preview `<slug>-staging.<appsDomain>` for any member.
 */
export const appListResponseSchema = z.object({
  items: z.array(appCatalogueItemSchema),
  appsDomain: z.string().nullable(),
})
export type AppListResponse = z.infer<typeof appListResponseSchema>

// ---- Ship settings and branch protection (issue #5, `docs/plans/i5-ship-to-staging.md`) ------

/**
 * Where a session's Ship ends (plan §1.10): `staging` — Launch waits for CI, merges the PR, cuts a
 * patch release and follows it live on staging; `pr` — the PR is opened and left for a person
 * (the flow before issue #5). `launch-sessions` imports these, never the reverse.
 */
export const SESSION_SHIP_MODES = ['staging', 'pr'] as const
export const sessionShipModeSchema = z.enum(SESSION_SHIP_MODES)
export type SessionShipMode = z.infer<typeof sessionShipModeSchema>

/**
 * Who must approve a session's merge (plan §1.11): nobody, the app's owners, or named groups. An
 * admin `approval_policies` row for `session.merge` overrides this (`shipReviewSetBy: 'policy'`).
 */
export const SHIP_REVIEW_MODES = ['none', 'app_owners', 'groups'] as const
export const shipReviewModeSchema = z.enum(SHIP_REVIEW_MODES)
export type ShipReviewMode = z.infer<typeof shipReviewModeSchema>

/** `apps.ship_settings` (jsonb; null = `DEFAULT_APP_SHIP_SETTINGS`). */
export const appShipSettingsSchema = z.object({
  sessionShip: sessionShipModeSchema,
  review: z.object({
    mode: shipReviewModeSchema,
    groupIds: z.array(z.string().uuid()).max(50).default([]),
  }),
})
export type AppShipSettings = z.infer<typeof appShipSettingsSchema>

/** Every app, imported ones included, ships to staging with no review (decision §0.2). */
export const DEFAULT_APP_SHIP_SETTINGS: AppShipSettings = {
  sessionShip: 'staging',
  review: { mode: 'none', groupIds: [] },
}

/** The stored column with the defaults filled in; null or unparseable is the defaults. */
export function resolveAppShipSettings(stored: unknown): AppShipSettings {
  const parsed = appShipSettingsSchema.safeParse(stored)
  return parsed.success ? parsed.data : DEFAULT_APP_SHIP_SETTINGS
}

/** `PUT /api/apps/:id/ship-settings` — the app's owners and admins; `groups` names at least one. */
export const putAppShipSettingsRequestSchema = appShipSettingsSchema.superRefine((value, ctx) => {
  if (value.review.mode === 'groups' && value.review.groupIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['review', 'groupIds'],
      message: 'Name at least one team to review',
    })
  }
})
export type PutAppShipSettingsRequest = z.infer<typeof putAppShipSettingsRequestSchema>

/** Where the effective review rule comes from: the app's own setting, or an admin policy row. */
export const SHIP_REVIEW_SET_BY = ['app', 'policy'] as const
export const shipReviewSetBySchema = z.enum(SHIP_REVIEW_SET_BY)
export type ShipReviewSetBy = z.infer<typeof shipReviewSetBySchema>

/**
 * `GET /api/apps/:id/branch-protection` (plan §1.13): `ok` — Launch's ruleset requires `Gate` and
 * the App may bypass it; `none` — nothing protects the default branch; `blocks` — a rule (classic
 * protection, or a ruleset the App cannot bypass) would stop Launch's release bump; `unavailable`
 * — the owner's plan has no rulesets on this repo; `unknown` — GitHub could not be asked.
 */
/**
 * The status check Launch's ruleset requires and the landing waits on: the kit's `ci.yml` job
 * `gate` is named `Gate` (decision §0.5; `tests/config/kit-required-check.test.ts` pins it).
 */
export const KIT_REQUIRED_CHECK = 'Gate'

export const BRANCH_PROTECTION_STATES = ['ok', 'none', 'blocks', 'unavailable', 'unknown'] as const
export const branchProtectionStateSchema = z.enum(BRANCH_PROTECTION_STATES)
export type BranchProtectionState = z.infer<typeof branchProtectionStateSchema>

export const appBranchProtectionSchema = z.object({
  state: branchProtectionStateSchema,
  /** The status checks the default branch requires (rulesets and classic protection). */
  requiredChecks: z.array(z.string()),
  /** Whether Launch's GitHub App may bypass every rule that applies (its release bump lands). */
  appCanBypass: z.boolean(),
  /** Launch's own `launch` ruleset, when it exists. */
  rulesetId: z.number().int().positive().nullable(),
  /** A sentence for the admin: what blocks, or why it is unknown. */
  detail: z.string().nullable(),
})
export type AppBranchProtection = z.infer<typeof appBranchProtectionSchema>

/** `GET /api/apps/:slug`. */
export const appDetailSchema = appSummarySchema.extend({
  templateContractVersion: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  environments: z.array(appEnvironmentSchema),
  updatedAt: z.coerce.date(),
  /**
   * Whether the CALLER may approve or reject its production deploys and start one — the app's
   * owners (a named owner or a member of its owner group) and admins (`manage App`), exactly the
   * rule `POST /:id/deploys/…` enforces. Retry and archive stay `manage App`.
   */
  viewerCanDeploy: z.boolean(),
  /** Issue #5: `apps.ship_settings` resolved (defaults filled in). Defaulted so an older answer parses. */
  shipSettings: appShipSettingsSchema.default(DEFAULT_APP_SHIP_SETTINGS),
  /** `policy`: an admin `session.merge` policy row decides review, and the setting is read-only. */
  shipReviewSetBy: shipReviewSetBySchema.default('app'),
})
export type AppDetail = z.infer<typeof appDetailSchema>

/** `PATCH /api/apps/:id` — admins and above. */
export const updateAppRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    ownerGroupId: z.string().uuid().nullable().optional(),
  })
  .refine(body => Object.values(body).some(v => v !== undefined), 'Nothing to update')
export type UpdateAppRequest = z.infer<typeof updateAppRequestSchema>

/** One `app_health_checks` row, tagged with the environment it probed. */
export const appHealthCheckSchema = z.object({
  id: z.string().uuid(),
  environmentId: z.string().uuid(),
  environmentName: appEnvironmentNameSchema,
  checkedAt: z.coerce.date(),
  status: healthStatusSchema,
  httpStatus: z.number().int().nullable(),
  readyStatus: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  version: z.string().nullable(),
  error: z.string().nullable(),
})
export type AppHealthCheck = z.infer<typeof appHealthCheckSchema>

/** The history window the detail page asks for; the poller keeps seven days. */
export const appHealthQuerySchema = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(7 * 24)
    .default(24),
})

/** `GET /api/apps/:id/health` — oldest first, so a strip reads left to right. */
export const appHealthResponseSchema = z.object({
  since: z.coerce.date(),
  items: z.array(appHealthCheckSchema),
})
export type AppHealthResponse = z.infer<typeof appHealthResponseSchema>

/** `POST /api/apps/:id/health-check` — every environment, just probed. */
export const appHealthCheckRunResponseSchema = z.object({
  environments: z.array(appEnvironmentSummarySchema),
})
export type AppHealthCheckRunResponse = z.infer<typeof appHealthCheckRunResponseSchema>

export const appOperationSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  kind: z.string(),
  step: z.string(),
  status: appOperationStatusSchema,
  attempt: z.number().int(),
  error: z.string().nullable(),
  externalIds: appOperationExternalIdsSchema,
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type AppOperation = z.infer<typeof appOperationSchema>

/** `GET /api/apps/:id/operations` — newest first. */
export const appOperationListResponseSchema = z.object({ items: z.array(appOperationSchema) })
export type AppOperationListResponse = z.infer<typeof appOperationListResponseSchema>

// ---- The app's OIDC client (spec/05) ---------------------------------------------------------------

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/**
 * A redirect URI Launch will send a code to: `https:`, or `http:` on a loopback host (a developer's
 * `wrangler dev`), and no fragment (RFC 6749 §3.1.2).
 */
export const appRedirectUriSchema = z
  .string()
  .trim()
  .url()
  .refine(value => {
    try {
      const url = new URL(value)
      if (url.hash) return false
      if (url.protocol === 'https:') return true
      return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)
    } catch {
      return false
    }
  }, 'Use https:// (http:// only for localhost), with no #fragment')

/** The registration as the console shows it. Launch keeps a hash of the secret; this is its hint. */
export const appOidcClientSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string(),
  secretHint: z.string(),
  secretRotatedAt: z.coerce.date().nullable(),
  redirectUris: z.array(z.string()),
  postLogoutRedirectUris: z.array(z.string()),
  accessPolicy: z.string(),
  disabledAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type AppOidcClient = z.infer<typeof appOidcClientSchema>

/** `GET /api/apps/:id/oidc-client` — `client: null` until one is registered. */
export const appOidcClientResponseSchema = z.object({ client: appOidcClientSchema.nullable() })
export type AppOidcClientResponse = z.infer<typeof appOidcClientResponseSchema>

/**
 * `POST /api/apps/:id/oidc-client` and `POST …/oidc-client/rotate-secret`: the ONLY responses that
 * carry the secret. It is shown once — Launch keeps only a hash — beside the snippet that wires the
 * app to it.
 */
export const appOidcClientSecretResponseSchema = z.object({
  client: appOidcClientSchema,
  clientId: z.string(),
  clientSecret: z.string(),
  issuer: z.string(),
  snippet: z.string(),
})
export type AppOidcClientSecretResponse = z.infer<typeof appOidcClientSecretResponseSchema>

/** `PATCH /api/apps/:id/oidc-client/redirect-uris`. */
export const updateAppRedirectUrisRequestSchema = z.object({
  redirectUris: z.array(appRedirectUriSchema).min(1).max(20),
  postLogoutRedirectUris: z.array(appRedirectUriSchema).max(20).optional(),
})
export type UpdateAppRedirectUrisRequest = z.infer<typeof updateAppRedirectUrisRequestSchema>

/**
 * What an app sets to sign in through Launch — the kit's own OIDC relying party, so configuration
 * only: three `[vars]` in BOTH tomls, and the secret as a Worker secret per environment. The secret
 * is deliberately NOT in the snippet: it is pasted at the `wrangler secret put` prompt, so it never
 * lands in a toml or a shell history.
 */
export function appOidcConfigSnippet(input: { issuer: string; clientId: string }): string {
  return [
    '# apps/web/wrangler.toml AND apps/web/wrangler.staging.toml, under [vars]:',
    `OIDC_ISSUER = "${input.issuer}"`,
    `OIDC_CLIENT_ID = "${input.clientId}"`,
    'AUTH_OIDC_ONLY = "true"',
    '',
    '# Then store the client secret on each environment (paste it at the prompt):',
    'cd apps/web',
    'pnpm exec wrangler secret put OIDC_CLIENT_SECRET',
    'pnpm exec wrangler secret put OIDC_CLIENT_SECRET -c wrangler.staging.toml',
  ].join('\n')
}
