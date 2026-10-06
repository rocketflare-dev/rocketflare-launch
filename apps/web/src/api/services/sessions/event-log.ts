/**
 * `session_events` — a coding session's append-only log (Launch P3, plan §2), read by the chat
 * routes and the AG-UI stream, written by the Workflow ALONE.
 *
 * - **One writer, so `seq` is counted, not contended.** `createSessionEventWriter` reads the last
 *   `seq` once and numbers from there; `(session_id, seq)` is unique, so a second writer that should
 *   not exist fails loudly rather than interleaving. The one exception is the boot's two parallel
 *   branches (issue #15), whose short appends renumber on a conflict (`appendSessionEvents`).
 * - **Batched for the turn** (plan §3c: every 250 ms or 20 events): Claude Code prints in bursts, and
 *   one INSERT per line would be one round trip per token of a long answer. `append` buffers,
 *   `flush` writes one multi-row INSERT; flushes are serialised, so rows land in `seq` order.
 * - Every read is tenant-first.
 */
import type { SessionEvent, SessionEventInput } from '@launch/shared/launch-sessions'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type SessionEventRow, sessionEvents } from '../../../db/schema'

/** The row as the API returns it. */
export function toSessionEvent(row: SessionEventRow): SessionEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    turn: row.turn,
    type: row.type,
    data: row.data,
    at: row.at,
  }
}

/** The highest `seq` stored for a session (0 when it has none). */
export async function lastSessionEventSeq(
  db: Database,
  tenantId: string,
  sessionId: string
): Promise<number> {
  const [row] = await db
    .select({ seq: sessionEvents.seq })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.tenantId, tenantId), eq(sessionEvents.sessionId, sessionId)))
    .orderBy(desc(sessionEvents.seq))
    .limit(1)
  return row?.seq ?? 0
}

/** Rows after `afterSeq`, oldest first, at most `limit`. The stream's one quiet-tick query. */
export async function listSessionEvents(
  db: Database,
  tenantId: string,
  sessionId: string,
  afterSeq = 0,
  limit = 500
): Promise<SessionEventRow[]> {
  return db
    .select()
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.tenantId, tenantId),
        eq(sessionEvents.sessionId, sessionId),
        gt(sessionEvents.seq, afterSeq)
      )
    )
    .orderBy(asc(sessionEvents.seq))
    .limit(limit)
}

export interface SessionEventWriter {
  /** Buffer events; they are written by the next `flush` (the caller decides when). */
  append(...events: SessionEventInput[]): void
  /** Write everything buffered, in one INSERT. Serialised: concurrent calls queue. */
  flush(): Promise<void>
  /** How many events are waiting for a flush. */
  readonly pending: number
  /** The last `seq` assigned (flushed or not). */
  readonly seq: number
}

/** A writer for one session, numbering from the last stored `seq`. */
export async function createSessionEventWriter(
  db: Database,
  session: { id: string; tenantId: string }
): Promise<SessionEventWriter> {
  let seq = await lastSessionEventSeq(db, session.tenantId, session.id)
  let buffer: (SessionEventInput & { seq: number; at: Date })[] = []
  let chain: Promise<void> = Promise.resolve()

  const write = async (): Promise<void> => {
    if (buffer.length === 0) return
    const batch = buffer
    buffer = []
    await db.insert(sessionEvents).values(
      batch.map(event => ({
        sessionId: session.id,
        tenantId: session.tenantId,
        seq: event.seq,
        turn: event.turn,
        type: event.type,
        data: event.data,
        at: event.at,
      }))
    )
  }

  return {
    append(...events) {
      for (const event of events) {
        seq += 1
        buffer.push({ ...event, seq, at: new Date() })
      }
    },
    flush() {
      // A failed flush fails ITS caller; the next one still runs.
      const next = chain.catch(() => {}).then(write)
      chain = next
      return next
    },
    get pending() {
      return buffer.length
    },
    get seq() {
      return seq
    },
  }
}

/** How many times {@link appendSessionEvents} renumbers after another append took its `seq`s. */
export const APPEND_SEQ_ATTEMPTS = 5

/** A unique violation (`23505`) on the event log's `(session_id, seq)`, through any wrapping. */
function isSeqConflict(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    const { code, cause } = e as { code?: unknown; cause?: unknown }
    if (code === '23505') return true
    e = cause
  }
  return false
}

/**
 * Append `events` in one INSERT, numbering from the stored maximum — the unbatched writer the
 * lifecycle steps and the ship use (`events.ts`'s emitter). The Workflow is the one writer, but
 * two of its BOOT steps run side by side (issue #15: `db` alongside `sandbox.start` → `repo`), so
 * two appends may read the same maximum: the one whose INSERT loses on the unique `(session_id,
 * seq)` reads it again and renumbers, up to {@link APPEND_SEQ_ATTEMPTS} times. The batched turn
 * writer never runs alongside another and keeps its single read.
 */
export async function appendSessionEvents(
  db: Database,
  session: { id: string; tenantId: string },
  events: readonly SessionEventInput[]
): Promise<void> {
  if (events.length === 0) return
  for (let attempt = 1; ; attempt++) {
    const writer = await createSessionEventWriter(db, session)
    writer.append(...events)
    try {
      await writer.flush()
      return
    } catch (err) {
      if (attempt >= APPEND_SEQ_ATTEMPTS || !isSeqConflict(err)) throw err
    }
  }
}
