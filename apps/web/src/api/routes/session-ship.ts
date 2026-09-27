/**
 * The ship half of `/api/sessions` (Launch P3, slice 3d), mounted by `routes/sessions.ts` with
 * `sessionsRouter.route('/', sessionShipRouter)`, behind the `/api/sessions` mount's
 * `authMiddleware`. Every route resolves the session with `getVisibleSession`
 * (`services/sessions/access.ts`): another person's session, or another tenant's, is a 404.
 *
 * - `POST /:id/ship` → 202 `sessionDetailResponseSchema`: `requested_action = 'ship'` (a
 *   compare-and-set on `status = 'ready'` with nothing pending — 409 `session_not_ready`
 *   otherwise) + a wake; the Workflow's `ship` step runs `ship()` (`services/sessions/ship.ts`):
 *   the `session-ship` turn, Launch's own gate, the checkpoint and the PR. Audited
 *   `session.ship_requested` (the Workflow records `session.shipped`).
 * - `POST /:id/end` → 202 `sessionDetailResponseSchema`: `requested_action = 'end'` from any live
 *   status but `shipping` / `ending` (409 `session_not_endable`), and a running turn is asked to
 *   stop (`cancel_requested_at`) + a wake. Ending an already-ended session is a 409 too.
 * - `POST /:id/preview-grant` → `previewGrantResponseSchema`: a 60 s HMAC grant for the iframe
 *   (`services/sessions/preview.ts`, exchanged at the preview host by `api/preview/gateway.ts`).
 *   503 `previews_not_configured` without `SESSION_PREVIEW_URL`; 409 `session_ended` once settled.
 * - `GET /:id/pr` → `sessionPrResponseSchema`, refreshing `pr_checks` from the repo host when older
 *   than 30 s (`refreshChecks`); a failed refresh answers the stored checks.
 *
 * Routes START work (plan §1.2): they write the request columns and wake the `SessionWorkflow`
 * (`SESSION_WAKE_EVENT`, empty payload — the row is the truth); a missing `SESSION_WORKFLOW` is a
 * 503 `sessions_not_configured` before any row is written.
 */
import {
  type PreviewGrantResponse,
  previewLabel,
  previewUrl,
  resolveSessionPolicy,
  SESSION_WAKE_EVENT,
  type Session,
  type SessionDetailResponse,
  type SessionPrResponse,
  TERMINAL_SESSION_STATUSES,
  usdToMicrocents,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { type SessionRow, sessions } from '../../db/schema'
import { guardPermission } from '../middleware/permissions'
import { auditActor, recordAudit } from '../services/launch/audit'
import { getVisibleSession, sessionViewerOf } from '../services/sessions/access'
import { defaultSessionPorts } from '../services/sessions/ports'
import { mintGrant, PREVIEW_GRANT_PATH, PREVIEW_UI_PORT } from '../services/sessions/preview'
import { PR_CHECKS_MAX_AGE_MS, refreshChecks } from '../services/sessions/ship'
import type { AppBindings, AppContext } from '../types'
import { ConflictError, ServiceUnavailableError } from '../utils/core/errors'
import { type RouteContext, uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const sessionShipRouter = createRouter()

/** The session as `sessionSchema` draws it — no token, no sealed column. */
function toSession(row: SessionRow, viewerCanManage: boolean): Session {
  const policy = resolveSessionPolicy(row.policy)
  return {
    id: row.id,
    appId: row.appId,
    kind: row.kind,
    shortId: row.shortId,
    title: row.title,
    status: row.status,
    createdByUserId: row.createdByUserId,
    branch: row.branch,
    turnCount: row.turnCount,
    costMicrocents: row.costMicrocents,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    baseRef: row.baseRef,
    baseSha: row.baseSha,
    headSha: row.headSha,
    requestedAction: row.requestedAction,
    pendingMessage: row.pendingMessage !== null,
    cancelRequested: row.cancelRequestedAt !== null,
    imageVersion: row.imageVersion,
    policy,
    usage: {
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
    },
    budget: {
      spentMicrocents: row.costMicrocents,
      capMicrocents: usdToMicrocents(policy.maxSessionUsd) + row.budgetExtraMicrocents,
      extraMicrocents: row.budgetExtraMicrocents,
    },
    containerSeconds: row.containerSeconds,
    prChecks: row.prChecks ?? null,
    error: row.error,
    readyAt: row.readyAt,
    suspendedAt: row.suspendedAt,
    endedAt: row.endedAt,
    updatedAt: row.updatedAt,
    viewerCanManage,
  }
}

/** The Workflow binding, or the 503 — checked before any row is written. */
function requireWorkflow(env: AppBindings): Workflow {
  if (!env.SESSION_WORKFLOW) {
    throw new ServiceUnavailableError(
      'Coding sessions are not configured on this deployment',
      'sessions_not_configured'
    )
  }
  return env.SESSION_WORKFLOW
}

/**
 * Wake the session's Workflow. The row already says what to do, so a failed wake is logged, not
 * thrown: the instance also wakes on its idle timeout and re-reads the row.
 */
async function wake(
  workflow: Workflow,
  row: SessionRow,
  logger: RouteContext['logger']
): Promise<void> {
  try {
    const instance = await workflow.get(row.instanceId ?? row.id)
    await instance.sendEvent({ type: SESSION_WAKE_EVENT, payload: {} })
  } catch (err) {
    logger.warn(
      { err, sessionId: row.id },
      'session wake failed; the Workflow will re-read the row'
    )
  }
}

async function visible(c: AppContext, action: 'read' | 'update') {
  const auth = guardPermission(c, action, 'Session')
  const ctx = withAuthAndDb(c)
  const row = await getVisibleSession(
    ctx.db,
    ctx.tenantId,
    uuidParam(c, 'id'),
    sessionViewerOf(auth)
  )
  return { ...ctx, row }
}

/** Compare-and-set the request columns; the updated row or null. */
async function requestAction(
  db: Database,
  row: SessionRow,
  from: readonly SessionRow['status'][],
  set: Partial<typeof sessions.$inferInsert>,
  extra = true
) {
  const [updated] = await db
    .update(sessions)
    .set(set)
    .where(
      and(
        eq(sessions.tenantId, row.tenantId),
        eq(sessions.id, row.id),
        inArray(sessions.status, [...from]),
        extra ? isNull(sessions.pendingMessage) : undefined
      )
    )
    .returning()
  return updated ?? null
}

sessionShipRouter.post('/:id/ship', async c => {
  const { db, tenantId, logger, row } = await visible(c, 'update')
  const workflow = requireWorkflow(c.env)
  if (row.status === 'working' || row.pendingMessage !== null) {
    throw new ConflictError(
      'Wait for the current turn to finish before shipping',
      'turn_in_progress'
    )
  }
  const updated =
    row.requestedAction === null
      ? await requestAction(db, row, ['ready'], {
          requestedAction: 'ship',
          updatedAt: new Date(),
        })
      : null
  if (!updated) {
    throw new ConflictError(
      `This session cannot ship while it is ${row.status}`,
      'session_not_ready'
    )
  }
  await recordAudit(db, {
    ...auditActor(c),
    tenantId,
    action: 'session.ship_requested',
    targetType: 'session',
    targetId: row.id,
    appId: row.appId,
  })
  await wake(workflow, updated, logger)
  return c.json({ session: toSession(updated, true) } satisfies SessionDetailResponse, 202)
})

/** The statuses a person may end from: anything live but a ship in flight or an end already asked. */
const ENDABLE = ['requested', 'booting', 'ready', 'working', 'blocked', 'suspended'] as const

sessionShipRouter.post('/:id/end', async c => {
  const { db, logger, row } = await visible(c, 'update')
  const workflow = requireWorkflow(c.env)
  const now = new Date()
  const updated = await requestAction(
    db,
    row,
    ENDABLE,
    {
      requestedAction: 'end',
      // A running turn is asked to stop; the Workflow ends the session once it has.
      cancelRequestedAt: row.status === 'working' ? now : row.cancelRequestedAt,
      updatedAt: now,
    },
    false
  )
  if (!updated) {
    throw new ConflictError(
      `This session cannot be ended while it is ${row.status}`,
      'session_not_endable'
    )
  }
  await wake(workflow, updated, logger)
  return c.json({ session: toSession(updated, true) } satisfies SessionDetailResponse, 202)
})

sessionShipRouter.post('/:id/preview-grant', async c => {
  const { cfg, user, row } = await visible(c, 'read')
  if (!cfg.SESSION_PREVIEW_URL) {
    throw new ServiceUnavailableError(
      'Session previews are not configured on this deployment (SESSION_PREVIEW_URL)',
      'previews_not_configured'
    )
  }
  if ((TERMINAL_SESSION_STATUSES as readonly string[]).includes(row.status)) {
    throw new ConflictError('This session has ended', 'session_ended')
  }
  const origin = previewUrl(
    cfg.SESSION_PREVIEW_URL,
    previewLabel(PREVIEW_UI_PORT, row.shortId, row.previewToken)
  )
  const { token, expiresAt } = await mintGrant(cfg, {
    sessionId: row.id,
    userId: user.id,
    host: new URL(origin).host,
  })
  const url = `${origin}${PREVIEW_GRANT_PATH}?g=${encodeURIComponent(token)}`
  return c.json({ url, expiresAt } satisfies PreviewGrantResponse)
})

sessionShipRouter.get('/:id/pr', async c => {
  const { db, cfg, logger, row } = await visible(c, 'read')
  let checks = row.prChecks ?? null
  if (row.prNumber) {
    try {
      checks = await refreshChecks(db, defaultSessionPorts(c.env, cfg).repoHost(db), row, {
        maxAgeMs: PR_CHECKS_MAX_AGE_MS,
      })
    } catch (err) {
      logger.warn({ err, sessionId: row.id }, 'PR checks refresh failed; answering the stored ones')
    }
  }
  return c.json({
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    checks,
  } satisfies SessionPrResponse)
})
