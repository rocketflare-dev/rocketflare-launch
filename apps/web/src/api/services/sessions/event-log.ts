/**
 * `session_events` — a coding session's append-only log (Launch P3, plan §2), read by the chat
 * routes and the AG-UI stream, written by the Workflow ALONE.
 *
 * - **One writer, so `seq` is counted, not contended.** `createSessionEventWriter` reads the last
 *   `seq` once and numbers from there; `(session_id, seq)` is unique, so a second writer that should
 *   not exist fails loudly rather than interleaving.
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

/**
 * Append `events` in one INSERT, numbering from the stored maximum — the unbatched writer the
 * lifecycle steps and the ship use (`events.ts`'s emitter). The Workflow is the one writer, so the
 * read-then-insert cannot interleave with another.
 */
export async function appendSessionEvents(
  db: Database,
  session: { id: string; tenantId: string },
  events: readonly SessionEventInput[]
): Promise<void> {
  if (events.length === 0) return
  const writer = await createSessionEventWriter(db, session)
  writer.append(...events)
  await writer.flush()
}
