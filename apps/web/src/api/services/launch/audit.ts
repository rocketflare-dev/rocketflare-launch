/**
 * Launch's audit log writer and reader (spec/08). Not `recordActivity`: that one is
 * fire-and-forget through `defer`, and a failed write is logged and forgotten. **`recordAudit` is
 * awaited** — an action Launch cannot record is an action it should not report as done — and the
 * table it writes is append-only by the database (a trigger, plus the revoked grants).
 *
 * Every console action records its actor through `auditActor(c)`; a cron or a pipeline step
 * passes `SYSTEM_ACTOR`. `summary` holds the facts that changed and **never a secret value** —
 * write `{ after: { token: 'set' } }`, never the token.
 *
 * `listAudit` pages by cursor: `(at, id)` strictly below the cursor row's, compared in the
 * database so the timestamp keeps its full microsecond precision.
 */
import type {
  AuditActorType,
  AuditEvent,
  AuditListResponse,
  AuditSummary,
} from '@launch/shared/launch-audit'
import { and, desc, eq, or, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type AuditEventRow, auditEvents } from '../../../db/schema'
import { clientIpOf } from '../../routes/auth/helpers'
import type { AppContext } from '../../types'
import { BadRequestError } from '../../utils/core/errors'

/** Who did it, and from where. Spread into `recordAudit`'s input. */
export interface AuditActor {
  actorType: AuditActorType
  actorUserId: string | null
  actorEmail: string | null
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

/** Launch itself — a cron, a pipeline step, the health poller. */
export const SYSTEM_ACTOR: Readonly<AuditActor> = Object.freeze({
  actorType: 'system',
  actorUserId: null,
  actorEmail: null,
  ip: null,
  userAgent: null,
  requestId: null,
})

export interface AuditInput extends Partial<AuditActor> {
  tenantId: string
  /** Dotted: `app.imported`, `oidc.signin`, `credential.rotated`. */
  action: string
  targetType?: string | null
  targetId?: string | null
  appId?: string | null
  summary?: AuditSummary
  approvalId?: string | null
}

/** A user agent is attacker-supplied text; keep what identifies a browser and drop the rest. */
const USER_AGENT_MAX = 512

/**
 * The actor of the request in `c`: the signed-in user (or `user`, for a path that resolved the
 * person itself — the OIDC authorize endpoint reads the cookie without `authMiddleware`), the
 * client IP (`cf-connecting-ip`), the user agent and the request id. No user → `system`.
 */
export function auditActor(c: AppContext, user?: { id: string; email: string } | null): AuditActor {
  const who = user ?? c.get('auth')?.user ?? null
  return {
    actorType: who ? 'user' : 'system',
    actorUserId: who?.id ?? null,
    actorEmail: who?.email ?? null,
    ip: clientIpOf(c),
    userAgent: c.req.header('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
    requestId: c.get('requestId') ?? null,
  }
}

/** Append one row. Awaited — see the header. Pass the transaction's `tx` to write atomically. */
export async function recordAudit(db: Database, input: AuditInput): Promise<AuditEventRow> {
  const [row] = await db
    .insert(auditEvents)
    .values({
      tenantId: input.tenantId,
      actorType: input.actorType ?? 'system',
      actorUserId: input.actorUserId ?? null,
      actorEmail: input.actorEmail ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      appId: input.appId ?? null,
      summary: input.summary ?? {},
      requestId: input.requestId ?? null,
      approvalId: input.approvalId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning()
  if (!row) throw new Error('audit_events insert returned no row')
  return row
}

export interface AuditFilters {
  appId?: string
  /** The action itself or anything beneath it: `oidc` matches `oidc.signin`. */
  action?: string
  limit?: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Serialise one row for the wire (`auditEventSchema`). */
export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return { ...row, summary: row.summary ?? {} }
}

/**
 * One page of a tenant's log, newest first. `cursor` is the previous page's `nextCursor` (the id
 * of its last row); one that is not ours simply matches nothing.
 */
export async function listAudit(
  db: Database,
  tenantId: string,
  filters: AuditFilters = {},
  cursor?: string | null
): Promise<AuditListResponse> {
  if (cursor && !UUID_RE.test(cursor)) {
    throw new BadRequestError('Invalid cursor', 'invalid_cursor')
  }
  const limit = filters.limit ?? 50
  const where = and(
    eq(auditEvents.tenantId, tenantId),
    filters.appId ? eq(auditEvents.appId, filters.appId) : undefined,
    filters.action
      ? or(
          eq(auditEvents.action, filters.action),
          sql`starts_with(${auditEvents.action}, ${`${filters.action}.`})`
        )
      : undefined,
    cursor
      ? sql`(${auditEvents.at}, ${auditEvents.id}) < (
          SELECT c.at, c.id FROM audit_events c WHERE c.tenant_id = ${tenantId} AND c.id = ${cursor}
        )`
      : undefined
  )
  const rows = await db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(toAuditEvent),
    nextCursor: rows.length > limit && last ? last.id : null,
  }
}
