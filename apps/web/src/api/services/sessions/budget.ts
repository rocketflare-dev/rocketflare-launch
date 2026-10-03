/**
 * Session budgets (Launch P3, plan §1.11). Two caps, both in microcents:
 *
 * - **Per session**: `policy.maxSessionUsd` (frozen on the row at create) plus every extension
 *   (`budget_extra_microcents`), against the row's running `cost_microcents` — which the model proxy
 *   raises atomically on every metered call, so reading it is free.
 * - **Per app per calendar month (UTC)**: `apps.session_monthly_budget_microcents`, else the
 *   policy's `appMonthlyUsd`, against the `ai_usage` rows of the app's sessions this month (the
 *   ledger, not the session totals — a session that started last month has spent in both).
 *
 * Checked in three places, each with its own consequence:
 *
 * 1. at create (slice 3b's `createSession`) — 409 `session_budget_exhausted`;
 * 2. before each turn (`turn.ts`) — the session goes `blocked`, with a `budget.reached` event and the
 *    audit `session.budget.reached`;
 * 3. on every model call (`egress/anthropic.ts`) — an Anthropic-shaped 403, no upstream call.
 *
 * `spent >= cap` is over: a session at exactly its cap may not start another call.
 *
 * `extendBudget` is the way out of `blocked`: it adds `extraUsd`, audited `session.budget.extended`;
 * a blocked session that is now under both caps goes back to `ready` (a compare-and-set, so a
 * racing turn cannot be undone). From P4 it runs only as the effect of an approved
 * `session.budget` request (`services/approvals/kinds/session-budget.ts`, inside the decide
 * transaction); `POST /api/sessions/:id/budget` opens that request (`budget-request.ts`).
 */
import {
  resolveSessionPolicy,
  type SessionBudget,
  usdToMicrocents,
} from '@launch/shared/launch-sessions'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { aiUsage, apps, type SessionRow, sessions } from '../../../db/schema'
import { NotFoundError } from '../../utils/core/errors'
import { type AuditActor, recordAudit } from '../launch/audit'

type BudgetRow = Pick<SessionRow, 'costMicrocents' | 'budgetExtraMicrocents' | 'policy'>

/** What the session has spent and may spend (`sessionBudgetSchema`). Pure over the row. */
export function sessionSpend(row: BudgetRow): SessionBudget {
  const policy = resolveSessionPolicy(row.policy)
  const extra = Number(row.budgetExtraMicrocents ?? 0)
  return {
    spentMicrocents: Number(row.costMicrocents ?? 0),
    capMicrocents: usdToMicrocents(policy.maxSessionUsd) + extra,
    extraMicrocents: extra,
  }
}

/** The first instant of `now`'s calendar month, UTC. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

export interface AppMonthSpend {
  spentMicrocents: number
  capMicrocents: number
}

/** What the app's sessions have spent this calendar month, and its monthly cap. */
export async function appMonthSpend(
  db: Database,
  session: Pick<SessionRow, 'tenantId' | 'appId' | 'policy'>,
  now: Date = new Date()
): Promise<AppMonthSpend> {
  const [spent, [app]] = await Promise.all([
    db
      .select({ total: sql<string | number | null>`coalesce(sum(${aiUsage.costMicrocents}), 0)` })
      .from(aiUsage)
      .innerJoin(
        sessions,
        and(eq(sessions.id, aiUsage.sessionId), eq(sessions.tenantId, session.tenantId))
      )
      .where(
        and(
          eq(aiUsage.tenantId, session.tenantId),
          eq(sessions.appId, session.appId),
          gte(aiUsage.at, monthStartUtc(now))
        )
      ),
    db
      .select({ cap: apps.sessionMonthlyBudgetMicrocents })
      .from(apps)
      .where(and(eq(apps.tenantId, session.tenantId), eq(apps.id, session.appId)))
      .limit(1),
  ])
  const policy = resolveSessionPolicy(session.policy)
  return {
    spentMicrocents: Number(spent[0]?.total ?? 0),
    capMicrocents:
      app?.cap !== null && app?.cap !== undefined
        ? Number(app.cap)
        : usdToMicrocents(policy.appMonthlyUsd),
  }
}

export type BudgetVerdict =
  | { ok: true }
  | {
      ok: false
      scope: 'session' | 'app_month'
      spentMicrocents: number
      capMicrocents: number
    }

/**
 * Is the session under both caps? The session cap is checked first (it needs no query). A session
 * on a personal account (§18.22, `credential_source = 'user'`) has no money budget — Launch does
 * not pay for it; its turn and time limits still hold.
 */
export async function checkBudget(
  db: Database,
  session: Pick<
    SessionRow,
    'tenantId' | 'appId' | 'policy' | 'costMicrocents' | 'budgetExtraMicrocents'
  > &
    Partial<Pick<SessionRow, 'credentialSource'>>,
  now: Date = new Date()
): Promise<BudgetVerdict> {
  if (session.credentialSource === 'user') return { ok: true }
  const own = sessionSpend(session)
  if (own.spentMicrocents >= own.capMicrocents) {
    return {
      ok: false,
      scope: 'session',
      spentMicrocents: own.spentMicrocents,
      capMicrocents: own.capMicrocents,
    }
  }
  const month = await appMonthSpend(db, session, now)
  if (month.spentMicrocents >= month.capMicrocents) {
    return { ok: false, scope: 'app_month', ...month }
  }
  return { ok: true }
}

/** What a turn may still spend, and which cap it would reach first. */
export interface BudgetHeadroom {
  /** Microcents left under the nearer cap (≤ 0: nothing left). */
  microcents: number
  scope: 'session' | 'app_month'
  spentMicrocents: number
  capMicrocents: number
}

/**
 * The spend left before the session's cap or the app's month cap, whichever is nearer — what a
 * `host`-mode turn (`turn-meter.ts`) may run up before it is stopped, since no proxy checks each
 * of its requests. Read once at the start of the turn: the turn's own cost is not in the ledger
 * until it ends.
 */
export async function budgetHeadroom(
  db: Database,
  session: Pick<
    SessionRow,
    'tenantId' | 'appId' | 'policy' | 'costMicrocents' | 'budgetExtraMicrocents'
  >,
  now: Date = new Date()
): Promise<BudgetHeadroom> {
  const own = sessionSpend(session)
  const month = await appMonthSpend(db, session, now)
  const ownLeft = own.capMicrocents - own.spentMicrocents
  const monthLeft = month.capMicrocents - month.spentMicrocents
  return ownLeft <= monthLeft
    ? {
        microcents: ownLeft,
        scope: 'session',
        spentMicrocents: own.spentMicrocents,
        capMicrocents: own.capMicrocents,
      }
    : {
        microcents: monthLeft,
        scope: 'app_month',
        spentMicrocents: month.spentMicrocents,
        capMicrocents: month.capMicrocents,
      }
}

export interface ExtendBudgetInput {
  tenantId: string
  sessionId: string
  extraUsd: number
  actor: AuditActor
  /** The `session.budget` approval this extension is the effect of (on the audit row). */
  approvalId?: string | null
  now?: Date
}

export interface ExtendBudgetResult {
  session: SessionRow
  /** The session was `blocked` and is now `ready` again — wake the Workflow for its message. */
  unblocked: boolean
}

/**
 * Raise the session's cap by `extraUsd` (atomically — two extensions at once both count), audit
 * `session.budget.extended`, and move a `blocked` session back to `ready` when it is now under both
 * caps. Authorisation is the approval's: call it only from an approved `session.budget` request.
 */
export async function extendBudget(
  db: Database,
  input: ExtendBudgetInput
): Promise<ExtendBudgetResult> {
  const extra = usdToMicrocents(input.extraUsd)
  const [raised] = await db
    .update(sessions)
    .set({
      budgetExtraMicrocents: sql`${sessions.budgetExtraMicrocents} + ${extra}`,
      updatedAt: input.now ?? new Date(),
    })
    .where(and(eq(sessions.tenantId, input.tenantId), eq(sessions.id, input.sessionId)))
    .returning()
  if (!raised) throw new NotFoundError('Session not found', 'session_not_found')

  await recordAudit(db, {
    ...input.actor,
    tenantId: input.tenantId,
    action: 'session.budget.extended',
    targetType: 'session',
    targetId: raised.id,
    appId: raised.appId,
    approvalId: input.approvalId ?? null,
    summary: {
      before: { budgetExtraMicrocents: Number(raised.budgetExtraMicrocents) - extra },
      after: {
        budgetExtraMicrocents: Number(raised.budgetExtraMicrocents),
        extraUsd: input.extraUsd,
        capMicrocents: sessionSpend(raised).capMicrocents,
      },
    },
  })

  if (raised.status !== 'blocked') return { session: raised, unblocked: false }
  const verdict = await checkBudget(db, raised, input.now)
  if (!verdict.ok) return { session: raised, unblocked: false }
  const [ready] = await db
    .update(sessions)
    .set({ status: 'ready', updatedAt: input.now ?? new Date() })
    .where(
      and(
        eq(sessions.tenantId, input.tenantId),
        eq(sessions.id, input.sessionId),
        eq(sessions.status, 'blocked')
      )
    )
    .returning()
  return ready ? { session: ready, unblocked: true } : { session: raised, unblocked: false }
}
