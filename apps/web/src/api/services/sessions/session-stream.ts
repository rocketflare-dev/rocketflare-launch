/**
 * `GET /api/sessions/:id/agui/stream` — a coding session's chat, live (Launch P3, slice 3c).
 *
 * A **polling** read-stream, a copy of `services/agents/run-stream.ts` over `session_events`: one
 * open connection tails the log from a `seq` cursor, projects each new row
 * (`agui-projection.ts`) and frames it as spec AG-UI. It re-reads the session's STATUS each tick,
 * because a session that shipped, ended or failed writes nothing more, and waiting for a row that
 * will never come is waiting for ever. The cadence (`runStreamTickMs`) and the caps
 * (`RUN_STREAM_*`) are the run stream's own.
 *
 * The same four rules, each a bug if broken:
 *
 * 1. **`id:` goes on the LAST frame of a row's group, and on no other frame in it.** A `text` row
 *    is `START → CONTENT → END`; a cursor on the first frame leaves a dropped connection's client
 *    holding a message that never closes. Replaying a group is free: its ids derive from the row.
 * 2. **No `RUN_ERROR` for the stream's own failure.** The session is a durable Workflow in another
 *    isolate; this stream owns nothing. It logs and closes, and closing with no terminal event means
 *    "reconnect" — for a redeploy, an idle cap, a duration cap, a transport error and an abort alike.
 *    (`RUN_ERROR` here means the SESSION failed — read from its row, never from this loop.)
 * 3. **Nothing that costs a subrequest inside the loop.** Two indexed queries per tick on the
 *    stream's own client; no Workflow or Durable Object is touched.
 * 4. **Protobuf has no cursor and no comments**: a binary client resumes by `?afterSeq=` only, and
 *    no `: ping` frame is ever written into a binary stream.
 *
 * `?afterSeq=` beats `Last-Event-ID` (the route's `resolveStreamCursor`): the kit's own client is
 * explicit, and a stale browser value must never override it.
 */
import {
  RUN_STREAM_HEARTBEAT_MS,
  RUN_STREAM_IDLE_CAP_MS,
  RUN_STREAM_MAX_MS,
  RUN_STREAM_TAIL_LIMIT,
} from '@launch/shared/ai/agents'
import type { KitAguiEvent } from '@launch/shared/ai/agui'
import { type SessionStatus, TERMINAL_SESSION_STATUSES } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { stream } from 'hono/streaming'
import type { Database } from '../../../db/client'
import { type SessionRow, sessions } from '../../../db/schema'
import type { AppContext } from '../../types'
import { streamDatabase, withAuthAndDb } from '../../utils/routes/route-helpers'
import { runStreamTickMs } from '../agents/run-stream'
import { createAguiEncoder } from '../ai/agui'
import { createSessionProjector } from './agui-projection'
import { listSessionEvents, toSessionEvent } from './event-log'

/** The clock and the wait, injected so the tests are not timer-bound. */
export interface SessionStreamDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const REAL_DEPS: SessionStreamDeps = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/** Where the bytes go. `aborted` is polled between ticks, so a closed tab stops the loop. */
export interface SessionStreamSink {
  write(chunk: Uint8Array | string): Promise<void>
  readonly aborted: boolean
}

export interface SessionStreamParams {
  /** The stream's OWN client — never the request's, which is closed with the Response. */
  db: Database
  tenantId: string
  /** The session as it was at open. Its status is re-read each tick. */
  session: Pick<SessionRow, 'id' | 'status' | 'error'>
  /** Rows at or below this `seq` are already with the client. 0 also asks for the head. */
  afterSeq: number
  accept?: string
}

/** Why the loop stopped — logged, never sent. */
export type SessionStreamOutcome = 'terminal' | 'aborted' | 'idle_cap' | 'duration_cap' | 'gone'

const isTerminal = (status: SessionStatus) =>
  (TERMINAL_SESSION_STATUSES as readonly SessionStatus[]).includes(status)

async function readStatus(db: Database, tenantId: string, sessionId: string) {
  const [row] = await db
    .select({ id: sessions.id, status: sessions.status, error: sessions.error })
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.id, sessionId)))
    .limit(1)
  return row ?? null
}

/** The loop, as a plain function over a sink: no hono, no ExecutionContext, no real timers. */
export async function sessionStreamBody(
  params: SessionStreamParams,
  sink: SessionStreamSink,
  deps: Partial<SessionStreamDeps> = {}
): Promise<SessionStreamOutcome> {
  const { now, sleep } = { ...REAL_DEPS, ...deps }
  const { db, tenantId } = params
  const sessionId = params.session.id
  const encoder = createAguiEncoder(params.accept)
  const projector = createSessionProjector(params.session)

  /** One row's frames, with the cursor on the last frame the transport carries (rule 1). */
  const writeGroup = async (events: KitAguiEvent[], seq: number | null): Promise<void> => {
    const frames: Uint8Array[] = []
    for (const event of events) {
      const bytes = encoder.encode(event)
      if (bytes) frames.push(bytes)
    }
    for (let i = 0; i < frames.length; i++) {
      const last = i === frames.length - 1
      if (last && seq !== null && !encoder.binary) await sink.write(`id: ${seq}\n`)
      await sink.write(frames[i] as Uint8Array)
    }
  }

  let cursor = params.afterSeq
  let emptyTicks = 0
  let lastRowAt = now()
  let lastHeartbeat = now()
  const deadline = now() + RUN_STREAM_MAX_MS

  // A resume must not replay the head, or the client gets a second RUN_STARTED.
  if (cursor === 0) await writeGroup(projector.head(), 0)

  while (true) {
    if (sink.aborted) return 'aborted'

    const [rows, current] = await Promise.all([
      listSessionEvents(db, tenantId, sessionId, cursor, RUN_STREAM_TAIL_LIMIT),
      readStatus(db, tenantId, sessionId),
    ])
    // Deleted with its app (the FK cascades): nothing more will ever be written.
    if (!current) return 'gone'

    if (rows.length > 0) {
      for (const row of rows) {
        await writeGroup(projector.push(toSessionEvent(row)), row.seq)
        cursor = row.seq
      }
      emptyTicks = 0
      lastRowAt = now()
      lastHeartbeat = now()
    } else {
      emptyTicks += 1
    }

    // A full page means more is waiting: drain it before deciding the session is over.
    if (rows.length >= RUN_STREAM_TAIL_LIMIT) continue

    if (isTerminal(current.status)) {
      // No cursor on the terminal frame: it is derived from the row, not from a `seq`.
      await writeGroup(projector.finish(current), null)
      return 'terminal'
    }

    const at = now()
    if (at >= deadline) return 'duration_cap'
    if (at - lastRowAt >= RUN_STREAM_IDLE_CAP_MS) return 'idle_cap'
    if (at - lastHeartbeat >= RUN_STREAM_HEARTBEAT_MS) {
      if (!encoder.binary) await sink.write(': ping\n\n')
      lastHeartbeat = at
    }
    await sleep(runStreamTickMs(emptyTicks))
  }
}

/**
 * The route's half: negotiate the transport, open the stream's own database client, run the loop.
 * Everything that can fail as JSON — auth, the 404 for a session this caller cannot see, a garbage
 * cursor — has already happened in the route.
 */
export function streamSessionAgui(c: AppContext, session: SessionRow, afterSeq: number): Response {
  const { tenantId, logger } = withAuthAndDb(c)
  const encoder = createAguiEncoder(c.req.header('Accept'))
  c.header('Content-Type', encoder.contentType)
  if (!encoder.binary) {
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')
    c.header('X-Accel-Buffering', 'no')
  }

  return stream(c, async s => {
    const handle = streamDatabase(c)
    let aborted = false
    s.onAbort(() => {
      aborted = true
    })
    const sink: SessionStreamSink = {
      write: async chunk => {
        await s.write(chunk)
      },
      get aborted() {
        return aborted
      },
    }
    try {
      const outcome = await sessionStreamBody(
        { db: handle.db, tenantId, session, afterSeq, accept: c.req.header('Accept') },
        sink
      )
      logger.debug({ sessionId: session.id, outcome }, 'session-stream: closed')
    } catch (err) {
      // Rule 2: a read-stream failure is not a session failure. Log it and close.
      logger.warn({ err, sessionId: session.id }, 'session-stream: body failed')
    } finally {
      await handle.close()
    }
  })
}
