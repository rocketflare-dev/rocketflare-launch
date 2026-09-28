/**
 * The audit log export (Launch P4, plan §4e): a tenant's events with their place in the hash
 * chain, a page at a time, for `GET /api/audit/export` to stream as JSON Lines or CSV.
 *
 * **Order**: the sealed events first, in `seq` order — so an unfiltered export is exactly the
 * chain an external verifier walks (`scripts/verify-audit-export.mjs`) — then the unsealed ones in
 * `(at, id)` order with `seq` and `hash` null. The last `seq` is read once at the start; an event
 * sealed while the export runs appears in the second part as unsealed, so no row is skipped or
 * repeated however the seal and the export interleave.
 *
 * **Filters** (`auditExportQuerySchema`): `appId`; `action`, the action or anything beneath it, as
 * `GET /api/audit` reads it; `from`/`to`, the half-open range `from ≤ at < to`. A filtered export
 * is still one row per event with its own `seq`/`hash`, but it is not a whole chain.
 *
 * **Formats**:
 * - JSON Lines: one `auditExportRowSchema` object per line, keys in `EXPORT_COLUMNS` order, `at`
 *   as ISO 8601. This is the verifiable format.
 * - CSV (RFC 4180, `\r\n` line ends): a header of `EXPORT_COLUMNS`, null as an empty cell,
 *   `summary` as its sorted-key JSON. A cell a spreadsheet would run as a formula (`= + - @`, tab,
 *   carriage return first) is prefixed with `'` — actor emails and user agents are typed by
 *   whoever signed in — so the CSV is for people to read, and JSON Lines for machines to verify.
 */
import type { AuditExportQuery, AuditExportRow } from '@launch/shared/launch-audit'
import { and, asc, eq, gt, gte, lt, lte, max, notExists, or, type SQL, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { auditChain, auditEvents } from '../../../db/schema'
import { toAuditEvent } from './audit'
import { stableJson } from './audit-chain'

/** Rows read per round trip — and so per chunk of the stream. */
export const AUDIT_EXPORT_PAGE = 500

/** The column order of both formats. */
export const EXPORT_COLUMNS = [
  'seq',
  'hash',
  'id',
  'tenantId',
  'at',
  'actorType',
  'actorUserId',
  'actorEmail',
  'action',
  'targetType',
  'targetId',
  'appId',
  'summary',
  'requestId',
  'approvalId',
  'ip',
  'userAgent',
] as const satisfies readonly (keyof AuditExportRow)[]

export type AuditExportFilters = Omit<AuditExportQuery, 'format'>

/** `audit_events` predicates for the filters, always under the tenant. */
function eventFilters(tenantId: string, filters: AuditExportFilters): SQL | undefined {
  return and(
    eq(auditEvents.tenantId, tenantId),
    filters.appId ? eq(auditEvents.appId, filters.appId) : undefined,
    filters.action
      ? or(
          eq(auditEvents.action, filters.action),
          sql`starts_with(${auditEvents.action}, ${`${filters.action}.`})`
        )
      : undefined,
    filters.from ? gte(auditEvents.at, filters.from) : undefined,
    filters.to ? lt(auditEvents.at, filters.to) : undefined
  )
}

/**
 * The tenant's export rows, one page per iteration (see the header for the order). A consumer may
 * stop early (`return()`); nothing is held open between pages.
 */
export async function* auditExportPages(
  db: Database,
  tenantId: string,
  filters: AuditExportFilters = {},
  pageSize = AUDIT_EXPORT_PAGE
): AsyncGenerator<AuditExportRow[]> {
  const [head] = await db
    .select({ seq: max(auditChain.seq) })
    .from(auditChain)
    .where(eq(auditChain.tenantId, tenantId))
  const through = head?.seq === null || head?.seq === undefined ? 0 : Number(head.seq)

  // 1. Sealed, by seq.
  let afterSeq = 0
  while (afterSeq < through) {
    const page = await db
      .select({ seq: auditChain.seq, hash: auditChain.hash, event: auditEvents })
      .from(auditChain)
      .innerJoin(auditEvents, eq(auditEvents.id, auditChain.auditEventId))
      .where(
        and(
          eq(auditChain.tenantId, tenantId),
          gt(auditChain.seq, afterSeq),
          lte(auditChain.seq, through),
          eventFilters(tenantId, filters)
        )
      )
      .orderBy(asc(auditChain.seq))
      .limit(pageSize)
    if (page.length > 0) {
      yield page.map(r => ({ seq: Number(r.seq), hash: r.hash, ...toAuditEvent(r.event) }))
    }
    const last = page.at(-1)
    if (!last || page.length < pageSize) break
    afterSeq = Number(last.seq)
  }

  // 2. Not sealed as of the start, by (at, id). The keyset compares in the database, against the
  // last row's own `(at, id)`: a JS Date would drop `at`'s microseconds and repeat rows.
  let afterId: string | null = null
  while (true) {
    const page = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eventFilters(tenantId, filters),
          notExists(
            db
              .select({ one: sql`1` })
              .from(auditChain)
              .where(
                and(
                  eq(auditChain.tenantId, tenantId),
                  eq(auditChain.auditEventId, auditEvents.id),
                  lte(auditChain.seq, through)
                )
              )
          ),
          afterId
            ? sql`(${auditEvents.at}, ${auditEvents.id}) > (
                SELECT c.at, c.id FROM audit_events c WHERE c.tenant_id = ${tenantId} AND c.id = ${afterId}
              )`
            : undefined
        )
      )
      .orderBy(asc(auditEvents.at), asc(auditEvents.id))
      .limit(pageSize)
    if (page.length > 0) {
      yield page.map(r => ({ seq: null, hash: null, ...toAuditEvent(r) }))
    }
    const last = page.at(-1)
    if (!last || page.length < pageSize) break
    afterId = last.id
  }
}

/** Keys in `EXPORT_COLUMNS` order, so the bytes of a line never depend on how a row was built. */
function ordered(row: AuditExportRow): Record<string, unknown> {
  return Object.fromEntries(EXPORT_COLUMNS.map(column => [column, row[column]]))
}

/** One JSON Lines line, `\n`-terminated. */
export function toJsonLine(row: AuditExportRow): string {
  return `${JSON.stringify(ordered(row))}\n`
}

/** The CSV header line. */
export const CSV_HEADER = `${EXPORT_COLUMNS.join(',')}\r\n`

const FORMULA_START = /^[=+\-@\t\r]/
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text: string
  if (value instanceof Date) text = value.toISOString()
  else if (typeof value === 'object') text = stableJson(value)
  else text = String(value)
  if (FORMULA_START.test(text)) text = `'${text}`
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** One CSV record, `\r\n`-terminated. */
export function toCsvLine(row: AuditExportRow): string {
  return `${EXPORT_COLUMNS.map(column => csvCell(row[column])).join(',')}\r\n`
}
