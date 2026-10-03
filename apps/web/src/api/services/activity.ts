/**
 * Activity log writer (D19). Every write route appends one row through `defer(() =>
 * recordActivity(...))` — fire-and-forget via `waitUntil`, so a failed write is logged, never
 * surfaced. Also called inside transactions (tenant create) where the caller passes the `tx`.
 *
 * **Audit is the one log.** Every activity event is ALSO appended to Launch's hash-chained
 * `audit_events` through `auditInsert` — the row builder `recordAudit` runs for every Launch action — with the
 * activity `type` as the audit `action` (1:1: `member.joined`, `api_key.created`), the subject as
 * the target, and the metadata as `summary.after` with secret-looking keys reduced to `set`. Both
 * rows are ONE statement (below), so they commit or roll back together. The
 * `activity_events` row stays (the kit's `/api/activity`, the analytics plugin's cubes read it).
 * Forward-only: rows recorded before this existed were never copied into the chain.
 */
import type { ActivityMetadata } from '@launch/shared/activity'
import type { AuditSummary } from '@launch/shared/launch-audit'
import { sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { activityEvents, users } from '../../db/schema'
import { auditInsert } from './launch/audit'

export interface ActivityInput {
  tenantId: string
  userId: string | null
  /** Dotted event name, e.g. `member.invited`, `api_key.created`. */
  type: string
  subjectType?: string | null
  subjectId?: string | null
  metadata?: ActivityMetadata
}

/**
 * A metadata key that could name a credential. No kit event carries one today — this is the
 * backstop for the next one (or a plugin's): the audit summary never holds a secret value.
 */
const SECRET_KEY_RE = /secret|token|password|passphrase|credential|private|api_?key$|^key$/i

/** Metadata → `summary.after`, every secret-looking value replaced by `set` (nested too). */
export function activitySummary(metadata: ActivityMetadata | undefined): AuditSummary {
  if (!metadata) return {}
  const facts = redact(metadata) as Record<string, unknown>
  return Object.keys(facts).length > 0 ? { after: facts } : {}
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      if (inner === undefined) continue
      out[key] = SECRET_KEY_RE.test(key) ? 'set' : redact(inner)
    }
    return out
  }
  return value
}

/**
 * Both rows in ONE statement — `WITH activity AS (INSERT …) INSERT INTO audit_events …` — for two
 * reasons. It is atomic without a transaction (an audit row never exists without its activity row,
 * nor the reverse). And it is one round trip issued at call time: a deferred write runs beside
 * `databaseMiddleware`'s close of the request client, which lets a query already sent finish but
 * refuses one sent after an await — so a second statement here would be silently lost.
 *
 * The audit row copies the actor's email at write time (a scalar subquery on `users`), so the log
 * never follows a rename or a delete. An activity has no request in hand, so ip / user agent /
 * request id stay null — the gap is stated in CONCEPTS.
 */
export async function recordActivity(db: Database, input: ActivityInput): Promise<void> {
  const activity = db.insert(activityEvents).values({
    tenantId: input.tenantId,
    userId: input.userId,
    type: input.type,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    metadata: input.metadata ?? {},
  })
  const audit = auditInsert(db, {
    tenantId: input.tenantId,
    actorType: input.userId ? 'user' : 'system',
    actorUserId: input.userId,
    actorEmail: input.userId
      ? sql`(SELECT ${users.email} FROM ${users} WHERE ${users.id} = ${input.userId})`
      : null,
    action: input.type,
    targetType: input.subjectType ?? null,
    targetId: input.subjectId ?? null,
    summary: activitySummary(input.metadata),
  })
  await db.execute(sql`WITH activity AS (${activity.getSQL()}) ${audit.getSQL()}`)
}
