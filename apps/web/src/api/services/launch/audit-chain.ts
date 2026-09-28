/**
 * The audit hash chain (Launch P4, spec/08 "Integrity options", plan §1.12 and §4e).
 *
 * - `canonicalAuditJson(event)`: the one serialisation a seal and a verify hash (below).
 * - `sealTenant`: under a per-tenant `pg_advisory_xact_lock`, append `audit_chain` rows for the
 *   next ≤ 1 000 unsealed events in `(at, id)` order — `hash = sha256(prev_hash ‖ canonical)`.
 * - `verifyChain`: recompute every sealed row in `seq` order; `auditVerifySchema`.
 * - `auditSeal`: the `audit.seal` task on the five-minute cron (registered in `api/scheduled.ts`).
 *
 * ## The canonical form (version 1) — what an external verifier re-derives
 *
 * `canonicalAuditJson` is compact JSON (no whitespace) of an object with EXACTLY these fifteen
 * keys, in this order (the lexicographic order of their names):
 *
 *   action, actorEmail, actorType, actorUserId, appId, approvalId, at, id, ip, requestId,
 *   summary, targetId, targetType, tenantId, userAgent
 *
 * - **Nulls are kept**: a column without a value is `"key":null`, never omitted.
 * - **`at`** is ISO 8601 in UTC with exactly three fractional digits, `2026-09-28T10:00:00.123Z`
 *   (JavaScript's `Date.prototype.toISOString`). Postgres stores microseconds; the chain covers
 *   the millisecond, the precision every driver reads and every export carries.
 * - **`summary`** (the jsonb) is written with its object keys sorted recursively, in UTF-16
 *   code-unit order (`Array.prototype.sort`; the same as code-point order for any key outside the
 *   astral planes), arrays kept in order, and a key whose value is `undefined` dropped.
 * - **Scalars** are ECMAScript `JSON.stringify`: strings escaped as it escapes them (`"`, `\`,
 *   control characters as `\uXXXX` or `\n`-style short forms; a lone surrogate as `\udXXX`),
 *   numbers in its shortest round-trip form. Everything else in an event is a string or null.
 * - The key list is FIXED: a column added to `audit_events` later is not hashed until a version 2
 *   says so, so an old row's hash never changes under it.
 *
 * `hash = lower-case hex SHA-256 of the UTF-8 bytes of (prev_hash + canonical)`, where `prev_hash`
 * is the previous row's `hash` as hex text and the empty string for `seq = 1`. `seq` runs 1, 2, 3 …
 * per tenant with no gap. `scripts/verify-audit-export.mjs` is a dependency-free verifier of a
 * JSON Lines export built from this paragraph alone.
 *
 * ## What the chain does and does not prove
 *
 * Editing or deleting a sealed event (possible only for someone who can disable the append-only
 * trigger), or editing, reordering or deleting a chain row, breaks the chain at that `seq` — a
 * deleted event takes its chain row with it (the FK cascades), which leaves a gap. It does NOT
 * catch (a) the loss of the newest sealed rows, or (b) someone rewriting the event AND re-sealing
 * everything after it: both leave a consistent chain. An export is the anchor for those — keep one
 * and later check that its last `seq` still carries the same `hash`. Events newer than the last
 * seal are not covered at all until the next five-minute run (plan §1.12: a sealer rather than a
 * trigger, so audit inserts never queue behind one lock).
 *
 * Cross-tenant by design, like every cron (allow-listed in `unscoped-allowlist.test.ts`):
 * `hasUnsealedEvents` and `tenantsWithUnsealedEvents` look across every tenant before the
 * per-tenant loop, and every write after it names the tenant it seals. Keep them (or the
 * allow-list entry goes stale and its test fails).
 */
import type { AuditEvent, AuditVerify } from '@launch/shared/launch-audit'
import { and, asc, count, desc, eq, gt, inArray, isNull, max, notExists, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type AuditEventRow, auditChain, auditEvents } from '../../../db/schema'
import type { ScheduledTask } from '../../scheduled'
import { toAuditEvent } from './audit'

/** Events sealed per tenant per batch. */
export const AUDIT_SEAL_BATCH = 1000

/** Batches one tenant may seal in one cron run; the rest waits five minutes (logged). */
export const AUDIT_SEAL_MAX_BATCHES = 20

/** Chain rows verified per round trip. */
const VERIFY_PAGE = 1000

/**
 * The first key of `pg_advisory_xact_lock(int4, int4)` — "AUDT" — so the per-tenant seal lock
 * cannot collide with another feature's lock that hashes the same tenant id.
 */
const AUDIT_SEAL_LOCK = 0x41554454

/**
 * How far before the last sealed event an unsealed one is still looked for. `at` is the inserting
 * transaction's start, so a slow transaction can commit an event dated before one already sealed;
 * a day is far longer than any Worker transaction, and bounds the anti-join so a large log is not
 * re-read from its start every five minutes. A row outside it would stay unsealed — and
 * `verifyChain` counts every unsealed row, so it could not go unnoticed.
 */
const SEAL_LOOKBACK_MS = 24 * 60 * 60 * 1000

/** The fifteen hashed fields, sorted. Fixed: see "The canonical form" in the header. */
export const CANONICAL_AUDIT_FIELDS = [
  'action',
  'actorEmail',
  'actorType',
  'actorUserId',
  'appId',
  'approvalId',
  'at',
  'id',
  'ip',
  'requestId',
  'summary',
  'targetId',
  'targetType',
  'tenantId',
  'userAgent',
] as const satisfies readonly (keyof AuditEvent)[]

/** What canonicalisation reads: an event as stored, or as exported (`at` an ISO string). */
export type CanonicalAuditInput = Omit<AuditEvent, 'at'> & { at: Date | string }

/** Compact JSON with object keys sorted recursively and `undefined` members dropped. */
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const members = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value)
}

/** `at` → `YYYY-MM-DDTHH:mm:ss.sssZ`. An unparseable value is a bug upstream, not a hash input. */
function canonicalAt(at: Date | string): string {
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) throw new TypeError(`audit event has an invalid at: ${at}`)
  return date.toISOString()
}

/** The canonical serialisation of one event (version 1 — the header documents it). */
export function canonicalAuditJson(event: CanonicalAuditInput): string {
  const members = CANONICAL_AUDIT_FIELDS.map(field => {
    const value = field === 'at' ? canonicalAt(event.at) : (event[field] ?? null)
    return `${JSON.stringify(field)}:${stableJson(value)}`
  })
  return `{${members.join(',')}}`
}

/** Lower-case hex SHA-256 of `prevHash + canonicalAuditJson(event)`, UTF-8. */
export async function chainHash(prevHash: string, event: CanonicalAuditInput): Promise<string> {
  const bytes = new TextEncoder().encode(prevHash + canonicalAuditJson(event))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
}

/** Is there any audit event, in any tenant, not yet in the chain? The seal's cheap first look. */
export async function hasUnsealedEvents(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .leftJoin(auditChain, eq(auditChain.auditEventId, auditEvents.id))
    .where(isNull(auditChain.auditEventId))
    .limit(1)
  return Boolean(row)
}

/**
 * Every tenant with at least one unsealed event — the cron's work list. `only` narrows it to
 * those tenants (a test seals its own and never another file's).
 */
export async function tenantsWithUnsealedEvents(
  db: Database,
  only?: readonly string[]
): Promise<string[]> {
  if (only && only.length === 0) return []
  const found = await db
    .selectDistinct({ id: auditEvents.tenantId })
    .from(auditEvents)
    .leftJoin(auditChain, eq(auditChain.auditEventId, auditEvents.id))
    .where(
      and(
        isNull(auditChain.auditEventId),
        only ? inArray(auditEvents.tenantId, [...only]) : undefined
      )
    )
  return found.map(r => r.id)
}

/** A tenant's last chain row and the `at` of the event it seals, or null before the first seal. */
async function chainHead(db: Database, tenantId: string) {
  const [head] = await db
    .select({ seq: auditChain.seq, hash: auditChain.hash, at: auditEvents.at })
    .from(auditChain)
    .innerJoin(auditEvents, eq(auditEvents.id, auditChain.auditEventId))
    .where(eq(auditChain.tenantId, tenantId))
    .orderBy(desc(auditChain.seq))
    .limit(1)
  return head ?? null
}

/**
 * Seal the next ≤ `batch` unsealed events of one tenant, in one transaction under the tenant's
 * advisory lock: a second seal of the same tenant waits, then reads the head the first one wrote
 * (READ COMMITTED takes a fresh snapshot per statement), so it neither forks the chain nor seals an
 * event twice. `(tenant_id, seq)` and the unique `audit_event_id` are the backstop if a caller
 * ever skips the lock. Returns what it sealed and the chain's last `seq` afterwards.
 */
export async function sealTenant(
  db: Database,
  tenantId: string,
  opts: { batch?: number } = {}
): Promise<{ sealed: number; through: number | null }> {
  const batch = opts.batch ?? AUDIT_SEAL_BATCH
  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${AUDIT_SEAL_LOCK}::int4, hashtext(${tenantId}::text))`
    )
    const head = await chainHead(tx, tenantId)
    const unsealed = await tx
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          head ? gt(auditEvents.at, new Date(head.at.getTime() - SEAL_LOOKBACK_MS)) : undefined,
          notExists(
            tx
              .select({ one: sql`1` })
              .from(auditChain)
              .where(eq(auditChain.auditEventId, auditEvents.id))
          )
        )
      )
      .orderBy(asc(auditEvents.at), asc(auditEvents.id))
      .limit(batch)
    if (unsealed.length === 0) return { sealed: 0, through: head?.seq ?? null }

    let seq = head?.seq ?? 0
    let prevHash = head?.hash ?? ''
    const links: (typeof auditChain.$inferInsert)[] = []
    for (const row of unsealed) {
      seq += 1
      const hash = await chainHash(prevHash, toAuditEvent(row))
      links.push({ tenantId, seq, auditEventId: row.id, prevHash, hash })
      prevHash = hash
    }
    await tx.insert(auditChain).values(links)
    return { sealed: links.length, through: seq }
  })
}

/** How many of a tenant's events are not in the chain yet. */
async function countUnsealed(db: Database, tenantId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(auditEvents)
    .leftJoin(auditChain, eq(auditChain.auditEventId, auditEvents.id))
    .where(and(eq(auditEvents.tenantId, tenantId), isNull(auditChain.auditEventId)))
  return Number(row?.n ?? 0)
}

/**
 * Recompute a tenant's chain from `seq = 1`, a page at a time, and stop at the first row that does
 * not follow: a `seq` gap, a `prev_hash` that is not the previous row's `hash`, or a `hash` that is
 * not `sha256(prev_hash ‖ canonical)` of the event as it reads now. `checked` counts the rows
 * examined, the broken one included.
 */
export async function verifyChain(db: Database, tenantId: string): Promise<AuditVerify> {
  let expectedSeq = 1
  let prevHash = ''
  let checked = 0
  let broken: { seq: number; eventId: string } | null = null

  pages: while (true) {
    const page: { seq: number; prevHash: string; hash: string; event: AuditEventRow }[] = await db
      .select({
        seq: auditChain.seq,
        prevHash: auditChain.prevHash,
        hash: auditChain.hash,
        event: auditEvents,
      })
      .from(auditChain)
      .innerJoin(auditEvents, eq(auditEvents.id, auditChain.auditEventId))
      .where(and(eq(auditChain.tenantId, tenantId), gt(auditChain.seq, expectedSeq - 1)))
      .orderBy(asc(auditChain.seq))
      .limit(VERIFY_PAGE)
    for (const link of page) {
      checked += 1
      const follows =
        link.seq === expectedSeq &&
        link.prevHash === prevHash &&
        link.hash === (await chainHash(prevHash, toAuditEvent(link.event)))
      if (!follows) {
        broken = { seq: link.seq, eventId: link.event.id }
        break pages
      }
      prevHash = link.hash
      expectedSeq += 1
    }
    if (page.length < VERIFY_PAGE) break
  }

  const [last] = await db
    .select({ seq: max(auditChain.seq) })
    .from(auditChain)
    .where(eq(auditChain.tenantId, tenantId))
  const sealedThrough = last?.seq === null || last?.seq === undefined ? null : Number(last.seq)
  return {
    ok: broken === null,
    checked,
    sealedThrough,
    unsealed: await countUnsealed(db, tenantId),
    firstBrokenSeq: broken?.seq ?? null,
    firstBrokenEventId: broken?.eventId ?? null,
    verifiedAt: new Date(),
  }
}

/**
 * The `audit.seal` task: one cheap look across every tenant, then each tenant with unsealed events
 * sealed batch by batch (at most `AUDIT_SEAL_MAX_BATCHES` a run). One tenant's failure — a tenant
 * deleted mid-seal, say — is logged and the loop moves on.
 */
export async function runAuditSeal(
  db: Database,
  logger: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
  opts: AuditSealOptions = {}
): Promise<{ tenants: number; sealed: number; failed: number }> {
  const result = { tenants: 0, sealed: 0, failed: 0 }
  if (!(await hasUnsealedEvents(db))) return result
  for (const tenantId of await tenantsWithUnsealedEvents(db, opts.tenantIds)) {
    result.tenants += 1
    try {
      for (let i = 0; i < AUDIT_SEAL_MAX_BATCHES; i++) {
        const { sealed } = await sealTenant(db, tenantId)
        result.sealed += sealed
        if (sealed < AUDIT_SEAL_BATCH) break
        if (i === AUDIT_SEAL_MAX_BATCHES - 1) {
          logger.warn(
            { tenantId },
            'audit.seal: batch cap reached; the rest waits for the next run'
          )
        }
      }
    } catch (err) {
      result.failed += 1
      logger.warn({ err, tenantId }, 'audit.seal: sealing this tenant failed')
    }
  }
  return result
}

export interface AuditSealOptions {
  /**
   * Seal only these tenants. The cron passes nothing (every tenant); a test passes its own, so a
   * seal in one test file never seals — and so never changes — another file's rows (the suite
   * shares one database, `.claude/rules/testing.md`).
   */
  tenantIds?: readonly string[]
}

/** The `audit.seal` task over the given options (the `healthPollTask` pattern). */
export function auditSealTask(opts: AuditSealOptions = {}): ScheduledTask {
  return {
    name: 'audit.seal',
    async run({ db, logger }) {
      const result = await runAuditSeal(db, logger, opts)
      if (result.tenants > 0) logger.info(result, 'audit.seal: sealed new audit events')
    },
  }
}

/** Registered on `*` + `/5` in `api/scheduled.ts`: every tenant. */
export const auditSeal: ScheduledTask = auditSealTask()
