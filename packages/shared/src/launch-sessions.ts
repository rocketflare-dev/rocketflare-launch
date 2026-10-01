/**
 * Launch P3 contracts: coding sessions (spec/07, `docs/plans/p3-sessions.md`). A session is a
 * sandbox running Claude Code against an app's repo, with a live preview and a pull request at
 * the end. Everything the API, the UI and the CLI say about one is here:
 *
 * - the enums the `sessions` table mirrors (`SESSION_KINDS`, `SESSION_STATUSES`,
 *   `ACTIVE_SESSION_STATUSES` — the concurrency index's predicate — `SESSION_ACTIONS`);
 * - the event log (`SESSION_EVENT_TYPES`, one payload schema per type in `SESSION_EVENT_DATA`),
 *   shaped like `AgentRunEvent` so the agent timeline folds it;
 * - the policy (`sessionPolicySchema`, `DEFAULT_SESSION_POLICY`), snapshotted on the row at create;
 * - the jsonb shapes (`sessionDbSchema`, `appSessionDbSchema`, `prChecksSchema`, and issue #5's
 *   `sessionLandingSchema` / `sessionShipSummarySchema` — what follows the PR, up to staging);
 * - the request and response bodies of `/api/sessions`, `/api/apps/:id/sessions` and
 *   `/api/admin/sessions`;
 * - `SESSION_WAKE_EVENT`, golden-tested against Cloudflare's event-type rule;
 * - `SESSION_CUSTOM_EVENTS` — the `launch.session.event` AG-UI `CUSTOM` event of the read stream;
 * - the preview host grammar: `previewLabel()` / `parsePreviewHost()` / `previewUrl()`.
 *
 * Money is microcents throughout (`@launch/shared/ai/pricing`: 100 000 000 per USD), as on
 * `ai_usage`; `usdToMicrocents` / `microcentsToUsd` convert at the edges. No credential, sealed
 * column or preview token ever appears in a response schema here.
 */
import { z } from 'zod'
import {
  agentErrorEventDataSchema,
  agentStatusEventDataSchema,
  agentStepEventDataSchema,
  agentTextEventDataSchema,
  agentToolEndEventDataSchema,
  agentToolStartEventDataSchema,
} from './ai/agents'
import { healthStatusSchema, sessionShipModeSchema } from './launch-apps'

// ---- enums -------------------------------------------------------------------------------------

/** `session` is a person's chat; `prepare` is the one-off run that migrates and seeds `dev`. */
export const SESSION_KINDS = ['session', 'prepare'] as const
export const sessionKindSchema = z.enum(SESSION_KINDS)
export type SessionKind = z.infer<typeof sessionKindSchema>

/**
 * Mirrors the `session_status` pg enum — append-only. The lifecycle (plan §1.2, §1.8):
 *
 *   requested → booting → ready ⇄ working → shipping → shipped
 *                          │  ⇅               ↘
 *                        blocked  suspended     ending → ended      (and `failed` from anywhere)
 *
 * `blocked` is over budget (a person may extend it); `suspended` has no sandbox but keeps its
 * branch and database, and resumes by booting again.
 */
export const SESSION_STATUSES = [
  'requested',
  'booting',
  'ready',
  'working',
  'blocked',
  'suspended',
  'shipping',
  'shipped',
  'ending',
  'ended',
  'failed',
] as const
export const sessionStatusSchema = z.enum(SESSION_STATUSES)
export type SessionStatus = z.infer<typeof sessionStatusSchema>

/**
 * The statuses that hold resources — a Neon branch, and a sandbox or the right to boot one — and
 * so count against `maxConcurrentPerApp`. `sessions_app_active_idx`'s predicate is RENDERED from
 * this list, so the index and the check cannot disagree. `suspended` is in it on purpose: it still
 * holds a branch, and Neon caps branches per project.
 */
export const ACTIVE_SESSION_STATUSES = [
  'requested',
  'booting',
  'ready',
  'working',
  'blocked',
  'suspended',
  'shipping',
  'ending',
] as const satisfies readonly SessionStatus[]

/** Settled: nothing left to run, the sandbox is gone (or going) and the row is history. */
export const TERMINAL_SESSION_STATUSES = [
  'shipped',
  'ended',
  'failed',
] as const satisfies readonly SessionStatus[]

export function isActiveSessionStatus(status: SessionStatus): boolean {
  return (ACTIVE_SESSION_STATUSES as readonly SessionStatus[]).includes(status)
}

/** `sessions.requested_action` — what the Workflow should do when it next wakes. */
export const SESSION_ACTIONS = ['ship', 'end', 'resume'] as const
export const sessionActionSchema = z.enum(SESSION_ACTIONS)
export type SessionAction = z.infer<typeof sessionActionSchema>

/**
 * The event type every route sends to wake a session's Workflow (`instance.sendEvent`). The
 * payload is ignored: the row is the truth (`pending_message`, `requested_action`,
 * `cancel_requested_at`), so a wake carries nothing that could disagree with it.
 *
 * **Golden-tested** (`tests/config/launch-sessions.test.ts`) against `/^[A-Za-z0-9_-]{1,100}$/`:
 * Cloudflare rejects anything else — a `.` is the classic mistake — with
 * `workflow.invalid_event_type` at RUNTIME, and no fake binding would ever notice.
 */
export const SESSION_WAKE_EVENT = 'session_wake'

/**
 * `SESSION_WORKFLOW.create({ id, params })` — one instance per session (id = the session id,
 * `<id>-rN` after a restart; a prepare run is a session row of kind `prepare`). Ids only: the
 * Workflow re-reads everything else from the row, so a retried step sees what is true now.
 */
export const sessionWorkflowParamsSchema = z.object({
  sessionId: z.string().uuid(),
  tenantId: z.string().uuid(),
})
export type SessionWorkflowParams = z.infer<typeof sessionWorkflowParamsSchema>

/**
 * The realtime nudge's entity: `entity.changed { entity: 'session', id }` after every durable
 * write, which `invalidationsFor()` resolves to the `['session']` query-key root. The chat's own
 * AG-UI list is a separate root (`session-agui`) and must stay out of it, exactly as
 * `agent-run-agui` stays out of `agent-run`.
 */
export const SESSION_REALTIME_ENTITY = 'session'

// ---- events ------------------------------------------------------------------------------------

/**
 * `session_events.type`. The Workflow is the ONE writer. The first seven are shaped like the agent
 * run's events so `timelineModel` and `ToolCallRow` fold a session's turns with no new code.
 */
export const SESSION_EVENT_TYPES = [
  'user.message',
  'turn.start',
  'text',
  'tool.start',
  'tool.end',
  'turn.end',
  'turn.failed',
  'turn.interrupted',
  'step',
  'status',
  'preview.ready',
  'budget.reached',
  'ship.gate',
  'ship.pr',
  'error',
  // P5 (plan §1.14–§1.15): the shared config the PR's head declares and the app does not hold.
  'ship.config_needs',
  // Issue #5 (`docs/plans/i5-ship-to-staging.md` §2): what follows the PR, up to live on staging.
  'ship.ci',
  'ship.review',
  'ship.merged',
  'ship.released',
  'ship.staging',
  'ship.reopened',
] as const
export const sessionEventTypeSchema = z.enum(SESSION_EVENT_TYPES)
export type SessionEventType = z.infer<typeof sessionEventTypeSchema>

/** Token counts as the model proxy meters them (Anthropic's names, flattened). */
export const sessionUsageSchema = z.object({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
})
export type SessionUsage = z.infer<typeof sessionUsageSchema>

export const sessionUserMessageDataSchema = z.object({
  text: z.string(),
  userId: z.string().uuid().nullable(),
})
export const sessionTurnStartDataSchema = z.object({ turn: z.number().int().positive() })
export const sessionTurnEndDataSchema = z
  .object({
    turn: z.number().int().positive(),
    /** Claude Code's `result` line: `success` / `error_max_turns` / … */
    result: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    usage: sessionUsageSchema.partial().optional(),
    costMicrocents: z.number().int().nonnegative().optional(),
  })
  .passthrough()
export const sessionTurnFailedDataSchema = z
  .object({ turn: z.number().int().positive(), message: z.string() })
  .passthrough()
/**
 * A turn cut off by a rollout, a container that died under it (`container_lost` — its boot marker
 * is gone), a cancel or the turn timeout. The session goes `suspended` (rollout, container_lost)
 * or back to `ready`.
 */
export const sessionTurnInterruptedDataSchema = z
  .object({
    turn: z.number().int().positive(),
    reason: z.enum(['rollout', 'container_lost', 'cancelled', 'timeout']),
    /** A sentence for the person (`container_lost`: the container stopped, most likely out of memory). */
    message: z.string().optional(),
  })
  .passthrough()
export const sessionPreviewReadyDataSchema = z.object({ port: z.number().int().positive() })
export const sessionBudgetReachedDataSchema = z.object({
  spentMicrocents: z.number().int().nonnegative(),
  capMicrocents: z.number().int().nonnegative(),
  scope: z.enum(['session', 'app_month']),
})
/**
 * The ship gate's steps (issue #1): the kit's own commands, which Launch runs itself in the
 * sandbox, in this order, stopping at the first that fails (`services/sessions/gate.ts` holds the
 * commands and deadlines). They are the kit's `pnpm gate` steps (0.16.0) minus `build`, which the
 * PR's CI runs; `test` runs on a throwaway Neon gate branch. No `generated` step: the kit has none.
 */
export const SHIP_GATE_STEPS = ['lint', 'typecheck', 'test'] as const
export const shipGateStepSchema = z.enum(SHIP_GATE_STEPS)
export type ShipGateStep = z.infer<typeof shipGateStepSchema>
/** How many times a ship runs the gate — a Claude fix turn between one red run and the next. */
export const SHIP_GATE_ATTEMPTS = 3
/** What the ship panel, the chat notices and the CLI call each step. */
export const SHIP_GATE_STEP_LABELS: Record<ShipGateStep, string> = {
  lint: 'Lint',
  typecheck: 'Typecheck',
  test: 'Tests',
}

/**
 * One `ship.gate` row: ONE step of one attempt (`step`), written when that step ends. A row with
 * no `step` is from before issue #1 — the whole gate as one run — and still renders.
 */
export const sessionShipGateDataSchema = z
  .object({
    passed: z.boolean(),
    attempt: z.number().int().positive(),
    step: shipGateStepSchema.optional(),
    /** The command Launch ran (`pnpm gate lint`) — never with its environment. */
    command: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    /**
     * The `test` step only: the target line the kit's `pnpm test` prints first (0.16.0) —
     * `test target: remote Neon branch gate-… (…)` — redacted like the output.
     */
    target: z.string().optional(),
    /**
     * The tail of the step's output, for the ship panel — redacted: the test step's database URL
     * (and anything shaped like a connection string or a key) never survives into it.
     */
    output: z.string().optional(),
  })
  .passthrough()
export const sessionShipPrDataSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  /** Issue #5: the PR's title (the ship summary's), when the writer knows it. */
  title: z.string().optional(),
})

/**
 * P5: what ship's scan of the PR head found (`services/grants/detect.ts`) — reported to the author
 * as an event and never stored as the app's scan. Names only: a session never receives a grant's
 * values (spec/03), so the sandbox runs on the kit's missing-config 503 and this line says why.
 */
export const sessionShipConfigNeedsDataSchema = z.object({
  /** Matched shared resources that no environment of the app holds yet. */
  needs: z.array(
    z.object({
      resourceId: z.string().uuid(),
      slug: z.string(),
      displayName: z.string(),
      keys: z.array(z.string()),
    })
  ),
  /** Declared keys that match no shared resource. */
  unmatched: z.array(z.string()).default([]),
  /** The PR head the scan read. */
  sha: z.string().nullable().optional(),
})
export type SessionShipConfigNeedsData = z.infer<typeof sessionShipConfigNeedsDataSchema>

/**
 * GitHub check-run / commit-status states, folded to one verdict (`prChecksSchema`, `ship.ci`).
 * Declared above the events because `ship.ci` carries one.
 */
export const PR_CHECK_STATES = ['pending', 'success', 'failure', 'none'] as const
export const prCheckStateSchema = z.enum(PR_CHECK_STATES)
export type PrCheckState = z.infer<typeof prCheckStateSchema>

// ---- landing: what follows the PR (issue #5, `docs/plans/i5-ship-to-staging.md`) --------------

/**
 * `sessions.landing.stage` (plan §1.1). Phase A, status `shipping`: `ci → [approval] → merging`;
 * Phase B, status `shipped`: `releasing → deploying → live | stalled`. `pr` is the `pr` ship mode's
 * only stage: the PR is open and Launch follows it no further.
 */
export const SHIP_LANDING_STAGES = [
  'ci',
  'approval',
  'merging',
  'releasing',
  'deploying',
  'live',
  'pr',
  'stalled',
] as const
export const shipLandingStageSchema = z.enum(SHIP_LANDING_STAGES)
export type ShipLandingStage = z.infer<typeof shipLandingStageSchema>

/** The stages a landing is still moving through — what the safety-net cron wakes (plan §1.4). */
export const MOVING_LANDING_STAGES = [
  'ci',
  'approval',
  'merging',
  'releasing',
  'deploying',
] as const satisfies readonly ShipLandingStage[]

/** Why a landing stalled after the merge (decision §0.1: it never reopens). */
export const SHIP_STALLED_REASONS = [
  'release_failed',
  'deploy_failed',
  'deploy_timeout',
  'unhealthy',
] as const
export const shipStalledReasonSchema = z.enum(SHIP_STALLED_REASONS)
export type ShipStalledReason = z.infer<typeof shipStalledReasonSchema>

/** Why a landing gave the session back before the merge (`ship.reopened`, `land.reopen#N`). */
export const SHIP_REOPEN_REASONS = [
  'ci_failed',
  'ci_timeout',
  'ci_none',
  'head_moved',
  'pr_closed',
  'review_rejected',
  'review_expired',
  'merge_refused',
] as const
export const shipReopenReasonSchema = z.enum(SHIP_REOPEN_REASONS)
export type ShipReopenReason = z.infer<typeof shipReopenReasonSchema>

/**
 * How the landing's review was decided when `ship.pr` snapshotted it: the app's own setting (the
 * `SHIP_REVIEW_MODES` of `launch-apps`), or `policy` — an admin `approval_policies` row for
 * `session.merge` made review mandatory (plan §1.11).
 */
export const LANDING_REVIEW_MODES = ['none', 'app_owners', 'groups', 'policy'] as const
export const landingReviewModeSchema = z.enum(LANDING_REVIEW_MODES)
export type LandingReviewMode = z.infer<typeof landingReviewModeSchema>

/** CI watch (plan §1.4): give up after this long; "no check ever reported" after the grace refuses. */
export const SHIP_CI_MAX_MINUTES = 120
export const SHIP_CI_NONE_GRACE_MINUTES = 10

/** An ISO timestamp inside a jsonb column (a string both ways, so the row round-trips unchanged). */
const isoTimestampSchema = z.string().datetime({ offset: true })

/**
 * `sessions.landing` (jsonb; null before a ship reaches its PR, and again after a reopen). The
 * stage is what the Workflow's `land` steps read; every other field is what a stage recorded.
 * Written by `ship.pr`, then only by compare-and-set on `landing->>'stage'`.
 */
export const sessionLandingSchema = z.object({
  /** The app's `sessionShip` at `ship.pr` (`SESSION_BACKEND=local` forces `pr`). */
  mode: sessionShipModeSchema,
  stage: shipLandingStageSchema,
  prNumber: z.number().int().positive(),
  /** `sessions.head_sha` after `ship.commit`: the only head Launch reads CI on and merges. */
  gateSha: z.string(),
  startedAt: isoTimestampSchema,
  /** When `stage` last changed — the safety-net cron wakes a landing quiet for three rounds. */
  stageAt: isoTimestampSchema,
  reviewMode: landingReviewModeSchema,
  /** The `session.merge` approval, once `land.review` opened it. */
  approvalId: z.string().uuid().nullable().default(null),
  mergeSha: z.string().nullable().default(null),
  mergedAt: isoTimestampSchema.nullable().default(null),
  releaseId: z.string().uuid().nullable().default(null),
  version: z.string().nullable().default(null),
  tag: z.string().nullable().default(null),
  /** Staging's `app_environments.url`, once live. */
  stagingUrl: z.string().nullable().default(null),
  /** The container was backed up and destroyed while waiting (plan §1.7): a reopen suspends. */
  containerReleased: z.boolean().default(false),
  stalledReason: shipStalledReasonSchema.nullable().default(null),
  /** A sentence for the person: why it stalled, or what the last round saw. */
  error: z.string().nullable().default(null),
})
export type SessionLanding = z.infer<typeof sessionLandingSchema>

/** The ship summary's caps (plan §1.15). */
export const SHIP_SUMMARY_TITLE_MAX = 200
export const SHIP_SUMMARY_BODY_MAX = 4000
export const SHIP_SUMMARY_DIFFSTAT_MAX = 6000

/**
 * `sessions.ship_summary` (jsonb): the PR's title and body as Launch wrote them, kept on the
 * session because the squash message, the `session.merge` context and the pipeline strip all read
 * it after the PR. `body` is without Launch's "Opened by Launch…" footer. Written by
 * `openShipPullRequest` in the CAS that records the PR number; overwritten on a re-ship.
 */
export const sessionShipSummarySchema = z.object({
  title: z.string().max(SHIP_SUMMARY_TITLE_MAX),
  body: z.string().max(SHIP_SUMMARY_BODY_MAX),
  /** `model`: the summary call wrote it; `fallback`: Launch's own, from the commits. */
  source: z.enum(['model', 'fallback']),
  diffStat: z.string().max(SHIP_SUMMARY_DIFFSTAT_MAX),
  prNumber: z.number().int().positive(),
  gateSha: z.string().nullable(),
  at: isoTimestampSchema,
})
export type SessionShipSummary = z.infer<typeof sessionShipSummarySchema>

/** `ship.ci` — one CI round on the gate SHA, and the failing check when red. */
export const sessionShipCiDataSchema = z.object({
  state: prCheckStateSchema,
  headSha: z.string(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  failedCheck: z
    .object({
      name: z.string(),
      url: z.string().nullable(),
      /** The last lines of its log (or its annotations), redacted like the gate's output. */
      logTail: z.string().optional(),
    })
    .optional(),
})
export type SessionShipCiData = z.infer<typeof sessionShipCiDataSchema>

export const SHIP_REVIEW_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'expired',
  'cancelled',
] as const
/** `ship.review` — the `session.merge` approval opened or settled. */
export const sessionShipReviewDataSchema = z.object({
  status: z.enum(SHIP_REVIEW_STATUSES),
  approvalId: z.string().uuid(),
  /** Who decided, by name. */
  by: z.string().optional(),
  /** The decision's comment. */
  note: z.string().optional(),
})
export type SessionShipReviewData = z.infer<typeof sessionShipReviewDataSchema>

/** `ship.merged` — the PR was squash-merged (by Launch, or by a person meanwhile). */
export const sessionShipMergedDataSchema = z.object({
  number: z.number().int().positive(),
  sha: z.string(),
  url: z.string(),
  approvalId: z.string().uuid().nullable(),
})
export type SessionShipMergedData = z.infer<typeof sessionShipMergedDataSchema>

/** `ship.released` — the release that carries the merge; `shared` when another merge cut it. */
export const sessionShipReleasedDataSchema = z.object({
  releaseId: z.string().uuid(),
  version: z.string(),
  tag: z.string(),
  shared: z.boolean(),
})
export type SessionShipReleasedData = z.infer<typeof sessionShipReleasedDataSchema>

export const SHIP_STAGING_STATUSES = [
  'deploying',
  'active',
  'live',
  'failed',
  'unhealthy',
  'timeout',
] as const
/** `ship.staging` — the release's staging deploy and health, up to live. */
export const sessionShipStagingDataSchema = z.object({
  status: z.enum(SHIP_STAGING_STATUSES),
  version: z.string(),
  url: z.string().nullable(),
  health: healthStatusSchema.optional(),
  error: z.string().optional(),
})
export type SessionShipStagingData = z.infer<typeof sessionShipStagingDataSchema>

/** `ship.reopened` — the landing gave the session back (before the merge only). */
export const sessionShipReopenedDataSchema = z.object({
  reason: shipReopenReasonSchema,
  message: z.string(),
})
export type SessionShipReopenedData = z.infer<typeof sessionShipReopenedDataSchema>

/** Event type → the schema its `data` parses with; one lookup for the timeline and the projection. */
export const SESSION_EVENT_DATA = {
  'user.message': sessionUserMessageDataSchema,
  'turn.start': sessionTurnStartDataSchema,
  text: agentTextEventDataSchema,
  'tool.start': agentToolStartEventDataSchema,
  'tool.end': agentToolEndEventDataSchema,
  'turn.end': sessionTurnEndDataSchema,
  'turn.failed': sessionTurnFailedDataSchema,
  'turn.interrupted': sessionTurnInterruptedDataSchema,
  step: agentStepEventDataSchema,
  status: agentStatusEventDataSchema,
  'preview.ready': sessionPreviewReadyDataSchema,
  'budget.reached': sessionBudgetReachedDataSchema,
  'ship.gate': sessionShipGateDataSchema,
  'ship.pr': sessionShipPrDataSchema,
  error: agentErrorEventDataSchema,
  'ship.config_needs': sessionShipConfigNeedsDataSchema,
  'ship.ci': sessionShipCiDataSchema,
  'ship.review': sessionShipReviewDataSchema,
  'ship.merged': sessionShipMergedDataSchema,
  'ship.released': sessionShipReleasedDataSchema,
  'ship.staging': sessionShipStagingDataSchema,
  'ship.reopened': sessionShipReopenedDataSchema,
} as const satisfies Record<SessionEventType, z.ZodTypeAny>

/** One `session_events` row. `data` stays `unknown` so a row from a newer server still lists. */
export const sessionEventSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  /** Position in the session's stream, from 1. Unique per session. */
  seq: z.number().int().positive(),
  /** The turn it belongs to; 0 for boot and lifecycle rows. */
  turn: z.number().int().nonnegative(),
  type: sessionEventTypeSchema,
  data: z.unknown(),
  at: z.coerce.date(),
})
export type SessionEvent = z.infer<typeof sessionEventSchema>

/**
 * Launch's own AG-UI `CUSTOM` event on a session's read stream (`GET /api/sessions/:id/agui/stream`,
 * `services/sessions/agui-projection.ts`): an app's prefix (`launch.`), never the kit's `kit.`.
 * Its `value` is one `session_events` row as `sessionEventSchema` draws it (`at` an ISO string on
 * the wire) — the facts with no AG-UI frame of their own: `turn.end` / `turn.failed` /
 * `turn.interrupted`, `status`, `preview.ready`, `budget.reached`, `ship.*`, `error`.
 */
export const SESSION_CUSTOM_EVENTS = {
  event: 'launch.session.event',
} as const
export const sessionCustomEventValueSchema = sessionEventSchema
export type SessionCustomEventValue = z.infer<typeof sessionCustomEventValueSchema>

/** What a writer hands the event log (the Workflow assigns `seq` and `at`). */
export interface SessionEventInput<T extends SessionEventType = SessionEventType> {
  type: T
  turn: number
  data: z.infer<(typeof SESSION_EVENT_DATA)[T]>
}

// ---- policy ------------------------------------------------------------------------------------

/**
 * `launch_settings.session_policy`, with code defaults, snapshotted on `sessions.policy` at create
 * so a policy edit never changes a session already running. `model` is the ONLY model the model
 * proxy lets through for the session.
 */
export const sessionPolicySchema = z.object({
  model: z.string().trim().min(1).max(100),
  maxSessionUsd: z.number().positive().max(10_000),
  appMonthlyUsd: z.number().positive().max(1_000_000),
  maxConcurrentPerApp: z.number().int().positive().max(25),
  maxTurnMinutes: z.number().int().positive().max(120),
  idleSuspendMinutes: z.number().int().positive().max(1440),
  suspendedExpiryHours: z.number().int().positive().max(720),
  maxSessionHours: z.number().int().positive().max(168),
  maxTurns: z.number().int().positive().max(1000),
})
export type SessionPolicy = z.infer<typeof sessionPolicySchema>

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  model: 'claude-sonnet-4-5',
  maxSessionUsd: 10,
  appMonthlyUsd: 200,
  maxConcurrentPerApp: 3,
  maxTurnMinutes: 20,
  idleSuspendMinutes: 30,
  suspendedExpiryHours: 24,
  maxSessionHours: 8,
  maxTurns: 100,
}

/** A stored policy with the defaults filled in; an unparseable one is the defaults. */
export function resolveSessionPolicy(stored: unknown): SessionPolicy {
  const partial = sessionPolicySchema.partial().safeParse(stored)
  return partial.success ? { ...DEFAULT_SESSION_POLICY, ...partial.data } : DEFAULT_SESSION_POLICY
}

/** Microcents (1/1 000 000 of a cent) per USD — `ai_usage.cost_microcents`'s unit. */
export const MICROCENTS_PER_USD = 100_000_000
export const usdToMicrocents = (usd: number): number => Math.round(usd * MICROCENTS_PER_USD)
export const microcentsToUsd = (microcents: number): number => microcents / MICROCENTS_PER_USD

// ---- jsonb shapes ------------------------------------------------------------------------------

/**
 * `sessions.db` — where the session's database lives. NON-secret: the connection string is sealed
 * separately in `db_uri_sealed`. `neon`: a branch of the app's `dev` branch — every session's,
 * under either `SESSION_BACKEND`. `local` is only read back: rows written by the laptop-Postgres
 * session database Launch no longer has.
 */
export const sessionDbSchema = z.object({
  provider: z.enum(['neon', 'local']),
  projectId: z.string().nullable(),
  branchId: z.string(),
  host: z.string(),
  database: z.string(),
  role: z.string(),
})
export type SessionDb = z.infer<typeof sessionDbSchema>

export const APP_SESSION_DB_STATUSES = ['none', 'preparing', 'ready', 'failed'] as const

/**
 * `apps.session_db` — the app's prepared `dev` branch, which sessions branch from. `preparedCommit`
 * is the commit the prepare run migrated and seeded at; a newer `main` re-prepares.
 */
export const appSessionDbSchema = z.object({
  devBranchId: z.string().nullable(),
  database: z.string(),
  preparedCommit: z.string().nullable(),
  preparedAt: z.coerce.date().nullable(),
  status: z.enum(APP_SESSION_DB_STATUSES),
  /**
   * While `preparing`: the session holding the claim and since when. A claim whose session is no
   * longer active, or older than 30 minutes, may be taken over (`claimDevPrepare`).
   */
  preparingSessionId: z.string().optional(),
  preparingSince: z.string().optional(),
  /**
   * The prepared checkout's `apps/web/migrations` hash: a session branched from a `ready` `dev`
   * starts from it, so its bootstrap never re-seeds and migrates only when its migrations differ.
   * Missing on a `dev` prepared before it was recorded.
   */
  migrationsHash: z.string().optional(),
})
export type AppSessionDb = z.infer<typeof appSessionDbSchema>

/**
 * `sessions.pr_checks` — the PR head's CI, from check runs plus the combined status. Refreshed when
 * read (at most every 30 s) and by the five-minute cron while `pending`.
 */
export const prChecksSchema = z.object({
  state: prCheckStateSchema,
  headSha: z.string().nullable(),
  checkedAt: z.coerce.date(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  checks: z.array(
    z.object({
      name: z.string(),
      /** `check_run` or `status` (a commit status context). */
      source: z.enum(['check_run', 'status']),
      state: prCheckStateSchema,
      url: z.string().nullable(),
    })
  ),
})
export type PrChecks = z.infer<typeof prChecksSchema>

// ---- requests ----------------------------------------------------------------------------------

/** A branch, tag or sha to start from. Git's own rules, minus the characters a shell would read. */
const gitRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])$/, 'A branch, tag or commit')

/** `POST /api/apps/:id/sessions`. */
export const createSessionRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  /** Defaults to the app's default branch. */
  baseRef: gitRefSchema.optional(),
})
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>

export const SESSION_MESSAGE_MAX = 20_000

/** `POST /api/sessions/:id/turns`. */
export const sessionTurnRequestSchema = z.object({
  message: z.string().trim().min(1).max(SESSION_MESSAGE_MAX),
})
export type SessionTurnRequest = z.infer<typeof sessionTurnRequestSchema>

/** `POST /api/sessions/:id/budget` — owners and admins; audited `session.budget.extended`. */
export const extendBudgetSchema = z.object({
  extraUsd: z.number().positive().max(1000),
  /** P4: why — shown on the `session.budget` approval the request opens (plan §4c). */
  reason: z.string().trim().max(1000).optional(),
})
export type ExtendBudgetRequest = z.infer<typeof extendBudgetSchema>

/** `GET /api/apps/:id/sessions` and `GET /api/admin/sessions`. */
export const sessionListQuerySchema = z.object({
  scope: z.enum(['active', 'all']).default('active'),
})
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>

/** `GET /api/sessions/:id/events` (and the AG-UI stream's `?afterSeq=`). */
export const sessionEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().optional(),
})
export type SessionEventsQuery = z.infer<typeof sessionEventsQuerySchema>

// ---- responses ---------------------------------------------------------------------------------

/** What a session cost and may cost, in microcents. */
export const sessionBudgetSchema = z.object({
  spentMicrocents: z.number().int().nonnegative(),
  /** `policy.maxSessionUsd` plus every extension. */
  capMicrocents: z.number().int().nonnegative(),
  extraMicrocents: z.number().int().nonnegative(),
})
export type SessionBudget = z.infer<typeof sessionBudgetSchema>

/** One row in a list: the app's sessions card, the admin page, `launch sessions ls`. */
export const sessionSummarySchema = z.object({
  id: z.string().uuid(),
  appId: z.string().uuid(),
  kind: sessionKindSchema,
  shortId: z.string(),
  title: z.string().nullable(),
  status: sessionStatusSchema,
  createdByUserId: z.string().uuid().nullable(),
  branch: z.string().nullable(),
  turnCount: z.number().int().nonnegative(),
  costMicrocents: z.number().int().nonnegative(),
  prNumber: z.number().int().positive().nullable(),
  prUrl: z.string().nullable(),
  lastActivityAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>

/** `GET /api/sessions/:id` — everything the session page draws. No token, no sealed column. */
export const sessionSchema = sessionSummarySchema.extend({
  baseRef: z.string().nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  requestedAction: sessionActionSchema.nullable(),
  /** A turn is waiting for the Workflow to pick it up. */
  pendingMessage: z.boolean(),
  cancelRequested: z.boolean(),
  imageVersion: z.string().nullable(),
  policy: sessionPolicySchema,
  usage: sessionUsageSchema,
  budget: sessionBudgetSchema,
  containerSeconds: z.number().int().nonnegative(),
  prChecks: prChecksSchema.nullable(),
  error: z.string().nullable(),
  readyAt: z.coerce.date().nullable(),
  suspendedAt: z.coerce.date().nullable(),
  endedAt: z.coerce.date().nullable(),
  updatedAt: z.coerce.date(),
  /** Whether the caller may ship, end, extend (the creator, the app's owners, admins). */
  viewerCanManage: z.boolean(),
  /** Issue #5: where the ship stands after its PR; null before one, and after a reopen. */
  landing: sessionLandingSchema.nullable().default(null),
  /** Issue #5: the PR's title and body as Launch wrote them; null before the first ship. */
  shipSummary: sessionShipSummarySchema.nullable().default(null),
})
export type Session = z.infer<typeof sessionSchema>

export const sessionDetailResponseSchema = z.object({ session: sessionSchema })
export type SessionDetailResponse = z.infer<typeof sessionDetailResponseSchema>

/**
 * `POST /api/sessions/:id/budget` (P4, plan §4c) — the session as it is now, plus the
 * `session.budget` approval the call opened or joined. 200 when the caller's own approval raised
 * the cap in the same call; 202 when the request waits in the approvals inbox. `approvalId` is
 * optional and nullable so a P3-shaped answer still parses.
 */
export const extendBudgetResponseSchema = sessionDetailResponseSchema.extend({
  approvalId: z.string().uuid().nullable().optional(),
})
export type ExtendBudgetResponse = z.infer<typeof extendBudgetResponseSchema>

export const sessionListResponseSchema = z.object({ items: z.array(sessionSummarySchema) })
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>

/** `GET /api/sessions/:id/events`. `nextSeq` is the cursor to pass as `afterSeq`. */
export const sessionEventsResponseSchema = z.object({
  items: z.array(sessionEventSchema),
  nextSeq: z.number().int().nonnegative(),
})
export type SessionEventsResponse = z.infer<typeof sessionEventsResponseSchema>

/** `POST /api/sessions/:id/cancel`. */
export const sessionCancelResponseSchema = z.object({ cancelRequested: z.literal(true) })

/** `POST /api/sessions/:id/preview-grant` — load `url` in the iframe within `expiresAt`. */
export const previewGrantResponseSchema = z.object({
  url: z.string(),
  expiresAt: z.coerce.date(),
})
export type PreviewGrantResponse = z.infer<typeof previewGrantResponseSchema>

/** `GET /api/sessions/:id/pr`. */
export const sessionPrResponseSchema = z.object({
  prNumber: z.number().int().positive().nullable(),
  prUrl: z.string().nullable(),
  checks: prChecksSchema.nullable(),
})
export type SessionPrResponse = z.infer<typeof sessionPrResponseSchema>

/** `GET /api/admin/sessions` — a live session with the app it belongs to. */
export const adminSessionSchema = sessionSummarySchema.extend({
  appSlug: z.string(),
  tenantId: z.string().uuid(),
  imageVersion: z.string().nullable(),
  containerSeconds: z.number().int().nonnegative(),
})
export type AdminSession = z.infer<typeof adminSessionSchema>

export const adminSessionListResponseSchema = z.object({
  items: z.array(adminSessionSchema),
  /** `launch_settings.sessions_paused`: new sessions are refused while true. */
  paused: z.boolean(),
})
export type AdminSessionListResponse = z.infer<typeof adminSessionListResponseSchema>

/** `POST /api/admin/sessions/drain` and `/undrain`. */
export const drainResponseSchema = z.object({
  paused: z.boolean(),
  /** How many live sessions the drain asked to suspend (0 on an undrain). */
  suspended: z.number().int().nonnegative(),
})
export type DrainResponse = z.infer<typeof drainResponseSchema>

// ---- ids, branches and preview hosts -----------------------------------------------------------

/** 12 lower-case base32 characters (RFC 4648 alphabet): a DNS-safe, unguessable short id. */
export const SESSION_SHORT_ID_RE = /^[a-z2-7]{12}$/
/** 10 lower-case alphanumerics — the preview host's second secret. */
export const PREVIEW_TOKEN_RE = /^[a-z0-9]{10}$/

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomChars(alphabet: string, length: number): string {
  // Rejection sampling, so every character is equally likely even when 256 % alphabet ≠ 0.
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2))
    for (const b of bytes) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length]
    }
  }
  return out
}

/** A fresh `sessions.short_id`. */
export const newSessionShortId = (): string => randomChars(BASE32, 12)
/** A fresh `sessions.preview_token`. */
export const newPreviewToken = (): string => randomChars(ALNUM, 10)

/** The git branch a session works on: `session/<shortId>`. */
export const sessionBranchName = (shortId: string): string => `session/${shortId}`

/** The DNS label of one preview port: `<port>-<shortId>-<token>`. */
export function previewLabel(port: number, shortId: string, token: string): string {
  return `${port}-${shortId}-${token}`
}

/**
 * `SESSION_PREVIEW_URL` with the label filled in — `https://{label}.clewro.com` →
 * `https://5173-abcdefghijkl-0123456789.clewro.com`. No trailing slash.
 */
export function previewUrl(template: string, label: string): string {
  return template.replace('{label}', label).replace(/\/+$/, '')
}

export interface PreviewHost {
  port: number
  shortId: string
  token: string
}

const LABEL_RE = /^(\d{2,5})-([a-z2-7]{12})-([a-z0-9]{10})$/

/**
 * The preview a request's `Host` names, or null when it is not a preview host of `template`. The
 * suffix is whatever follows `{label}` in the template's host (`.clewro.com`, `.localhost:3001`),
 * compared case-insensitively and INCLUDING the port, so `launch.clewro.com` itself is never one.
 */
export function parsePreviewHost(host: string, template: string): PreviewHost | null {
  const templateHost = template.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? ''
  const at = templateHost.indexOf('{label}')
  if (at !== 0) return null
  const suffix = templateHost.slice('{label}'.length).toLowerCase()
  const candidate = host.trim().toLowerCase()
  if (!suffix || !candidate.endsWith(suffix)) return null
  const match = LABEL_RE.exec(candidate.slice(0, candidate.length - suffix.length))
  if (!match) return null
  const port = Number(match[1])
  if (port < 1 || port > 65_535) return null
  return { port, shortId: match[2] as string, token: match[3] as string }
}
