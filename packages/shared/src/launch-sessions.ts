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
 * - the preview host grammar: `previewLabel()` / `parsePreviewHost()` / `previewUrl()`, and the
 *   preview's page paths (`safePreviewPath()`, the bridge's `previewLocationMessageSchema`).
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
import {
  AGENT_RUNTIMES,
  type AgentRuntimeId,
  agentRuntimeSchema,
  DEFAULT_AGENT_RUNTIME,
  sessionCredentialModeSchema,
  sessionCredentialSourceSchema,
} from './launch-agents'
import { healthStatusSchema, KIT_REQUIRED_CHECK, sessionShipModeSchema } from './launch-apps'

// ---- enums -------------------------------------------------------------------------------------

/**
 * `session` is a person's chat; `prepare` is the one-off run that migrates and seeds `dev`;
 * `upgrade` (P6 6c) is a coding session started to upgrade the app's kit — a `session` in every
 * respect, plus its `upgrade_id`, the first turn's auto-ship, a push token that may change
 * `.github/workflows/**`, and therefore NO human input ({@link sessionTakesMessages}).
 * Append-only (a pg enum).
 */
export const SESSION_KINDS = ['session', 'prepare', 'upgrade'] as const
export const sessionKindSchema = z.enum(SESSION_KINDS)
export type SessionKind = z.infer<typeof sessionKindSchema>

/**
 * The kinds that are a coding session a person works in — a branch, a sandbox, a chat — as
 * opposed to `prepare`. What the concurrency count, the app's session list and the cleanup of a
 * session's branch select by.
 */
export const CODING_SESSION_KINDS = ['session', 'upgrade'] as const satisfies readonly SessionKind[]

/**
 * Whether a person may steer the session — send a message, attach an image, take a screenshot
 * for one, withdraw what waits. Never a kit upgrade's: its push token carries `workflows: write`
 * (it edits the app's CI workflows), so nobody may put words in front of it. Launch's own turns —
 * the upgrade prompt, a ship's fix turns — still run. Every refusing route answers 403
 * {@link UPGRADE_SESSION_READ_ONLY_CODE}.
 */
export function sessionTakesMessages(session: { kind: SessionKind }): boolean {
  return session.kind !== 'upgrade'
}

/** The 403 code of a person's input to a kit upgrade session ({@link sessionTakesMessages}). */
export const UPGRADE_SESSION_READ_ONLY_CODE = 'upgrade_session_read_only'

/** That 403's message — what the CLI prints and the session page says instead of a composer. */
export const UPGRADE_SESSION_READ_ONLY_MESSAGE =
  "Launch is running this kit upgrade on its own; it can't take messages because it can change the app's CI workflows."

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
  // Issue #3: a workspace backup taken before a container was destroyed — or why there is none.
  'workspace.backup',
  // Issue #8: how long each phase of a boot took, written once when the boot is done.
  'boot.timing',
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

/** The image types a message may carry — what Claude and Codex both read. */
export const SESSION_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const
export const sessionAttachmentMimeTypeSchema = z.enum(SESSION_ATTACHMENT_MIME_TYPES)
export type SessionAttachmentMimeType = z.infer<typeof sessionAttachmentMimeTypeSchema>

export function isSessionAttachmentMimeType(value: string): value is SessionAttachmentMimeType {
  return (SESSION_ATTACHMENT_MIME_TYPES as readonly string[]).includes(value)
}

/** One image's cap: Anthropic's per-image limit. */
export const SESSION_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024
/** Images per message. */
export const SESSION_ATTACHMENTS_MAX = 5
/**
 * The longest edge the composer downscales an image to before it uploads it: past this Anthropic
 * resizes it anyway, so the extra pixels only cost upload time and tokens.
 */
export const SESSION_ATTACHMENT_MAX_EDGE = 1568

/** An image a message carries, by id — its bytes are `GET /api/sessions/:id/attachments/:aid`. */
export const sessionAttachmentSchema = z.object({
  id: z.string().uuid(),
  contentType: sessionAttachmentMimeTypeSchema,
})
export type SessionAttachment = z.infer<typeof sessionAttachmentSchema>

/** Where an image's bytes are read (same origin, the session cookie): `GET` streams it. */
export function sessionAttachmentPath(sessionId: string, attachmentId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`
}

export const sessionUserMessageDataSchema = z.object({
  text: z.string(),
  userId: z.string().uuid().nullable(),
  /** The images sent with it, in order (absent on rows written before images, and with none). */
  attachments: z.array(sessionAttachmentSchema).optional(),
})
export const sessionTurnStartDataSchema = z.object({
  turn: z.number().int().positive(),
  /** The model the turn runs on (the policy's, after any switch the message asked for); null: the agent's own default. */
  model: z.string().nullable().optional(),
})
export const sessionTurnEndDataSchema = z
  .object({
    turn: z.number().int().positive(),
    /** Claude Code's `result` line: `success` / `error_max_turns` / … */
    result: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    usage: sessionUsageSchema.partial().optional(),
    costMicrocents: z.number().int().nonnegative().optional(),
    /**
     * Issue #8: from the turn's start (Launch's clock, before the agent's process starts) to the
     * first thing the agent said or did — a text or a tool call. The agent streams whole messages,
     * so it is an upper bound on its first token. Absent on rows written before it was measured.
     */
    firstTokenMs: z.number().int().nonnegative().optional(),
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
     * Issue #9: the attempt's LAST step only — the git tree of the working tree as it stood when
     * the command ended (what the checkpoint would commit). `ship.commit` refuses any other tree.
     */
    tree: z.string().optional(),
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

/**
 * Why a landing stalled after the merge (decision §0.1: it never reopens). `main_ci_failed` (issue
 * #11): the squash commit's own `Gate` went red on the default branch, so no release was cut.
 */
export const SHIP_STALLED_REASONS = [
  'release_failed',
  'deploy_failed',
  'deploy_timeout',
  'unhealthy',
  'main_ci_failed',
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
/**
 * Issue #11, `land.main-ci` (Phase B, before the release): how long Launch waits for the SQUASH
 * commit's `Gate` on the default branch before cutting the release anyway (the tag's deploy then
 * re-gates, as before issue #11), and how long a commit with no check at all (a repository whose
 * CI does not run on a push to main) is given before the release goes ahead. Both from the landing
 * reaching `releasing`.
 */
export const SHIP_MAIN_CI_MAX_MINUTES = 30
export const SHIP_MAIN_CI_NONE_GRACE_MINUTES = 3

/**
 * Issue #11: what `land.main-ci` decided the release on — the squash commit's `Gate` green
 * (`success`: the tag's deploy can skip its gate), no check reported within the grace (`none`), or
 * still running past {@link SHIP_MAIN_CI_MAX_MINUTES} (`timeout`). A red one stalls instead —
 * until a person presses Release anyway on the stall (`override`, issue #21: the tag's deploy
 * re-gates).
 */
export const SHIP_MAIN_CI_VERDICTS = ['success', 'none', 'timeout', 'override'] as const
export const shipMainCiVerdictSchema = z.enum(SHIP_MAIN_CI_VERDICTS)
export type ShipMainCiVerdict = z.infer<typeof shipMainCiVerdictSchema>

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
  /**
   * Issue #9: the git TREE of that commit (`HEAD^{tree}`) — the content the green gate ran on,
   * asserted equal at `ship.commit` and attested as the `launch/gate` check's `external_id`. Null on
   * a landing written before issue #9 (or a ship whose gate recorded no tree).
   */
  gateTree: z.string().nullable().default(null),
  startedAt: isoTimestampSchema,
  /** When `stage` last changed — the safety-net cron wakes a landing quiet for three rounds. */
  stageAt: isoTimestampSchema,
  reviewMode: landingReviewModeSchema,
  /** The `session.merge` approval, once `land.review` opened it. */
  approvalId: z.string().uuid().nullable().default(null),
  mergeSha: z.string().nullable().default(null),
  mergedAt: isoTimestampSchema.nullable().default(null),
  /**
   * Issue #11: `land.main-ci`'s verdict on the merge commit's `Gate` (`sha`) and when it was
   * reached — the release follows it. Null until then (and on a landing written before issue #11).
   */
  mainCi: z
    .object({ verdict: shipMainCiVerdictSchema, sha: z.string(), at: isoTimestampSchema })
    .nullable()
    .default(null),
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
  /** Issue #9: `gateSha`'s tree — what the gate ran on (`sessionLandingSchema.gateTree`). */
  gateTree: z.string().nullable().default(null),
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
  /**
   * Who merged it: Launch's squash, or a person on GitHub (during the landing, or a merge the
   * `sessions.checks` cron adopted). Absent on rows written before it existed.
   */
  by: z.enum(['launch', 'github']).optional(),
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

/**
 * `workspace.backup` — one workspace backup attempt (`SESSION_WORKSPACE_BACKUP`), written when a
 * suspend, a cool or a landing destroys the container. `saved`: the archive is in R2 and on the row
 * (`sessions.workspace_backup`). `failed`: why not — a backup never fails the suspend, so this is
 * the one record of why the next cold resume clones and installs. No row when backups are off.
 */
export const sessionWorkspaceBackupDataSchema = z.object({
  status: z.enum(['saved', 'failed']),
  /** `binding` or `presigned` (`workspace-backup.ts`). */
  mode: z.string(),
  /** `failed` only: the secret-free reason. */
  reason: z.string().optional(),
  /** How long the backup took, the HEAD check included. */
  durationMs: z.number().int().nonnegative().optional(),
  /** `saved` only: the commit the archive holds. */
  headSha: z.string().optional(),
})
export type SessionWorkspaceBackupData = z.infer<typeof sessionWorkspaceBackupDataSchema>

/**
 * Issue #8: the phases a `boot.timing` row names — the boot checklist's steps (`sandbox.start` is
 * the checklist's `sandbox`), with its `bootstrap` step split into the dependency install and the
 * kit bootstrap after it. A boot lists only the phases it ran, in the order they started.
 */
export const BOOT_TIMING_PHASES = [
  'db',
  'prepare',
  'branch',
  'sandbox.start',
  'restore',
  'repo',
  'install',
  'bootstrap',
  'dev',
  'transcript',
] as const
export const bootTimingPhaseSchema = z.enum(BOOT_TIMING_PHASES)
export type BootTimingPhase = z.infer<typeof bootTimingPhaseSchema>

/** A first boot, a resume onto the kept container, or a resume that booted a new one. */
export const BOOT_TIMING_KINDS = ['boot', 'warm', 'cold'] as const
export const bootTimingKindSchema = z.enum(BOOT_TIMING_KINDS)
export type BootTimingKind = z.infer<typeof bootTimingKindSchema>

/**
 * `boot.timing` (issue #8) — ONE row when a boot (or a resume) is done: what each phase took, by
 * the clock of the step that ran it. `startMs` is from the boot's first phase, so phases that run
 * alongside each other overlap and `totalMs` (first start → last end) is less than their sum.
 * Ids and numbers only.
 */
export const sessionBootTimingDataSchema = z
  .object({
    kind: bootTimingKindSchema,
    totalMs: z.number().int().nonnegative(),
    phases: z.array(
      z.object({
        phase: bootTimingPhaseSchema,
        startMs: z.number().int().nonnegative(),
        ms: z.number().int().nonnegative(),
      })
    ),
    /** The boot's trace in `ai_spans` (`launch traces show <id>`), when one was recorded. */
    traceId: z.string().optional(),
  })
  .passthrough()
export type SessionBootTimingData = z.infer<typeof sessionBootTimingDataSchema>

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
  'workspace.backup': sessionWorkspaceBackupDataSchema,
  'boot.timing': sessionBootTimingDataSchema,
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
 * `turn.interrupted`, `status`, `preview.ready`, `budget.reached`, `ship.*`, `error`, `boot.timing`.
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
 * A session's model: a pinned id, or null — the coding agent's OWN default (Claude Code and Codex
 * pick their model as they would on a laptop; Launch passes no model flag). Null is the default.
 */
export const sessionModelSchema = z.string().trim().min(1).max(100).nullable()
export type SessionModel = z.infer<typeof sessionModelSchema>

/**
 * `pending_model`'s value for "back to the agent's own default" — the column is text, and NULL
 * there already means "no switch asked for". Never a real model id.
 */
export const PENDING_MODEL_DEFAULT = 'default'

/**
 * One agent runtime under the session policy (§18.22): whether sessions may run it, its model
 * (null: the agent's own default), and whose account they bill. The ONE place these switches live
 * — a platform setting edited on the Platform → Coding agents tab
 * (`PUT /api/platform/setup/session-agents`), not a deployment var.
 */
export const runtimePolicySchema = z.object({
  enabled: z.boolean(),
  model: sessionModelSchema,
  credentialMode: sessionCredentialModeSchema,
})
export type RuntimePolicy = z.infer<typeof runtimePolicySchema>

/**
 * `launch_settings.session_policy`, with code defaults, snapshotted on `sessions.policy` at create
 * so a policy edit never changes a session already running. `model` is the CHOSEN runtime's model
 * once frozen on a row (`createSession`): pinned, it is the ONLY model the model proxy lets
 * through; null (the default), the agent picks its own and the proxy lets through any model of
 * the runtime's provider that Launch can price — budgets are money. `runtime` (the default a
 * session starts with) and `runtimes` (per-runtime settings) are optional: a stored policy without
 * them is Claude Code on Launch's key, exactly as before (`runtimePolicyOf`).
 */
export const sessionPolicySchema = z.object({
  model: sessionModelSchema,
  runtime: agentRuntimeSchema.optional(),
  runtimes: z.object(runtimesShape()).partial().optional(),
  maxSessionUsd: z.number().positive().max(10_000),
  appMonthlyUsd: z.number().positive().max(1_000_000),
  maxConcurrentPerApp: z.number().int().positive().max(25),
  maxTurnMinutes: z.number().int().positive().max(120),
  idleSuspendMinutes: z.number().int().positive().max(1440),
  suspendedExpiryHours: z.number().int().positive().max(720),
  maxSessionHours: z.number().int().positive().max(168),
  maxTurns: z.number().int().positive().max(1000),
  /**
   * Issue #17: how many WARM sessions — started when the person opened the composer (`warm`),
   * not written to yet — one person may hold at once, across the deployment's apps. Each still
   * counts against `maxConcurrentPerApp` too.
   */
  maxWarmPerUser: z.number().int().positive().max(25),
})
export type SessionPolicy = z.infer<typeof sessionPolicySchema>

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  model: null,
  maxSessionUsd: 10,
  appMonthlyUsd: 200,
  maxConcurrentPerApp: 3,
  maxTurnMinutes: 20,
  idleSuspendMinutes: 30,
  suspendedExpiryHours: 24,
  maxSessionHours: 8,
  maxTurns: 100,
  maxWarmPerUser: 2,
}

/** A stored policy with the defaults filled in; an unparseable one is the defaults. */
export function resolveSessionPolicy(stored: unknown): SessionPolicy {
  const partial = sessionPolicySchema.partial().safeParse(stored)
  return partial.success ? { ...DEFAULT_SESSION_POLICY, ...partial.data } : DEFAULT_SESSION_POLICY
}

function runtimesShape(): Record<AgentRuntimeId, typeof runtimePolicySchema> {
  return Object.fromEntries(AGENT_RUNTIMES.map(id => [id, runtimePolicySchema])) as Record<
    AgentRuntimeId,
    typeof runtimePolicySchema
  >
}

/**
 * Codex 0.160's own default model (§18.22-B) — the first of its bundled
 * `models-manager/models.json` by priority, "latest workhorse model for coding". Only the Setup
 * page's key check calls it: a session with no pinned model lets Codex choose.
 */
export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol'

/**
 * Claude Code's own default model today — only the Setup page's key check calls it: a session
 * with no pinned model lets Claude Code choose.
 */
export const DEFAULT_CLAUDE_CODE_MODEL = 'claude-opus-5-5'

/**
 * The policy for one runtime, defaults filled in. FAIL-CLOSED: with no `runtimes` entry Claude Code
 * runs on Launch's key only (on the policy's own `model` — so every policy stored before runtimes
 * existed is unchanged in effect) and every other runtime is OFF. Turning a runtime on, or letting
 * people bill their own account, is an admin's explicit choice on the Setup page, which stores an
 * entry; an entry is then taken as it stands.
 */
export function runtimePolicyOf(policy: SessionPolicy, runtime: AgentRuntimeId): RuntimePolicy {
  const stored = policy.runtimes?.[runtime]
  if (stored) return stored
  return runtime === 'claude_code'
    ? { enabled: true, model: policy.model, credentialMode: 'platform' }
    : { enabled: false, model: null, credentialMode: 'platform' }
}

/** The runtime a new session runs when the request names none. */
export function defaultRuntimeOf(policy: SessionPolicy): AgentRuntimeId {
  return policy.runtime ?? DEFAULT_AGENT_RUNTIME
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
export const APP_SESSION_DEV_SOURCES = ['staging', 'main'] as const
export type AppSessionDevSource = (typeof APP_SESSION_DEV_SOURCES)[number]

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
  /**
   * Where `dev` was cut from: `staging` (`parent-data`, then scrubbed of the app's data and its
   * inherited passwords before any session saw it) or `main` (`schema-only` — an app with no
   * staging branch). Recorded only once that scrub finished; missing on a `dev` cut before it was.
   */
  devSource: z.enum(APP_SESSION_DEV_SOURCES).optional(),
  /**
   * Issue #15: the version of `ensureDev`'s checks (the session role, the app's RLS role and its
   * grant, the database and its extensions) that last passed on this `dev`, and the RLS role name
   * they checked. A session on a `ready` `dev` whose record matches the running Launch skips
   * `ensureDev` and branches at once. Missing until the first `ensureDev` that records them.
   */
  roleVersion: z.number().int().positive().optional(),
  appRole: z.string().optional(),
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

/**
 * Issue #9: the check run Launch's GitHub App posts on a ship's pushed head after a GREEN sandbox
 * gate — `external_id` `tree:<HEAD^{tree}>`, conclusion `success` — so the kit's CI can skip the
 * gate it would only run again (the kit reads it; Launch never counts it as CI itself).
 */
export const LAUNCH_GATE_CHECK = 'launch/gate'

/** `launch/gate`'s `external_id` for a tree: `tree:<40-hex sha>`. */
export function launchGateExternalId(tree: string): string {
  return `tree:${tree}`
}

/**
 * Issue #9: the verdict a landing acts on — the REQUIRED check (`KIT_REQUIRED_CHECK`, `Gate`), not
 * the fold of every check (`PrChecks.state`, which stays what the panel shows): a red optional
 * check (an evals run) beside a green `Gate` does not stop a landing. Any `Gate` red → `failure`;
 * any still running → `pending`; all green → `success`. No `Gate` at all (an app on an older kit
 * whose CI job is named otherwise) → the fold over the other checks, as before issue #9: any red →
 * `failure`, all green → `success`, else `pending`; nothing reported → `none` (the `ci_none` grace:
 * a repo with no CI). Launch's own `launch/gate` is never CI here — it neither counts as `Gate`
 * nor as "something reported".
 */
export function requiredCheckState(checks: PrChecks['checks']): PrCheckState {
  const reported = checks.filter(c => c.name !== LAUNCH_GATE_CHECK)
  if (reported.length === 0) return 'none'
  const gate = reported.filter(c => c.name === KIT_REQUIRED_CHECK)
  const decides = gate.length > 0 ? gate : reported
  if (decides.some(c => c.state === 'failure')) return 'failure'
  if (decides.some(c => c.state !== 'success')) return 'pending'
  return 'success'
}

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
  /**
   * App page P2 ("Fix in a session"): seed the session with a failed release of THIS app — the
   * server writes its first message (the failed stage, the GitHub run and the tail of the failing
   * job's log when GitHub still has it) and the session takes it as its first turn once it is
   * ready. 409 `release_not_retryable` when the release is not failing.
   */
  fixRelease: z.object({ releaseId: z.string().uuid() }).optional(),
  /** §18.22: the coding agent (default: the policy's `runtime`, else Claude Code). */
  runtime: agentRuntimeSchema.optional(),
  /**
   * §18.22: whose account the session bills — `platform` (Launch's key) or `user` (the creator's
   * connected personal account). Default: `user` when the runtime's mode is `user`, else
   * `platform`. Fixed for the session's life.
   */
  credential: sessionCredentialSourceSchema.optional(),
  /**
   * Issue #17, warm on intent: the person opened the composer and has not written yet, so the
   * session boots while they type. The caller's own warm session on this app that nobody has
   * written to yet (same runtime and account, still booting or ready) is returned instead of a
   * second one; past `maxWarmPerUser` such sessions it is 409 `warm_session_limit`; and one
   * nobody writes to ends after `SESSION_WARM_START_MINUTES` quiet, its container destroyed and
   * no turn counted. Ignored for a seeded start (`fixRelease`), which has its first message.
   */
  warm: z.boolean().optional(),
})
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>

export const SESSION_MESSAGE_MAX = 20_000

/** `POST /api/sessions/:id/turns`. */
export const sessionTurnRequestSchema = z
  .object({
    /** May be empty when the message carries images. */
    message: z.string().trim().max(SESSION_MESSAGE_MAX).default(''),
    /**
     * Switch the session to this model from this turn on — one of `AGENT_RUNTIME_MODELS[runtime]`
     * that is priced, else 400 `model_not_offered`; null: back to the agent's own default. Absent:
     * the session's current model.
     */
    model: sessionModelSchema.optional(),
    /**
     * While a turn runs: `queue` (the default) runs this message when the turn ends; `interrupt`
     * also stops the turn — the same write asks for the cancel — so this message runs next, resuming
     * the conversation. Either way one message waits at most (409 `turn_in_progress`).
     */
    mode: z.enum(['queue', 'interrupt']).default('queue'),
    /**
     * Images uploaded first (`POST /:id/attachments`), by id, in order — each must be this
     * session's (400 `attachment_not_found` otherwise).
     */
    attachments: z.array(z.string().uuid()).max(SESSION_ATTACHMENTS_MAX).default([]),
  })
  .refine(body => body.message.length > 0 || body.attachments.length > 0, {
    path: ['message'],
    message: 'Write a message or attach an image',
  })
export type SessionTurnRequest = z.infer<typeof sessionTurnRequestSchema>
/** What a client sends (`mode` may be left out). */
export type SessionTurnRequestInput = z.input<typeof sessionTurnRequestSchema>

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
  /** §18.22: the coding agent this session runs — fixed at create, so the list names it. */
  runtime: agentRuntimeSchema.default(DEFAULT_AGENT_RUNTIME),
  /** §18.22: `platform` (Launch's key) or `user` (a personal account) — fixed at create. */
  credentialSource: sessionCredentialSourceSchema.default('platform'),
  /** The model the session runs now (`policy.model`); null: the agent's own default. */
  model: z.string().nullable().default(null),
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
  /**
   * The waiting message's text (null when none) — queued behind a running turn, or waiting for the
   * sandbox — so a reload can show it. Withdrawn with `POST /:id/queued/withdraw`.
   */
  queuedMessage: z.string().nullable().default(null),
  /** The waiting message's images (empty when none) — an image-only message has `queuedMessage: ''`. */
  queuedAttachments: z.array(sessionAttachmentSchema).default([]),
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
  /**
   * §18.22: whose personal account a `user` session bills — the only person who may send it turns
   * or ship it (409 `session_credential_owner_only` for anyone else). Null for `platform`.
   */
  credentialOwnerUserId: z.string().uuid().nullable().default(null),
})
export type Session = z.infer<typeof sessionSchema>

export const sessionDetailResponseSchema = z.object({ session: sessionSchema })
export type SessionDetailResponse = z.infer<typeof sessionDetailResponseSchema>

/**
 * Issue #21: the stalls a person can move on from the session (`POST /api/sessions/:id/landing/retry`)
 * — nothing was released yet, so trying again cannot deploy anything twice. `main_ci_failed`: the
 * merge commit's CI is re-run (its failed jobs) and `land.main-ci` waits for it again;
 * `release_failed`: `land.release` runs again.
 */
export const RETRYABLE_STALLED_REASONS = [
  'main_ci_failed',
  'release_failed',
] as const satisfies readonly ShipStalledReason[]

/**
 * `POST /api/sessions/:id/landing/retry` — `retry` (the default) as above; `release_anyway`, on a
 * `main_ci_failed` stall only, cuts the release without a green default-branch `Gate` (recorded as
 * the `override` verdict; the tag's deploy runs the full gate itself). Answers 202
 * `sessionDetailResponseSchema`; 409 `landing_not_retryable` when the landing is not such a stall.
 * A merge commit with nothing left to re-run still goes round (`land.main-ci` reads it again).
 */
export const LANDING_RETRY_ACTIONS = ['retry', 'release_anyway'] as const
export const landingRetryRequestSchema = z.object({
  action: z.enum(LANDING_RETRY_ACTIONS).default('retry'),
})
export type LandingRetryRequest = z.infer<typeof landingRetryRequestSchema>

/** Whether a person may retry `landing` from the session (issue #21). Pure. */
export function landingRetryable(
  landing: Pick<SessionLanding, 'stage' | 'stalledReason'> | null | undefined
): boolean {
  return (
    landing?.stage === 'stalled' &&
    (RETRYABLE_STALLED_REASONS as readonly (string | null)[]).includes(landing.stalledReason)
  )
}

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

/**
 * `POST /api/sessions/:id/attachments` (multipart, one `file` part) — an image for the next
 * message: PNG, JPEG, GIF or WebP, checked by its bytes as well as its declared type, at most
 * {@link SESSION_ATTACHMENT_MAX_BYTES}. Send its `id` in the turn's `attachments`.
 */
export const sessionAttachmentUploadResponseSchema = sessionAttachmentSchema.extend({
  bytes: z.number().int().positive(),
})
export type SessionAttachmentUploadResponse = z.infer<typeof sessionAttachmentUploadResponseSchema>

/**
 * `POST /api/sessions/:id/queued/withdraw` — no body; answers `sessionDetailResponseSchema` (the
 * row with its waiting message gone), or 409 `nothing_queued`.
 */
/** The longest page path a preview grant carries (`to=`) or the bridge reports. */
export const PREVIEW_PATH_MAX = 2048

const PREVIEW_PATH_BASE = 'https://preview.invalid'

/**
 * A page on the preview to land on, normalised — or null when `value` could leave the preview's
 * origin or is not a page: it must start with exactly one `/` and hold no backslash, no control
 * character and nothing that parses to another origin; Launch's own `/__launch/…` paths are refused
 * too. The route's contract and the gateway's `to=` both use it; the gateway falls back to `/`.
 */
export function safePreviewPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > PREVIEW_PATH_MAX) {
    return null
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return null
  }
  let url: URL
  try {
    url = new URL(value, PREVIEW_PATH_BASE)
  } catch {
    return null
  }
  if (url.origin !== PREVIEW_PATH_BASE) return null
  const path = `${url.pathname}${url.search}${url.hash}`
  if (path === '/__launch' || path.startsWith('/__launch/')) return null
  return path
}

/**
 * `POST /api/sessions/:id/preview-grant` — `path`, when given, is where the frame lands after the
 * exchange (the page the person was on, so a reload keeps it). No body is the same as `{}`.
 */
export const previewGrantRequestSchema = z.object({
  path: z
    .string()
    .max(PREVIEW_PATH_MAX)
    .refine(v => safePreviewPath(v) !== null, 'Must be a page path on the preview, like /orders')
    .optional(),
})
export type PreviewGrantRequest = z.infer<typeof previewGrantRequestSchema>

/**
 * What the preview bridge (`/__launch/bridge.js`, injected into every HTML page the gateway serves)
 * posts to Launch's window on load and on every history change.
 */
export const PREVIEW_LOCATION_MESSAGE = 'launch.preview.location'
export const previewLocationMessageSchema = z.object({
  type: z.literal(PREVIEW_LOCATION_MESSAGE),
  path: z.string().max(PREVIEW_PATH_MAX),
})
export type PreviewLocationMessage = z.infer<typeof previewLocationMessageSchema>

/**
 * `POST /api/sessions/:id/preview-grant` — load `url` in the iframe within `expiresAt`.
 * `screenshots`: this deployment can capture the preview (`POST /:id/preview-screenshot` — it has
 * Browser Rendering's `BROWSER`); the pane shows its camera only then.
 */
export const previewGrantResponseSchema = z.object({
  url: z.string(),
  expiresAt: z.coerce.date(),
  screenshots: z.boolean().default(false),
})
export type PreviewGrantResponse = z.infer<typeof previewGrantResponseSchema>

/** The container ports a session's preview serves: the app's Vite UI, then its API (`wrangler dev`). */
export const SESSION_PREVIEW_PORTS = [5173, 8787] as const

/** The viewport a preview screenshot may ask for (the pane's rendered size, within reason). */
export const PREVIEW_SCREENSHOT_BOUNDS = {
  width: { min: 320, max: 2560 },
  height: { min: 240, max: 1600 },
} as const

/**
 * `POST /api/sessions/:id/preview-screenshot` — capture the preview as the person sees it, into a
 * new image for the next message: `path` (`safePreviewPath`) is the page, `port` one of
 * {@link SESSION_PREVIEW_PORTS} (default the UI's), `width` × `height` the viewport.
 */
export const previewScreenshotRequestSchema = z.object({
  path: z
    .string()
    .max(PREVIEW_PATH_MAX)
    .refine(v => safePreviewPath(v) !== null, 'Must be a page path on the preview, like /orders')
    .optional(),
  port: z
    .number()
    .int()
    .refine(
      p => (SESSION_PREVIEW_PORTS as readonly number[]).includes(p),
      `Must be one of ${SESSION_PREVIEW_PORTS.join(', ')}`
    )
    .default(SESSION_PREVIEW_PORTS[0]),
  width: z
    .number()
    .int()
    .min(PREVIEW_SCREENSHOT_BOUNDS.width.min)
    .max(PREVIEW_SCREENSHOT_BOUNDS.width.max),
  height: z
    .number()
    .int()
    .min(PREVIEW_SCREENSHOT_BOUNDS.height.min)
    .max(PREVIEW_SCREENSHOT_BOUNDS.height.max),
})
export type PreviewScreenshotRequest = z.infer<typeof previewScreenshotRequestSchema>
export type PreviewScreenshotRequestInput = z.input<typeof previewScreenshotRequestSchema>

/**
 * 202: the capture is queued and will land as the image `attachmentId` — `GET
 * /:id/attachments/:aid` is 404 until then, and 422 `screenshot_failed` if it could not be taken.
 */
export const previewScreenshotResponseSchema = z.object({ attachmentId: z.string().uuid() })
export type PreviewScreenshotResponse = z.infer<typeof previewScreenshotResponseSchema>

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

/**
 * The CSP source that lets Launch's page frame its session previews: every host of `template` —
 * `https://{label}.clewro.com` → `https://*.clewro.com`, `http://{label}.localhost:3001` →
 * `http://*.localhost:3001`. Null when the template has no leading `{label}` (nothing to frame).
 */
export function previewFrameSource(template: string): string | null {
  const m = /^([a-z]+):\/\/\{label\}(\.[^/]+)/i.exec(template.trim())
  return m ? `${(m[1] as string).toLowerCase()}://*${(m[2] as string).toLowerCase()}` : null
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
