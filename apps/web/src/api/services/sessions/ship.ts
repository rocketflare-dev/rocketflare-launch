/**
 * Ship a session (Launch P3, plan §1.10): the ship turn, Launch's own gate, the final checkpoint,
 * the pull request, and its CI.
 *
 * **Stable signature — the Workflow (slice 3b) calls this from its `ship` step when the row's
 * `requested_action` is `ship`:**
 *
 * ```ts
 * ship(db, { cfg, ports, storage, runTurn, emit?, now? }, { tenantId, sessionId }) → Promise<ShipOutcome>
 * ```
 *
 * `runTurn` is the turn runner (slice 3c's `runTurn`, adapted by the Workflow): it runs ONE Claude
 * Code turn with `message` as the user's message — writing `user.message` … `turn.end` as any turn
 * does — and answers `{ outcome, turn, text? }` (`createShipTurnRunner` in `turn.ts`, bound in
 * `hooks.ts`). `emit` appends events (the Workflow's emitter, which also nudges; default
 * `appendSessionEvents` from `event-log.ts` — the Workflow is the one writer, so there is no race
 * to lose).
 *
 * The steps:
 *
 * 1. **Claim**: compare-and-set `ready | shipping → shipping`, clearing `requested_action`. A
 *    session already `shipped` answers its PR (a retried step); any other status is `skipped`.
 * 2. **The ship turn**, with the `session-ship` prompt (gate command, attempts, app and person):
 *    Claude runs the gate, fixes what fails, and ends with `{ title, body, gatePassed }` as JSON.
 * 3. **Launch's own gate**: the model's word is not enough — unless it already said `gatePassed:
 *    false`, Launch runs the gate command itself (`bash -c`) and only its exit code counts.
 *    Red → a `ship.gate { passed: false }` event with the output's tail, status back to `ready`,
 *    no PR — the person reads why and carries on chatting.
 * 4. **Green** → `ship.gate { passed: true }`, `checkpoint()` with the PR title as the commit
 *    subject, `openPullRequest` (head `session/<short>`, base the app's default branch), the row's
 *    `pr_number` / `pr_url`, status `shipped`, a `ship.pr` event, audit `session.shipped`, and a
 *    first `refreshChecks`.
 *
 * `refreshChecks` is also what `GET /api/sessions/:id/pr` (at most every 30 s) and the `*\/5`
 * cron (`sessionsChecksTask`, while `pending`) call.
 */
import {
  type PrChecks,
  type SessionEventInput,
  type SessionStatus,
  sessionBranchName,
} from '@launch/shared/launch-sessions'
import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { apps, type SessionRow, sessionEvents, sessions, tenants, users } from '../../../db/schema'
import { NotFoundError } from '../../utils/core/errors'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import { resolvePrompt } from '../prompts'
import type { StorageService } from '../storage'
import { checkpoint, outputTail, SESSION_REPO_DIR } from './checkpoint'
import { appendSessionEvents } from './event-log'
import type { RepoHostPort, RepoRef, SessionPorts } from './ports'
import type { ShipTurnResult, ShipTurnRunner } from './turn'

/** The Rocketflare gate (plan §1.10). */
export const DEFAULT_SHIP_GATE = 'pnpm lint && pnpm typecheck && pnpm test'
/** How many gate runs the ship turn may make while fixing. */
export const DEFAULT_SHIP_ATTEMPTS = 3
/** How long Launch's own gate run may take. */
export const SHIP_GATE_TIMEOUT_MS = 20 * 60 * 1000
/** `GET /:id/pr` refreshes checks older than this. */
export const PR_CHECKS_MAX_AGE_MS = 30_000

/** The ship turn's runner (`createShipTurnRunner`, `turn.ts`) — the one definition is 3c's. */
export type { ShipTurnResult, ShipTurnRunner }

/** Appends events to the session's log — the Workflow's emitter (`events.ts`) in production. */
export type ShipEventEmitter = (events: SessionEventInput[]) => Promise<void>

export interface ShipDeps {
  cfg: AppConfig
  ports: Pick<SessionPorts, 'sandbox' | 'repoHost'>
  /** `createR2Storage(env.FILES)` for the final checkpoint's transcript; null skips it. */
  storage: StorageService | null
  runTurn: ShipTurnRunner
  emit?: ShipEventEmitter
  now?: () => Date
  gateCommand?: string
  maxAttempts?: number
  repoDir?: string
}

export type ShipOutcome =
  | { status: 'shipped'; prNumber: number; prUrl: string; checks: PrChecks | null }
  | { status: 'gate_failed'; output: string }
  | { status: 'turn_failed'; reason: ShipTurnResult['outcome'] }
  | { status: 'skipped'; reason: string }

// ---- the reply ---------------------------------------------------------------------------------

export interface ShipReply {
  title: string
  body: string
  /** What the model says of the gate; null when it did not say. */
  gatePassed: boolean | null
}

/**
 * The `{ title, body, gatePassed }` object the ship prompt asks for: the LAST parseable JSON object
 * in the reply that has a string `title` (a fenced block, the last line, or the whole reply).
 * Null when there is none — the caller falls back to a title of its own.
 */
export function parseShipReply(text: string | null | undefined): ShipReply | null {
  if (!text) return null
  const candidates: string[] = []
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (match[1]) candidates.push(match[1])
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed)
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))

  let found: ShipReply | null = null
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim()) as Record<string, unknown>
      if (!value || typeof value !== 'object' || typeof value.title !== 'string') continue
      const title = value.title.replace(/\s+/g, ' ').trim()
      if (!title) continue
      found = {
        title: title.slice(0, 200),
        body: typeof value.body === 'string' ? value.body : '',
        gatePassed: typeof value.gatePassed === 'boolean' ? value.gatePassed : null,
      }
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return found
}

/** The turn's assistant text, joined, from its `text` events. */
async function turnText(db: Database, session: SessionRow, turn: number): Promise<string> {
  const rows = await db
    .select({ data: sessionEvents.data })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, session.tenantId),
        eq(sessionEvents.sessionId, session.id),
        eq(sessionEvents.turn, turn),
        eq(sessionEvents.type, 'text')
      )
    )
    .orderBy(sessionEvents.seq)
  return rows
    .map(r => (r.data as { text?: unknown }).text)
    .filter((t): t is string => typeof t === 'string')
    .join('')
}

// ---- helpers -----------------------------------------------------------------------------------

async function loadSession(db: Database, tenantId: string, sessionId: string): Promise<SessionRow> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)))
    .limit(1)
  if (!row) throw new NotFoundError('Session not found', 'session_not_found')
  return row
}

/** Compare-and-set the status; the updated row, or null when it was not in `from`. */
async function transition(
  db: Database,
  session: Pick<SessionRow, 'id' | 'tenantId'>,
  from: readonly SessionStatus[],
  set: Partial<typeof sessions.$inferInsert>
): Promise<SessionRow | null> {
  const [row] = await db
    .update(sessions)
    .set(set)
    .where(
      and(
        eq(sessions.tenantId, session.tenantId),
        eq(sessions.id, session.id),
        inArray(sessions.status, [...from])
      )
    )
    .returning()
  return row ?? null
}

/** The app's repo as the repo port takes it, tenant-first. */
export async function sessionRepo(
  db: Database,
  session: Pick<SessionRow, 'tenantId' | 'appId'>
): Promise<RepoRef & { defaultBranch: string; displayName: string }> {
  const [app] = await db
    .select({
      repoOwner: apps.repoOwner,
      repoName: apps.repoName,
      defaultBranch: apps.defaultBranch,
      displayName: apps.displayName,
    })
    .from(apps)
    .where(and(eq(apps.tenantId, session.tenantId), eq(apps.id, session.appId)))
    .limit(1)
  if (!app?.repoOwner || !app.repoName) {
    throw new NotFoundError('The session’s app has no repository', 'app_repo_missing')
  }
  return {
    owner: app.repoOwner,
    repo: app.repoName,
    defaultBranch: app.defaultBranch ?? 'main',
    displayName: app.displayName,
  }
}

// ---- checks ------------------------------------------------------------------------------------

/**
 * The PR's CI, refreshed from the repo host when the stored verdict is older than `maxAgeMs`
 * (0 forces it) and written back to `pr_checks`. Null when the session has no PR.
 */
export async function refreshChecks(
  db: Database,
  repoHost: RepoHostPort,
  session: SessionRow,
  opts: { maxAgeMs?: number; now?: Date } = {}
): Promise<PrChecks | null> {
  if (!session.prNumber) return null
  const now = opts.now ?? new Date()
  const stored = session.prChecks
  if (
    stored &&
    opts.maxAgeMs !== undefined &&
    now.getTime() - new Date(stored.checkedAt).getTime() < opts.maxAgeMs
  ) {
    return stored
  }
  const repo = await sessionRepo(db, session)
  const checks = await repoHost.getChecks(repo, {
    prNumber: session.prNumber,
    headSha: session.headSha ?? session.branch ?? sessionBranchName(session.shortId),
  })
  await db
    .update(sessions)
    .set({ prChecks: checks })
    .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, session.id)))
  return checks
}

// ---- ship --------------------------------------------------------------------------------------

export async function ship(
  db: Database,
  deps: ShipDeps,
  ref: { tenantId: string; sessionId: string }
): Promise<ShipOutcome> {
  const now = deps.now ?? (() => new Date())
  const emit: ShipEventEmitter =
    deps.emit ??
    (events => appendSessionEvents(db, { id: ref.sessionId, tenantId: ref.tenantId }, events))
  const current = await loadSession(db, ref.tenantId, ref.sessionId)

  // A retried step after the PR was opened: nothing left to do.
  if (current.status === 'shipped' && current.prNumber && current.prUrl) {
    return {
      status: 'shipped',
      prNumber: current.prNumber,
      prUrl: current.prUrl,
      checks: current.prChecks ?? null,
    }
  }

  // 1. Claim.
  const session = await transition(db, current, ['ready', 'shipping'], {
    status: 'shipping',
    requestedAction: null,
    lastActivityAt: now(),
  })
  if (!session) return { status: 'skipped', reason: `session is ${current.status}` }

  const repo = await sessionRepo(db, session)
  const sandbox = deps.ports.sandbox(session.id)
  const gateCommand = deps.gateCommand ?? DEFAULT_SHIP_GATE
  const [creator] = session.createdByUserId
    ? await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, session.createdByUserId))
        .limit(1)
    : []
  const priorGates = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, session.tenantId),
        eq(sessionEvents.sessionId, session.id),
        eq(sessionEvents.type, 'ship.gate')
      )
    )
  const attempt = (priorGates[0]?.n ?? 0) + 1

  // 2. The ship turn.
  const message = await resolvePrompt(db, session.tenantId, 'session-ship', {
    appName: repo.displayName,
    userName: creator?.name ?? 'The person in this session',
    gateCommand,
    maxAttempts: String(deps.maxAttempts ?? DEFAULT_SHIP_ATTEMPTS),
  })
  const turn = await deps.runTurn({ message, session })
  if (turn.outcome !== 'completed') {
    // An interrupted turn has already moved the session (rollout → suspended); only undo our claim.
    await transition(db, session, ['shipping'], { status: 'ready' })
    return { status: 'turn_failed', reason: turn.outcome }
  }
  const text = turn.text ?? (await turnText(db, session, turn.turn))
  const reply = parseShipReply(text)

  // 3. Launch's own gate.
  let passed = false
  let output = ''
  if (reply?.gatePassed === false) {
    output = 'The ship turn reported that the gate still fails.'
  } else {
    const result = await sandbox.exec(`bash -c ${shellQuote(gateCommand)}`, {
      cwd: deps.repoDir ?? SESSION_REPO_DIR,
      timeoutMs: SHIP_GATE_TIMEOUT_MS,
    })
    passed = result.exitCode === 0
    output = outputTail(result, 2000)
  }
  if (!passed) {
    await emit([{ type: 'ship.gate', turn: turn.turn, data: { passed: false, attempt, output } }])
    await transition(db, session, ['shipping'], { status: 'ready', lastActivityAt: now() })
    return { status: 'gate_failed', output }
  }
  await emit([{ type: 'ship.gate', turn: turn.turn, data: { passed: true, attempt, output } }])

  // 4. Checkpoint, PR, shipped.
  const title = reply?.title ?? session.title ?? `Changes from Launch session ${session.shortId}`
  await checkpoint(
    db,
    { cfg: deps.cfg, sandbox, storage: deps.storage, now },
    { tenantId: session.tenantId, sessionId: session.id },
    { message: title, repoDir: deps.repoDir }
  )
  const branch = session.branch ?? sessionBranchName(session.shortId)
  const body = [
    reply?.body?.trim() || 'Changes made in a Launch coding session.',
    '',
    '---',
    `Opened by Launch from coding session \`${session.shortId}\`${creator ? ` for ${creator.name}` : ''}. The gate (\`${gateCommand}\`) passed before this PR was opened.`,
  ].join('\n')
  const repoHost = deps.ports.repoHost(db)
  const pr = await repoHost.openPullRequest(repo, {
    head: branch,
    base: repo.defaultBranch,
    title,
    body,
  })
  const shipped = await transition(db, session, ['shipping'], {
    status: 'shipped',
    prNumber: pr.number,
    prUrl: pr.url,
    lastActivityAt: now(),
  })
  if (!shipped)
    return { status: 'skipped', reason: 'the session left shipping while its PR opened' }
  await emit([{ type: 'ship.pr', turn: turn.turn, data: { number: pr.number, url: pr.url } }])
  await recordAudit(db, {
    ...SYSTEM_ACTOR,
    tenantId: session.tenantId,
    action: 'session.shipped',
    targetType: 'session',
    targetId: session.id,
    appId: session.appId,
    summary: {
      after: { prNumber: pr.number, prUrl: pr.url, branch, headSha: shipped.headSha, title },
    },
  })

  // 5. The PR's first CI reading (a failure here is not a failed ship: the cron reads it again).
  let checks: PrChecks | null = null
  try {
    checks = await refreshChecks(db, repoHost, shipped, { now: now() })
  } catch {
    checks = null
  }
  return { status: 'shipped', prNumber: pr.number, prUrl: pr.url, checks }
}

/** `'…'` for bash, with embedded single quotes escaped. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// ---- the cron ----------------------------------------------------------------------------------

/** Shipped sessions whose checks are still worth reading: pending (or never read), started < 7 days ago. */
const CHECKS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The `sessions.checks` cron body: every shipped session's PR whose CI is pending (or unread),
 * refreshed. One tenant at a time, tenant-first, like `runPruneAiSpans`.
 */
export async function runSessionChecks(
  db: Database,
  repoHostFor: (db: Database) => RepoHostPort,
  opts: { now?: Date; limitPerTenant?: number } = {}
): Promise<{ refreshed: number; failed: number }> {
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - CHECKS_WINDOW_MS)
  const tenantIds = await db.select({ tenantId: tenants.id }).from(tenants)
  let refreshed = 0
  let failed = 0
  const host = repoHostFor(db)
  for (const { tenantId } of tenantIds) {
    const rows = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          eq(sessions.status, 'shipped'),
          isNotNull(sessions.prNumber),
          sql`(${sessions.prChecks} IS NULL OR ${sessions.prChecks}->>'state' = 'pending')`,
          gt(sessions.createdAt, since)
        )
      )
      .limit(opts.limitPerTenant ?? 50)
    for (const row of rows) {
      try {
        await refreshChecks(db, host, row, { now })
        refreshed++
      } catch {
        failed++
      }
    }
  }
  return { refreshed, failed }
}
