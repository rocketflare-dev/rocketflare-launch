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
  type SessionStatus,
  TERMINAL_SESSION_STATUSES,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import {
  appEnvironments,
  apps,
  type SessionRow,
  type SessionWorkspaceBackup,
  sessions,
} from '../../../db/schema'
import { decryptToken, encryptToken } from '../../auth/oauth-encryption'
import type { AppBindings } from '../../types'
import type { Logger } from '../../utils/core/logger'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import type { Realtime } from '../realtime'
import { createR2Storage } from '../storage'
import { getSessionRow } from './access'
import { CORE_DUMP_EXCLUDES } from './checkpoint'
import { sessionDbEgressHosts } from './db/neon-session-db'
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
  SandboxInterruptedError,
  type SandboxPort,
  SandboxRestartedError,
  type SessionAppRef,
  type SessionPorts,
  sessionAllowedHosts,
} from './ports'
import {
  type BootstrapSkip,
  claudeSettingsLocal,
  claudeTranscriptPath,
  migrationsHash,
  previewHostSuffix,
  resumeDevServer,
  SESSION_IMAGE_VERSION,
  SESSION_LAUNCH_DIR,
  SESSION_UI_PORT,
  SESSION_WORKSPACE,
  type SessionDevEnv,
  sessionBootstrap,
  sessionDevVars,
  startDevServer,
  writeDevVars,
} from './rocketflare-dev'
import { warmMinutesLeft } from './warm'
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
}

export const limitsOf = (scope: Pick<StepScope, 'limits'>): SessionCallLimits =>
  scope.limits ?? SESSION_CALL_LIMITS

/** A vendor call (Neon) from a step, bounded: `<phase>: <what> did not answer within N min`. */
function vendorCall<T>(scope: StepScope, what: string, work: () => Promise<T>): Promise<T> {
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

// ---- the sandbox side --------------------------------------------------------------------------

/** The session's sandbox, every call bounded (`deadline.ts`) and named after the running step. */
export function sandboxFor(scope: StepScope, session: Pick<SessionRow, 'id'>): SandboxPort {
  return boundedSandbox(scope.ports.sandbox(session.id), scope.phase, limitsOf(scope))
}

/**
 * Where `sandbox.start` writes this boot's id. Every later boot step compares it with the id the
 * start returned: a container that died and came back EMPTY (Docker's OOM killer on a laptop, the
 * platform replacing it) has no marker, and the step says so (`SandboxRestartedError`) rather than
 * cloning into nothing or curling a dev server that is not there.
 */
export const SESSION_BOOT_MARKER = `${SESSION_LAUNCH_DIR}/boot-id`

/** True / false when the marker could be read; null when the sandbox could not even be asked. */
async function containerIsOurs(sandbox: SandboxPort, bootId: string): Promise<boolean | null> {
  try {
    return (await sandbox.readFile(SESSION_BOOT_MARKER))?.trim() === bootId
  } catch {
    return null
  }
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
    // Launch's own files never land in a commit, and neither does a core dump (checkpoint.ts).
    'mkdir -p .claude && printf "%s\\n" .claude/settings.local.json >> .git/info/exclude',
    `printf "%s\\n" ${CORE_DUMP_EXCLUDES.map(p => q(p)).join(' ')} >> .git/info/exclude`,
    'echo "base=$base"',
    'echo "head=$(git rev-parse HEAD)"'
  )
  return lines.join('\n')
}

// ---- claim -------------------------------------------------------------------------------------

/** `turn.failed` for a turn whose instance was lost under it (`claim`). */
export const LOST_TURN_MESSAGE =
  'This turn stopped: its Workflow was lost. Launch is restarting the session from its last checkpoint; send your message again.'

export type ClaimResult =
  | { start: 'boot'; kind: 'session' | 'prepare' }
  | { start: 'loop' }
  | { start: 'cleanup' }
  | { start: 'skip'; status: SessionStatus }

/**
 * Step `claim`. `requested → booting` for a fresh session; a session this instance finds already
 * live (its previous instance was lost) is put back to `suspended` with a `resume` request, so the
 * loop boots it again from its branch — a turn it finds `working` is closed with `turn.failed`
 * ({@link LOST_TURN_MESSAGE}); `ending` goes straight to cleanup; a settled one is left.
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
    // Settled but never cleaned up (its instance died between `fail` and `cleanup`, or it was
    // settled by hand): an instance started by the reconcile does the cleanup now.
    return session.endedAt === null
      ? { start: 'cleanup' }
      : { start: 'skip', status: session.status }
  }
  if (session.status === 'ending') return { start: 'cleanup' }
  if (session.status !== 'suspended') {
    // A lost instance under a live session: its container state is unknown — start over from the
    // branch (the last checkpoint), as a resume would.
    await sandboxFor(scope, session)
      .destroy()
      .catch(() => {})
    const moved = await transition(
      scope,
      ['booting', 'ready', 'working', 'blocked', 'shipping'],
      'suspended',
      { suspendedAt: scope.now(), requestedAction: 'resume', cancelRequestedAt: null }
    )
    if (moved && session.status === 'working') {
      // The turn it was running died with the instance: close it, so it does not spin for ever.
      const turn = Math.max(1, session.turnCount)
      await emitterFor(scope)({
        type: 'turn.failed',
        turn,
        data: { turn, message: LOST_TURN_MESSAGE },
      })
    }
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

/** Step `branch` (or the tail of `db`): the session's own copy of `dev`, sealed onto the row. */
export async function branchStep(scope: StepScope): Promise<{ branched: true }> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  const branch = await vendorCall(scope, "Neon (the session's branch)", () =>
    scope.ports.sessionDb(scope.db).createBranch(app, session)
  )
  await updateSession(scope, {
    db: branch.db,
    dbUriSealed: await encryptToken(scope.cfg, branch.uri),
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
async function dbEgressHostsOf(scope: StepScope, session: SessionRow): Promise<string[]> {
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

async function checkOut(
  scope: StepScope,
  session: SessionRow,
  app: SessionAppRef,
  sandbox: SandboxPort
): Promise<{ baseSha: string; headSha: string }> {
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
export async function prepareStep(scope: StepScope, bootId?: string): Promise<{ prepared: true }> {
  const session = await loadSession(scope)
  const app = await loadAppRef(scope, session.appId)
  const port = scope.ports.sessionDb(scope.db)
  const dev =
    app.sessionDb ??
    (await vendorCall(scope, "Neon (the app's dev branch)", () => port.ensureDev(app)))
  // The claim fields go when the prepare settles, either way.
  const { preparingSessionId: _holder, preparingSince: _since, ...settled } = dev
  try {
    const uri = await vendorCall(scope, "Neon (the dev branch's password)", () =>
      port.devUriFor({ ...app, sessionDb: dev })
    )
    const sandbox = sandboxFor(scope, session)
    await inOurContainer(scope, sandbox, bootId, () =>
      sessionBootstrap({ sandbox, dbUri: uri, dev: devEnvFor(scope.cfg, session) })
    )
  } catch (err) {
    await saveAppSessionDb(scope, app.id, { ...settled, status: 'failed' })
    throw err
  }
  await saveAppSessionDb(scope, app.id, {
    ...settled,
    status: 'ready',
    preparedCommit: session.baseSha,
    preparedAt: scope.now(),
  })
  return { prepared: true }
}

export interface BootstrapStepResult {
  installMs: number
  bootstrapMs: number
  /** False on a resume whose migrations had not changed since the last bootstrap. */
  migrated: boolean
  /** False on every bootstrap after the first successful one: a resume never re-seeds. */
  seeded: boolean
  /**
   * A restored workspace (`restore#K`) whose migrations had not changed: no install and no kit
   * bootstrap at all — `node_modules` and `.dev.vars` came back with it.
   */
  reused?: boolean
}

/**
 * Step `bootstrap[#K]`: the kit bootstrap against the session's own branch. The FIRST successful
 * one records the checkout's migrations hash (`sessions.migrations_hash`); a later one (a cold
 * resume) is against a database that is already prepared, so it never re-seeds (nor re-checks
 * the database), and migrates only when `apps/web/migrations` hashes differently now — the
 * session's own turns may have added a migration.
 */
export async function bootstrapStep(
  scope: StepScope,
  bootId?: string,
  opts: { restored?: boolean } = {}
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
    if (opts.restored && prepared && !migrate) {
      // The restored workspace IS the last bootstrap's result: only the allow-list (this
      // container's) and the dev-server keys (non-secret, re-derived) are put back.
      await sandbox.setAllowedHosts(sessionAllowedHosts(sessionDbEgressHosts(uri)))
      await writeDevVars(sandbox, `${SESSION_WORKSPACE}/apps/web/.dev.vars`, sessionDevVars(dev))
      return { installMs: 0, bootstrapMs: 0, migrated: false, seeded: false, reused: true }
    }
    const skip: BootstrapSkip[] = prepared
      ? ['seed', 'db-check', ...(migrate ? [] : (['migrate'] as const))]
      : []
    const timings = await sessionBootstrap({
      sandbox,
      dbUri: uri,
      dev,
      skip,
    })
    if (hash) await updateSession(scope, { migrationsHash: hash })
    return { ...timings, migrated: migrate, seeded: !prepared }
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
 * copy the last checkpoint made (`transcript_key`). Nothing to restore is not an error.
 */
export async function restoreTranscriptStep(
  scope: StepScope,
  bootId?: string
): Promise<{ restored: boolean }> {
  const session = await loadSession(scope)
  const claudeSessionId = session.claudeSessionId
  if (!session.transcriptKey || !claudeSessionId || !scope.env.FILES) {
    return { restored: false }
  }
  const object = await scope.env.FILES.get(session.transcriptKey)
  if (!object) return { restored: false }
  const text = await object.text()
  const sandbox = sandboxFor(scope, session)
  await inOurContainer(scope, sandbox, bootId, () =>
    sandbox.writeFile(claudeTranscriptPath(claudeSessionId), text)
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
  restore: 'Restoring the saved workspace',
  repo: 'Cloning repo',
  bootstrap: 'Installing and seeding',
  dev: 'Starting dev server',
  transcript: 'Restoring the conversation',
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

const endRequested = (row: Pick<SessionRow, 'status' | 'requestedAction'>) =>
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

export function withProgress<T>(
  phase: BootPhase,
  body: (scope: StepScope) => Promise<T>
): (scope: StepScope) => Promise<T> {
  return async outer => {
    const label = BOOT_STEP_LABELS[phase]
    const scope: StepScope = { ...outer, phase: label }
    const emit = emitterFor(scope)
    // An end asked before (or between) steps: stop before starting anything.
    await throwIfEndRequested(scope)
    await heartbeat(scope)
    await emit({ type: 'step', turn: 0, data: { key: phase, label, status: 'running' } })
    try {
      const result = await watched(scope, body(scope))
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
      return result
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
  | { action: 'end'; reason: string }
  | { action: 'resume' }
  | { action: 'suspend'; reason: 'drain' }
  | { action: 'cool'; reason: 'idle' | 'drain' }
  | {
      action: 'wait'
      waitingIn: SessionStatus
      timeoutMinutes: number
      /** A timeout means the kept container's warm window is over: cool it, do not end. */
      cool?: boolean
    }
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
    const paused = await sessionsPaused(scope.db)
    if (session.requestedAction === 'resume' && !paused) return { action: 'resume' }
    const expiryMinutes = policy.suspendedExpiryHours * 60
    const warmLeft = warmMinutesLeft(session.containerKeptAt, scope.now())
    if (warmLeft !== null) {
      // A kept container: a drain destroys it now; otherwise it waits out its warm window.
      if (paused) return { action: 'cool', reason: 'drain' }
      if (warmLeft === 0) return { action: 'cool', reason: 'idle' }
      if (warmLeft < expiryMinutes) {
        return { action: 'wait', waitingIn: status, timeoutMinutes: warmLeft, cool: true }
      }
    }
    return { action: 'wait', waitingIn: status, timeoutMinutes: expiryMinutes }
  }
  if (status === 'ready' && session.requestedAction === 'ship') return { action: 'ship' }
  if (status === 'ready' && session.pendingMessage !== null) {
    return { action: 'turn', maxTurnMinutes: policy.maxTurnMinutes }
  }
  return {
    action: 'wait',
    waitingIn: status,
    timeoutMinutes: idleMinutesLeft(session, policy.idleSuspendMinutes, scope.now()),
  }
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
 * Step `suspend#N`: checkpoint, then `suspended` — the branch and database are kept. An IDLE
 * suspend keeps the container too (`container_kept_at`, `warm.ts`): a resume inside the warm
 * window reuses it, and `cool#N` destroys it after. A DRAIN destroys it now (a deploy is about to
 * replace it), and a resume boots again from the branch.
 */
export async function suspendStep(
  scope: StepScope,
  reason: 'idle' | 'drain'
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
  await checkpointStep(scope, 'suspend')
  const keep = reason === 'idle'
  if (!keep) {
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

/**
 * Back the workspace up before its container is destroyed, and record it on the row (replacing —
 * and deleting — the previous one). Best effort: a backup that fails, or is off, costs the next
 * resume a clone and an install, never the suspend. True when a backup was recorded.
 */
async function backupWorkspace(
  scope: StepScope,
  session: SessionRow,
  sandbox: SandboxPort
): Promise<boolean> {
  if (session.kind !== 'session' || workspaceBackupMode(scope.cfg) === 'off') return false
  try {
    const head = await sandbox.exec(`git -C ${SESSION_WORKSPACE} rev-parse HEAD`, {
      timeoutMs: 30_000,
    })
    const headSha = head.exitCode === 0 ? head.stdout.trim() : ''
    if (!/^[0-9a-f]{40}$/.test(headSha)) return false
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
    scope.logger.warn({ err }, 'session: workspace backup failed; the next resume clones')
    return false
  }
}

/** Why a recorded backup cannot be restored now, or null when it can. */
function unusableBackup(scope: StepScope, session: SessionRow): string | null {
  const backup = session.workspaceBackup
  if (workspaceBackupMode(scope.cfg) === 'off') return 'backups are off'
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
      return { restored: true }
    } catch (err) {
      if (err instanceof SandboxRestartedError) throw err
      scope.logger.warn({ err }, 'session: workspace restore failed; cloning instead')
      // Leave nothing half-restored behind for the clone (a presigned restore is a FUSE mount).
      await sandbox
        .exec(
          `fusermount3 -uz ${SESSION_WORKSPACE} 2>/dev/null; rm -rf ${SESSION_WORKSPACE}; true`,
          { timeoutMs: 120_000 }
        )
        .catch(() => {})
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
 * Step `cleanup` — ALWAYS: destroy the container, delete the branch, settle `ended` (a `shipped`
 * or `failed` session keeps its status), forget the sealed credentials, audit `session.ended`.
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
  if (session.db && session.kind === 'session') {
    const app = await loadAppRef(scope, session.appId)
    const db = session.db
    await vendorCall(scope, "Deleting the session's database branch", () =>
      scope.ports.sessionDb(scope.db).deleteBranch(app, db)
    )
  }
  await releaseDevPrepare(scope.db, {
    tenantId: session.tenantId,
    appId: session.appId,
    sessionId: session.id,
  })
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
      workspaceBackup: null,
      containerKeptAt: null,
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
