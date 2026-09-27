/**
 * A coding session's transcript, live (Launch P3, spec/07): the durable `session_events` rows,
 * fetched once and then TOPPED UP as the session writes more.
 *
 * The shape is `RunPage`'s `useLiveRun`, made incremental because a session is long:
 *
 * - **The rows are the one representation.** `GET /api/sessions/:id/events?afterSeq=` is the
 *   contract (`sessionEventsResponseSchema`); the page folds the rows (`sessionChatModel.ts`), and
 *   the AG-UI stream is only a CADENCE (`lib/sessionAguiStream.ts`): when it reports a `seq` the
 *   log has not read, the log reads after its own cursor. Deleting the stream leaves a working page
 *   — the nudge and the poll still top the log up.
 * - **This hook is the ONLY writer of `['session-agui', id]`**, which must stay out of
 *   `REALTIME_INVALIDATIONS`: every durable write nudges `['session']`, and a list under that root
 *   would be thrown away and re-read whole on every one. Rows are MERGED (deduplicated by id,
 *   ordered by seq), never appended blindly, because a stream-triggered read and a nudge-triggered
 *   read can overlap.
 * - **Top-ups are coalesced**: one read in flight, and a request that arrives meanwhile runs once
 *   more after it rather than stacking.
 * - **Triggers**: a stream frame past the cursor; any change to the session row the page already
 *   holds (the nudge and `useSession`'s own poll refresh that); and, when the stream has given up
 *   (`RUN_STREAM_FALLBACK_ATTEMPTS` empty connections, or a pre-stream error), a `SESSION_POLL_MS`
 *   interval while the session is moving.
 * - **A read-stream closing is "reconnect", never an error** — after a short backoff, and only
 *   while the session is moving (`sessionOwesAnswer`); an idle `ready` session holds no connection.
 */
import { RUN_STREAM_FALLBACK_ATTEMPTS } from '@launch/shared/ai/agents'
import {
  type Session,
  type SessionEvent,
  type SessionEventsResponse,
  sessionEventsResponseSchema,
} from '@launch/shared/launch-sessions'
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'
import { streamSessionAgui } from '@/ui/lib/sessionAguiStream'
import { SESSION_POLL_MS, sessionOwesAnswer } from './useSessions'

/** What `['session-agui', id]` holds: every row read so far and the cursor after the last. */
export interface SessionEventLog {
  items: SessionEvent[]
  nextSeq: number
}

/** A safety valve on the first read of a very long session; each page is the server's size. */
const MAX_INITIAL_PAGES = 50
/** Pause between reconnects, grown with each empty connection so a closing server is not hammered. */
export const SESSION_STREAM_BACKOFF_MS = 750

/** Merge rows into the log: deduplicated by id, ordered by seq. Pure. */
export function mergeSessionEvents(
  existing: readonly SessionEvent[],
  incoming: readonly SessionEvent[]
): SessionEvent[] {
  if (incoming.length === 0) return existing as SessionEvent[]
  const byId = new Map<string, SessionEvent>()
  for (const event of existing) byId.set(event.id, event)
  for (const event of incoming) if (!byId.has(event.id)) byId.set(event.id, event)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

const eventsUrl = (id: string, afterSeq: number) =>
  `/api/sessions/${encodeURIComponent(id)}/events?afterSeq=${afterSeq}`

async function readEvents(id: string, afterSeq: number): Promise<SessionEventsResponse> {
  return api.get(eventsUrl(id, afterSeq), { schema: sessionEventsResponseSchema })
}

/** The first read: every page, until the server has nothing more. */
async function readWholeLog(id: string): Promise<SessionEventLog> {
  let log: SessionEventLog = { items: [], nextSeq: 0 }
  for (let page = 0; page < MAX_INITIAL_PAGES; page++) {
    const batch = await readEvents(id, log.nextSeq)
    if (batch.items.length === 0 || batch.nextSeq <= log.nextSeq) break
    log = { items: mergeSessionEvents(log.items, batch.items), nextSeq: batch.nextSeq }
  }
  return log
}

/** Read after the cached cursor and merge. Returns how many rows were new. */
async function topUp(queryClient: QueryClient, id: string): Promise<number> {
  const key = queryKeys.sessionAgui.detail(id)
  const before = queryClient.getQueryData<SessionEventLog>(key)
  if (!before) return 0
  const batch = await readEvents(id, before.nextSeq)
  let added = 0
  queryClient.setQueryData<SessionEventLog>(key, prev => {
    const base = prev ?? before
    const items = mergeSessionEvents(base.items, batch.items)
    added = items.length - base.items.length
    return { items, nextSeq: Math.max(base.nextSeq, batch.nextSeq) }
  })
  return added
}

export interface UseSessionStreamResult {
  events: SessionEvent[]
  isLoading: boolean
  error: Error | null
  /** A stream connection is open right now. */
  connected: boolean
  /** The stream gave up; the log is being polled instead. Cosmetic — the rows are the same. */
  fallback: boolean
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

export function useSessionStream(session: Session | undefined): UseSessionStreamResult {
  const id = session?.id
  const queryClient = useQueryClient()
  const [connected, setConnected] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [streamSeq, setStreamSeq] = useState(0)

  const query = useQuery({
    queryKey: queryKeys.sessionAgui.detail(id ?? ''),
    queryFn: () => readWholeLog(id ?? ''),
    enabled: Boolean(id),
    // This hook owns the entry once it is loaded; nothing may refetch it underneath.
    staleTime: Number.POSITIVE_INFINITY,
  })
  const loaded = query.isSuccess
  const nextSeq = query.data?.nextSeq ?? 0

  // ---- coalesced top-ups ----------------------------------------------------------------------
  const inFlight = useRef(false)
  const again = useRef(false)
  const refresh = useCallback(() => {
    if (!id) return
    if (inFlight.current) {
      again.current = true
      return
    }
    inFlight.current = true
    void (async () => {
      try {
        do {
          again.current = false
          await topUp(queryClient, id)
        } while (again.current)
      } catch {
        // A failed top-up is not worth a toast: the next trigger (a frame, the nudge, the poll)
        // tries again from the same cursor.
      } finally {
        inFlight.current = false
      }
    })()
  }, [id, queryClient])

  // The stream reported rows past the cursor.
  useEffect(() => {
    if (loaded && streamSeq > nextSeq) refresh()
  }, [loaded, streamSeq, nextSeq, refresh])

  // The row moved (the nudge or `useSession`'s poll refreshed it): the log may have too.
  const rowVersion = session
    ? `${session.status}|${session.turnCount}|${session.pendingMessage}|${session.updatedAt.getTime()}`
    : ''
  const firstVersion = useRef<string | null>(null)
  useEffect(() => {
    if (!loaded || !rowVersion) return
    if (firstVersion.current === null) {
      firstVersion.current = rowVersion
      return
    }
    refresh()
  }, [loaded, rowVersion, refresh])

  const live = sessionOwesAnswer(session)

  // ---- the fallback poll ----------------------------------------------------------------------
  useEffect(() => {
    if (!loaded || !fallback || !live) return
    const timer = setInterval(refresh, SESSION_POLL_MS)
    return () => clearInterval(timer)
  }, [loaded, fallback, live, refresh])

  // ---- the stream -----------------------------------------------------------------------------
  // The cursor the next connection resumes from, read through a ref so a growing log never
  // re-runs the effect below (a reconnect per row would be worse than no stream at all).
  const cursor = useRef(0)
  cursor.current = nextSeq

  useEffect(() => {
    if (!id || !loaded || !live || fallback) return
    const abort = new AbortController()
    let empty = 0

    void (async () => {
      while (!abort.signal.aborted) {
        setConnected(true)
        let result: Awaited<ReturnType<typeof streamSessionAgui>>
        try {
          result = await streamSessionAgui({
            sessionId: id,
            afterSeq: cursor.current,
            onFrame: (_frame, lastSeq) => setStreamSeq(prev => Math.max(prev, lastSeq)),
            signal: abort.signal,
          })
        } catch {
          // A pre-stream 4xx or a dropped connection: stop connecting, let the poll carry it.
          setConnected(false)
          if (!abort.signal.aborted) setFallback(true)
          return
        }
        setConnected(false)
        if (abort.signal.aborted || result.aborted) return
        empty = result.received === 0 ? empty + 1 : 0
        if (empty >= RUN_STREAM_FALLBACK_ATTEMPTS) {
          setFallback(true)
          return
        }
        await sleep(SESSION_STREAM_BACKOFF_MS * (empty + 1), abort.signal)
      }
    })()

    return () => {
      abort.abort()
      setConnected(false)
    }
  }, [id, loaded, live, fallback])

  return {
    events: query.data?.items ?? [],
    isLoading: query.isPending && Boolean(id),
    error: query.error,
    connected,
    fallback,
  }
}
