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
  previewLabel,
  previewUrl,
  resolveSessionPolicy,
  type SessionStatus,
  TERMINAL_SESSION_STATUSES,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { appEnvironments, apps, type SessionRow, sessions } from '../../../db/schema'
import { decryptToken, encryptToken } from '../../auth/oauth-encryption'
import type { AppBindings } from '../../types'
import type { Logger } from '../../utils/core/logger'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import type { Realtime } from '../realtime'
import { createR2Storage } from '../storage'
import { getSessionRow } from './access'
import { createSessionEmitter, nudgeSession, type SessionEmitter, safeErrorMessage } from './events'
import type { CheckpointReason, SessionStepContext, SessionStepHooks, TurnOutcome } from './hooks'
import { sessionsPaused } from './lifecycle'
import {
  SandboxInterruptedError,
  type SandboxPort,
  type SessionAppRef,
  type SessionPorts,
} from './ports'
import {
  claudeSettingsLocal,
  claudeTranscriptPath,
  previewHostSuffix,
  SESSION_IMAGE_VERSION,
  SESSION_UI_PORT,
  SESSION_WORKSPACE,
  type SessionDevEnv,
  sessionBootstrap,
  startDevServer,
} from './rocketflare-dev'

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

/** The app as the ports need it, tenant-first; its production Neon project if it has one. */
export async function loadAppRef(scope: StepScope, appId: string): Promise<SessionAppRef> {
  const tenantId = scope.params.tenantId
  const [app] = await scope.db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
  if (!app) throw new Error('The session’s app no longer exists')
  if (!app.repoOwner || !app.repoName) throw new Error('The app has no repository')
  const [production] = await scope.db
    .select({ neon: appEnvironments.neon })
    .from(appEnvironments)
    .where(
      and(
        eq(appEnvironments.tenantId, tenantId),
        eq(appEnvironments.appId, appId),
        eq(appEnvironments.name, 'production')
      )
    )
  return {
    id: app.id,
    tenantId,
    slug: app.slug,
    repoOwner: app.repoOwner,
    repoName: app.repoName,
    defaultBranch: app.defaultBranch ?? 'main',
    neonProjectId: production?.neon?.projectId ?? null,
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

/**
 * Claim the app's `dev` for preparing: `none | failed → preparing`, atomically on the jsonb. False
 * when another session is preparing it (or it is ready) — that session's branch then comes from
 * an unprepared `dev` and its own bootstrap migrates and seeds it (the slow path, still correct).
 */
async function claimDevPrepare(scope: StepScope, appId: string): Promise<boolean> {
  const updated = await scope.db
    .update(apps)
    .set({ sessionDb: sql`jsonb_set(${apps.sessionDb}, '{status}', '"preparing"')` })
    .where(
      and(
        eq(apps.tenantId, scope.params.tenantId),
        eq(apps.id, appId),
        sql`coalesce(${apps.sessionDb}->>'status', 'none') in ('none', 'failed')`
      )
    )
    .returning({ id: apps.id })
  return updated.length > 0
}

// ---- the sandbox side --------------------------------------------------------------------------

export function sandboxFor(scope: StepScope, session: Pick<SessionRow, 'id'>): SandboxPort {
  return scope.ports.sandbox(session.id)
}

/** What the dev stack is told about where it is served from. */
export function devEnvFor(cfg: AppConfig, session: Pick<SessionRow, 'shortId' | 'previewToken'>) {
  const template = cfg.SESSION_PREVIEW_URL
  const dev: SessionDevEnv = {
    previewOrigin: template
      ? previewUrl(template, previewLabel(SESSION_UI_PORT, session.shortId, session.previewToken))
      : null,
    previewHostSuffix: previewHostSuffix(template),
    localNeonProxy: cfg.SESSION_BACKEND === 'local' ? (cfg.SESSION_LOCAL_NEON_PROXY ?? null) : null,
    local: cfg.SESSION_BACKEND === 'local',
  }
  return dev
}

/** The clone URL the container uses. Always GitHub's: the git egress handler (3d) routes it. */
export const repoCloneUrl = (app: Pick<SessionAppRef, 'repoOwner' | 'repoName'>) =>
  `https://github.com/${app.repoOwner}/${app.repoName}.git`

/**
 * The checkout script: fetch `baseRef` (branch, tag or sha) at depth 50, then check out the
 * session's branch — from the remote when an earlier run pushed it (a resume), else fresh from
 * the base. Prints `base=<sha>` and `head=<sha>`.
 */
export function checkoutScript(input: {
  url: string
  baseRef: string
  branch: string | null
}): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  const lines = [
    'set -e',
    `rm -rf ${SESSION_WORKSPACE}`,
    `git init -q ${SESSION_WORKSPACE}`,
    `cd ${SESSION_WORKSPACE}`,
    `git remote add origin ${q(input.url)}`,
    `git fetch -q --depth 50 origin ${q(input.baseRef)}`,
    'base=$(git rev-parse FETCH_HEAD)',
  ]
  if (input.branch) {
    const branch = q(input.branch)
    const remote = q(`refs/remotes/origin/${input.branch}`)
    lines.push(
      `if git fetch -q --depth 50 origin ${q(`refs/heads/${input.branch}`)}:${remote} 2>/dev/null; then`,
      `  git checkout -q -B ${branch} ${remote}`,
      'else',
      `  git checkout -q -B ${branch} "$base"`,
      'fi'
    )
  } else {
    lines.push('git checkout -q --detach "$base"')
  }
  lines.push(
    // Launch's own files never land in a commit.
    'mkdir -p .claude && printf "%s\\n" .claude/settings.local.json >> .git/info/exclude',
    'echo "base=$base"',
    'echo "head=$(git rev-parse HEAD)"'
  )
  return lines.join('\n')
}

// ---- claim -------------------------------------------------------------------------------------

export type ClaimResult =
  | { start: 'boot'; kind: 'session' | 'prepare' }
  | { start: 'loop' }
  | { start: 'cleanup' }
  | { start: 'skip'; status: SessionStatus }

/**
 * Step `claim`. `requested → booting` for a fresh session; a session this instance finds already
 * live (its previous instance was lost) is put back to `suspended` with a `resume` request, so the
 * loop boots it again from its branch; `ending` goes straight to cleanup; a settled one is left.
 */
export async function claimStep(scope: StepScope): Promise<ClaimResult> {
  const session = await loadSession(scope)
  const sandboxId = sandboxFor(scope, session).id
  if (session.status === 'requested') {
    const claimed = await transition(scope, ['requested'], 'booting', {
      sandboxId,
      imageVersion: SESSION_IMAGE_VERSION,
      lastActivityAt: scope.now(),
    })
    return claimed ? { start: 'boot', kind: session.kind } : { start: 'skip', status: 'requested' }
  }
  if ((TERMINAL_SESSION_STATUSES as readonly string[]).includes(session.status)) {
    return { start: 'skip', status: session.status }
  }
  if (session.status === 'ending') return { start: 'cleanup' }
  if (session.status !== 'suspended') {
    // A lost instance under a live session: its container state is unknown — start over from the
    // branch (the last checkpoint), as a resume would.
    await sandboxFor(scope, session)
      .destroy()
      .catch(() => {})
    await transition(scope, ['booting', 'ready', 'working', 'blocked', 'shipping'], 'suspended', {
      suspendedAt: scope.now(),
      requestedAction: 'resume',
    })
  }
  return { start: 'loop' }
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
 */
export async function dbStep(scope: StepScope): Promise<DbStepResult> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  const port = scope.ports.sessionDb(scope.db)
  const dev = await port.ensureDev(app)
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

/** Step `branch` (or the tail of `db`): the session's own copy of `dev`, sealed onto the row. */
export async function branchStep(scope: StepScope): Promise<{ branched: true }> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  const branch = await scope.ports.sessionDb(scope.db).createBranch(app, session)
  await updateSession(scope, {
    db: branch.db,
    dbUriSealed: await encryptToken(scope.cfg, branch.uri),
  })
  return { branched: true }
}

/** Step `sandbox.start[#K]`. */
export async function startSandboxStep(scope: StepScope): Promise<{ sandboxId: string }> {
  const session = await loadSession(scope)
  const sandbox = sandboxFor(scope, session)
  await updateSession(scope, { sandboxId: sandbox.id })
  await sandbox.start()
  return { sandboxId: sandbox.id }
}

/** Step `repo[#K]`: clone and check out; `.claude/settings.local.json`. Returns the shas. */
export async function repoStep(scope: StepScope): Promise<{ baseSha: string; headSha: string }> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  const sandbox = sandboxFor(scope, session)
  const result = await sandbox.exec(
    checkoutScript({
      url: repoCloneUrl(app),
      baseRef: session.baseSha ?? session.baseRef ?? app.defaultBranch,
      branch: session.kind === 'prepare' ? null : session.branch,
    }),
    { timeoutMs: 5 * 60_000 }
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not check out ${app.repoOwner}/${app.repoName}: ${safeErrorMessage(result.stderr.trim().split('\n').at(-1) ?? '', `git exited ${result.exitCode}`)}`
    )
  }
  const baseSha = /base=([0-9a-f]{7,64})/.exec(result.stdout)?.[1] ?? ''
  const headSha = /head=([0-9a-f]{7,64})/.exec(result.stdout)?.[1] ?? baseSha
  await sandbox.writeFile(`${SESSION_WORKSPACE}/.claude/settings.local.json`, claudeSettingsLocal())
  await updateSession(scope, {
    baseSha: session.baseSha ?? (baseSha || null),
    headSha: session.headSha ?? (headSha || null),
  })
  return { baseSha, headSha }
}

/**
 * Step `prepare`: the kit's migrate + seed into the app's `dev` (`devUriFor` resets the role's
 * password, so the URI is this run's alone), then `apps.session_db` → ready at the base commit.
 */
export async function prepareStep(scope: StepScope): Promise<{ prepared: true }> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  const port = scope.ports.sessionDb(scope.db)
  const dev = app.sessionDb ?? (await port.ensureDev(app))
  try {
    const uri = await port.devUriFor({ ...app, sessionDb: dev })
    await sessionBootstrap({
      sandbox: sandboxFor(scope, session),
      dbUri: uri,
      dev: devEnvFor(scope.cfg, session),
    })
  } catch (err) {
    await saveAppSessionDb(scope, app.id, { ...dev, status: 'failed' })
    throw err
  }
  await saveAppSessionDb(scope, app.id, {
    ...dev,
    status: 'ready',
    preparedCommit: session.baseSha,
    preparedAt: scope.now(),
  })
  return { prepared: true }
}

/** Step `bootstrap[#K]`: the kit bootstrap against the session's own branch. */
export async function bootstrapStep(
  scope: StepScope
): Promise<{ installMs: number; bootstrapMs: number }> {
  const session = await loadSession(scope)
  const uri = await decryptToken(scope.cfg, session.dbUriSealed)
  if (!uri) throw new Error('The session has no database')
  return sessionBootstrap({
    sandbox: sandboxFor(scope, session),
    dbUri: uri,
    dev: devEnvFor(scope.cfg, session),
  })
}

/** Step `dev[#K]`: `pnpm dev`, both ports up → `ready` and `preview.ready`. */
export async function devStep(scope: StepScope): Promise<{ ready: boolean }> {
  const session = await loadSession(scope)
  await startDevServer(sandboxFor(scope, session), devEnvFor(scope.cfg, session))
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
 * copy the last checkpoint made (`transcript_key`). Nothing to restore is not an error.
 */
export async function restoreTranscriptStep(scope: StepScope): Promise<{ restored: boolean }> {
  const session = await loadSession(scope)
  if (!session.transcriptKey || !session.claudeSessionId || !scope.env.FILES) {
    return { restored: false }
  }
  const object = await scope.env.FILES.get(session.transcriptKey)
  if (!object) return { restored: false }
  await sandboxFor(scope, session).writeFile(
    claudeTranscriptPath(session.claudeSessionId),
    await object.text()
  )
  return { restored: true }
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
  repo: 'Cloning repo',
  bootstrap: 'Installing and seeding',
  dev: 'Starting dev server',
  transcript: 'Restoring the conversation',
} as const

export type BootPhase = keyof typeof BOOT_STEP_LABELS

export function withProgress<T>(
  phase: BootPhase,
  body: (scope: StepScope) => Promise<T>
): (scope: StepScope) => Promise<T> {
  return async scope => {
    const emit = emitterFor(scope)
    const label = BOOT_STEP_LABELS[phase]
    await emit({ type: 'step', turn: 0, data: { key: phase, label, status: 'running' } })
    try {
      const result = await body(scope)
      await emit({ type: 'step', turn: 0, data: { key: phase, label, status: 'done' } })
      return result
    } catch (err) {
      await emit({
        type: 'step',
        turn: 0,
        data: { key: phase, label, status: 'error', detail: safeErrorMessage(err).slice(0, 300) },
      })
      throw err
    }
  }
}

// ---- the loop ----------------------------------------------------------------------------------

export type NextAction =
  | { action: 'turn'; maxTurnMinutes: number }
  | { action: 'ship' }
  | { action: 'end'; reason: string }
  | { action: 'resume' }
  | { action: 'suspend'; reason: 'drain' }
  | { action: 'wait'; waitingIn: SessionStatus; timeoutMinutes: number }
  | { action: 'done'; status: SessionStatus }

/**
 * Step `inspect#N`: what to do next, from the row alone. Order matters: an end beats everything,
 * a drain suspends a live session, a ship beats a turn, and nothing to do is a wait — whose
 * timeout is the idle policy (live) or the expiry (suspended).
 */
export async function inspectStep(scope: StepScope): Promise<NextAction> {
  const session = await loadSession(scope)
  const policy = resolveSessionPolicy(session.policy)
  const status = session.status
  if ((TERMINAL_SESSION_STATUSES as readonly string[]).includes(status)) {
    return { action: 'done', status }
  }
  if (status === 'ending' || session.requestedAction === 'end') {
    return { action: 'end', reason: 'requested' }
  }
  const ageHours = (scope.now().getTime() - session.createdAt.getTime()) / 3_600_000
  if (ageHours >= policy.maxSessionHours) return { action: 'end', reason: 'max_session_hours' }
  const live = status === 'ready' || status === 'blocked'
  if (live && (await sessionsPaused(scope.db))) return { action: 'suspend', reason: 'drain' }
  if (status === 'suspended') {
    if (session.requestedAction === 'resume' && !(await sessionsPaused(scope.db))) {
      return { action: 'resume' }
    }
    return { action: 'wait', waitingIn: status, timeoutMinutes: policy.suspendedExpiryHours * 60 }
  }
  if (status === 'ready' && session.requestedAction === 'ship') return { action: 'ship' }
  if (status === 'ready' && session.pendingMessage !== null) {
    return { action: 'turn', maxTurnMinutes: policy.maxTurnMinutes }
  }
  return { action: 'wait', waitingIn: status, timeoutMinutes: policy.idleSuspendMinutes }
}

/** A hook's context for this step: the fresh row, the sandbox, the emitter. */
export function hookContext(
  scope: StepScope,
  session: SessionRow,
  turn: number
): SessionStepContext {
  return {
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
  /** For `interrupted`: `rollout` (the container is gone) · `cancelled` · `timeout`. */
  reason?: string
}

/**
 * Step `turn#N`: `hooks.runTurn` (slice 3c) claims `ready → working`, runs the message, and
 * settles the status itself. A `SandboxInterruptedError` escaping it is a rollout: the Workflow
 * writes `turn.interrupted { reason: 'rollout' }` and suspends. Anything else escaping it (the
 * database) leaves a `working` row that `turn-settle#N` repairs.
 */
export async function turnStep(scope: StepScope): Promise<TurnStepResult> {
  const session = await loadSession(scope)
  try {
    const outcome = await scope.hooks.runTurn(hookContext(scope, session, session.turnCount))
    return {
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
    return { status: 'interrupted', reason: 'rollout' }
  }
}

/** A turn after which the branch should be checkpointed: it ran, and the container is still up. */
export function turnNeedsCheckpoint(result: TurnStepResult): boolean {
  if (result.status === 'completed' || result.status === 'failed') return true
  return result.status === 'interrupted' && result.reason !== 'rollout'
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
}

/**
 * Step `rollout#N`: after a turn cut off by a rollout (the session is already `suspended`), make
 * sure nothing of the old container lingers. No checkpoint: it is gone.
 */
export async function rolloutStep(scope: StepScope): Promise<{ destroyed: true }> {
  const session = await loadSession(scope)
  await sandboxFor(scope, session).destroy()
  return { destroyed: true }
}

/**
 * Step `checkpoint#N` (and the head of `suspend#N` / `end#N`): `hooks.checkpoint` (slice 3d). A
 * failed checkpoint is an `error` event, never a failed session — the previous one still stands.
 */
export async function checkpointStep(
  scope: StepScope,
  reason: CheckpointReason
): Promise<{ ok: boolean }> {
  const session = await loadSession(scope)
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
 * Step `suspend#N`: checkpoint, destroy the container, `suspended` — the branch and database are
 * kept, and a resume boots again from them. For an idle session and a drain alike.
 */
export async function suspendStep(
  scope: StepScope,
  reason: 'idle' | 'drain'
): Promise<{ suspended: boolean }> {
  const session = await loadSession(scope)
  if (session.status !== 'ready' && session.status !== 'blocked') return { suspended: false }
  await checkpointStep(scope, 'suspend')
  await sandboxFor(scope, session).destroy()
  const now = scope.now()
  // `onStop` in the Sandbox Durable Object may have got there first: suspended is suspended.
  const row = await transition(scope, ['ready', 'blocked', 'suspended'], 'suspended', {
    suspendedAt: now,
  })
  if (row) {
    await emitterFor(scope)({
      type: 'status',
      turn: session.turnCount,
      data: { status: 'suspended', reason },
    })
  }
  return { suspended: row !== null }
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

/**
 * Step `ship#N`: `hooks.ship` (slice 3d) claims `ready → shipping`, runs the ship turn and the
 * gate, and ends `shipped` (the PR open) or back at `ready` (a red gate). The ROW then decides:
 * `shipped` → the Workflow cleans up; a session left `shipping` by a throw goes back to `ready`.
 */
export async function shipStep(
  scope: StepScope
): Promise<{ status: 'shipped' | 'not_shipped' | 'skipped' }> {
  const before = await loadSession(scope)
  if (before.status !== 'ready') return { status: 'skipped' }
  try {
    await scope.hooks.ship(hookContext(scope, before, before.turnCount))
  } catch (err) {
    scope.logger.error({ err }, 'session: ship failed')
    await emitterFor(scope)({
      type: 'error',
      turn: before.turnCount,
      data: { message: `Shipping failed: ${safeErrorMessage(err)}` },
    })
  }
  const after = await loadSession(scope)
  if (after.status === 'shipped') return { status: 'shipped' }
  await transition(scope, ['shipping'], 'ready', { lastActivityAt: scope.now() })
  if (after.requestedAction === 'ship') {
    // Never loop on a ship the hook did not take up: the person asks again.
    await updateSession(scope, { requestedAction: null })
  }
  return { status: 'not_shipped' }
}

/** Step `end#N`: `→ ending` (a last checkpoint when the container is up); cleanup follows. */
export async function endStep(scope: StepScope, reason: string): Promise<{ ending: boolean }> {
  const session = await loadSession(scope)
  if (session.status === 'ready' || session.status === 'blocked') {
    await checkpointStep(scope, 'end')
  }
  const row = await transition(
    scope,
    ['requested', 'booting', 'ready', 'working', 'blocked', 'suspended', 'ending'],
    'ending',
    { requestedAction: null, lastActivityAt: scope.now() }
  )
  if (row && reason !== 'requested') {
    await emitterFor(scope)({
      type: 'status',
      turn: row.turnCount,
      data: { status: 'ending', reason },
    })
  }
  return { ending: row !== null }
}

/** Step `fail`: a boot or loop step gave up — `failed`, with a secret-free sentence. */
export async function failStep(scope: StepScope, message: string): Promise<void> {
  const session = await loadSession(scope)
  if ((TERMINAL_SESSION_STATUSES as readonly string[]).includes(session.status)) return
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
 * Step `cleanup` — ALWAYS: destroy the container, delete the branch, settle `ended` (a `shipped`
 * or `failed` session keeps its status), forget the sealed credentials, audit `session.ended`.
 * Throws (so the platform retries) if the container or the branch could not be removed.
 */
export async function cleanupStep(scope: StepScope): Promise<{ status: SessionStatus }> {
  const session = await loadSession(scope)
  await sandboxFor(scope, session).destroy()
  if (session.db && session.kind === 'session') {
    const app = await loadAppRef(scope, session.appId)
    await scope.ports.sessionDb(scope.db).deleteBranch(app, session.db)
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
      requestedAction: null,
    })
    .where(
      and(eq(sessions.tenantId, scope.params.tenantId), eq(sessions.id, scope.params.sessionId))
    )
    .returning()
  const status = row?.status ?? session.status
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
