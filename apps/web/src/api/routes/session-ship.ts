/**
 * The ship half of `/api/sessions` (Launch P3, slice 3d), mounted by `routes/sessions.ts` with
 * `sessionsRouter.route('/', sessionShipRouter)`, behind the `/api/sessions` mount's
 * `authMiddleware`. Every route resolves the session with `getVisibleSession`
 * (`services/sessions/access.ts`): another person's session, or another tenant's, is a 404.
 *
 * - `POST /:id/ship` → 202 `sessionDetailResponseSchema`: `requested_action = 'ship'` (a
 *   compare-and-set on `status = 'ready'` with nothing pending — 409 `session_not_ready`
 *   otherwise) + a wake; the Workflow's ship steps (`services/sessions/ship-steps.ts`, issue #1)
 *   run the gate themselves, a fix turn on red, and open the PR. Audited
 *   `session.ship_requested` (the Workflow records `session.shipped`).
 * - `POST /:id/end` → 202 `sessionDetailResponseSchema`: `requested_action = 'end'` from any live
 *   status but `ending` (409 `session_not_endable`) — `shipping` included: a gate command stops
 *   within seconds and its database branch is deleted — and a running turn (a chat turn, or a
 *   ship's fix turn) is asked to stop (`cancel_requested_at`) + a wake. Ending an already-ended
 *   session is a 409 too.
 * - `POST /:id/preview-grant` → `previewGrantResponseSchema`: a 60 s HMAC grant for the iframe
 *   (`services/sessions/preview.ts`, exchanged at the preview host by `api/preview/gateway.ts`).
 *   503 `previews_not_configured` without `SESSION_PREVIEW_URL`; 409 `session_ended` once settled.
 * - `GET /:id/pr` → `sessionPrResponseSchema`, refreshing `pr_checks` from the repo host when older
 *   than 30 s (`refreshChecks`); a failed refresh answers the stored checks.
 *
 * Routes START work (plan §1.2): they write the request columns and wake the `SessionWorkflow`
 * (`wakeOrRestart`, `lifecycle.ts`: `SESSION_WAKE_EVENT` with an empty payload — the row is the
 * truth — or a fresh instance when the old one is gone); a missing `SESSION_WORKFLOW` is a 503
 * `sessions_not_configured` before any row is written. The answer is `toSessionDetail` (`chat.ts`).
 */
import {
  type PreviewGrantResponse,
  previewLabel,
  previewUrl,
  type SessionDetailResponse,
  type SessionPrResponse,
  TERMINAL_SESSION_STATUSES,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { type SessionRow, sessions } from '../../db/schema'
import { guardPermission } from '../middleware/permissions'
import { auditActor, recordAudit } from '../services/launch/audit'
import { getSessionRow, getVisibleSession, sessionViewerOf } from '../services/sessions/access'
import { requireSessionWorkflow, toSessionDetail } from '../services/sessions/chat'
import { nudgeSession } from '../services/sessions/events'
import { wakeOrRestart } from '../services/sessions/lifecycle'
import { defaultSessionPorts } from '../services/sessions/ports'
import { mintGrant, PREVIEW_GRANT_PATH, PREVIEW_UI_PORT } from '../services/sessions/preview'
import { reconcileSessionSafely, SESSION_END_STALL_MS } from '../services/sessions/reconcile'
import { PR_CHECKS_MAX_AGE_MS, refreshChecks } from '../services/sessions/ship'
import type { AppContext } from '../types'
import { ConflictError, ServiceUnavailableError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const sessionShipRouter = createRouter()

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
  const { db, tenantId, logger, realtime, row } = await visible(c, 'update')
  const workflow = requireSessionWorkflow(c.env)
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
  const woken = await wakeOrRestart(db, workflow, updated, logger)
  nudgeSession(realtime, woken)
  return c.json({ session: toSessionDetail(woken, true) } satisfies SessionDetailResponse, 202)
})

/**
 * The statuses a person may end from: anything live but an end already asked — a ship in flight
 * included (its gate stops at the next poll, `ship-steps.ts`).
 */
const ENDABLE = [
  'requested',
  'booting',
  'ready',
  'working',
  'blocked',
  'suspended',
  'shipping',
] as const

sessionShipRouter.post('/:id/end', async c => {
  const { db, logger, realtime, row } = await visible(c, 'update')
  const workflow = requireSessionWorkflow(c.env)
  const now = new Date()
  const updated = await requestAction(
    db,
    row,
    ENDABLE,
    {
      requestedAction: 'end',
      // A running turn (or a ship's fix turn) is asked to stop; the Workflow ends the session
      // once it has.
      cancelRequestedAt:
        row.status === 'working' || row.status === 'shipping' ? now : row.cancelRequestedAt,
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
  // A lost instance (a `wrangler dev` reload, retention) is restarted from the row, so an end
  // always reaches a Workflow that cleans up. A live boot step sees the request within seconds
  // (`withProgress` polls the row); an instance alive in name only — a boot step with no
  // heartbeat for over a minute, or a turn as quiet — is settled now rather than on the next read
  // (`reconcile.ts`).
  const woken = await wakeOrRestart(db, workflow, updated, logger)
  const reconciled = await reconcileSessionSafely(db, c.env, woken, {
    logger,
    realtime,
    stallMs: SESSION_END_STALL_MS,
  })
  const current =
    reconciled.outcome === 'settled' ? await getSessionRow(db, row.tenantId, row.id) : woken
  nudgeSession(realtime, current)
  return c.json({ session: toSessionDetail(current, true) } satisfies SessionDetailResponse, 202)
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
