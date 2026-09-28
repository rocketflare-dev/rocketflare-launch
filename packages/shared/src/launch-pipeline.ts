/**
 * Launch P2 contracts — creating an app (`docs/plans/p2-create-app.md`): the create / retry /
 * teardown requests, the ordered steps of the two Workflows and the pipeline view the app page
 * polls, deploy tickets and their decisions, the scaffold job's and the deployer protocol's wire
 * bodies (`/ci/*`, DEPLOYER.md v1), and the two Workflow event types.
 *
 * Slice 2a owns this file; 2b–2e import from it and never edit it.
 */
import { z } from 'zod'
import {
  appEnvironmentNameSchema,
  appOperationStatusSchema,
  appSlugProblem,
  appSummarySchema,
} from './launch-apps'

// ---- Slugs ---------------------------------------------------------------------------------------

/**
 * Why `slug` cannot name a NEW app, or null. `appSlugProblem` plus one rule an import does not
 * need: no `launch-` prefix, because Launch's own account-scoped names (`launch-jobs`,
 * `launch-app-create`…) share the Cloudflare account with every app's.
 */
export function newAppSlugProblem(slug: string): string | null {
  return (
    appSlugProblem(slug) ??
    (slug.startsWith('launch-') ? 'A slug may not start with launch- (Launch uses it)' : null)
  )
}

export const newAppSlugSchema = z.string().superRefine((slug, ctx) => {
  const problem = newAppSlugProblem(slug)
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
})

// ---- Create, retry, teardown -----------------------------------------------------------------------

/** `POST /api/apps` — behind `manage App` and `launch_settings.app_create_role`. */
export const createAppRequestSchema = z.object({
  slug: newAppSlugSchema,
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  ownerGroupId: z.string().uuid().optional(),
  options: z
    .object({
      /** Run the staging deploy (steps 12–13) as part of the launch. */
      deployStaging: z.boolean().default(true),
    })
    .default({}),
})
export type CreateAppRequest = z.infer<typeof createAppRequestSchema>

/**
 * `POST /api/apps` → 202: the `requested` row, and the run whose steps the page polls. From P4 a
 * creator below the `app.create` auto-approve role gets `approvalId` too: the run id is reserved,
 * and its Workflow starts only when the approval is granted (plan §4c).
 */
export const createAppResponseSchema = z.object({
  app: appSummarySchema,
  runId: z.string().uuid(),
  approvalId: z.string().uuid().nullable().optional(),
})
export type CreateAppResponse = z.infer<typeof createAppResponseSchema>

/** What kind of pipeline run an `app_operations` row belongs to. `import` is P1's. */
export const PIPELINE_KINDS = ['create', 'teardown'] as const
export const pipelineKindSchema = z.enum(PIPELINE_KINDS)
export type PipelineKind = z.infer<typeof pipelineKindSchema>

/**
 * `POST /api/apps/:id/pipeline/retry` — only when the latest run of `kind` is `failed`. A new
 * Workflow instance `<runId>-rN` with the SAME run id, so every succeeded step is skipped.
 */
export const retryPipelineRequestSchema = z.object({
  kind: pipelineKindSchema.default('create'),
})
export type RetryPipelineRequest = z.infer<typeof retryPipelineRequestSchema>

export const retryPipelineResponseSchema = z.object({
  runId: z.string().uuid(),
  instanceId: z.string(),
})
export type RetryPipelineResponse = z.infer<typeof retryPipelineResponseSchema>

/** `POST /api/apps/:id/teardown`. `confirmSlug` must equal the app's slug (else 400). */
export const teardownRequestSchema = z.object({
  confirmSlug: z.string().trim().min(1),
  /** Delete the GitHub repository instead of archiving it. */
  deleteRepo: z.boolean().default(false),
})
export type TeardownRequest = z.infer<typeof teardownRequestSchema>

export const teardownResponseSchema = z.object({ runId: z.string().uuid() })
export type TeardownResponse = z.infer<typeof teardownResponseSchema>

// ---- Workflow parameters -------------------------------------------------------------------------

/** `APP_LAUNCH_WORKFLOW.create({ id, params })`. Ids only — the rows hold everything else. */
export const appLaunchParamsSchema = z.object({
  tenantId: z.string().uuid(),
  appId: z.string().uuid(),
  runId: z.string().uuid(),
  /** Who asked: the first owner, `BOOTSTRAP_ADMIN_EMAILS`, and the `app.launched` notification. */
  userId: z.string().uuid().nullable(),
  options: z.object({ deployStaging: z.boolean() }),
})
export type AppLaunchParams = z.infer<typeof appLaunchParamsSchema>

/** `APP_TEARDOWN_WORKFLOW.create({ id, params })`. */
export const appTeardownParamsSchema = z.object({
  tenantId: z.string().uuid(),
  appId: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  deleteRepo: z.boolean(),
})
export type AppTeardownParams = z.infer<typeof appTeardownParamsSchema>

// ---- Steps -----------------------------------------------------------------------------------------

export interface PipelineStepDefinition {
  /** The `app_operations.step` key. A Workflow step NAME may add `#N` (`health#3`); the row is one. */
  step: string
  label: string
}

/**
 * The launch, in order (plan §3 2c). Each is one `app_operations` row keyed `(run_id, step)`;
 * the `health` row covers every `health#N` try, and `production` is always `skipped` in P2.
 */
export const APP_LAUNCH_STEPS = [
  { step: 'reserve', label: 'Reserve the name' },
  { step: 'repo', label: 'Create the repository' },
  { step: 'scaffold.start', label: 'Start the scaffold job' },
  { step: 'scaffold.wait', label: 'Scaffold from the template' },
  { step: 'scaffold.verify', label: 'Check the scaffold' },
  { step: 'neon', label: 'Create the database' },
  { step: 'cloudflare', label: 'Create storage, queue and KV' },
  { step: 'oidc_client', label: 'Register sign-in' },
  { step: 'write_config', label: 'Write the configuration' },
  { step: 'placeholders', label: 'Create the Workers' },
  { step: 'github_env', label: 'Set up GitHub environments' },
  { step: 'worker_secrets', label: 'Set the Worker secrets' },
  { step: 'email', label: 'Create the email key' },
  { step: 'deploy_staging.start', label: 'Start the staging deploy' },
  { step: 'deploy_staging.wait', label: 'Build and deploy staging' },
  { step: 'deploy_staging.check', label: 'Check the staging deploy' },
  { step: 'health', label: 'Wait for staging to answer' },
  { step: 'production', label: 'Production' },
  { step: 'live', label: 'Live' },
] as const satisfies readonly PipelineStepDefinition[]
export type AppLaunchStep = (typeof APP_LAUNCH_STEPS)[number]['step']

/** The teardown, in order: the reverse of what the launch created (plan §3 2c). */
export const APP_TEARDOWN_STEPS = [
  { step: 'routes', label: 'Remove the routes' },
  { step: 'queue_consumers', label: 'Remove the queue consumers' },
  { step: 'workers', label: 'Delete the Workers' },
  { step: 'workflows', label: 'Delete the workflows' },
  { step: 'queues', label: 'Delete the queues' },
  { step: 'r2', label: 'Delete the file buckets' },
  { step: 'kv', label: 'Delete the KV namespaces' },
  { step: 'email', label: 'Delete the email keys' },
  { step: 'neon', label: 'Delete the database' },
  { step: 'oidc_client', label: 'Disable sign-in' },
  { step: 'repo', label: 'Archive the repository' },
  { step: 'archived', label: 'Archived' },
] as const satisfies readonly PipelineStepDefinition[]
export type AppTeardownStep = (typeof APP_TEARDOWN_STEPS)[number]['step']

/** The run as a whole: `none` before any, else derived from its rows. */
export const PIPELINE_RUN_STATUSES = ['none', 'running', 'succeeded', 'failed'] as const
export const pipelineRunStatusSchema = z.enum(PIPELINE_RUN_STATUSES)
export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>

export const pipelineStepSchema = z.object({
  step: z.string(),
  label: z.string(),
  /** `pending` for a step with no row yet. */
  status: appOperationStatusSchema,
  attempt: z.number().int(),
  error: z.string().nullable(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
})
export type PipelineStep = z.infer<typeof pipelineStepSchema>

/** `GET /api/apps/:id/pipeline[?kind=]` — the latest run of that kind, every step in order. */
export const pipelineViewSchema = z.object({
  appId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  kind: pipelineKindSchema,
  status: pipelineRunStatusSchema,
  steps: z.array(pipelineStepSchema),
})
export type PipelineView = z.infer<typeof pipelineViewSchema>

export const pipelineQuerySchema = z.object({ kind: pipelineKindSchema.default('create') })

// ---- Workflow events -------------------------------------------------------------------------------

/**
 * `sendEvent` types. Cloudflare accepts only `/^[A-Za-z0-9_-]{1,100}$/` — a `.` is
 * `workflow.invalid_event_type` at runtime and no fake would notice — so a golden test pins both.
 */
export const SCAFFOLD_FINISHED_EVENT = 'scaffold_finished'
export const DEPLOY_FINISHED_EVENT = 'deploy_finished'

/** Both events carry the ticket; the row, not the payload, is the truth. */
export const pipelineEventPayloadSchema = z.object({ ticketId: z.string().uuid() })
export type PipelineEventPayload = z.infer<typeof pipelineEventPayloadSchema>

// ---- Deploy tickets ----------------------------------------------------------------------------------

/** What a GitHub-OIDC ticket is for. Mirrors the `ci_ticket_purpose` pg enum — append-only. */
export const CI_TICKET_PURPOSES = ['deploy', 'scaffold'] as const
export const ciTicketPurposeSchema = z.enum(CI_TICKET_PURPOSES)
export type CiTicketPurpose = z.infer<typeof ciTicketPurposeSchema>

/** DEPLOYER.md "Ticket statuses". Mirrors the `deploy_ticket_status` pg enum — append-only. */
export const DEPLOY_TICKET_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'uploaded',
  'active',
  'finished',
  'failed',
] as const
export const deployTicketStatusSchema = z.enum(DEPLOY_TICKET_STATUSES)
export type DeployTicketStatus = z.infer<typeof deployTicketStatusSchema>

/**
 * Who approved: staging's policy, a person on the app page, "Deploy to production" (intent), or —
 * from P4 — a `deploy.production` approval decided in the engine (`approval`). Append-only.
 */
export const DEPLOY_DECISION_SOURCES = ['auto', 'user', 'intent', 'approval'] as const
export const deployDecisionSourceSchema = z.enum(DEPLOY_DECISION_SOURCES)
export type DeployDecisionSource = z.infer<typeof deployDecisionSourceSchema>

/** One ticket as the app page shows it. Never a credential — `migratorUrl` is never stored. */
export const deployTicketSchema = z.object({
  id: z.string().uuid(),
  appId: z.string().uuid(),
  environmentId: z.string().uuid(),
  environment: appEnvironmentNameSchema,
  purpose: ciTicketPurposeSchema,
  status: deployTicketStatusSchema,
  repository: z.string().nullable(),
  runId: z.string().nullable(),
  runAttempt: z.number().int().nullable(),
  sha: z.string().nullable(),
  ref: z.string().nullable(),
  actor: z.string().nullable(),
  version: z.string().nullable(),
  cfVersionId: z.string().nullable(),
  /** `"<kind> <binding>=<value>"` per refused binding, when the build was refused. */
  refused: z.array(z.string()).nullable(),
  decisionSource: deployDecisionSourceSchema.nullable(),
  decidedByUserId: z.string().uuid().nullable(),
  decidedAt: z.coerce.date().nullable(),
  expiresAt: z.coerce.date().nullable(),
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
  /** P4: the release whose tag this run deployed (set at `start`), and the approval behind it. */
  releaseId: z.string().uuid().nullable().default(null),
  approvalId: z.string().uuid().nullable().default(null),
})
export type DeployTicket = z.infer<typeof deployTicketSchema>

/** `GET /api/apps/:id/deploys` — newest first. */
export const deployTicketListResponseSchema = z.object({ items: z.array(deployTicketSchema) })
export type DeployTicketListResponse = z.infer<typeof deployTicketListResponseSchema>

/** `POST /api/apps/:id/deploys/:ticketId/decide` — app owners and admins, on a `pending` ticket. */
export const deployDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(500).optional(),
})
export type DeployDecision = z.infer<typeof deployDecisionSchema>

/**
 * `POST /api/apps/:id/deploys/production` → the pre-approved ticket, and the dispatch. From P4 the
 * button opens a `deploy.production` approval instead (plan §4d): `ticket` is then null until the
 * approval is decided, and `approvalId` names the request.
 */
export const productionDeployResponseSchema = z.object({
  ticket: deployTicketSchema.nullable(),
  approvalId: z.string().uuid().nullable().optional(),
})
export type ProductionDeployResponse = z.infer<typeof productionDeployResponseSchema>

/** How long a "Deploy to production" pre-approval waits for its run to claim it. */
export const PRODUCTION_INTENT_TTL_MS = 15 * 60 * 1000

// ---- The deployer protocol (DEPLOYER.md v1, `/ci/deploy/*`) ----------------------------------------

/** The protocol versions `/ci/deploy` speaks. Anything else at `start` → 400 `{ supported }`. */
export const DEPLOYER_PROTOCOL_VERSIONS = [1] as const

/**
 * `POST /ci/deploy/start`. `protocol` is a bare number, not a literal, so an unsupported version
 * reaches the handler and gets the protocol's own 400 `{ error, supported }` rather than a
 * validation envelope.
 */
export const deployStartSchema = z.object({ protocol: z.number().int() })
export type DeployStart = z.infer<typeof deployStartSchema>

/** `start` and `GET /ci/deploy/:id` answer `{ id, status }` (plus informative extras). */
export const deployTicketStateSchema = z.object({
  id: z.string().uuid(),
  status: deployTicketStatusSchema,
})
export type DeployTicketState = z.infer<typeof deployTicketStateSchema>

/** `POST /ci/deploy/:id/upload` — the build, base64 inside one JSON body (`/ci` allows 64 MB). */
export const deployUploadSchema = z.object({
  protocol: z.number().int(),
  version: z.string().trim().min(1).max(100),
  main: z.string().min(1),
  /** The wrangler config, verbatim. The gateway parses it itself and trusts nothing else in it. */
  toml: z.string().min(1),
  /** Path relative to the outdir → base64. */
  modules: z.record(z.string(), z.string()),
  /** `/`-rooted asset path → base64; `{}` when the toml has no `[assets]`. */
  assets: z.record(z.string(), z.string()).default({}),
})
export type DeployUpload = z.infer<typeof deployUploadSchema>

/** `upload` → 200. `migratorUrl` is a credential: returned once, never stored or logged. */
export const deployUploadResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('uploaded'),
  migratorUrl: z.string(),
  versionId: z.string(),
})
export type DeployUploadResponse = z.infer<typeof deployUploadResponseSchema>

/** `upload` → 403 when a binding is not this app's. */
export const deployRefusedResponseSchema = z.object({
  error: z.string(),
  refused: z.array(z.string()),
})

// ---- The scaffold job (`/ci/scaffold/*`) --------------------------------------------------------------

/** What the scaffold job builds: the new app's names and the pinned kit. No secret. */
export const scaffoldPlanSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  /** The apps domain, e.g. `clewro.com`. */
  domain: z.string(),
  /** `owner/name` of the new repository. */
  repo: z.string(),
  kitRepo: z.string(),
  tag: z.string(),
  commit: z.string(),
})
export type ScaffoldPlan = z.infer<typeof scaffoldPlanSchema>

/**
 * `POST /ci/scaffold/token` → 200 once per ticket (a second call is 409): a one-hour installation
 * token scoped to the one repo (`contents` + `workflows` write), and the plan.
 */
export const scaffoldTokenResponseSchema = z.object({
  ticketId: z.string().uuid(),
  token: z.string(),
  expiresAt: z.string(),
  plan: scaffoldPlanSchema,
})
export type ScaffoldTokenResponse = z.infer<typeof scaffoldTokenResponseSchema>

/** `POST /ci/scaffold/done` — the commit the job pushed to `main`. */
export const scaffoldDoneSchema = z.object({
  commit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{40}$/, 'A full commit SHA'),
})
export type ScaffoldDone = z.infer<typeof scaffoldDoneSchema>
