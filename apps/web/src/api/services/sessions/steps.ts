/**
 * The bodies of the `SessionWorkflow`'s steps (Launch P3, plan §3b) — kept out of the Workflow
 * class so each is a plain async function over a `StepScope` (one step's DB client, ports, hooks,
 * emitter and realtime) that a test can call, and so `workflows/session.ts` reads as the shape
 * only.
 *
 * Rules every function here keeps (they are what makes a replayed or retried step safe):
 *
 * - **The row is the truth.** Each step re-reads the session (tenant-first) and acts on what it
 *   says NOW; a wake carries nothing.
 * - **Every transition is a compare-and-set on `status`** (`transition`). A CAS that matches no
 *   row means somebody else moved the session — the step reports it and does nothing more.
 * - **No secret leaves a step.** Results are ids, flags and counts. The database URI is sealed
 *   onto `db_uri_sealed` (`encryptToken`) the moment it exists and unsealed only inside the
 *   `bootstrap` step that hands it to the container.
 * - **Cleanup always runs** (`cleanupStep`): destroy the container, delete the branch — on end,
 *   on ship, on failure (S7 finding 9: a leftover container counts against `max_instances`).
 */
import {
  ACTIVE_SESSION_STATUSES,
  previewLabel,
  previewUrl,
  resolveSessionPolicy,
  type SessionKind,
  type SessionLanding,
  type SessionStatus,
  type SessionWorkspaceBackupData,
  type ShipLandingStage,
  sessionLandingSchema,
  TERMINAL_SESSION_STATUSES,
} from '@launch/shared/launch-sessions'
import { UPGRADE_SESSION_REASONS } from '@launch/shared/launch-upgrades'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import {
  apps,
  type SessionRow,
  type SessionWorkspaceBackup,
  sessionEvents,
  sessions,
} from '../../../db/schema'
import { decryptToken, encryptToken } from '../../auth/oauth-encryption'
import type { AppBindings } from '../../types'
import type { Logger } from '../../utils/core/logger'
import { cancelMergeApproval } from '../approvals/kinds/session-merge'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import { MANIFEST_PATHS, parseManifest } from '../launch/rocketflare-manifest'
import {
  type AutoShipVerdict,
  autoShipVerdict,
  needsAttentionMessage,
  sendUpgradeFollowUp,
  settleUpgradeAtCleanup,
  type UpgradeTurnEvidence,
  upgradeAwaitingAutoShip,
  upgradeFollowUpDue,
  upgradeNeedsAttention,
} from '../launch/upgrades'
import type { Realtime } from '../realtime'
import { createR2Storage } from '../storage'
import { getSessionRow } from './access'
import { loadAppNeon } from './app-neon'
import {
  checkContainer,
  containerIsOurs,
  containerLostCheckpointMessage,
  SESSION_BOOT_MARKER,
} from './boot-marker'
import {
  type BootStepTiming,
  type BootTimingFinish,
  recordBootTiming,
  stepTiming,
} from './boot-timing'
import {
  CORE_DUMP_EXCLUDES,
  SESSION_CHECKPOINT_DEBOUNCE_MS,
  SESSION_CHECKPOINT_MAX_DEFER_MS,
  workspaceChanged,
} from './checkpoint'
import { devIsCurrent, sessionDbEgressHosts } from './db/neon-session-db'
import {
  boundedSandbox,
  SESSION_CALL_LIMITS,
  type SessionCallLimits,
  withDeadline,
} from './deadline'
import { createSessionEmitter, nudgeSession, type SessionEmitter, safeErrorMessage } from './events'
import type { CheckpointReason, SessionStepContext, SessionStepHooks, TurnOutcome } from './hooks'
import { sessionsPaused } from './lifecycle'
import {
  egressFor,
  type SandboxExecResult,
  SandboxInterruptedError,
  type SandboxPort,
  SandboxRestartedError,
  type SessionAppRef,
  type SessionPorts,
  sandboxHostOf,
  sessionAllowedHosts,
} from './ports'
import { followUpPrebuild, releasePrebuildClaim } from './prebuild'
import {
  type BootstrapSkip,
  healDevSetup,
  migrationsHash,
  prereadHotFiles,
  previewHostSuffix,
  resumeDevServer,
  SESSION_DEV_EXCLUDES,
  SESSION_IMAGE_VERSION,
  SESSION_LAUNCH_DIR,
  SESSION_UI_PORT,
  SESSION_WORKSPACE,
  type SessionDevEnv,
  sessionBootstrap,
  sessionDevVars,
  startDevServer,
  stopDevServerGracefully,
  writeDevVars,
} from './rocketflare-dev'
import { runtimeOf } from './runtimes'
import { CONVERSATION_LOST_MESSAGE, containerGone, TURN_HEARTBEAT_MS } from './turn'
import { isUnpromptedWarmStart, warmMinutesLeft, warmStartMinutes } from './warm'
import { BACKUP_TTL_MARGIN_SECONDS, workspaceBackupMode } from './workspace-backup'

/** One step's world. Built by the Workflow for each `step.do`, closed with it. */
export interface StepScope {
  db: Database
  env: AppBindings
  cfg: AppConfig
  ports: SessionPorts
  hooks: SessionStepHooks
  realtime: Realtime
  logger: Logger
  now: () => Date
  params: { sessionId: string; tenantId: string }
  /** The deadlines and poll intervals (`deadline.ts`); tests pass smaller ones. */
  limits?: SessionCallLimits
  /** The boot step running (its checklist label) — what a timeout names. Set by `withProgress`. */
  phase?: string
  /**
   * Set by `withProgress`: say what the running boot step is doing now — a `step` event, still
   * `running`, with this `detail`. Callers only call it when the detail CHANGES.
   */
  progress?: (detail: string) => Promise<void>
  /**
   * Set by {@link restartable}: a replaced container is not this step's end, so `withProgress`
   * says the boot is starting again ({@link BOOT_RESTART_DETAIL}) on its one error row.
   */
  restartable?: boolean
}

export const limitsOf = (scope: Pick<StepScope, 'limits'>): SessionCallLimits =>
  scope.limits ?? SESSION_CALL_LIMITS

/** A vendor call (Neon) from a step, bounded: `<phase>: <what> did not answer within N min`. */
export function vendorCall<T>(scope: StepScope, what: string, work: () => Promise<T>): Promise<T> {
  return withDeadline(
    scope.phase ? `${scope.phase}: ${what}` : what,
    limitsOf(scope).vendorMs,
    work
  )
}

// ---- rows --------------------------------------------------------------------------------------

export function loadSession(scope: StepScope): Promise<SessionRow> {
  return getSessionRow(scope.db, scope.params.tenantId, scope.params.sessionId)
}

export function emitterFor(scope: StepScope): SessionEmitter {
  return createSessionEmitter(
    scope.db,
    { id: scope.params.sessionId, tenantId: scope.params.tenantId },
    scope.realtime
  )
}

/**
 * Issue #5: the row's landing (`sessions.landing`), parsed — null before a ship reaches its PR,
 * after a reopen, or when the stored value will not parse.
 */
export function landingOf(row: Pick<SessionRow, 'landing'>): SessionLanding | null {
  if (!row.landing) return null
  const parsed = sessionLandingSchema.safeParse(row.landing)
  return parsed.success ? parsed.data : null
}

/** Issue #5 Phase A: the landing stages the turn loop drives (`SessionWorkflow.land`). */
export const PHASE_A_LANDING_STAGES = [
  'ci',
  'approval',
  'merging',
] as const satisfies readonly ShipLandingStage[]
export type PhaseALandingStage = (typeof PHASE_A_LANDING_STAGES)[number]

/** Issue #5 Phase B: the landing stages `SessionWorkflow.release` follows after the merge. */
export const PHASE_B_LANDING_STAGES = [
  'releasing',
  'deploying',
] as const satisfies readonly ShipLandingStage[]

/** The Phase A stage a `shipping` row's landing is in, or null (no landing, or another stage). */
export function phaseAStageOf(
  row: Pick<SessionRow, 'status' | 'landing'>
): PhaseALandingStage | null {
  if (row.status !== 'shipping') return null
  const stage = landingOf(row)?.stage
  return stage && (PHASE_A_LANDING_STAGES as readonly string[]).includes(stage)
    ? (stage as PhaseALandingStage)
    : null
}

/**
 * Compare-and-set `status` from one of `from` to `to` (plus any other columns). The row after, or
 * null when the session was not in `from`.
 */
export async function transition(
  scope: StepScope,
  from: readonly SessionStatus[],
  to: SessionStatus,
  set: Partial<typeof sessions.$inferInsert> = {}
): Promise<SessionRow | null> {
  const [row] = await scope.db
    .update(sessions)
    .set({ ...set, status: to })
    .where(
      and(
        eq(sessions.tenantId, scope.params.tenantId),
        eq(sessions.id, scope.params.sessionId),
        inArray(sessions.status, [...from])
      )
    )
    .returning()
  if (row) nudgeSession(scope.realtime, row)
  return row ?? null
}

/** Write non-status columns. */
async function updateSession(
  scope: StepScope,
  set: Partial<typeof sessions.$inferInsert>
): Promise<SessionRow> {
  const [row] = await scope.db
    .update(sessions)
    .set(set)
    .where(
      and(eq(sessions.tenantId, scope.params.tenantId), eq(sessions.id, scope.params.sessionId))
    )
    .returning()
  if (!row) throw new Error('session row vanished')
  return row
}

/**
 * The app as the ports need it, tenant-first; its production Neon project and staging branch if it
 * has them.
 */
export async function loadAppRef(scope: StepScope, appId: string): Promise<SessionAppRef> {
  const tenantId = scope.params.tenantId
  const [app] = await scope.db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
  if (!app) throw new Error('The session’s app no longer exists')
  if (!app.repoOwner || !app.repoName) throw new Error('The app has no repository')
  return {
    id: app.id,
    tenantId,
    slug: app.slug,
    repoOwner: app.repoOwner,
    repoName: app.repoName,
    defaultBranch: app.defaultBranch ?? 'main',
    ...(await loadAppNeon(scope.db, tenantId, appId)),
    sessionDb: app.sessionDb ?? null,
  }
}

async function saveAppSessionDb(
  scope: StepScope,
  appId: string,
  value: NonNullable<SessionAppRef['sessionDb']>
): Promise<void> {
  await scope.db
    .update(apps)
    .set({ sessionDb: value })
    .where(and(eq(apps.tenantId, scope.params.tenantId), eq(apps.id, appId)))
}

/** A `preparing` claim older than this is abandoned (its session died without saying so). */
export const PREPARE_STALE_MS = 30 * 60_000

const ACTIVE_STATUS_SQL = sql.raw(ACTIVE_SESSION_STATUSES.map(status => `'${status}'`).join(', '))

/**
 * Claim the app's `dev` for preparing: `none | failed → preparing`, atomically on the jsonb, with
 * who claimed it and when (`preparingSessionId`, `preparingSince`). False when another session is
 * preparing it (or it is ready) — that session's branch then comes from an unprepared `dev` and its
 * own bootstrap migrates and seeds it (the slow path, still correct).
 *
 * **A stuck `preparing` is claimable again**: when the session holding it is no longer active
 * (failed, ended — or the claim predates these fields) or the claim is older than
 * {@link PREPARE_STALE_MS}. Without this, a prepare run that died without reaching its `catch` (a
 * `wrangler dev` reload, a crashed container, a terminated instance) left `preparing` for ever and
 * no later session prepared `dev` again.
 */
async function claimDevPrepare(scope: StepScope, appId: string): Promise<boolean> {
  const now = scope.now()
  const staleBefore = new Date(now.getTime() - PREPARE_STALE_MS).toISOString()
  const claim = JSON.stringify({
    status: 'preparing',
    preparingSessionId: scope.params.sessionId,
    preparingSince: now.toISOString(),
  })
  const tenantId = scope.params.tenantId
  const updated = await scope.db
    .update(apps)
    .set({ sessionDb: sql`coalesce(${apps.sessionDb}, '{}'::jsonb) || ${claim}::jsonb` })
    .where(
      and(
        eq(apps.tenantId, tenantId),
        eq(apps.id, appId),
        or(
          sql`coalesce(${apps.sessionDb}->>'status', 'none') in ('none', 'failed')`,
          and(
            sql`${apps.sessionDb}->>'status' = 'preparing'`,
            or(
              sql`${apps.sessionDb}->>'preparingSessionId' = ${scope.params.sessionId}`,
              sql`coalesce(${apps.sessionDb}->>'preparingSince', '') < ${staleBefore}`,
              sql`not exists (select 1 from ${sessions} where ${sessions.tenantId} = ${tenantId} and ${sessions.id}::text = ${apps.sessionDb}->>'preparingSessionId' and ${sessions.status} in (${ACTIVE_STATUS_SQL}))`
            )
          )
        )
      )
    )
    .returning({ id: apps.id })
  return updated.length > 0
}

/**
 * Give the app's `dev` back when THIS session held the prepare claim and is going away without
 * finishing it: `preparing → failed`, so the next session prepares again at once. A no-op when
 * the claim is someone else's or already settled. Called by `fail`, `cleanup` and the reconcile.
 */
export async function releaseDevPrepare(
  db: Database,
  ref: { tenantId: string; appId: string; sessionId: string }
): Promise<boolean> {
  const updated = await db
    .update(apps)
    .set({
      sessionDb: sql`(${apps.sessionDb} || '{"status":"failed"}'::jsonb) - 'preparingSessionId' - 'preparingSince'`,
    })
    .where(
      and(
        eq(apps.tenantId, ref.tenantId),
        eq(apps.id, ref.appId),
        sql`${apps.sessionDb}->>'status' = 'preparing'`,
        sql`${apps.sessionDb}->>'preparingSessionId' = ${ref.sessionId}`
      )
    )
    .returning({ id: apps.id })
  return updated.length > 0
}

export { SESSION_BOOT_MARKER }

// ---- the sandbox side --------------------------------------------------------------------------

/** The session's sandbox, every call bounded (`deadline.ts`) and named after the running step. */
export function sandboxFor(scope: StepScope, session: Pick<SessionRow, 'id'>): SandboxPort {
  return boundedSandbox(scope.ports.sandbox(session.id), scope.phase, limitsOf(scope))
}

/**
 * Run `work` in the container `bootId` booted: refused up front when the marker is gone, and a
 * failure is re-explained as `SandboxRestartedError` when the marker vanished under it (the SDK's
 * own error for that is a bare `HTTP error! status: 500`). No `bootId` (a caller outside the
 * Workflow's boot) runs `work` as is.
 */
export async function inOurContainer<T>(
  scope: StepScope,
  sandbox: SandboxPort,
  bootId: string | undefined,
  work: () => Promise<T>
): Promise<T> {
  if (!bootId) return work()
  const phase = scope.phase ?? 'booting'
  if ((await containerIsOurs(sandbox, bootId)) === false) throw new SandboxRestartedError(phase)
  try {
    return await work()
  } catch (err) {
    if (err instanceof SandboxRestartedError) throw err
    if ((await containerIsOurs(sandbox, bootId)) === false) throw new SandboxRestartedError(phase)
    throw err
  }
}

/**
 * How many times one boot starts its container again after it was replaced under a step (see
 * {@link restartable}); one more replacement fails the boot with the step's own sentence.
 */
export const MAX_BOOT_RESTARTS = 2

/** A boot step that found its container replaced: `restart` is the step's sentence for it. */
export interface BootRestart {
  restart: string
}

/** The checklist's word for a boot step whose container was replaced: the boot carries on. */
export const BOOT_RESTART_DETAIL =
  'The session container stopped and came back empty — starting it again'

/**
 * A boot step (`repo`, `bootstrap`, `dev`) whose container may be replaced under it: a
 * {@link SandboxRestartedError} becomes a RESULT, `{ restart }`, rather than a failure — the
 * platform's retries would only find the same empty container — and the Workflow boots again from
 * `sandbox.start` (a fresh marker, then the clone), under `.rN` step names. Wraps `withProgress`;
 * the step's checklist row then says the boot is starting again ({@link BOOT_RESTART_DETAIL})
 * rather than "Start a new session". Any other failure throws as before.
 */
export function restartable<T>(
  phase: BootPhase,
  body: (scope: StepScope) => Promise<T>
): (scope: StepScope) => Promise<T | BootRestart> {
  return async scope => {
    try {
      return await body({ ...scope, restartable: true })
    } catch (err) {
      if (!(err instanceof SandboxRestartedError)) throw err
      scope.logger.warn({ err, phase }, 'session: container replaced mid-boot')
      return { restart: err.message }
    }
  }
}

/** Did the step come back asking for the boot to start again from `sandbox.start`? */
export function isBootRestart(result: object): result is BootRestart {
  return 'restart' in result && typeof (result as BootRestart).restart === 'string'
}

/** What the dev stack is told about where it is served from. */
export function devEnvFor(cfg: AppConfig, session: Pick<SessionRow, 'shortId' | 'previewToken'>) {
  const template = cfg.SESSION_PREVIEW_URL
  const dev: SessionDevEnv = {
    previewOrigin: template
      ? previewUrl(template, previewLabel(SESSION_UI_PORT, session.shortId, session.previewToken))
      : null,
    previewHostSuffix: previewHostSuffix(template),
    // `wrangler dev` runs every container on the laptop's Docker, whatever SESSION_BACKEND says.
    emulated: cfg.APP_ENV === 'development',
  }
  return dev
}

/** The clone URL the container uses. Always GitHub's: the git egress handler (3d) routes it. */
export const repoCloneUrl = (app: Pick<SessionAppRef, 'repoOwner' | 'repoName'>) =>
  `https://github.com/${app.repoOwner}/${app.repoName}.git`

/**
 * The lock one checkout holds while it rebuilds the workspace. A step that timed out on Launch's
 * side leaves its script running in the container (the SDK cannot cancel an `exec`), and the
 * step's retry would otherwise `rm -rf` and `git init` the same directory underneath it.
 */
export const REPO_LOCK_FILE = `${SESSION_LAUNCH_DIR}/repo.lock`

/** How long a checkout waits for an earlier one to finish before it gives up. */
export const REPO_LOCK_WAIT_SECONDS = 120

/** How many of git's last stderr lines a failed checkout reports. */
export const CHECKOUT_ERROR_LINES = 15

/**
 * The checkout script: fetch `baseRef` (branch, tag or sha) at depth 50, then check out the
 * session's branch — from the remote when an earlier run pushed it (a resume), else fresh from
 * the base. Prints `base=<sha>` and `head=<sha>`.
 *
 * `restored` (issue #16): the workspace is the app's PREBUILD, just restored — a checkout of the
 * default branch with `node_modules` installed. It is checked out IN PLACE instead of being wiped:
 * the same fetch, then a forced checkout and `git clean -fd` (never `-x`: the git-ignored
 * `node_modules` is the point), so the tracked files are exactly the session's commit's.
 *
 * - `GIT_TERMINAL_PROMPT=0`: git never waits for a username on a terminal nobody is at — a
 *   refused credential fails at once, with git's own message, instead of hanging to the timeout.
 * - The whole body runs under `flock` on {@link REPO_LOCK_FILE} (file descriptor 9, released when
 *   the shell exits), waiting up to {@link REPO_LOCK_WAIT_SECONDS} for an abandoned earlier attempt.
 */
export function checkoutScript(input: {
  url: string
  baseRef: string
  branch: string | null
  restored?: boolean
}): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  const lines = [
    'set -e',
    'export GIT_TERMINAL_PROMPT=0',
    `mkdir -p ${SESSION_LAUNCH_DIR}`,
    `exec 9>${REPO_LOCK_FILE}`,
    `flock -w ${REPO_LOCK_WAIT_SECONDS} 9 || { echo "An earlier checkout still holds ${REPO_LOCK_FILE}" >&2; exit 1; }`,
    ...(input.restored
      ? [`cd ${SESSION_WORKSPACE}`, `git remote set-url origin ${q(input.url)}`]
      : [
          `rm -rf ${SESSION_WORKSPACE}`,
          `git init -q ${SESSION_WORKSPACE}`,
          `cd ${SESSION_WORKSPACE}`,
          `git remote add origin ${q(input.url)}`,
        ]),
    `git fetch -q --depth 50 origin ${q(input.baseRef)}`,
    'base=$(git rev-parse FETCH_HEAD)',
  ]
  const force = input.restored ? ' -f' : ''
  if (input.branch) {
    const branch = q(input.branch)
    const remote = q(`refs/remotes/origin/${input.branch}`)
    lines.push(
      `if git fetch -q --depth 50 origin ${q(`refs/heads/${input.branch}`)}:${remote} 2>/dev/null; then`,
      `  git checkout -q${force} -B ${branch} ${remote}`,
      'else',
      `  git checkout -q${force} -B ${branch} "$base"`,
      'fi'
    )
  } else {
    lines.push(`git checkout -q${force} --detach "$base"`)
  }
  if (input.restored) lines.push('git clean -q -fd')
  lines.push(
    // Launch's own files never land in a commit, and neither does a core dump (checkpoint.ts).
    'mkdir -p .claude && printf "%s\\n" .claude/settings.local.json >> .git/info/exclude',
    `printf "%s\\n" ${CORE_DUMP_EXCLUDES.map(p => q(p)).join(' ')} >> .git/info/exclude`,
    // Nor the dev server's own config (`SESSION_WRANGLER_SCRIPT`): the setup is never committed.
    `printf "%s\\n" ${SESSION_DEV_EXCLUDES.map(p => q(p)).join(' ')} >> .git/info/exclude`,
    'echo "base=$base"',
    'echo "head=$(git rev-parse HEAD)"'
  )
  return lines.join('\n')
}

// ---- claim -------------------------------------------------------------------------------------

export type ClaimResult =
  | { start: 'boot'; kind: SessionKind }
  | { start: 'loop' }
  /** A live session whose instance was lost: `salvage` first, then the loop. */
  | { start: 'salvage' }
  | { start: 'cleanup' }
  /**
   * Issue #5 Phase B: a merged landing (`shipped`, stage `releasing | deploying`) whose instance
   * was lost — `cleanup` first when it never ran (`ended_at` still null), then the release follow.
   */
  | { start: 'land'; cleanup: boolean }
  | { start: 'skip'; status: SessionStatus }

/** The live statuses whose container may hold work nobody saved when their instance was lost. */
export const SALVAGE_STATUSES = [
  'ready',
  'working',
  'blocked',
  'shipping',
] as const satisfies readonly SessionStatus[]

/**
 * Step `claim`. `requested → booting` for a fresh session; a session this instance finds already
 * live (its previous instance was lost — a `wrangler dev` reload, a deploy, the reconcile's
 * restart) goes to `salvage` first ({@link salvageStep}), which saves what its container holds
 * before the loop resumes it; a `booting` one has nothing worth saving and is put straight back to
 * `suspended` with a `resume` request, so the loop boots it again from its branch. `ending` goes
 * straight to cleanup; a settled one is left.
 */
export async function claimStep(scope: StepScope): Promise<ClaimResult> {
  const session = await loadSession(scope)
  const sandboxId = sandboxFor(scope, session).id
  // Issue #5: a landing is resumed where it stands, never salvaged — the work is committed (it is
  // the gate SHA on the PR), and the loop's `land` round needs no container until a reopen.
  const landing = landingOf(session)
  if (
    session.status === 'shipped' &&
    landing &&
    (PHASE_B_LANDING_STAGES as readonly string[]).includes(landing.stage)
  ) {
    return { start: 'land', cleanup: session.endedAt === null }
  }
  if (phaseAStageOf(session)) {
    await scope.db
      .update(sessions)
      .set({ lastActivityAt: scope.now() })
      .where(
        and(eq(sessions.tenantId, scope.params.tenantId), eq(sessions.id, scope.params.sessionId))
      )
    return { start: 'loop' }
  }
  if (session.status === 'requested') {
    const claimed = await transition(scope, ['requested'], 'booting', {
      sandboxId,
      imageVersion: SESSION_IMAGE_VERSION,
      lastActivityAt: scope.now(),
    })
    return claimed ? { start: 'boot', kind: session.kind } : { start: 'skip', status: 'requested' }
  }
  if ((TERMINAL_SESSION_STATUSES as readonly string[]).includes(session.status)) {
    // Settled but never cleaned up (its instance died between `fail` and `cleanup`, or it was
    // settled by hand): an instance started by the reconcile does the cleanup now.
    return session.endedAt === null
      ? { start: 'cleanup' }
      : { start: 'skip', status: session.status }
  }
  if (session.status === 'ending') return { start: 'cleanup' }
  if (session.kind === 'prebuild') {
    // Issue #16: a `prebuild` run whose instance was lost mid-build has nothing worth resuming —
    // it is failed (its claim given back by `cleanup`), and the next request builds again.
    await transition(scope, ['booting'], 'failed', { error: 'The prebuild was interrupted' })
    return { start: 'cleanup' }
  }
  if ((SALVAGE_STATUSES as readonly SessionStatus[]).includes(session.status)) {
    // "Alive again": the reconcile must not take this instance for the one it replaced.
    await scope.db
      .update(sessions)
      .set({ lastActivityAt: scope.now() })
      .where(
        and(eq(sessions.tenantId, scope.params.tenantId), eq(sessions.id, scope.params.sessionId))
      )
    return { start: 'salvage' }
  }
  if (session.status !== 'suspended') {
    // A lost instance under a boot: its container holds no work yet — start over from the branch
    // (the last checkpoint), as a resume would.
    await sandboxFor(scope, session)
      .destroy()
      .catch(() => {})
    await transition(scope, ['booting'], 'suspended', {
      suspendedAt: scope.now(),
      requestedAction: session.requestedAction === 'end' ? 'end' : 'resume',
      cancelRequestedAt: null,
    })
  }
  return { start: 'loop' }
}

// ---- salvage -----------------------------------------------------------------------------------

/**
 * What `salvage` managed, which is also what it tells the person:
 * - `saved` — the orphaned turn process is stopped and the checkpoint (commit, push, transcript)
 *   ran; the container is KEPT, so the resume is warm;
 * - `kept` — the process is stopped but the checkpoint failed (`detail` says why): the work is
 *   still in the container's workspace, and the container is kept for exactly that reason;
 * - `lost` — the container could not be reached, came back empty (no boot marker) or would not
 *   stop the process: it is destroyed, and the resume boots cold from the branch's last checkpoint.
 */
export type SalvageOutcome = 'saved' | 'kept' | 'lost'

/** `turn.failed` for a turn whose Workflow was lost under it, by what `salvage` managed. */
export function lostTurnMessage(outcome: SalvageOutcome, detail?: string): string {
  const head = 'This turn stopped: Launch lost track of it (its Workflow stopped).'
  switch (outcome) {
    case 'saved':
      return `${head} Launch stopped Claude Code and saved your work — the code on the session’s branch and the conversation. Send your message again to carry on.`
    case 'kept':
      return `${head} Launch stopped Claude Code but could not save your work to the branch${detail ? ` (${detail})` : ''}; it is still in the session’s workspace, which Launch kept. Send your message again to carry on.`
    case 'lost':
      return `${head} Launch could not save its work: the sandbox could not be reached. The session restarts from its last checkpoint; send your message again.`
  }
}

/** The `error` a ship whose Workflow was lost mid-gate ends with, by what `salvage` managed. */
export function lostShipMessage(outcome: SalvageOutcome, detail?: string): string {
  const head =
    'The ship stopped before it opened a pull request: Launch lost track of it (its Workflow stopped).'
  switch (outcome) {
    case 'saved':
      return `${head} Your work is saved on the session’s branch; ship again to run the gate.`
    case 'kept':
      return `${head} Launch could not save your work to the branch${detail ? ` (${detail})` : ''}; it is still in the session’s workspace, which Launch kept. Ship again to run the gate.`
    case 'lost':
      return `${head} The sandbox could not be reached, so the session restarts from its last checkpoint; ship again to run the gate.`
  }
}

/** The `turn.interrupted { reason: 'cancelled' }` sentence for a Stop that `salvage` carried out. */
export function salvagedCancelMessage(outcome: SalvageOutcome, detail?: string): string {
  switch (outcome) {
    case 'saved':
      return 'Stopped. Launch saved the turn’s work — the code on the session’s branch and the conversation.'
    case 'kept':
      return `Stopped, but Launch could not save the turn’s work to the branch${detail ? ` (${detail})` : ''}; it is still in the session’s workspace, which Launch kept.`
    case 'lost':
      return 'Stopped, but Launch could not reach the sandbox to save the turn’s work; the session restarts from its last checkpoint.'
  }
}

/** The label a salvage's bounded sandbox calls carry in a timeout's sentence. */
const SALVAGE_PHASE = 'Saving the interrupted work'

/**
 * Write the session's heartbeat (`last_activity_at`) now and every `every` ms while it is in one
 * of `statuses`, until the returned stop function is called. A failed beat is not a failed step:
 * the next one tries again.
 */
function startBeating(
  scope: StepScope,
  statuses: readonly SessionStatus[],
  every: number
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const beat = async () => {
    if (stopped) return
    await scope.db
      .update(sessions)
      .set({ lastActivityAt: scope.now() })
      .where(
        and(
          eq(sessions.tenantId, scope.params.tenantId),
          eq(sessions.id, scope.params.sessionId),
          inArray(sessions.status, [...statuses])
        )
      )
      .catch(() => {})
    if (!stopped) timer = setTimeout(beat, every)
  }
  timer = setTimeout(beat, every)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/**
 * Write the heartbeat of a live session while `salvage` runs, so neither the reconcile (3 min) nor
 * a Stop's fast path (`SESSION_CANCEL_STALL_MS`, 30 s) mistakes the salvage itself for another
 * lost turn and terminates the instance doing it. Returns the stop function.
 */
function keepAlive(scope: StepScope): () => void {
  return startBeating(
    scope,
    SALVAGE_STATUSES,
    Math.min(limitsOf(scope).heartbeatMs, TURN_HEARTBEAT_MS)
  )
}

/**
 * A step body that writes the session's heartbeat when it starts and every `heartbeatMs` while it
 * runs — but only while the row is in one of `statuses` — so the reconcile (`reconcile.ts`) can
 * tell a healthy ship, landing or Phase B step, however long it takes (a gate command, a fix turn,
 * a slow GitHub answer), from an instance that died under it. The gap a healthy instance leaves is
 * then only what it waits BETWEEN steps (a retry's delay, a landing round's wait), from which the
 * reconcile's windows are computed.
 */
export function withHeartbeat<T>(
  statuses: readonly SessionStatus[],
  body: (scope: StepScope) => Promise<T>
): (scope: StepScope) => Promise<T> {
  return async scope => {
    const stop = startBeating(scope, statuses, limitsOf(scope).heartbeatMs)
    try {
      await scope.db
        .update(sessions)
        .set({ lastActivityAt: scope.now() })
        .where(
          and(
            eq(sessions.tenantId, scope.params.tenantId),
            eq(sessions.id, scope.params.sessionId),
            inArray(sessions.status, [...statuses])
          )
        )
      return await body(scope)
    } finally {
      stop()
    }
  }
}

/**
 * Stop the orphaned turn (`runtime.cancel` — a process runtime: its `TURN_PID_FILE`, SIGTERM, the
 * grace, SIGKILL, the turn's own `turnKillScript`). True when nothing of it is left (or there was
 * nothing to stop); false when it could not be asked.
 */
async function stopOrphanedTurn(
  scope: StepScope,
  session: SessionRow,
  sandbox: SandboxPort
): Promise<boolean> {
  try {
    await runtimeOf(session).cancel({ session, sandbox, logger: scope.logger })
    return true
  } catch (err) {
    scope.logger.warn({ err }, 'session salvage: could not stop the orphaned turn')
    return false
  }
}

/**
 * Step `salvage` — a live session (`ready` · `working` · `blocked` · `shipping`) whose Workflow
 * instance was lost, found by the fresh instance's `claim`. The container usually OUTLIVES the
 * instance (a `wrangler dev` reload or a deploy kills the step, not the sandbox), and in it may be
 * a Claude Code process nobody reads and edits nobody committed. Before anything is destroyed:
 *
 * 1. **Reach it**: its boot marker must still be there (a container that came back empty holds
 *    nothing; one that does not answer cannot be saved).
 * 2. **Stop the orphaned turn** by its pid file, SIGTERM then SIGKILL — so nothing edits the
 *    workspace while it is saved, and nothing spends with nobody reading.
 * 3. **Checkpoint** (`hooks.checkpoint(…, 'salvage')`): commit, push, and the transcript to R2 —
 *    so even a later cold resume keeps the work and `--resume` has the conversation.
 * 4. **Keep or destroy**: a container whose turn is confirmed stopped is KEPT (`container_kept_at`)
 *    — whether or not the checkpoint worked, because when it did not, the workspace is the only
 *    copy of the work — and the loop's resume finds its boot marker and goes WARM (`dev#K` only,
 *    the dev server reused when it answers; `warm.ts`). Anything else is destroyed, as before.
 * 5. **Settle** `→ suspended` with a `resume` (an `end` the person asked for stays asked), and
 *    close a `working` turn with what happened: `turn.interrupted { cancelled }` when a Stop was
 *    pending, else `turn.failed` ({@link lostTurnMessage}) — either way saying whether the work
 *    was saved.
 *
 * Every sandbox call is bounded (`deadline.ts`) and caught: a salvage never fails the session, and
 * only a database error makes the step throw. It is idempotent: a retry finds nothing to stop, an
 * unchanged checkout to commit, and (once settled) a status it does not salvage.
 */
export async function salvageStep(
  outer: StepScope
): Promise<{ outcome: SalvageOutcome | 'skipped'; kept: boolean }> {
  const scope: StepScope = { ...outer, phase: SALVAGE_PHASE }
  const session = await loadSession(scope)
  if (!(SALVAGE_STATUSES as readonly SessionStatus[]).includes(session.status)) {
    return { outcome: 'skipped', kept: false }
  }
  const sandbox = sandboxFor(scope, session)
  const stopBeating = keepAlive(scope)
  let outcome: SalvageOutcome = 'lost'
  let detail: string | undefined
  try {
    const marker = await sandbox.readFile(SESSION_BOOT_MARKER).catch(() => null)
    if (marker?.trim() && (await stopOrphanedTurn(scope, session, sandbox))) {
      try {
        const current = await loadSession(scope)
        await scope.hooks.checkpoint(hookContext(scope, current, current.turnCount), 'salvage')
        outcome = 'saved'
      } catch (err) {
        scope.logger.warn({ err }, 'session salvage: the checkpoint failed; keeping the container')
        outcome = 'kept'
        detail = safeErrorMessage(err, 'the checkpoint failed', 600)
      }
    }
    if (outcome === 'lost') {
      await sandbox.destroy().catch(err => {
        scope.logger.warn({ err }, 'session salvage: could not destroy the container')
      })
    }
  } finally {
    stopBeating()
  }

  const keep = outcome !== 'lost'
  const now = scope.now()
  const moved = await transition(scope, [session.status], 'suspended', {
    suspendedAt: now,
    requestedAction: session.requestedAction === 'end' ? 'end' : 'resume',
    cancelRequestedAt: null,
    containerKeptAt: keep ? now : null,
  })
  if (!moved) return { outcome, kept: false }
  const emit = emitterFor(scope)
  const turn = Math.max(1, session.turnCount)
  if (session.status === 'working' && session.cancelRequestedAt) {
    // The Stop the person pressed, carried out without the turn step that should have done it.
    const message = salvagedCancelMessage(outcome, detail)
    await emit([
      { type: 'turn.interrupted', turn, data: { turn, reason: 'cancelled', message } },
      ...(outcome === 'saved' ? [] : [{ type: 'error' as const, turn, data: { message } }]),
    ])
  } else if (session.status === 'working') {
    const message = lostTurnMessage(outcome, detail)
    await emit({ type: 'turn.failed', turn, data: { turn, message } })
  } else if (session.status === 'shipping') {
    // A ship whose Workflow died before it opened a pull request (a Phase A landing is resumed by
    // `claim`, never salvaged): the gate is not re-run on its own — the person ships again.
    await emit({
      type: 'error',
      turn: session.turnCount,
      data: { message: lostShipMessage(outcome, detail) },
    })
  } else if (outcome === 'kept') {
    await emit({
      type: 'error',
      turn: session.turnCount,
      data: { message: `Could not save the session's work: ${detail ?? 'the checkpoint failed'}` },
    })
  }
  scope.logger.warn(
    { sessionId: session.id, status: session.status, outcome, kept: keep },
    'session: salvaged a live session whose Workflow instance was lost'
  )
  return { outcome, kept: keep }
}

// ---- boot --------------------------------------------------------------------------------------

export interface DbStepResult {
  /** The session's branch exists (sealed on the row). */
  branched: boolean
  /** This run must prepare `dev` (migrate + seed) before branching. */
  prepare: boolean
}

/**
 * Step `db`: the app's `dev` (created if missing), then — when it is prepared, or somebody else is
 * preparing it — the session's branch. When nobody has prepared it, this session claims the job
 * and branches AFTER its `prepare` step (plan §1.7: "prepare inline if needed").
 *
 * Issue #15: a `ready` `dev` whose checks last passed under this Launch (`devIsCurrent`) is
 * branched at once, without `ensureDev`. Should that branch fail (`dev` deleted under Launch, say),
 * the record is dropped before the error goes up, so the step's retry runs `ensureDev` in full.
 */
export async function dbStep(scope: StepScope): Promise<DbStepResult> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  if (session.kind !== 'prepare' && devIsCurrent(app)) {
    try {
      await branchStep(scope)
    } catch (err) {
      await forgetDevCheck(scope, app.id).catch(() => {})
      throw err
    }
    return { branched: true, prepare: false }
  }
  const port = scope.ports.sessionDb(scope.db)
  const dev = await vendorCall(scope, "Neon (the app's dev branch)", () => port.ensureDev(app))
  await saveAppSessionDb(scope, app.id, dev)
  if (session.kind === 'prepare') {
    await claimDevPrepare(scope, app.id)
    return { branched: false, prepare: true }
  }
  if (dev.status !== 'ready' && (await claimDevPrepare(scope, app.id))) {
    return { branched: false, prepare: true }
  }
  await branchStep(scope)
  return { branched: true, prepare: false }
}

/** Drop `dev`'s record of its last check (`roleVersion`): the next `db` step runs `ensureDev`. */
async function forgetDevCheck(scope: StepScope, appId: string): Promise<void> {
  await scope.db
    .update(apps)
    .set({ sessionDb: sql`${apps.sessionDb} - 'roleVersion'` })
    .where(and(eq(apps.tenantId, scope.params.tenantId), eq(apps.id, appId)))
}

/**
 * What a session branched from a `ready` `dev` whose migrations hash was not recorded (prepared
 * before it was) starts from: prepared — never re-seeded, never re-checked — but its migrations
 * unknown, so its first bootstrap always migrates (a no-op when nothing is new).
 */
export const UNKNOWN_MIGRATIONS_HASH = 'unknown'

/**
 * Step `branch` (or the tail of `db`): the session's own copy of `dev`, sealed onto the row. A
 * branch of a `ready` `dev` holds the prepared database already, so the session starts from
 * `dev`'s migrations hash: its bootstrap is then a resume's — no seed, no database check, and a
 * migrate only when the checkout's migrations differ. Each of those is a database WebSocket from
 * the container, and on real containers a later one hung (docs/plans/sandbox-session-issues.md).
 */
export async function branchStep(scope: StepScope): Promise<{ branched: true }> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  const branch = await vendorCall(scope, "Neon (the session's branch)", () =>
    scope.ports.sessionDb(scope.db).createBranch(app, session)
  )
  const parent = app.sessionDb
  const inherited =
    parent?.status === 'ready' ? (parent.migrationsHash ?? UNKNOWN_MIGRATIONS_HASH) : null
  await updateSession(scope, {
    db: branch.db,
    dbUriSealed: await encryptToken(scope.cfg, branch.uri),
    ...(session.migrationsHash === null && inherited ? { migrationsHash: inherited } : {}),
  })
  return { branched: true }
}

export interface StartSandboxResult {
  sandboxId: string
  bootId: string
  /**
   * The container an idle suspend KEPT is still there (its boot marker survived): the resume
   * skips the clone, the install and the bootstrap (`warm.ts`). Always false on a first boot.
   */
  warm: boolean
}

/**
 * The Neon hosts the session's own database needs on the allow-list — from the sealed URI, so a
 * warm resume (which skips the bootstrap that would add them) reaches its branch at once. Empty
 * before the session has a database, or when the URI is not a Neon endpoint's (the bootstrap then
 * fails with the reason).
 */
export async function dbEgressHostsOf(scope: StepScope, session: SessionRow): Promise<string[]> {
  const uri = session.dbUriSealed ? await decryptToken(scope.cfg, session.dbUriSealed) : null
  if (!uri) return []
  try {
    return sessionDbEgressHosts(uri)
  } catch {
    return []
  }
}

/**
 * Step `sandbox.start[#K]`: boot the container and mark it (`SESSION_BOOT_MARKER`) — the `bootId`
 * it returns is what every later boot step checks it is still talking to. On a resume of a session
 * whose container an idle suspend kept (`container_kept_at`), a marker that is still there means
 * it is the SAME container, workspace and dev server included: `warm`, and its marker is reused.
 * A container that was recreated under it (the SDK's sleep, Docker's OOM killer) has no marker and
 * boots cold like any other.
 */
export async function startSandboxStep(scope: StepScope): Promise<StartSandboxResult> {
  const session = await loadSession(scope)
  const sandbox = sandboxFor(scope, session)
  const kept = session.containerKeptAt !== null
  // The kept container is being used (or is gone): either way the row no longer promises one.
  await updateSession(scope, { sandboxId: sandbox.id, containerKeptAt: null })
  await sandbox.start({ extraAllowedHosts: await dbEgressHostsOf(scope, session) })
  if (kept) {
    const marker = (await sandbox.readFile(SESSION_BOOT_MARKER))?.trim()
    if (marker) return { sandboxId: sandbox.id, bootId: marker, warm: true }
  }
  const bootId = crypto.randomUUID()
  await sandbox.writeFile(SESSION_BOOT_MARKER, bootId)
  return { sandboxId: sandbox.id, bootId, warm: false }
}

/** Step `repo[#K]`: clone and check out; `.claude/settings.local.json`. Returns the shas. */
export async function repoStep(
  scope: StepScope,
  bootId?: string
): Promise<{ baseSha: string; headSha: string }> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  const sandbox = sandboxFor(scope, session)
  return inOurContainer(scope, sandbox, bootId, () => checkOut(scope, session, app, sandbox))
}

/**
 * A failed checkout, with git's last {@link CHECKOUT_ERROR_LINES} stderr lines — not just its last
 * one: the cause (an auth refusal, a missing ref, the lock) is usually a line or two above
 * `fatal:`. Through `safeErrorMessage`, so no token or connection string survives into the event.
 */
export function checkoutFailure(
  app: Pick<SessionAppRef, 'repoOwner' | 'repoName'>,
  result: Pick<SandboxExecResult, 'exitCode' | 'stderr'>
): Error {
  const tail = result.stderr.trim().split('\n').slice(-CHECKOUT_ERROR_LINES).join('\n')
  return new Error(
    `Could not check out ${app.repoOwner}/${app.repoName}: ${safeErrorMessage(tail, `git exited ${result.exitCode}`, 2_000)}`
  )
}

/**
 * Clone (or, `restored`, check out in place — {@link checkoutScript}) the session's commit and
 * record its shas. A `prebuild` run (issue #16) clones the default branch detached and writes no
 * runtime files: its workspace is saved for sessions that write their own.
 */
export async function checkOut(
  scope: StepScope,
  session: SessionRow,
  app: SessionAppRef,
  sandbox: SandboxPort,
  opts: { restored?: boolean } = {}
): Promise<{ baseSha: string; headSha: string }> {
  // `host` (a remote sandbox): the host's git handler is granted the token; `proxied`: nothing.
  await egressFor(scope.ports, scope.db).prepareGit(sandbox, session)
  const coding = session.kind !== 'prepare' && session.kind !== 'prebuild'
  const result = await sandbox.exec(
    checkoutScript({
      url: repoCloneUrl(app),
      baseRef: session.baseSha ?? session.baseRef ?? app.defaultBranch,
      branch: coding ? session.branch : null,
      ...(opts.restored ? { restored: true } : {}),
    }),
    { timeoutMs: 5 * 60_000 }
  )
  if (result.exitCode !== 0) throw checkoutFailure(app, result)
  const baseSha = /base=([0-9a-f]{7,64})/.exec(result.stdout)?.[1] ?? ''
  const headSha = /head=([0-9a-f]{7,64})/.exec(result.stdout)?.[1] ?? baseSha
  // The runtime's own files in the checkout (§18.22 — Claude: `.claude/settings.local.json`).
  if (session.kind !== 'prebuild') {
    for (const file of runtimeOf(session).workspaceFiles()) {
      await sandbox.writeFile(file.path, file.content)
    }
  }
  await updateSession(scope, {
    baseSha: session.baseSha ?? (baseSha || null),
    headSha: session.headSha ?? (headSha || null),
  })
  return { baseSha, headSha }
}

/**
 * Step `prepare`: the kit's migrate + seed into the app's `dev` (`devUriFor` resets the role's
 * password, so the URI is this run's alone), then `apps.session_db` → ready at the base commit,
 * with the checkout's migrations hash (a session branched from it starts from it: `branchStep`).
 */
export async function prepareStep(scope: StepScope, bootId?: string): Promise<{ prepared: true }> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  const port = scope.ports.sessionDb(scope.db)
  const dev =
    app.sessionDb ??
    (await vendorCall(scope, "Neon (the app's dev branch)", () => port.ensureDev(app)))
  // The claim fields go when the prepare settles, either way.
  const { preparingSessionId: _holder, preparingSince: _since, ...settled } = dev
  let hash: string | null = null
  try {
    const uri = await vendorCall(scope, "Neon (the dev branch's password)", () =>
      port.devUriFor({ ...app, sessionDb: dev })
    )
    const sandbox = sandboxFor(scope, session)
    hash = await inOurContainer(scope, sandbox, bootId, async () => {
      await sessionBootstrap({
        sandbox,
        dbUri: uri,
        dev: devEnvFor(scope.cfg, session),
        ...bootstrapPolling(scope, sandbox, bootId),
      })
      return migrationsHash(sandbox)
    })
  } catch (err) {
    await saveAppSessionDb(scope, app.id, { ...settled, status: 'failed' })
    throw err
  }
  const { migrationsHash: _stale, ...rest } = settled
  await saveAppSessionDb(scope, app.id, {
    ...rest,
    status: 'ready',
    preparedCommit: session.baseSha,
    preparedAt: scope.now(),
    ...(hash ? { migrationsHash: hash } : {}),
  })
  return { prepared: true }
}

/** How long a running command's boot-marker probe may take before it counts as "not known". */
export const REPLACED_PROBE_MS = 15_000

/**
 * How a step's kit bootstrap polls its commands and reports progress (`sessionBootstrap`), and —
 * with the boot's id — how it notices the container was replaced under a command: the marker read
 * answers, and is not this boot's. A probe that fails or stalls is no evidence either way.
 */
export function bootstrapPolling(
  scope: StepScope,
  sandbox: SandboxPort,
  bootId: string | undefined
) {
  const limits = limitsOf(scope)
  return {
    pollMs: limits.commandPollMs,
    maxCommandMs: limits.execMaxMs,
    ...(scope.progress ? { onProgress: scope.progress } : {}),
    ...(bootId
      ? {
          replaced: async () =>
            (await checkContainer(sandbox, bootId, REPLACED_PROBE_MS)) === 'replaced',
        }
      : {}),
  }
}

export interface BootstrapStepResult {
  installMs: number
  bootstrapMs: number
  /** False when no install ran: a restored workspace, or a prebuild whose lockfile matched. */
  installed: boolean
  /** False on a resume whose migrations had not changed since the last bootstrap. */
  migrated: boolean
  /** False on every bootstrap after the first successful one: a resume never re-seeds. */
  seeded: boolean
  /**
   * A restored workspace (`restore#K`) whose migrations had not changed: no install and no kit
   * bootstrap at all — `node_modules` and `.dev.vars` came back with it.
   */
  reused?: boolean
  /**
   * The tracked files put back from an earlier Launch's offline `[ai]` toggle (`healDevSetup`):
   * a resume of a branch checkpointed before the dev config left the tracked files.
   */
  healed?: string[]
}

/**
 * Step `bootstrap[#K]`: the kit bootstrap against the session's own branch. The FIRST successful
 * one records the checkout's migrations hash (`sessions.migrations_hash`); a later one (a cold
 * resume) — or the first on a branch of a `ready` `dev`, which starts from `dev`'s hash
 * (`branchStep`) — is against a database that is already prepared, so it never re-seeds (nor
 * re-checks the database), and migrates only when `apps/web/migrations` hashes differently now —
 * the session's own turns, or commits since the prepare, may have added a migration.
 */
export async function bootstrapStep(
  scope: StepScope,
  bootId?: string,
  opts: { restored?: boolean; install?: boolean } = {}
): Promise<BootstrapStepResult> {
  const session = await loadSession(scope)
  const uri = await decryptToken(scope.cfg, session.dbUriSealed)
  if (!uri) throw new Error('The session has no database')
  const sandbox = sandboxFor(scope, session)
  return inOurContainer(scope, sandbox, bootId, async () => {
    const hash = await migrationsHash(sandbox)
    const prepared = session.migrationsHash !== null
    const migrate = !prepared || hash === null || hash !== session.migrationsHash
    const dev = devEnvFor(scope.cfg, session)
    // A branch an earlier Launch checkpointed may carry the kit's offline `[ai]` toggle: put the
    // tracked files back (against the session's base) — the next checkpoint commits the repair.
    const heal = () => healDevSetup(sandbox, session.baseSha)
    if (opts.restored && prepared && !migrate) {
      // The restored workspace IS the last bootstrap's result: only the allow-list (this
      // container's) and the dev-server keys (non-secret, re-derived) are put back.
      await sandbox.setAllowedHosts(sessionAllowedHosts(sessionDbEgressHosts(uri)))
      await writeDevVars(sandbox, `${SESSION_WORKSPACE}/apps/web/.dev.vars`, sessionDevVars(dev))
      const healed = await heal()
      return {
        installMs: 0,
        bootstrapMs: 0,
        installed: false,
        migrated: false,
        seeded: false,
        reused: true,
        healed,
      }
    }
    const skip: BootstrapSkip[] = prepared
      ? ['seed', 'db-check', ...(migrate ? [] : (['migrate'] as const))]
      : []
    const timings = await sessionBootstrap({
      sandbox,
      dbUri: uri,
      dev,
      skip,
      // Issue #16: a restored prebuild whose lockfile matched already has the install's result.
      ...(opts.install === false ? { install: false } : {}),
      ...bootstrapPolling(scope, sandbox, bootId),
    })
    if (hash) await updateSession(scope, { migrationsHash: hash })
    const healed = await heal()
    return { ...timings, migrated: migrate, seeded: !prepared, healed }
  })
}

/**
 * Step `dev[#K]`: `pnpm dev`, both ports up → `ready` and `preview.ready`. Between wait chunks it
 * stops for an end request and for a container that died (`startDevServer`'s `checkpoint`).
 */
export async function devStep(
  scope: StepScope,
  bootId?: string,
  opts: { chunkMs?: number; warm?: boolean } = {}
): Promise<{ ready: boolean }> {
  const session = await loadSession(scope)
  const sandbox = sandboxFor(scope, session)
  const { warm = false, ...waitOpts } = opts
  const startOpts = {
    ...waitOpts,
    checkpoint: async () => {
      await throwIfEndRequested(scope)
      if (bootId && (await containerIsOurs(sandbox, bootId)) === false) {
        throw new SandboxRestartedError(scope.phase ?? 'starting the dev server')
      }
    },
  }
  const dev = devEnvFor(scope.cfg, session)
  // A warm resume reuses the kept container's dev server when it still answers.
  await inOurContainer(scope, sandbox, bootId, async () => {
    if (warm) await resumeDevServer(sandbox, dev, startOpts)
    else await startDevServer(sandbox, dev, startOpts)
  })
  const now = scope.now()
  const ready = await transition(scope, ['booting'], 'ready', {
    readyAt: session.readyAt ?? now,
    lastActivityAt: now,
    error: null,
  })
  if (!ready) return { ready: false }
  await emitterFor(scope)([
    { type: 'preview.ready', turn: 0, data: { port: SESSION_UI_PORT } },
    { type: 'status', turn: 0, data: { status: 'ready' } },
  ])
  return { ready: true }
}

/**
 * Step `transcript#K`: put Claude Code's transcript back where `--resume` finds it, from the R2
 * copy the last checkpoint made (`transcript_key`). No conversation yet is not an error.
 *
 * **A conversation that cannot come back is forgotten, never left to break the session**: a
 * `claude_session_id` with no transcript to restore (the turn that started it was never
 * checkpointed — its instance died first — or the copy is gone, or there is no bucket), or a file
 * the container does not hold after the write, clears `claude_session_id` — so the next turn starts
 * a new conversation instead of a `claude --resume <id>` that fails every time — and an `error`
 * event says so ({@link CONVERSATION_LOST_MESSAGE}). The code is on the branch either way.
 */
export async function restoreTranscriptStep(
  scope: StepScope,
  bootId?: string
): Promise<{ restored: boolean; stepDetail?: string }> {
  const session = await loadSession(scope)
  const claudeSessionId = session.claudeSessionId
  if (!claudeSessionId) return { restored: false }
  const object =
    session.transcriptKey && scope.env.FILES
      ? await scope.env.FILES.get(session.transcriptKey)
      : null
  // Where the session's runtime keeps the conversation (§18.22 — Claude: its transcript).
  const state = runtimeOf(session).state
  if (object && state.restorable(session)) {
    const text = await object.text()
    const sandbox = sandboxFor(scope, session)
    const there = await inOurContainer(scope, sandbox, bootId, () =>
      state.restore({ session, sandbox, logger: scope.logger }, text)
    )
    if (there) return { restored: true }
  }
  // Only the id this step read: a turn that started a new conversation meanwhile keeps its own.
  const [forgot] = await scope.db
    .update(sessions)
    .set({ claudeSessionId: null })
    .where(
      and(
        eq(sessions.tenantId, scope.params.tenantId),
        eq(sessions.id, scope.params.sessionId),
        eq(sessions.claudeSessionId, claudeSessionId)
      )
    )
    .returning({ id: sessions.id })
  if (forgot) {
    await emitterFor(scope)({
      type: 'error',
      turn: session.turnCount,
      data: { message: CONVERSATION_LOST_MESSAGE },
    })
  }
  return { restored: false, stepDetail: CONVERSATION_LOST_MESSAGE }
}

/**
 * The boot's progress, as `step` events the session page draws as a checklist (`BootProgress`):
 * `running` when a step starts, `done` when it ends, `error` (with the secret-free reason) when it
 * fails. Keyed by the phase, so a retried step updates its own line rather than adding one.
 */
export const BOOT_STEP_LABELS = {
  db: 'Creating database branch',
  prepare: "Preparing the app's database (first session only)",
  branch: 'Creating database branch',
  sandbox: 'Starting sandbox',
  restore: 'Restoring the saved workspace',
  repo: 'Cloning repo',
  bootstrap: 'Installing and seeding',
  dev: 'Starting dev server',
  transcript: 'Restoring the conversation',
  // Issue #16: a `prebuild` run's clone + install, then its save.
  prebuild: "Building the app's prebuild",
} as const

export type BootPhase = keyof typeof BOOT_STEP_LABELS

/** How much of a failed boot step's reason the checklist and `sessions.error` carry. */
export const BOOT_ERROR_MAX_CHARS = 4000

/** The person asked to end the session while a boot step was running. */
export class SessionEndRequestedError extends Error {
  constructor() {
    super('The session was ended while it was starting')
    this.name = 'SessionEndRequestedError'
  }
}

/** The row says the session is being ended (asked, `ending`, or already settled). */
export const endRequested = (row: Pick<SessionRow, 'status' | 'requestedAction'>) =>
  row.requestedAction === 'end' ||
  row.status === 'ending' ||
  (TERMINAL_SESSION_STATUSES as readonly string[]).includes(row.status)

/** Throw {@link SessionEndRequestedError} when the row says the session is being ended. */
export async function throwIfEndRequested(scope: StepScope): Promise<void> {
  const [row] = await scope.db
    .select({ status: sessions.status, requestedAction: sessions.requestedAction })
    .from(sessions)
    .where(
      and(eq(sessions.tenantId, scope.params.tenantId), eq(sessions.id, scope.params.sessionId))
    )
  if (row && endRequested(row)) throw new SessionEndRequestedError()
}

/** "I am alive": `last_activity_at` of a booting session — the clock `reconcile.ts` reads. */
async function heartbeat(scope: StepScope): Promise<void> {
  await scope.db
    .update(sessions)
    .set({ lastActivityAt: scope.now() })
    .where(
      and(
        eq(sessions.tenantId, scope.params.tenantId),
        eq(sessions.id, scope.params.sessionId),
        inArray(sessions.status, ['requested', 'booting'])
      )
    )
}

/**
 * Run a boot step's body while watching the row: every `endPollMs` an end request (or a session
 * already ending) stops the step at once with {@link SessionEndRequestedError} — the Workflow then
 * ends the session instead of failing it — and every `heartbeatMs` the session's heartbeat is
 * written. The body cannot be cancelled; the container's destruction in `cleanup` ends it.
 */
async function watched<T>(scope: StepScope, body: Promise<T>): Promise<T> {
  const limits = limitsOf(scope)
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let lastBeat = Date.now()
  const watcher = new Promise<never>((_, reject) => {
    const tick = async () => {
      if (stopped) return
      try {
        await throwIfEndRequested(scope)
        if (Date.now() - lastBeat >= limits.heartbeatMs) {
          lastBeat = Date.now()
          await heartbeat(scope)
        }
      } catch (err) {
        if (err instanceof SessionEndRequestedError) {
          reject(err)
          return
        }
        // A failed poll is not a failed step.
      }
      if (!stopped) timer = setTimeout(tick, limits.endPollMs)
    }
    timer = setTimeout(tick, limits.endPollMs)
  })
  try {
    return await Promise.race([body, watcher])
  } finally {
    stopped = true
    clearTimeout(timer)
    body.catch(() => {})
    watcher.catch(() => {})
  }
}

/**
 * A boot step's body, with its checklist line (above) and its clock (issue #8): the result carries
 * `timing` — when the body started and how long it ran — for the Workflow to collect. Given
 * `finish`, this is the boot's LAST step: once it is done it writes the boot's `boot.timing` event
 * and spans (`boot-timing.ts`) from `finish.before` and its own timing.
 */
export function withProgress<T extends object>(
  phase: BootPhase,
  body: (scope: StepScope) => Promise<T>,
  finish?: BootTimingFinish
): (scope: StepScope) => Promise<T & { timing: BootStepTiming }> {
  return async outer => {
    const label = BOOT_STEP_LABELS[phase]
    const scope: StepScope = { ...outer, phase: label }
    const emit = emitterFor(scope)
    // Progress on the running step: the same `step` row, still `running`, with a detail.
    scope.progress = async detail => {
      await emit({ type: 'step', turn: 0, data: { key: phase, label, status: 'running', detail } })
    }
    // An end asked before (or between) steps: stop before starting anything.
    await throwIfEndRequested(scope)
    await heartbeat(scope)
    await emit({ type: 'step', turn: 0, data: { key: phase, label, status: 'running' } })
    try {
      const startedAt = scope.now().getTime()
      const result = await watched(scope, body(scope))
      const timing = stepTiming(phase, startedAt, scope.now().getTime(), result)
      // A step that finished another way than planned says how (`restore#K`: "Cloning instead").
      const detail = (result as { stepDetail?: unknown } | null)?.stepDetail
      await emit({
        type: 'step',
        turn: 0,
        data: {
          key: phase,
          label,
          status: 'done',
          ...(typeof detail === 'string' ? { detail } : {}),
        },
      })
      if (finish) {
        await recordBootTiming(scope, finish, timing, data =>
          emit({ type: 'boot.timing', turn: 0, data })
        ).catch(err => scope.logger.warn({ err }, 'session: could not record the boot timing'))
      }
      return { ...result, timing }
    } catch (err) {
      await emit({
        type: 'step',
        turn: 0,
        data: {
          key: phase,
          label,
          status: 'error',
          detail:
            err instanceof SessionEndRequestedError
              ? 'Stopped: the session is being ended'
              : scope.restartable && err instanceof SandboxRestartedError
                ? BOOT_RESTART_DETAIL
                : safeErrorMessage(err, 'The step failed', BOOT_ERROR_MAX_CHARS),
        },
      })
      throw err
    }
  }
}

// ---- the loop ----------------------------------------------------------------------------------

export type NextAction =
  | { action: 'turn'; maxTurnMinutes: number }
  | { action: 'ship' }
  /** Issue #5 Phase A: the `shipping` session's landing is in `stage` — `SessionWorkflow.land`. */
  | { action: 'land'; stage: PhaseALandingStage }
  | { action: 'end'; reason: string }
  | { action: 'resume' }
  | { action: 'suspend'; reason: 'drain' }
  | { action: 'cool'; reason: 'idle' | 'drain' }
  /** The workspace holds unsaved changes and the debounce is already over: save it now. */
  | { action: 'checkpoint' }
  | {
      action: 'wait'
      waitingIn: SessionStatus
      /** Whole seconds (`waitDuration` renders it); at least one. */
      timeoutSeconds: number
      /** A timeout means the kept container's warm window is over: cool it, do not end. */
      cool?: boolean
      /**
       * Issue #17: the session is a warm start nobody has written to — a timeout ENDS it
       * (`endStep` with `unprompted`, which re-checks it is still unprompted and quiet), it is
       * never suspended.
       */
      unprompted?: boolean
      /**
       * The timeout is the checkpoint debounce's, not the idle policy's: on a timeout the loop
       * checkpoints and carries on waiting — it never suspends for it.
       */
      debounce?: boolean
    }
  | { action: 'done'; status: SessionStatus }

/**
 * The loop's memory of unsaved work (Launch P3, debounced checkpoints): ISO timestamps, both taken
 * INSIDE a step (`turn#N`'s `endedAt`) — the Workflow replays everything outside a step, so the
 * loop never reads a clock itself; it only carries these from one step's result into the next
 * step's argument.
 */
export interface DirtyState {
  /** When the first turn that left the workspace changed (and not yet checkpointed) ended. */
  dirtySince: string
  /** When the latest turn ended — the debounce counts from here. */
  lastTurnAt: string
}

/** `limits` may shrink the debounce and its cap (`overrides.limits`); these are the defaults. */
export function checkpointClocks(limits: SessionCallLimits = SESSION_CALL_LIMITS): {
  debounceMs: number
  maxDeferMs: number
} {
  return {
    debounceMs: limits.checkpointDebounceMs ?? SESSION_CHECKPOINT_DEBOUNCE_MS,
    maxDeferMs: limits.checkpointMaxDeferMs ?? SESSION_CHECKPOINT_MAX_DEFER_MS,
  }
}

/**
 * Milliseconds until a dirty workspace should be checkpointed: the debounce after the latest turn,
 * or the cap after the first unsaved change, whichever comes first. Zero or less = now.
 */
export function checkpointDueInMs(
  dirty: DirtyState,
  now: Date,
  limits: SessionCallLimits = SESSION_CALL_LIMITS
): number {
  const { debounceMs, maxDeferMs } = checkpointClocks(limits)
  const due = Math.min(
    Date.parse(dirty.lastTurnAt) + debounceMs,
    Date.parse(dirty.dirtySince) + maxDeferMs
  )
  return due - now.getTime()
}

/**
 * Step `inspect#N`: what to do next, from the row alone — plus the loop's {@link DirtyState}. Order
 * matters: an end beats everything, a drain suspends a live session, a ship beats a turn, a turn
 * beats a due checkpoint, and nothing to do is a wait — whose timeout is the idle policy (live),
 * the expiry (suspended), or, while the workspace holds unsaved changes, what is left of the
 * checkpoint debounce when that is sooner (`debounce: true`).
 */
export async function inspectStep(
  scope: StepScope,
  dirty: DirtyState | null = null
): Promise<NextAction> {
  const session = await loadSession(scope)
  const policy = resolveSessionPolicy(session.policy)
  const status = session.status
  if ((TERMINAL_SESSION_STATUSES as readonly string[]).includes(status)) {
    return { action: 'done', status }
  }
  // Issue #5: a merge in flight is never stopped half-way, not even by an End (the route refuses
  // one in `merging`; this covers the race). Any other landing stage yields to an explicit End,
  // and beats `maxSessionHours`.
  const landStage = phaseAStageOf(session)
  if (landStage === 'merging') return { action: 'land', stage: landStage }
  if (status === 'ending' || session.requestedAction === 'end') {
    return { action: 'end', reason: 'requested' }
  }
  if (landStage) return { action: 'land', stage: landStage }
  const ageHours = (scope.now().getTime() - session.createdAt.getTime()) / 3_600_000
  if (ageHours >= policy.maxSessionHours) return { action: 'end', reason: 'max_session_hours' }
  const live = status === 'ready' || status === 'blocked'
  if (live && (await sessionsPaused(scope.db))) return { action: 'suspend', reason: 'drain' }
  if (status === 'suspended') {
    const paused = await sessionsPaused(scope.db)
    if (session.requestedAction === 'resume' && !paused) return { action: 'resume' }
    // Issue #17: a warm start nobody wrote to has nothing to resume to — it ends at once.
    if (isUnpromptedWarmStart(session)) return { action: 'end', reason: 'unprompted' }
    const expiryMinutes = policy.suspendedExpiryHours * 60
    const warmLeft = warmMinutesLeft(session.containerKeptAt, scope.now())
    if (warmLeft !== null) {
      // A kept container: a drain destroys it now; otherwise it waits out its warm window.
      if (paused) return { action: 'cool', reason: 'drain' }
      if (warmLeft === 0) return { action: 'cool', reason: 'idle' }
      if (warmLeft < expiryMinutes) {
        return { action: 'wait', waitingIn: status, timeoutSeconds: warmLeft * 60, cool: true }
      }
    }
    return { action: 'wait', waitingIn: status, timeoutSeconds: expiryMinutes * 60 }
  }
  if (status === 'ready' && session.requestedAction === 'ship') return { action: 'ship' }
  if (status === 'ready' && session.pendingMessage !== null) {
    return { action: 'turn', maxTurnMinutes: policy.maxTurnMinutes }
  }
  if (status === 'ready' && isUnpromptedWarmStart(session)) {
    // Issue #17: booted on intent and still waiting for its first message — it ends, quiet for
    // the warm-start window (`warm.ts`); a message wakes it first.
    const left = idleMinutesLeft(session, warmStartMinutes(policy), scope.now())
    return { action: 'wait', waitingIn: status, timeoutSeconds: left * 60, unprompted: true }
  }
  const idleSeconds = idleMinutesLeft(session, policy.idleSuspendMinutes, scope.now()) * 60
  if (live && dirty) {
    const dueMs = checkpointDueInMs(dirty, scope.now(), limitsOf(scope))
    if (dueMs <= 0) return { action: 'checkpoint' }
    const debounceSeconds = Math.max(1, Math.ceil(dueMs / 1000))
    if (debounceSeconds <= idleSeconds) {
      return { action: 'wait', waitingIn: status, timeoutSeconds: debounceSeconds, debounce: true }
    }
  }
  return { action: 'wait', waitingIn: status, timeoutSeconds: idleSeconds }
}

/**
 * A `waitForEvent` timeout: whole minutes when it is (`30 minutes`), else seconds (`30 seconds`,
 * the checkpoint debounce).
 */
export function waitDuration(seconds: number): `${number} minutes` | `${number} seconds` {
  const s = Math.max(1, Math.ceil(seconds))
  return s % 60 === 0 ? `${s / 60} minutes` : `${s} seconds`
}

/**
 * The idle clock of a live session: minutes until it has been quiet for `idleMinutes`, counted
 * from `last_activity_at` — which a turn, a checkpoint, the model proxy AND the person's use of
 * the preview (`api/preview/gateway.ts`, throttled) move. At least one minute; the whole window
 * when nothing was ever recorded.
 */
export function idleMinutesLeft(
  session: Pick<SessionRow, 'lastActivityAt'>,
  idleMinutes: number,
  now: Date
): number {
  if (!session.lastActivityAt) return idleMinutes
  const quietMinutes = (now.getTime() - session.lastActivityAt.getTime()) / 60_000
  return Math.min(idleMinutes, Math.max(1, Math.ceil(idleMinutes - quietMinutes)))
}

/** A hook's context for this step: the fresh row, the sandbox, the emitter. */
export function hookContext(
  scope: StepScope,
  session: SessionRow,
  turn: number,
  bootId?: string
): SessionStepContext {
  return {
    ...(bootId ? { bootId } : {}),
    db: scope.db,
    env: scope.env,
    cfg: scope.cfg,
    ports: scope.ports,
    sandbox: sandboxFor(scope, session),
    storage: scope.env.FILES ? createR2Storage(scope.env.FILES) : null,
    ref: { tenantId: scope.params.tenantId, sessionId: scope.params.sessionId },
    session,
    turn,
    emit: emitterFor(scope),
    realtime: scope.realtime,
    logger: scope.logger,
    now: scope.now,
  }
}

/** What `turn#N` reports to the loop: 3c's outcome, reduced to what decides the next step. */
export interface TurnStepResult {
  status: TurnOutcome['status']
  /**
   * For `interrupted`: `rollout` · `container_lost` (either way the container is gone and the
   * session `suspended` — `containerGone`) · `cancelled` · `timeout`.
   */
  reason?: string
  /**
   * For a turn that ran with the container still up ({@link turnNeedsCheckpoint}): the workspace
   * differs from the last checkpoint (`workspaceChanged` — true when the check itself failed).
   */
  changed?: boolean
  /** When the step saw the turn end (ISO) — the loop's debounce clock ({@link DirtyState}). */
  endedAt?: string
  /** The workspace has held unsaved changes for the cap: checkpoint now, do not debounce. */
  checkpointNow?: boolean
}

/**
 * Step `turn#N`: `hooks.runTurn` (slice 3c) claims `ready → working`, runs the message, and
 * settles the status itself. A `SandboxInterruptedError` escaping it is a rollout: the Workflow
 * writes `turn.interrupted { reason: 'rollout' }` and suspends. Anything else escaping it (the
 * database) leaves a `working` row that `turn-settle#N` repairs.
 *
 * After a turn that ran with the container still up, it asks the checkout whether anything is
 * unsaved (`workspaceChanged`: `git status`, HEAD against `head_sha`) and whether the session has
 * now held unsaved changes for the cap (`dirty` is the loop's state before this turn) — the loop
 * decides from that whether to checkpoint now, debounce, or do nothing.
 */
export async function turnStep(
  scope: StepScope,
  dirty: DirtyState | null = null,
  bootId?: string
): Promise<TurnStepResult> {
  const session = await loadSession(scope)
  let result: TurnStepResult
  let outcome: TurnOutcome
  try {
    outcome = await scope.hooks.runTurn(hookContext(scope, session, session.turnCount, bootId))
    result = {
      status: outcome.status,
      ...(outcome.status === 'interrupted' ? { reason: outcome.reason } : {}),
    }
  } catch (err) {
    if (!(err instanceof SandboxInterruptedError)) throw err
    const current = await loadSession(scope)
    const turn = Math.max(1, current.turnCount)
    await emitterFor(scope)({ type: 'turn.interrupted', turn, data: { turn, reason: 'rollout' } })
    await transition(scope, ['ready', 'working'], 'suspended', {
      suspendedAt: scope.now(),
      cancelRequestedAt: null,
    })
    await autoShipAfterTurn(scope, { status: 'interrupted', turn }, undefined)
    return { status: 'interrupted', reason: 'rollout' }
  }
  if (!turnNeedsCheckpoint(result)) {
    await autoShipAfterTurn(scope, outcome, undefined)
    return result
  }
  const after = await loadSession(scope)
  const changed = await workspaceChanged(sandboxFor(scope, after), after.headSha)
  const endedAt = scope.now()
  const since = dirty?.dirtySince ?? (changed ? endedAt.toISOString() : null)
  const { maxDeferMs } = checkpointClocks(limitsOf(scope))
  const checkpointNow =
    changed && since !== null && endedAt.getTime() - Date.parse(since) >= maxDeferMs
  await autoShipAfterTurn(scope, outcome, changed)
  return { ...result, changed, endedAt: endedAt.toISOString(), checkpointNow }
}

// ---- auto-ship (P6 6c: a kit upgrade's first turn) -------------------------------------------------

/** The tool Claude Code asks a person a question with — an upgrade turn that called it stopped to ask. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

/**
 * After a turn of a session with `auto_ship` (a kit upgrade's): decide, ONCE, whether to ship it.
 * Nothing is decided while the first message still waits (a budget stop, a container lost before
 * the turn ran — it runs later, and is decided then) or for a turn that never ran (`skipped`).
 * Otherwise `auto_ship` is cleared whichever way it goes, by a compare-and-set, so a retried step
 * or a later turn never decides again:
 *
 * - clean (`autoShipVerdict`: a `success` result ending `LAUNCH-UPGRADE: DONE`, no question asked,
 *   the workspace changed and the checkout's `.rocketflare.json` at the target) → `requested_action
 *   = ship` on the `ready` row, which the loop's next `inspect` starts at once;
 * - a turn that never ran the upgrade (`upgradeFollowUpDue`: a clean `success` with NO
 *   `LAUNCH-UPGRADE:` line and the workspace measured unchanged) → ONCE per upgrade, Launch sends
 *   it back with its own follow-up turn (`sendUpgradeFollowUp`, claimed by `follow_up_sent_at`)
 *   and leaves `auto_ship` set, so that next turn is decided here exactly as this one would be;
 * - anything else → the upgrade `needs_attention`, with the reason in a `status` event the chat
 *   shows; the owner carries on in the session.
 *
 * Never throws: a check that fails is a reason, not a failed turn.
 */
async function autoShipAfterTurn(
  scope: StepScope,
  outcome: TurnOutcome | { status: 'interrupted'; turn: number },
  changed: boolean | undefined
): Promise<void> {
  if (outcome.status === 'skipped') return
  const row = await loadSession(scope)
  if (!row.autoShip || row.pendingMessage !== null) return
  let verdict: AutoShipVerdict
  let upgrade: Awaited<ReturnType<typeof upgradeAwaitingAutoShip>> = null
  try {
    upgrade = await upgradeAwaitingAutoShip(scope.db, row)
    if (!upgrade) {
      verdict = { ship: false, reason: 'The upgrade is no longer waiting to ship.' }
    } else {
      const turn = 'turn' in outcome ? outcome.turn : row.turnCount
      const completed = outcome.status === 'completed'
      const evidence: UpgradeTurnEvidence = {
        status: outcome.status,
        ...('result' in outcome && outcome.result ? { result: outcome.result } : {}),
        ...(changed !== undefined ? { changed } : {}),
        askedQuestion: completed ? await turnAskedQuestion(scope, row, turn) : false,
        manifestVersion: completed && changed ? await checkoutKitVersion(scope, row) : null,
      }
      // The turn never ran the upgrade (no marker, nothing changed): send it back ONCE, and leave
      // `auto_ship` set so the next turn is decided here as this one would have been.
      if (
        upgradeFollowUpDue(evidence, upgrade.followUpSentAt !== null) &&
        (await followUpUpgrade(scope, row, upgrade))
      ) {
        return
      }
      verdict = autoShipVerdict(evidence, upgrade.toVersion)
    }
  } catch (err) {
    scope.logger.warn({ err, sessionId: row.id }, 'session: could not check the upgrade turn')
    verdict = { ship: false, reason: 'Launch could not check the upgrade.' }
  }
  const tenantId = scope.params.tenantId
  const [decided] = await scope.db
    .update(sessions)
    .set({
      autoShip: false,
      ...(verdict.ship ? { requestedAction: 'ship' as const, lastActivityAt: scope.now() } : {}),
    })
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        eq(sessions.id, row.id),
        eq(sessions.autoShip, true),
        // A ship is asked of a `ready` session only (`ACTION_FROM`); anything else is not clean.
        verdict.ship ? eq(sessions.status, 'ready') : undefined
      )
    )
    .returning()
  if (!decided && verdict.ship) {
    verdict = { ship: false, reason: 'The session was no longer ready to ship.' }
    const [cleared] = await scope.db
      .update(sessions)
      .set({ autoShip: false })
      .where(
        and(eq(sessions.tenantId, tenantId), eq(sessions.id, row.id), eq(sessions.autoShip, true))
      )
      .returning()
    if (!cleared) return
  } else if (!decided) {
    return
  }
  const emit = emitterFor(scope)
  if (verdict.ship) {
    await emit({
      type: 'status',
      turn: row.turnCount,
      data: {
        status: 'ready',
        reason: UPGRADE_SESSION_REASONS.autoShip,
        message: 'The upgrade finished cleanly, so Launch is shipping it.',
      },
    })
    nudgeSession(scope.realtime, row)
    return
  }
  const message = needsAttentionMessage(verdict.reason)
  if (upgrade) await upgradeNeedsAttention(scope.db, row, verdict.reason, scope.realtime)
  await emit({
    type: 'status',
    turn: row.turnCount,
    data: { status: row.status, reason: UPGRADE_SESSION_REASONS.needsAttention, message },
  })
  nudgeSession(scope.realtime, row)
}

/**
 * Send an upgrade session that never ran the upgrade its one follow-up turn
 * (`sendUpgradeFollowUp`) and say so in the chat. True when it was sent; false when it was not
 * (already sent by an earlier attempt of this step, or the session takes no turn now) — the caller
 * then decides as usual. Never throws.
 */
async function followUpUpgrade(
  scope: StepScope,
  row: SessionRow,
  upgrade: NonNullable<Awaited<ReturnType<typeof upgradeAwaitingAutoShip>>>
): Promise<boolean> {
  let sent: SessionRow | null
  try {
    sent = await sendUpgradeFollowUp(scope.db, row, upgrade, scope.now())
  } catch (err) {
    scope.logger.warn({ err, sessionId: row.id }, 'session: could not send the upgrade follow-up')
    return false
  }
  if (!sent) return false
  // Sent: the message waits on the row, so a failed event must not undo the decision.
  try {
    await emitterFor(scope)({
      type: 'status',
      turn: row.turnCount,
      data: {
        status: sent.status,
        reason: UPGRADE_SESSION_REASONS.followUp,
        message:
          'The upgrade turn ended without running the upgrade, so Launch sent it back to run it. This happens once.',
      },
    })
  } catch (err) {
    scope.logger.warn({ err, sessionId: row.id }, 'session: could not record the upgrade follow-up')
  }
  nudgeSession(scope.realtime, row)
  return true
}

/** Did turn `turn` call `AskUserQuestion` (a `tool.start` naming it)? */
async function turnAskedQuestion(
  scope: StepScope,
  row: SessionRow,
  turn: number
): Promise<boolean> {
  const [hit] = await scope.db
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, row.tenantId),
        eq(sessionEvents.sessionId, row.id),
        eq(sessionEvents.turn, turn),
        eq(sessionEvents.type, 'tool.start'),
        sql`${sessionEvents.data}->>'name' = ${ASK_USER_QUESTION_TOOL}`
      )
    )
    .limit(1)
  return hit !== undefined
}

/** `.rocketflare.json`'s `kit.version` in the session's checkout, or null when it cannot be read. */
async function checkoutKitVersion(scope: StepScope, row: SessionRow): Promise<string | null> {
  const result = await sandboxFor(scope, row).exec(
    `cat ${SESSION_WORKSPACE}/${MANIFEST_PATHS[0]}`,
    { timeoutMs: 30_000 }
  )
  if (result.exitCode !== 0) return null
  try {
    return parseManifest(result.stdout).kitVersion
  } catch {
    return null
  }
}

/** A turn that ran with the container still up: its workspace is worth checking (and saving). */
export function turnNeedsCheckpoint(result: TurnStepResult): boolean {
  if (result.status === 'completed' || result.status === 'failed') return true
  return result.status === 'interrupted' && !containerGone(result)
}

/**
 * The loop's {@link DirtyState} after a turn that did not checkpoint: a changed workspace keeps
 * the FIRST change's time and moves the debounce to this turn's end; an unchanged one is clean
 * (the check is of the whole workspace against the last checkpoint, not of this turn's own
 * edits — so nothing is left unsaved); a turn that never ran leaves the state as it was.
 */
export function dirtyAfterTurn(
  dirty: DirtyState | null,
  result: TurnStepResult
): DirtyState | null {
  if (result.endedAt === undefined || result.changed === undefined) return dirty
  if (!result.changed) return null
  return { dirtySince: dirty?.dirtySince ?? result.endedAt, lastTurnAt: result.endedAt }
}

/**
 * Step `turn-settle#N`: the turn STEP itself died (the platform's timeout, a database error) with
 * the row still `working` — say so, and put the session back to `ready`.
 */
export async function turnSettleStep(scope: StepScope, message: string): Promise<void> {
  const session = await loadSession(scope)
  if (session.status !== 'working') return
  const turn = Math.max(1, session.turnCount)
  await emitterFor(scope)({ type: 'turn.failed', turn, data: { turn, message } })
  await transition(scope, ['working'], 'ready', {
    lastActivityAt: scope.now(),
    cancelRequestedAt: null,
  })
  // A kit upgrade's first turn that died this way did not end cleanly: hand it to its owner.
  await autoShipAfterTurn(scope, { status: 'interrupted', turn }, undefined)
}

/**
 * Step `rollout#N`: after a turn whose container is gone — a rollout, or one that died and came
 * back empty (`container_lost`); the session is already `suspended` — make sure nothing of it
 * lingers. No checkpoint: there is nothing in it to save. The next message resumes cold, from the
 * workspace backup or the branch.
 */
export async function rolloutStep(scope: StepScope): Promise<{ destroyed: true }> {
  const session = await loadSession(scope)
  await sandboxFor(scope, session).destroy()
  return { destroyed: true }
}

/**
 * Step `checkpoint#N` (and the head of `suspend#N` / `end#N`): `hooks.checkpoint` (slice 3d). A
 * failed checkpoint is an `error` event, never a failed session — the previous one still stands.
 *
 * With the boot's id, it first checks the container is still the one the boot prepared: one that
 * died and came back EMPTY has nothing to save, and a checkpoint of it would fail at its first
 * `cd` ("Failed to change directory"). That is `lost`, said as such — and a `turn` checkpoint of
 * a live session suspends it (the empty container destroyed), so the next message resumes from
 * the last save instead of running on nothing. `suspend#N` and `end#N` settle the status
 * themselves.
 */
export async function checkpointStep(
  scope: StepScope,
  reason: CheckpointReason,
  bootId?: string
): Promise<{ ok: boolean; lost?: boolean }> {
  const session = await loadSession(scope)
  if (bootId) {
    const sandbox = sandboxFor(scope, session)
    const verdict = await checkContainer(sandbox, bootId)
    if (verdict === 'replaced' || verdict === 'interrupted') {
      scope.logger.warn({ reason, verdict }, 'session: checkpoint found the container lost')
      const suspends = reason === 'turn'
      await emitterFor(scope)({
        type: 'error',
        turn: session.turnCount,
        data: { message: containerLostCheckpointMessage(suspends) },
      })
      if (suspends) {
        await transition(scope, ['ready', 'blocked'], 'suspended', {
          suspendedAt: scope.now(),
          containerKeptAt: null,
          cancelRequestedAt: null,
        })
        await sandbox.destroy().catch(err => {
          scope.logger.warn({ err }, 'session: could not destroy the lost container')
        })
      }
      return { ok: false, lost: true }
    }
  }
  try {
    await scope.hooks.checkpoint(hookContext(scope, session, session.turnCount), reason)
    return { ok: true }
  } catch (err) {
    scope.logger.warn({ err, reason }, 'session: checkpoint failed')
    await emitterFor(scope)({
      type: 'error',
      turn: session.turnCount,
      data: { message: `Could not save the session's work: ${safeErrorMessage(err)}` },
    })
    return { ok: false }
  }
}

/**
 * Step `suspend#N`: checkpoint, then `suspended` — the branch and database are kept. An IDLE
 * suspend keeps the container too (`container_kept_at`, `warm.ts`): a resume inside the warm
 * window reuses it, and `cool#N` destroys it after. A DRAIN destroys it now (a deploy is about to
 * replace it), and a resume boots again from the branch.
 */
export async function suspendStep(
  scope: StepScope,
  reason: 'idle' | 'drain',
  bootId?: string
): Promise<{ suspended: boolean }> {
  const session = await loadSession(scope)
  if (session.status !== 'ready' && session.status !== 'blocked') return { suspended: false }
  if (reason === 'idle') {
    // The wait timed out, but the person may have been using the preview meanwhile (nothing
    // wakes the Workflow for that): not idle yet → the loop's next `inspect` waits out the rest.
    const idleMinutes = resolveSessionPolicy(session.policy).idleSuspendMinutes
    const lastActivity = session.lastActivityAt?.getTime() ?? 0
    if (scope.now().getTime() - lastActivity < idleMinutes * 60_000) return { suspended: false }
  }
  const { lost } = await checkpointStep(scope, 'suspend', bootId)
  // A container that came back empty is not worth keeping, nor backing up: destroy it.
  const keep = reason === 'idle' && !lost
  if (lost) {
    await sandboxFor(scope, session)
      .destroy()
      .catch(err => scope.logger.warn({ err }, 'session: could not destroy the lost container'))
  } else if (!keep) {
    const sandbox = sandboxFor(scope, session)
    await backupWorkspace(scope, await loadSession(scope), sandbox)
    await sandbox.destroy()
  }
  const now = scope.now()
  // `onStop` in the Sandbox Durable Object may have got there first: suspended is suspended — and
  // then there is no container left to keep.
  const row = await transition(scope, ['ready', 'blocked'], 'suspended', {
    suspendedAt: now,
    containerKeptAt: keep ? now : null,
  })
  const settled = row ?? (await transition(scope, ['suspended'], 'suspended', { suspendedAt: now }))
  if (settled) {
    await emitterFor(scope)({
      type: 'status',
      turn: session.turnCount,
      data: { status: 'suspended', reason },
    })
  }
  return { suspended: settled !== null }
}

/**
 * Step `cool#N`: a suspended session's KEPT container is destroyed — its warm window is over
 * (`idle`) or a drain wants every container gone (`drain`). Nothing to do when the row no longer
 * keeps one (a resume took it, `onStop` saw it go), or when a resume is waiting: the loop's next
 * `inspect` resumes onto it instead.
 */
export async function coolStep(
  scope: StepScope,
  reason: 'idle' | 'drain'
): Promise<{ cooled: boolean }> {
  const session = await loadSession(scope)
  if (session.status !== 'suspended' || session.containerKeptAt === null) return { cooled: false }
  if (reason === 'idle' && session.requestedAction === 'resume') return { cooled: false }
  const sandbox = sandboxFor(scope, session)
  // Only the kept container's own workspace is worth saving: one recreated under the session
  // (no boot marker) is empty, and a backup of it would restore nothing.
  if ((await sandbox.readFile(SESSION_BOOT_MARKER).catch(() => null)) !== null) {
    await backupWorkspace(scope, session, sandbox)
  }
  await sandbox.destroy()
  await updateSession(scope, { containerKeptAt: null })
  return { cooled: true }
}

// ---- workspace backups (`workspace-backup.ts`) ------------------------------------------------

/** A backup failure's reason for the event log: secret-free, and no presigned URL's signature. */
export function backupFailureReason(err: unknown): string {
  return safeErrorMessage(err, 'the backup failed', 400).replace(
    /(https?:\/\/[^\s?'"]+)\?[^\s'"]*/gi,
    '$1'
  )
}

/**
 * Back the workspace up before its container is destroyed, and record it on the row (replacing —
 * and deleting — the previous one). Best effort: a backup that fails, or is off, costs the next
 * resume a clone and an install, never the suspend. Every attempt is a `workspace.backup` event —
 * `failed` with the reason, so a `workspace_backup` that stayed null is explained (issue #3) —
 * and a failure is logged. True when a backup was recorded.
 */
export async function backupWorkspace(
  scope: StepScope,
  session: SessionRow,
  sandbox: SandboxPort
): Promise<boolean> {
  if (session.kind === 'prepare') return false
  const mode = workspaceBackupMode(scope.cfg, sandboxHostOf(session))
  if (mode === 'off') return false
  const started = Date.now()
  const record = async (data: Omit<SessionWorkspaceBackupData, 'mode' | 'durationMs'>) => {
    await emitterFor(scope)({
      type: 'workspace.backup',
      turn: session.turnCount,
      data: { ...data, mode, durationMs: Math.max(0, Date.now() - started) },
    }).catch(err => scope.logger.warn({ err }, 'session: could not record the workspace backup'))
  }
  try {
    const head = await sandbox.exec(`git -C ${SESSION_WORKSPACE} rev-parse HEAD`, {
      timeoutMs: 30_000,
    })
    const headSha = head.exitCode === 0 ? head.stdout.trim() : ''
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      const reason = 'the workspace has no commit to back up (git rev-parse HEAD failed)'
      scope.logger.warn({ mode }, `session: workspace not backed up: ${reason}`)
      await record({ status: 'failed', reason })
      return false
    }
    // The container is destroyed after every backup: stop the dev server politely first, so its
    // node processes write their compile cache into the workspace the backup carries.
    await stopDevServerGracefully(sandbox)
    const dbHosts = await dbEgressHostsOf(scope, session)
    const extra = sandbox.backupHosts
    if (extra.length) await sandbox.setAllowedHosts(sessionAllowedHosts([...dbHosts, ...extra]))
    try {
      const policy = resolveSessionPolicy(session.policy)
      const handle = await sandbox.backup({
        dir: SESSION_WORKSPACE,
        ttlSeconds: policy.suspendedExpiryHours * 3600 + BACKUP_TTL_MARGIN_SECONDS,
        name: `session-${session.shortId}`,
      })
      const backup: SessionWorkspaceBackup = {
        ...handle,
        headSha,
        imageVersion: SESSION_IMAGE_VERSION,
        createdAt: scope.now().toISOString(),
      }
      await updateSession(scope, { workspaceBackup: backup })
      await record({ status: 'saved', headSha })
      const previous = session.workspaceBackup
      if (previous && previous.id !== backup.id) {
        await sandbox.deleteBackup(previous).catch(err => {
          scope.logger.warn({ err }, 'session: could not delete the previous workspace backup')
        })
      }
      return true
    } finally {
      if (extra.length) {
        await sandbox.setAllowedHosts(sessionAllowedHosts(dbHosts)).catch(() => {})
      }
    }
  } catch (err) {
    const reason = backupFailureReason(err)
    scope.logger.warn(
      { err, mode },
      `session: workspace backup failed (${reason}); the next resume clones`
    )
    await record({ status: 'failed', reason })
    return false
  }
}

/**
 * Leave nothing half-restored behind for the clone after a failed restore: a presigned restore is
 * a FUSE mount (squashfuse + an overlay), unmounted before the directory goes. Never throws.
 */
export async function clearRestoredWorkspace(sandbox: SandboxPort): Promise<void> {
  await sandbox
    .exec(`fusermount3 -uz ${SESSION_WORKSPACE} 2>/dev/null; rm -rf ${SESSION_WORKSPACE}; true`, {
      timeoutMs: 120_000,
    })
    .catch(() => {})
}

/** Why a recorded backup cannot be restored now, or null when it can. */
function unusableBackup(scope: StepScope, session: SessionRow): string | null {
  const backup = session.workspaceBackup
  if (workspaceBackupMode(scope.cfg, sandboxHostOf(session)) === 'off') return 'backups are off'
  if (!backup) return 'no backup'
  if (!session.headSha || backup.headSha !== session.headSha) return 'the branch moved on'
  if (backup.imageVersion !== SESSION_IMAGE_VERSION) return 'another session image'
  return null
}

/**
 * Step `restore.check#K` (no checklist line): whether a cold resume can restore the workspace
 * backup instead of cloning — the backup's commit is the branch head and its image is this one.
 */
export async function restoreCheckStep(scope: StepScope): Promise<{ usable: boolean }> {
  return { usable: unusableBackup(scope, await loadSession(scope)) === null }
}

/**
 * Step `restore#K`: put the workspace backup back into the fresh container, then check its HEAD
 * is the backup's. Never throws for the restore itself: a failed or wrong restore is cleared and
 * `{ restored: false }` sends the resume down the clone-and-install path (the checklist line says
 * so in its detail).
 */
export async function restoreStep(
  scope: StepScope,
  bootId?: string
): Promise<{ restored: boolean; stepDetail?: string }> {
  const session = await loadSession(scope)
  const backup = session.workspaceBackup
  const why = unusableBackup(scope, session)
  if (why || !backup) return { restored: false, stepDetail: `Cloning instead: ${why}` }
  const sandbox = sandboxFor(scope, session)
  return inOurContainer(scope, sandbox, bootId, async () => {
    const dbHosts = await dbEgressHostsOf(scope, session)
    const extra = sandbox.backupHosts
    try {
      if (extra.length) await sandbox.setAllowedHosts(sessionAllowedHosts([...dbHosts, ...extra]))
      await sandbox.restore(backup)
      const head = await sandbox.exec(`git -C ${SESSION_WORKSPACE} rev-parse HEAD`, {
        timeoutMs: 30_000,
      })
      if (head.exitCode !== 0 || head.stdout.trim() !== backup.headSha) {
        throw new Error('the restored workspace is not at the backup’s commit')
      }
      // A presigned restore mounts the archive lazily from R2: page the dev server's biggest
      // files in while the bootstrap runs (in the background, never waited on).
      await prereadHotFiles(sandbox)
      return { restored: true }
    } catch (err) {
      if (err instanceof SandboxRestartedError) throw err
      scope.logger.warn({ err }, 'session: workspace restore failed; cloning instead')
      await clearRestoredWorkspace(sandbox)
      return {
        restored: false,
        stepDetail: `Cloning instead: ${safeErrorMessage(err, 'the restore failed')}`,
      }
    } finally {
      if (extra.length) {
        await sandbox.setAllowedHosts(sessionAllowedHosts(dbHosts)).catch(() => {})
      }
    }
  })
}

/** Step `resume#N`: `suspended → booting`, the request consumed. The boot steps follow. */
export async function resumeStep(scope: StepScope): Promise<{ resumed: boolean }> {
  const row = await transition(scope, ['suspended'], 'booting', {
    requestedAction: null,
    suspendedAt: null,
    lastActivityAt: scope.now(),
  })
  if (row) {
    await emitterFor(scope)({
      type: 'status',
      turn: row.turnCount,
      data: { status: 'booting', reason: 'resume' },
    })
  }
  return { resumed: row !== null }
}

/** Step `end#N`: `→ ending` (a last checkpoint when the container is up); cleanup follows. */
export async function endStep(
  scope: StepScope,
  reason: string,
  bootId?: string
): Promise<{ ending: boolean }> {
  const session = await loadSession(scope)
  if (reason === 'unprompted') return endUnpromptedWarmStart(scope, session)
  if (session.status === 'ready' || session.status === 'blocked') {
    await checkpointStep(scope, 'end', bootId)
  }
  // Issue #5: an End while the landing waits in `ci` or `approval` (never `merging` — `inspect`
  // finishes that first) abandons it: the `session.merge` request is cancelled, the landing
  // cleared. The PR stays open on GitHub, as it would in `pr` mode.
  const landing = session.status === 'shipping' ? landingOf(session) : null
  const row = await transition(
    scope,
    ['requested', 'booting', 'ready', 'working', 'blocked', 'suspended', 'shipping', 'ending'],
    'ending',
    {
      requestedAction: null,
      lastActivityAt: scope.now(),
      ...(session.status === 'shipping' ? { landing: null } : {}),
    }
  )
  if (row && landing?.approvalId) {
    const cancelled = await cancelMergeApproval(scope.db, {
      tenantId: scope.params.tenantId,
      approvalId: landing.approvalId,
      reason: 'The session was ended',
      now: scope.now(),
    })
    if (cancelled) {
      await emitterFor(scope)({
        type: 'ship.review',
        turn: row.turnCount,
        data: {
          status: 'cancelled',
          approvalId: landing.approvalId,
          note: 'The session was ended',
        },
      })
    }
  }
  if (row && reason !== 'requested') {
    await emitterFor(scope)({
      type: 'status',
      turn: row.turnCount,
      data: { status: 'ending', reason },
    })
  }
  return { ending: row !== null }
}

/**
 * `end#N` for an abandoned warm start (issue #17, `warm.ts`): the session is moved to `ending` ONLY
 * while it is still unprompted — a compare-and-set on `turn_count = 0` and no `pending_message`, so
 * a first message that lands meanwhile wins — and, when `ready`, only once it has been quiet for the
 * warm-start window (the preview moves the clock without waking the Workflow). No checkpoint:
 * nobody asked for anything, so there is nothing to save. `cleanup` then destroys the container
 * and deletes the branch. `{ ending: false }` = carry on (the next `inspect` reads the row).
 */
async function endUnpromptedWarmStart(
  scope: StepScope,
  session: SessionRow
): Promise<{ ending: boolean }> {
  if (!isUnpromptedWarmStart(session)) return { ending: false }
  if (session.status === 'ready') {
    const windowMs = warmStartMinutes(resolveSessionPolicy(session.policy)) * 60_000
    const lastActivity = session.lastActivityAt?.getTime() ?? 0
    if (scope.now().getTime() - lastActivity < windowMs) return { ending: false }
  }
  const [row] = await scope.db
    .update(sessions)
    .set({ status: 'ending', requestedAction: null, lastActivityAt: scope.now() })
    .where(
      and(
        eq(sessions.tenantId, scope.params.tenantId),
        eq(sessions.id, scope.params.sessionId),
        inArray(sessions.status, ['ready', 'suspended']),
        eq(sessions.turnCount, 0),
        isNull(sessions.pendingMessage)
      )
    )
    .returning()
  if (!row) return { ending: false }
  nudgeSession(scope.realtime, row)
  await emitterFor(scope)({
    type: 'status',
    turn: 0,
    data: { status: 'ending', reason: 'unprompted' },
  })
  return { ending: true }
}

/**
 * Step `fail`: a boot or loop step gave up — `failed`, with a secret-free sentence. When the person
 * had asked to END the session (a boot step stopped for it, `SessionEndRequestedError`), it is an
 * end, not a failure: `ending`, and `cleanup` settles it `ended`. Either way a prepare claim this
 * session held on the app's `dev` is given back (`releaseDevPrepare`).
 */
export async function failStep(scope: StepScope, message: string): Promise<void> {
  const session = await loadSession(scope)
  await releaseDevPrepare(scope.db, {
    tenantId: session.tenantId,
    appId: session.appId,
    sessionId: session.id,
  })
  if (session.kind === 'prebuild') {
    await releasePrebuildClaim(scope.db, {
      tenantId: session.tenantId,
      appId: session.appId,
      sessionId: session.id,
      error: message,
      now: scope.now(),
    })
  }
  if ((TERMINAL_SESSION_STATUSES as readonly string[]).includes(session.status)) return
  if (session.requestedAction === 'end' || session.status === 'ending') {
    await endStep(scope, 'requested')
    return
  }
  await transition(
    scope,
    ['requested', 'booting', 'ready', 'working', 'blocked', 'suspended', 'shipping', 'ending'],
    'failed',
    { error: message }
  )
  await emitterFor(scope)({
    type: 'error',
    turn: session.turnCount,
    data: { message },
  })
}

/**
 * Step `cleanup` — ALWAYS: destroy the container, delete the ship gate's branches and then the
 * session's branch, settle `ended` (a `shipped` or `failed` session keeps its status), forget the
 * sealed credentials, audit `session.ended`.
 * Throws (so the platform retries) if the container or the branch could not be removed.
 */
export async function cleanupStep(scope: StepScope): Promise<{ status: SessionStatus }> {
  const session = await loadSession(scope)
  await sandboxFor(scope, session).destroy()
  if (session.workspaceBackup) {
    // Best effort: an R2 lifecycle rule on `backups/` is the backstop (docs/DEPLOY.md).
    await sandboxFor(scope, session)
      .deleteBackup(session.workspaceBackup)
      .catch(err => scope.logger.warn({ err }, 'session: could not delete the workspace backup'))
  }
  if (session.db && session.kind !== 'prepare') {
    const app = await loadAppRef(scope, session.appId)
    const db = session.db
    const port = scope.ports.sessionDb(scope.db)
    // The ship gate's branches are CHILDREN of the session's: Neon refuses to delete a parent,
    // so they go first — a ship the session ended (or lost) mid-gate leaves none behind.
    await vendorCall(scope, "Deleting the ship gate's database branches", () =>
      port.deleteGateBranches(app, session.shortId)
    )
    await vendorCall(scope, "Deleting the session's database branch", () =>
      port.deleteBranch(app, db)
    )
  }
  await releaseDevPrepare(scope.db, {
    tenantId: session.tenantId,
    appId: session.appId,
    sessionId: session.id,
  })
  if (session.kind === 'prebuild') {
    // Issue #16: a run that saved has given its claim back already; any other gives it back here.
    await releasePrebuildClaim(scope.db, {
      tenantId: session.tenantId,
      appId: session.appId,
      sessionId: session.id,
      error: session.error ?? 'The prebuild ended before it was saved',
      now: scope.now(),
    })
    // A request that came while it was building is not lost with it (the backoff may defer it).
    await followUpPrebuild(scope.db, scope.env, scope.cfg, session, scope.now())
      .then(result =>
        result
          ? emitterFor(scope)({
              type: 'workspace.prebuild',
              turn: 0,
              data: result.requested
                ? {
                    status: 'requested',
                    reason: 'asked for while this one was building',
                    prebuildSessionId: result.sessionId,
                  }
                : { status: 'deferred', reason: result.reason },
            })
          : undefined
      )
      .catch(err => scope.logger.warn({ err }, 'session: could not follow a prebuild up'))
  }
  const now = scope.now()
  const keep = session.status === 'shipped' || session.status === 'failed'
  const [row] = await scope.db
    .update(sessions)
    .set({
      ...(keep ? {} : { status: 'ended' as const }),
      endedAt: session.endedAt ?? now,
      dbUriSealed: null,
      githubTokenSealed: null,
      githubTokenExpiresAt: null,
      pendingMessage: null,
      pendingModel: null,
      pendingAttachments: null,
      requestedAction: null,
      workspaceBackup: null,
      containerKeptAt: null,
    })
    .where(
      and(eq(sessions.tenantId, scope.params.tenantId), eq(sessions.id, scope.params.sessionId))
    )
    .returning()
  const status = row?.status ?? session.status
  // P6 6c: the upgrade this session was doing follows it (a PR → `pr_open`, failed, cancelled).
  await settleUpgradeAtCleanup(scope.db, row ?? session, scope.realtime)
  if (session.endedAt === null) {
    await recordAudit(scope.db, {
      ...SYSTEM_ACTOR,
      tenantId: session.tenantId,
      action: 'session.ended',
      targetType: 'session',
      targetId: session.id,
      appId: session.appId,
      summary: {
        after: {
          status,
          turns: session.turnCount,
          costMicrocents: session.costMicrocents,
          containerSeconds: session.containerSeconds,
        },
      },
    })
    await emitterFor(scope)({
      type: 'status',
      turn: session.turnCount,
      data: { status },
    })
  }
  if (row) nudgeSession(scope.realtime, row)
  return { status }
}
