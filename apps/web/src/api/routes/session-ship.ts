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
 *   `session.ship_requested` (the Workflow records `session.shipped`). §18.22: 409
 *   `session_credential_owner_only` from anyone but the owner of a session on a personal account.
 * - `POST /:id/end` → 202 `sessionDetailResponseSchema`: `requested_action = 'end'` from any live
 *   status but `ending` (409 `session_not_endable`) — `shipping` included: a gate command stops
 *   within seconds and its database branch is deleted — and a running turn (a chat turn, or a
 *   ship's fix turn) is asked to stop (`cancel_requested_at`) + a wake. Ending an already-ended
 *   session is a 409 too. Issue #5: an End while the landing waits in `ci` or `approval` abandons
 *   it (`end#N` cancels the `session.merge` request); while Launch is MERGING it is a 409
 *   `session_merging` — a merge is never stopped half-way.
 * - Issue #5: an eligible approver of a pending `session.merge` may use the two READ routes below
 *   (the preview grant, the PR), never ship or end (`access.ts`).
 * - `POST /:id/preview-grant {path?}` → `previewGrantResponseSchema`: a 60 s HMAC grant for the
 *   iframe (`services/sessions/preview.ts`, exchanged at the preview host by
 *   `api/preview/gateway.ts`); `path` (`safePreviewPath`, else a 400) is the page it lands on, and
 *   `screenshots` says whether this deployment has `BROWSER` (the pane's camera).
 *   503 `previews_not_configured` without `SESSION_PREVIEW_URL`; 409 `session_ended` once settled.
 * - Issue #21: `POST /:id/landing/retry {action?}` → 202 `sessionDetailResponseSchema`: a landing
 *   stalled before its release (`main_ci_failed`, `release_failed`) goes round again — the merge
 *   commit's failed CI re-run, or (`release_anyway`) the release cut past a red default-branch
 *   `Gate` (`services/sessions/land-retry.ts`). Same permission as ship (`update`), no
 *   credential-owner rule (Phase B runs no turn). A double press retries once. 409
 *   `landing_not_retryable`.
 * - `GET /:id/pr` → `sessionPrResponseSchema`, refreshing `pr_checks` from the repo host when older
 *   than 30 s (`refreshChecks`); a failed refresh answers the stored checks. Then the session is
 *   reconciled (`reconcile.ts`): a ship or landing whose Workflow died is restarted.
 *
 * Routes START work (plan §1.2): they write the request columns and wake the `SessionWorkflow`
 * (`wakeOrRestart`, `lifecycle.ts`: `SESSION_WAKE_EVENT` with an empty payload — the row is the
 * truth — or a fresh instance when the old one is gone); a missing `SESSION_WORKFLOW` is a 503
 * `sessions_not_configured` before any row is written. The answer is `toSessionDetail` (`chat.ts`).
 */
import {
  landingRetryRequestSchema,
  type PreviewGrantRequest,
  type PreviewGrantResponse,
  previewGrantRequestSchema,
  type SessionDetailResponse,
  type SessionPrResponse,
  TERMINAL_SESSION_STATUSES,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import type { Database } from '../../db/client'
import { type SessionRow, sessions } from '../../db/schema'
import { guardPermission } from '../middleware/permissions'
import { auditActor, recordAudit } from '../services/launch/audit'
import { getSessionRow, getVisibleSession, sessionViewerOf } from '../services/sessions/access'
import {
  assertCredentialOwner,
  requireSessionWorkflow,
  toSessionDetail,
} from '../services/sessions/chat'
import { nudgeSession } from '../services/sessions/events'
import { retryLanding } from '../services/sessions/land-retry'
import { wakeOrRestart } from '../services/sessions/lifecycle'
import { defaultSessionPorts } from '../services/sessions/ports'
import { previewGrantUrl } from '../services/sessions/preview'
import { reconcileSessionSafely, SESSION_END_STALL_MS } from '../services/sessions/reconcile'
import { PR_CHECKS_MAX_AGE_MS, refreshChecks } from '../services/sessions/ship'
import { landingOf } from '../services/sessions/steps'
import type { AppContext } from '../types'
import { ConflictError, ServiceUnavailableError, ValidationError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const sessionShipRouter = createRouter()

async function visible(c: AppContext, action: 'read' | 'update') {
  const auth = guardPermission(c, action, 'Session')
  const ctx = withAuthAndDb(c)
  // Issue #5: a pending merge's reviewer may read (the preview grant, the PR), never ship or end.
  const row = await getVisibleSession(
    ctx.db,
    ctx.tenantId,
    uuidParam(c, 'id'),
    sessionViewerOf(auth),
    { readOnly: action === 'read' }
  )
  return { ...ctx, row }
}

/** Compare-and-set the request columns; the updated row or null. */
async function requestAction(
  db: Database,
  row: SessionRow,
  from: readonly SessionRow['status'][],
  set: PgUpdateSetSource<typeof sessions>,
  extra = true,
  notMerging = false
) {
  const [updated] = await db
    .update(sessions)
    .set(set)
    .where(
      and(
        eq(sessions.tenantId, row.tenantId),
        eq(sessions.id, row.id),
        inArray(sessions.status, [...from]),
        extra ? isNull(sessions.pendingMessage) : undefined,
        // Issue #5: a merge in flight is never stopped half-way.
        notMerging
          ? sql`coalesce(${sessions.landing}->>'stage', '') <> ${MERGING_STAGE}`
          : undefined
      )
    )
    .returning()
  return updated ?? null
}

const MERGING_STAGE = 'merging'

/** Issue #5: the 409 for an End while Launch is merging the session's PR. */
function mergingConflict(): ConflictError {
  return new ConflictError(
    'Launch is merging this session’s pull request; it can be ended once the merge is done',
    'session_merging'
  )
}

sessionShipRouter.post('/:id/ship', async c => {
  const { db, tenantId, logger, realtime, user, row } = await visible(c, 'update')
  const workflow = requireSessionWorkflow(c.env)
  // §18.22: a ship runs fix turns on the session's account — its owner's call alone.
  assertCredentialOwner(row, user.id)
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
          // The owed-work window (`reconcile.ts`) runs from the request.
          lastActivityAt: new Date(),
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
  if (row.status === 'shipping' && landingOf(row)?.stage === MERGING_STAGE) throw mergingConflict()
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
      // An idle session's owed-work window (`reconcile.ts`) runs from the request — so the
      // reconcile below never takes the instance this End just woke for a dead one. A running
      // step's `last_activity_at` is its HEARTBEAT: left alone, so a dead one still looks dead.
      lastActivityAt: sql`case when ${sessions.status} in ('ready', 'suspended', 'blocked')
        then ${now.toISOString()}::timestamptz else ${sessions.lastActivityAt} end`,
      updatedAt: now,
    },
    false,
    true
  )
  if (!updated) {
    const current = await getSessionRow(db, row.tenantId, row.id)
    if (current.status === 'shipping' && landingOf(current)?.stage === MERGING_STAGE) {
      throw mergingConflict()
    }
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

sessionShipRouter.post(
  '/:id/landing/retry',
  validate('json', landingRetryRequestSchema),
  async c => {
    const { action } = c.req.valid('json')
    const { db, cfg, logger, realtime, row } = await visible(c, 'update')
    const workflow = requireSessionWorkflow(c.env)
    const { row: current } = await retryLanding({
      db,
      workflow,
      repoHost: defaultSessionPorts(c.env, cfg).repoHost(db),
      row,
      action,
      actor: auditActor(c),
      logger,
    })
    nudgeSession(realtime, current)
    return c.json({ session: toSessionDetail(current, true) } satisfies SessionDetailResponse, 202)
  }
)

/**
 * The preview grant's optional body. Not `validate('json')`: that refuses an EMPTY body sent as
 * `application/json` as malformed — which is what the UI's client sends for no body, and what
 * every UI before `path` sent — so an empty body is `{}` here, and anything else must parse.
 */
async function previewGrantRequest(c: AppContext): Promise<PreviewGrantRequest> {
  const text = await c.req.text()
  let input: unknown = {}
  if (text.trim()) {
    try {
      input = JSON.parse(text)
    } catch {
      throw new ValidationError([{ path: [], message: 'Malformed JSON' }], 'Invalid json')
    }
  }
  const parsed = previewGrantRequestSchema.safeParse(input)
  if (!parsed.success) throw new ValidationError(parsed.error.issues, 'Invalid json')
  return parsed.data
}

sessionShipRouter.post('/:id/preview-grant', async c => {
  const { path } = await previewGrantRequest(c)
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
  const { url, expiresAt } = await previewGrantUrl(cfg, row, user.id, { path })
  // Whether the pane may offer its camera (`POST /:id/preview-screenshot`).
  const screenshots = Boolean(c.env.BROWSER)
  return c.json({ url, expiresAt, screenshots } satisfies PreviewGrantResponse)
})

sessionShipRouter.get('/:id/pr', async c => {
  const { db, cfg, logger, realtime, row } = await visible(c, 'read')
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
  // The ship panel polls this while a landing waits on CI: a landing whose Workflow died under it
  // is restarted here, throttled, as on `GET /:id` (`reconcile.ts`) — a fresh one costs nothing.
  await reconcileSessionSafely(db, c.env, row, { logger, realtime })
  return c.json({
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    checks,
  } satisfies SessionPrResponse)
})
