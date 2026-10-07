/**
 * The coding-session lifecycle as the ROUTES drive it (Launch P3, plan §1.2, §1.8, §1.11): start a
 * session, ask it for an action (ship, end, resume), drain and undrain. A route never runs
 * anything: it writes the request columns as a compare-and-set on `status` and wakes the
 * `SessionWorkflow` (`SESSION_WAKE_EVENT`), which re-reads the row and does the work. Turns and
 * cancels are `chat.ts` (slice 3c: `requestTurn`, `requestCancel`) on the same rule.
 *
 * `createSession` refuses — BEFORE any write — with:
 * - 503 `sessions_not_configured` without the `SESSION_WORKFLOW` binding;
 * - 409 `app_has_no_repo` for an app with no repository to clone;
 * - 409 `sessions_paused` while an operator has drained sessions;
 * - 409 `session_limit` at `maxConcurrentPerApp` active sessions (`ACTIVE_SESSION_STATUSES`, the
 *   partial index `sessions_app_active_idx`);
 * - 409 `session_budget_exhausted` when the app's month is spent (`appMonthSpend`, `budget.ts`) —
 *   not for a session on a personal account, which Launch does not pay for;
 * - §18.22 (`credentials/resolve.ts`): 409 `session_runtime_disabled`,
 *   `agent_credential_not_allowed` or `agent_credential_required` for a runtime or account that is
 *   not on offer;
 * - 409 `session_sandbox_unavailable` when the `session_sandbox_host` setting names a host this
 *   Worker cannot run a container on right now (`sandbox-host.ts`);
 * - issue #17, a WARM start (`warm: true`, the composer opened): 409 `warm_session_limit` when the
 *   caller already holds `maxWarmPerUser` warm sessions nobody has written to (`warm.ts`). Before
 *   any refusal, the caller's own such session on THIS app (same runtime and account, booting or
 *   ready) is returned instead of a new one — no row, no audit, no instance.
 * Then the row (the policy SNAPSHOTTED onto it, with the chosen runtime's model; the runtime,
 * whose account it bills and the sandbox host fixed for its life), audit `session.created`, and
 * `SESSION_WORKFLOW.create({ id: session.id, params })`.
 *
 * Waking is 3c's `wakeSession`. When it cannot deliver — the instance is gone (a `wrangler dev`
 * restart, retention past a long suspend) — `wakeOrRestart` starts a fresh instance (`<id>-r1`,
 * `-r2`…) whose `claim` reads the row and carries on from it, as the agent runtime's
 * `nudgeOrRestartInstance` does.
 */
import {
  ACTIVE_SESSION_STATUSES,
  CODING_SESSION_KINDS,
  type CreateSessionRequest,
  type DrainResponse,
  LANDING_SESSION_STATUSES,
  MOVING_LANDING_STAGES,
  newPreviewToken,
  newSessionShortId,
  RETRYABLE_STALLED_REASONS,
  resolveSessionPolicy,
  type SessionAction,
  type SessionPolicy,
  type SessionStatus,
  type SessionWorkflowParams,
  sessionBranchName,
} from '@launch/shared/launch-sessions'
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AppRow, apps, type SessionRow, sessions } from '../../../db/schema'
import type { AppBindings } from '../../types'
import { ConflictError, isUniqueViolation, ServiceUnavailableError } from '../../utils/core/errors'
import { type AuditActor, recordAudit } from '../launch/audit'
import { getSetting, putSetting } from '../launch/credentials'
import type { Realtime } from '../realtime'
import { appMonthSpend } from './budget'
import { requireSessionWorkflow, type WarnLogger, wakeSession } from './chat'
import { resolveSessionCredential, runtimeReadiness } from './credentials/resolve'
import { nudgeSession } from './events'
import { SESSION_IMAGE_VERSION } from './rocketflare-dev'
import { resolveNewSandboxHost } from './sandbox-host'

// ---- settings ----------------------------------------------------------------------------------

/** `launch_settings.session_policy` with the code defaults filled in. */
export async function loadSessionPolicy(db: Database): Promise<SessionPolicy> {
  return resolveSessionPolicy(await getSetting(db, 'session_policy'))
}

/** `launch_settings.sessions_paused` — true while drained. */
export async function sessionsPaused(db: Database): Promise<boolean> {
  return (await getSetting(db, 'sessions_paused')) === true
}

// ---- concurrency -------------------------------------------------------------------------------

/** How many of the app's coding sessions hold resources right now (`CODING_SESSION_KINDS`). */
export async function activeSessionCount(
  db: Database,
  tenantId: string,
  appId: string
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(sessions)
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        eq(sessions.appId, appId),
        inArray(sessions.kind, [...CODING_SESSION_KINDS]),
        inArray(sessions.status, [...ACTIVE_SESSION_STATUSES])
      )
    )
  return Number(row?.n ?? 0)
}

// ---- warm starts (issue #17, `warm.ts`) ---------------------------------------------------------

/** Statuses a warm start nobody has written to may be in: it holds, or is about to hold, a container. */
const UNPROMPTED_WARM_STATUSES: readonly SessionStatus[] = [
  'requested',
  'booting',
  'ready',
  'suspended',
]

/** The caller's warm starts nobody has written to yet, newest first — across the tenant's apps. */
export async function unpromptedWarmSessions(
  db: Database,
  tenantId: string,
  userId: string
): Promise<SessionRow[]> {
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        eq(sessions.createdByUserId, userId),
        eq(sessions.kind, 'session'),
        eq(sessions.warmStart, true),
        eq(sessions.turnCount, 0),
        isNull(sessions.pendingMessage),
        inArray(sessions.status, [...UNPROMPTED_WARM_STATUSES])
      )
    )
    .orderBy(desc(sessions.createdAt))
}

/**
 * The warm session a new warm start on `appId` should attach to: the caller's own, unprompted,
 * booting or ready (a suspended one would boot again — a fresh start is no slower), on the same
 * base and with the same runtime and account when the request names them.
 */
function reusableWarmSession(
  rows: readonly SessionRow[],
  appId: string,
  request: CreateSessionRequest
): SessionRow | null {
  return (
    rows.find(
      row =>
        row.appId === appId &&
        (row.status === 'requested' || row.status === 'booting' || row.status === 'ready') &&
        // Never one its person already asked to end.
        row.requestedAction === null &&
        (request.title === undefined || request.title === row.title) &&
        (request.baseRef === undefined || request.baseRef === row.baseRef) &&
        (request.runtime === undefined || request.runtime === row.runtime) &&
        (request.credential === undefined || request.credential === row.credentialSource)
    ) ?? null
  )
}

// ---- waking the Workflow -----------------------------------------------------------------------

/** `<id>` → `<id>-r1` → `<id>-r2`: the instance id a restart takes. */
export function nextSessionInstanceId(sessionId: string, current: string | null): string {
  const match = current?.startsWith(`${sessionId}-r`) ? /-r(\d+)$/.exec(current) : null
  return `${sessionId}-r${match?.[1] ? Number(match[1]) + 1 : 1}`
}

/**
 * Wake the session's instance (3c's `wakeSession`); when that cannot deliver, start a fresh
 * instance from the ROW and record its id. Returns the row (with the new `instance_id` when one
 * was made).
 */
export async function wakeOrRestart(
  db: Database,
  workflow: Workflow,
  session: SessionRow,
  logger?: WarnLogger
): Promise<SessionRow> {
  if (await wakeSession(workflow, session, logger)) return session
  return restartSessionInstance(db, workflow, session)
}

/**
 * Start a fresh instance (`<id>-rN`) for `session` and record its id — without waking the old one
 * first. What `wakeOrRestart` falls back to, and what the reconcile (`reconcile.ts`) uses after it
 * terminated an instance that was alive in name only. `options.salvage` is what the fresh
 * instance's salvage asks for (`SessionWorkflowParams`); absent, a resume.
 */
export async function restartSessionInstance(
  db: Database,
  workflow: Workflow,
  session: SessionRow,
  options: { salvage?: SessionWorkflowParams['salvage'] } = {}
): Promise<SessionRow> {
  let lastError: unknown
  let candidate = nextSessionInstanceId(session.id, session.instanceId)
  const params: SessionWorkflowParams = {
    sessionId: session.id,
    tenantId: session.tenantId,
    ...(options.salvage ? { salvage: options.salvage } : {}),
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const instance = await workflow.create({ id: candidate, params })
      const [updated] = await db
        .update(sessions)
        .set({ instanceId: instance.id })
        .where(and(eq(sessions.tenantId, session.tenantId), eq(sessions.id, session.id)))
        .returning()
      return updated ?? session
    } catch (err) {
      lastError = err
      candidate = nextSessionInstanceId(session.id, candidate)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('session: could not restart instance')
}

// ---- create ------------------------------------------------------------------------------------

export interface CreateSessionInput {
  tenantId: string
  app: AppRow
  userId: string
  request: CreateSessionRequest
  actor: AuditActor
  realtime?: Realtime
  now?: Date
  /**
   * App page P2 ("Fix in a session"): the session's first message, written as its pending turn so
   * the Workflow runs it as soon as the sandbox is ready. The route composes it
   * (`releases/fix-session.ts`).
   */
  firstMessage?: string | null
  /**
   * P6 6c: a kit upgrade's session — kind `upgrade`, the `app_upgrades` row it is doing, and
   * whether its first turn ships by itself (`upgrades.ts`). Absent: an ordinary `session`.
   */
  upgrade?: { upgradeId: string; autoShip: boolean } | null
  /**
   * The Worker's config: with it, the `session_sandbox_host` setting is resolved (and refused when
   * unavailable) and frozen on the row; absent (a fixture) = this Worker's own containers. Which
   * runtimes run, and on whose account, is the session policy's `runtimes`.
   */
  cfg?: AppConfig
}

/** Start a session on `app` — see the header for every refusal. */
export async function createSession(
  db: Database,
  env: AppBindings,
  input: CreateSessionInput
): Promise<SessionRow> {
  const workflow = requireSessionWorkflow(env)
  const { tenantId, app } = input
  if (!app.repoOwner || !app.repoName) {
    throw new ConflictError('This app has no repository to work on', 'app_has_no_repo')
  }
  // Issue #17: a warm start is an ordinary start with no first message yet (a seeded one has one).
  const warm = input.request.warm === true && !input.firstMessage && !input.upgrade
  const warmRows = warm ? await unpromptedWarmSessions(db, tenantId, input.userId) : []
  const reusable = reusableWarmSession(warmRows, app.id, input.request)
  if (reusable) {
    // Opening the composer again is activity: its quiet window starts over (`warm.ts`).
    const [touched] = await db
      .update(sessions)
      .set({ lastActivityAt: input.now ?? new Date() })
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, reusable.id)))
      .returning()
    return touched ?? reusable
  }
  if (await sessionsPaused(db)) {
    throw new ConflictError(
      'Coding sessions are paused while Launch is being updated. Try again in a few minutes.',
      'sessions_paused'
    )
  }
  const stored = await loadSessionPolicy(db)
  // §18.22: which runtime, whose account, and the model to freeze — refused before any write.
  const resolved = await resolveSessionCredential(db, {
    policy: stored,
    tenantId,
    userId: input.userId,
    request: { runtime: input.request.runtime, credential: input.request.credential },
    // What this Worker can run (Pi needs Workers AI bound); a fixture without `cfg` offers no Pi.
    ...(input.cfg ? { readiness: await runtimeReadiness(db, input.cfg, env) } : {}),
    now: input.now,
  })
  const policy = resolved.policy
  // Where its container runs, frozen on the row: a resume never moves to another host.
  const sandboxHost = input.cfg ? await resolveNewSandboxHost(db, env, input.cfg) : 'local'
  if ((await activeSessionCount(db, tenantId, app.id)) >= policy.maxConcurrentPerApp) {
    throw new ConflictError(
      `This app already has ${policy.maxConcurrentPerApp} active sessions. End one first.`,
      'session_limit',
      { limit: policy.maxConcurrentPerApp }
    )
  }
  const warmLimit = policy.maxWarmPerUser
  if (warm && warmRows.length >= warmLimit) {
    throw new ConflictError(
      `You already have ${warmRows.length} sessions waiting for a first message. Write in one of them, or end it, to start another.`,
      'warm_session_limit',
      { limit: warmLimit, sessionIds: warmRows.map(row => row.id) }
    )
  }
  const month =
    resolved.source === 'user'
      ? null
      : await appMonthSpend(db, { tenantId, appId: app.id, policy }, input.now)
  if (month && month.spentMicrocents >= month.capMicrocents) {
    throw new ConflictError(
      'This app has used its coding-session budget for the month',
      'session_budget_exhausted',
      { ...month, scope: 'app_month' }
    )
  }

  const now = input.now ?? new Date()
  let row: SessionRow | undefined
  for (let attempt = 0; !row; attempt++) {
    const shortId = newSessionShortId()
    const id = crypto.randomUUID()
    try {
      ;[row] = await db
        .insert(sessions)
        .values({
          id,
          tenantId,
          appId: app.id,
          createdByUserId: input.userId,
          kind: input.upgrade ? 'upgrade' : 'session',
          upgradeId: input.upgrade?.upgradeId ?? null,
          autoShip: input.upgrade?.autoShip ?? false,
          warmStart: warm,
          shortId,
          previewToken: newPreviewToken(),
          title: input.request.title ?? null,
          status: 'requested',
          pendingMessage: input.firstMessage ?? null,
          baseRef: input.request.baseRef ?? app.defaultBranch ?? 'main',
          branch: sessionBranchName(shortId),
          instanceId: id,
          imageVersion: SESSION_IMAGE_VERSION,
          sandboxHost,
          policy,
          runtime: resolved.runtime,
          credentialSource: resolved.source,
          agentCredentialId: resolved.credentialId,
          pendingMessageUserId: input.firstMessage ? input.userId : null,
          lastActivityAt: now,
        })
        .returning()
    } catch (err) {
      // A short-id collision (60 bits) is astronomically rare; one more draw settles it.
      if (attempt >= 2 || !isUniqueViolation(err)) throw err
    }
  }

  await recordAudit(db, {
    ...input.actor,
    tenantId,
    action: 'session.created',
    targetType: 'session',
    targetId: row.id,
    appId: app.id,
    summary: {
      after: {
        branch: row.branch,
        baseRef: row.baseRef,
        title: row.title,
        ...(row.kind !== 'session' ? { kind: row.kind, upgradeId: row.upgradeId } : {}),
        // §18.22: only when not the default, so a Claude-on-Launch audit row reads as it always did.
        ...(row.runtime !== 'claude_code' ? { runtime: row.runtime } : {}),
        ...(row.credentialSource !== 'platform' ? { credentialSource: row.credentialSource } : {}),
        ...(row.sandboxHost !== 'local' ? { sandboxHost: row.sandboxHost } : {}),
        ...(row.warmStart ? { warmStart: true } : {}),
      },
    },
  })

  try {
    await workflow.create({ id: row.id, params: { sessionId: row.id, tenantId } })
  } catch (err) {
    // The row exists but nothing will ever drive it: settle it now rather than leave a phantom
    // that counts against the app's concurrency.
    await db
      .update(sessions)
      .set({ status: 'failed', error: 'The session could not be started', endedAt: new Date() })
      .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, row.id)))
    throw new ServiceUnavailableError(
      `The session could not be started: ${err instanceof Error ? err.message : String(err)}`,
      'session_start_failed'
    )
  }
  nudgeSession(input.realtime, row)
  return row
}

// ---- actions -----------------------------------------------------------------------------------

/** Where each action may be asked from. */
export const ACTION_FROM: Record<SessionAction, readonly SessionStatus[]> = {
  ship: ['ready'],
  resume: ['suspended'],
  end: ['requested', 'booting', 'ready', 'working', 'blocked', 'suspended'],
}

/**
 * Set `requested_action` (a compare-and-set on the statuses `ACTION_FROM` allows) and wake. 409
 * `session_not_ready` otherwise. `POST /:id/resume` here; ship and end are `session-ship.ts`'s
 * routes on the same rule.
 */
export async function requestAction(
  db: Database,
  env: AppBindings,
  session: SessionRow,
  action: SessionAction,
  opts: { realtime?: Realtime; logger?: WarnLogger } = {}
): Promise<SessionRow> {
  const workflow = requireSessionWorkflow(env)
  const [row] = await db
    .update(sessions)
    .set({ requestedAction: action, lastActivityAt: new Date() })
    .where(
      and(
        eq(sessions.tenantId, session.tenantId),
        eq(sessions.id, session.id),
        inArray(sessions.status, [...ACTION_FROM[action]])
      )
    )
    .returning()
  if (!row) {
    throw new ConflictError(
      `A ${session.status} session cannot ${action} right now`,
      'session_not_ready',
      { status: session.status }
    )
  }
  const woken = await wakeOrRestart(db, workflow, row, opts.logger)
  nudgeSession(opts.realtime, woken)
  return woken
}

// ---- drain -------------------------------------------------------------------------------------

/** The statuses a drain asks to suspend — everything with a live (or booting) container. */
const DRAINABLE: readonly SessionStatus[] = ['requested', 'booting', 'ready', 'working', 'blocked']

/**
 * `POST /api/admin/sessions/drain`: pause new sessions and wake every live one — the Workflow's
 * `inspect#N` sees `sessions_paused` and suspends it (checkpoint first; a running turn finishes
 * first) — and every suspended one that still KEEPS its container (`container_kept_at`, a warm
 * idle suspend), which `inspect#N` cools (destroys) at once. Across every organisation: a drain is about the deployment's image. Audited
 * `sessions.drained` in each organisation that had a live session, and in the operator's own.
 */
export async function drainSessions(
  db: Database,
  env: AppBindings,
  input: {
    actor: AuditActor
    actorTenantId: string | null
    userId: string | null
    logger?: WarnLogger
  }
): Promise<DrainResponse> {
  await putSetting(db, 'sessions_paused', true, input.userId)
  const live = await db
    .select()
    .from(sessions)
    .where(
      or(
        inArray(sessions.status, [...DRAINABLE]),
        and(eq(sessions.status, 'suspended'), isNotNull(sessions.containerKeptAt))
      )
    )
    .orderBy(desc(sessions.createdAt))
  const byTenant = new Map<string, number>()
  const workflow = env.SESSION_WORKFLOW
  for (const session of live) {
    byTenant.set(session.tenantId, (byTenant.get(session.tenantId) ?? 0) + 1)
    // A plain wake: a session whose instance is gone has no live container to drain either (the
    // Durable Object's `onStop` marks it suspended), and a drain must not start instances.
    if (workflow) await wakeSession(workflow, session, input.logger)
  }
  if (input.actorTenantId && !byTenant.has(input.actorTenantId)) {
    byTenant.set(input.actorTenantId, 0)
  }
  for (const [tenantId, count] of byTenant) {
    await recordAudit(db, {
      ...input.actor,
      tenantId,
      action: 'sessions.drained',
      targetType: 'deployment',
      summary: { after: { paused: true, suspending: count } },
    })
  }
  return { paused: true, suspended: live.length }
}

/** `POST /api/admin/sessions/undrain`: new sessions allowed again; people resume their own. */
export async function undrainSessions(
  db: Database,
  input: { actor: AuditActor; actorTenantId: string | null }
): Promise<DrainResponse> {
  await putSetting(db, 'sessions_paused', null, null)
  if (input.actorTenantId) {
    await recordAudit(db, {
      ...input.actor,
      tenantId: input.actorTenantId,
      action: 'sessions.undrained',
      targetType: 'deployment',
      summary: { after: { paused: false } },
    })
  }
  return { paused: false, suspended: 0 }
}

// ---- lists -------------------------------------------------------------------------------------

const textList = (values: readonly string[]) =>
  sql.join(
    values.map(value => sql`${value}`),
    sql`, `
  )

/**
 * A ship still in flight — `sessionShippingOf(row) !== null` in SQL: a landing on a `shipping` /
 * `shipped` row in a moving stage, or stalled before its release. Such a row is in the `active`
 * lists whatever its status: after the merge it is `shipped` (settled) while the landing still
 * releases and deploys, or waits on a person.
 */
export function shipInFlightSql() {
  return and(
    inArray(sessions.status, [...LANDING_SESSION_STATUSES]),
    or(
      sql`${sessions.landing}->>'stage' in (${textList(MOVING_LANDING_STAGES)})`,
      and(
        sql`${sessions.landing}->>'stage' = 'stalled'`,
        sql`${sessions.landing}->>'stalledReason' in (${textList(RETRYABLE_STALLED_REASONS)})`
      )
    )
  )
}

/** The `active` scope: holding resources, or shipping (`shipInFlightSql`). */
function activeScopeSql() {
  return or(inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]), shipInFlightSql())
}

/** An app's sessions for `GET /api/apps/:id/sessions`, newest first. */
export async function listAppSessions(
  db: Database,
  tenantId: string,
  appId: string,
  filter: { scope: 'active' | 'all'; onlyCreatedBy: string | null }
): Promise<SessionRow[]> {
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        eq(sessions.appId, appId),
        inArray(sessions.kind, [...CODING_SESSION_KINDS]),
        filter.scope === 'active' ? activeScopeSql() : undefined,
        filter.onlyCreatedBy ? eq(sessions.createdByUserId, filter.onlyCreatedBy) : undefined
      )
    )
    .orderBy(desc(sessions.createdAt))
    .limit(100)
}

/**
 * Every organisation's sessions for the operator (`GET /api/admin/sessions`) — platform capacity,
 * behind `globalAdminMiddleware`. The app is joined inside its own tenant.
 */
export async function listAllSessions(
  db: Database,
  scope: 'active' | 'all'
): Promise<{ session: SessionRow; appSlug: string }[]> {
  return db
    .select({ session: sessions, appSlug: apps.slug })
    .from(sessions)
    .innerJoin(apps, and(eq(apps.id, sessions.appId), eq(apps.tenantId, sessions.tenantId)))
    .where(scope === 'active' ? activeScopeSql() : undefined)
    .orderBy(desc(sessions.createdAt))
    .limit(500)
}

// ---- container time (the Sandbox Durable Object) -----------------------------------------------

/**
 * `SessionSandbox.onStop`: add the container's run time to its session and — when the container
 * went away under a session that thinks it is live (the SDK's idle sleep, a rollout) — mark it
 * `suspended`, so the next wake boots again rather than talking to an empty container — and
 * forget a container a warm suspend kept (`container_kept_at`). Found by
 * `sandbox_id` (the Durable Object's own id; pre-tenant), then written inside its tenant.
 */
export async function recordContainerStop(
  db: Database,
  sandboxId: string,
  seconds: number,
  now: Date = new Date()
): Promise<void> {
  const [found] = await db
    .select({ id: sessions.id, tenantId: sessions.tenantId })
    .from(sessions)
    .where(eq(sessions.sandboxId, sandboxId))
    .limit(1)
  if (!found) return
  const where = and(eq(sessions.tenantId, found.tenantId), eq(sessions.id, found.id))
  await db
    .update(sessions)
    .set({
      containerSeconds: sql`${sessions.containerSeconds} + ${Math.max(0, Math.round(seconds))}`,
      // Whatever an idle suspend kept is gone now: the next resume boots cold.
      containerKeptAt: null,
    })
    .where(where)
  await db
    .update(sessions)
    .set({ status: 'suspended', suspendedAt: now })
    .where(and(where, inArray(sessions.status, ['ready', 'blocked'])))
}
