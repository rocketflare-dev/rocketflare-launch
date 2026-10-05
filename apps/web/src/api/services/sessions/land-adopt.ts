/**
 * Adopting a merge made by hand on GitHub (issue #5 follow-up, CONCEPTS §18.13): a session's PR
 * that a person merged on GitHub while NO landing was moving — a session shipped before issue #5
 * (landing null), or one whose landing stopped at stage `pr` (shipped in `pr` mode, the app switched
 * to `staging` since) — would otherwise only be recorded `pr.merged` by `sessions.checks` and wait
 * for someone to press New release. When the app ships to `staging`, the cron adopts it instead:
 *
 * 1. `adoptHandMerge`: ONE compare-and-set on `status = 'shipped' AND (landing IS NULL OR
 *    landing->>'stage' = 'pr')` writes a fresh landing at stage `releasing` (mode `staging`,
 *    review `none`, the merge SHA and time) — the same row Launch's own merge leaves — then
 *    `ship.merged` (`by: 'github'`, no approval) and audit `session.merged` (`by: 'github'`,
 *    `adopted: true`). The status stays `shipped`.
 * 2. `startAdoptedLanding`: the session's Workflow — its instance finished long ago, so a fresh
 *    one (`wakeOrRestartLanding`); its `claim` routes `shipped` + `releasing` to Phase B, which
 *    follows the release exactly as after Launch's merge (the claim, a shared release when another
 *    PR already cut it, the staging follow, health, `live` / `stalled`). A start that fails is the
 *    safety net's (`nudgeLandingSessions` restarts a quiet `releasing` landing).
 *
 * Guards: `pr`-mode apps keep the old behaviour (a reviewer merging on GitHub releases by hand);
 * only a merge newer than `LAND_ADOPT_MAX_AGE_HOURS` is adopted, so the first deploy of this code
 * does not release every PR merged in the last two weeks; the CAS makes a second pass (or a
 * concurrent one) a no-op — and `sessions.checks` stops reading a PR once `pr.merged` is recorded.
 * Every query names the tenant.
 */
import { resolveAppShipSettings } from '@launch/shared/launch-apps'
import type { SessionLanding } from '@launch/shared/launch-sessions'
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type SessionRow, sessions } from '../../../db/schema'
import type { Logger } from '../../utils/core/logger'
import { recordAudit, SYSTEM_ACTOR } from '../launch/audit'
import { createSessionEmitter } from './events'
import { wakeOrRestartLanding } from './land'

/**
 * A hand merge older than this is never adopted (it is recorded `pr.merged` only, as before). A
 * day: wide enough for a cron that missed a few passes, narrow enough that the first deploy of the
 * adoption releases only today's merges, not the fortnight `MERGE_FOLLOW_WINDOW_MS` still follows.
 */
export const LAND_ADOPT_MAX_AGE_HOURS = 24

/** The merge as GitHub reports it. */
export interface HandMerge {
  number: number
  /** The merge commit on the base branch (null when GitHub did not say). */
  mergeSha: string | null
  /** ISO. */
  mergedAt: string
  /** The PR's head when it merged: the landing's `gateSha` when it had none. */
  headSha: string
  url: string
}

/** Whether the cron may adopt this merge for this app: `staging` mode, merged recently. Pure. */
export function adoptable(shipSettings: unknown, mergedAt: string, now: Date): boolean {
  if (resolveAppShipSettings(shipSettings).sessionShip !== 'staging') return false
  const at = Date.parse(mergedAt)
  return Number.isFinite(at) && now.getTime() - at <= LAND_ADOPT_MAX_AGE_HOURS * 3_600_000
}

/**
 * Step 1 (see the header): the landing, `ship.merged` and `session.merged` — the row after, or
 * null when the merge is not adoptable or the row was not there to adopt (a second pass, a moving
 * landing, another status).
 */
export async function adoptHandMerge(
  db: Database,
  input: {
    tenantId: string
    sessionId: string
    appId: string
    shipSettings: unknown
    /** The row's landing as the caller read it (null, or stage `pr`). */
    landing: SessionLanding | null
    merge: HandMerge
    now: Date
  }
): Promise<SessionRow | null> {
  const { merge, now } = input
  if (!adoptable(input.shipSettings, merge.mergedAt, now)) return null
  const stamp = now.toISOString()
  const landing: SessionLanding = {
    mode: 'staging',
    stage: 'releasing',
    prNumber: merge.number,
    gateSha: input.landing?.gateSha ?? merge.headSha,
    // A hand merge's head was gated only when it is still the landing's gate SHA.
    gateTree:
      input.landing && input.landing.gateSha === merge.headSha
        ? (input.landing.gateTree ?? null)
        : null,
    startedAt: input.landing?.startedAt ?? stamp,
    stageAt: stamp,
    reviewMode: 'none',
    approvalId: null,
    mergeSha: merge.mergeSha,
    mergedAt: new Date(merge.mergedAt).toISOString(),
    mainCi: null,
    releaseId: null,
    version: null,
    tag: null,
    stagingUrl: null,
    // A shipped session's container is gone; Phase B never needs one.
    containerReleased: true,
    stalledReason: null,
    error: null,
  }
  const [row] = await db
    .update(sessions)
    .set({ landing, lastActivityAt: now })
    .where(
      and(
        eq(sessions.tenantId, input.tenantId),
        eq(sessions.id, input.sessionId),
        eq(sessions.status, 'shipped'),
        eq(sessions.prNumber, merge.number),
        sql`(${sessions.landing} IS NULL OR ${sessions.landing}->>'stage' = 'pr')`
      )
    )
    .returning()
  if (!row) return null
  const sha = merge.mergeSha ?? merge.headSha
  await createSessionEmitter(db, { id: row.id, tenantId: row.tenantId })({
    type: 'ship.merged',
    turn: row.turnCount,
    data: { number: merge.number, sha, url: merge.url, approvalId: null, by: 'github' },
  })
  await recordAudit(db, {
    ...SYSTEM_ACTOR,
    tenantId: input.tenantId,
    action: 'session.merged',
    targetType: 'session',
    targetId: row.id,
    appId: input.appId,
    summary: {
      after: {
        prNumber: merge.number,
        gateSha: landing.gateSha,
        mergeSha: merge.mergeSha,
        approvalId: null,
        by: 'github',
        adopted: true,
      },
    },
  })
  return row
}

/**
 * Step 2 (see the header): Phase B under the session's Workflow. Never throws — a start that
 * fails is left to the safety net, which restarts a quiet `releasing` landing.
 */
export async function startAdoptedLanding(
  db: Database,
  workflow: Workflow,
  row: SessionRow,
  logger: Logger
): Promise<boolean> {
  try {
    return (await wakeOrRestartLanding(db, workflow, row, logger)) !== null
  } catch (err) {
    logger.warn({ err, sessionId: row.id }, 'sessions.checks: could not start an adopted landing')
    return false
  }
}
