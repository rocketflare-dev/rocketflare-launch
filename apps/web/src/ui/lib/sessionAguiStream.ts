/**
 * The read-stream of a LIVE coding session (Launch P3, spec/07): GET
 * `/api/sessions/:id/agui/stream?afterSeq=` and report how far the session's event log has got.
 *
 * A sibling of `runAguiStream.ts`, used the way `RunPage` uses that one — **as a cadence, not as a
 * representation**. The session page renders the DURABLE rows (`GET /api/sessions/:id/events`,
 * `sessionEventSchema`), which are the contract; this stream only says "the log has reached seq N"
 * sooner than a poll would, and the hook re-reads the rows after N. So there is ONE representation
 * of a session's transcript (the rows) rather than a second, lossy one rebuilt from AG-UI frames,
 * and this module needs to understand nothing about the frames beyond their `id:` field.
 *
 * That is also why the parser here is deliberately permissive — any JSON object with a string
 * `type` counts: the projection's vocabulary (`services/sessions/agui-projection.ts`) may grow
 * (`CUSTOM` names, a per-turn `RUN_STARTED`/`RUN_FINISHED`) without this file changing, and a
 * frame the kit schema would refuse must still move the cursor.
 *
 * Transport only, exactly like its sibling: the stream closing with no terminal event means
 * *reconnect* — redeploy, the server's idle and duration caps, a dropped connection, the caller's
 * own abort all look the same — and reconnecting is the hook's job (`useSessionStream`).
 */
import { ApiError, notifyUnauthorized, parseErrorBody } from './api-client'
import { isAbortError, readSse, type SseFrameParser } from './sse'

/** The one thing this module reads from a frame: its AG-UI `type`. */
export interface SessionStreamFrame {
  type: string
}

export interface SessionAguiStreamOptions {
  sessionId: string
  /** Rows at or below this `seq` are already rendered; 0 asks for the session from the start. */
  afterSeq?: number
  /** Every frame, in order, with the cursor AFTER it (unchanged mid-group). */
  onFrame?: (frame: SessionStreamFrame, lastSeq: number) => void
  signal?: AbortSignal
}

/** What one connection amounted to. The hook decides what to do about it. */
export interface SessionAguiStreamResult {
  /** The newest `seq` this connection delivered, or the `afterSeq` it started from. */
  lastSeq: number
  /** Frames received — 0 is what the fallback counts. */
  received: number
  /** The caller's signal fired. Not a failure and never a toast. */
  aborted: boolean
}

const parseFrame: SseFrameParser<SessionStreamFrame> = json =>
  json && typeof json === 'object' && typeof (json as { type?: unknown }).type === 'string'
    ? { ok: true, event: { type: (json as { type: string }).type } }
    : { ok: false, reason: 'not an AG-UI frame' }

export function sessionStreamUrl(sessionId: string, afterSeq: number): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/agui/stream?afterSeq=${afterSeq}`
}

/**
 * Open one connection and read it to the end. Resolves when the server closes or the signal
 * aborts; rejects with `ApiError` for a pre-stream failure (404 for a session this person cannot
 * see, 400 on a bad cursor) and with the transport error for a connection that dropped mid-read.
 */
export async function streamSessionAgui({
  sessionId,
  afterSeq = 0,
  onFrame,
  signal,
}: SessionAguiStreamOptions): Promise<SessionAguiStreamResult> {
  const result: SessionAguiStreamResult = { lastSeq: afterSeq, received: 0, aborted: false }

  let response: Response
  try {
    response = await fetch(sessionStreamUrl(sessionId, afterSeq), {
      credentials: 'include',
      headers: { Accept: 'text/event-stream', 'X-Requested-With': 'fetch' },
      signal,
    })
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) return { ...result, aborted: true }
    throw error
  }

  if (!response.ok) {
    const body = await parseErrorBody(response)
    const error = new ApiError(body)
    if (body.statusCode === 401) notifyUnauthorized(error)
    throw error
  }

  await readSse(
    response,
    parseFrame,
    (frame, raw) => {
      // The server writes `session_events.seq` into the `id:` of the LAST frame of each row's
      // group, so the cursor only ever lands between whole rows.
      const seq = raw.id === undefined ? Number.NaN : Number(raw.id)
      if (Number.isInteger(seq) && seq >= result.lastSeq) result.lastSeq = seq
      result.received += 1
      onFrame?.(frame, result.lastSeq)
    },
    { signal }
  )

  if (signal?.aborted) result.aborted = true
  return result
}
