/**
 * Coding-session fixtures for the UI tests (Launch P3): a `sessionSchema`-shaped row as the API
 * sends it (ISO strings, not `Date`s — the hooks parse), `session_events` rows, and a fake
 * read-stream whose frames carry `id:` the way the session AG-UI stream writes the row's `seq`.
 */
import { DEFAULT_SESSION_POLICY } from '@launch/shared/launch-sessions'
import { IDS } from './renderWithProviders'

export const APP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
export const SESSION_ID = '5e551000-0000-4000-8000-000000000001'

const at = (seq: number) => new Date(Date.UTC(2026, 8, 28, 10, 0, seq)).toISOString()

export function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    appId: APP_ID,
    kind: 'session',
    shortId: 'abcdefghijkl',
    title: 'Friendlier home page',
    status: 'ready',
    createdByUserId: IDS.user,
    branch: 'session/abcdefghijkl',
    turnCount: 1,
    costMicrocents: 12_000_000,
    prNumber: null,
    prUrl: null,
    lastActivityAt: at(0),
    createdAt: at(0),
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    requestedAction: null,
    pendingMessage: false,
    cancelRequested: false,
    imageVersion: 'session-0.1.0',
    policy: DEFAULT_SESSION_POLICY,
    usage: { tokensIn: 1200, tokensOut: 300, cacheRead: 0, cacheWrite: 0 },
    budget: { spentMicrocents: 12_000_000, capMicrocents: 1_000_000_000, extraMicrocents: 0 },
    containerSeconds: 240,
    prChecks: null,
    error: null,
    readyAt: at(1),
    suspendedAt: null,
    endedAt: null,
    updatedAt: at(2),
    viewerCanManage: true,
    ...overrides,
  }
}

export const detailOf = (overrides: Record<string, unknown> = {}) => ({
  session: sessionRow(overrides),
})

export function summaryRow(overrides: Record<string, unknown> = {}) {
  const {
    baseRef: _b,
    baseSha: _bs,
    headSha: _h,
    requestedAction: _r,
    pendingMessage: _p,
    cancelRequested: _c,
    imageVersion: _i,
    policy: _po,
    usage: _u,
    budget: _bu,
    containerSeconds: _cs,
    prChecks: _pc,
    error: _e,
    readyAt: _ra,
    suspendedAt: _sa,
    endedAt: _ea,
    updatedAt: _ua,
    viewerCanManage: _v,
    ...summary
  } = sessionRow(overrides)
  return summary
}

export const eventId = (seq: number) => `e0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`

export function sessionEvent(seq: number, type: string, data: unknown, turn = 1) {
  return { id: eventId(seq), sessionId: SESSION_ID, seq, turn, type, data, at: at(seq) }
}

/** `GET /events?afterSeq=` over a mutable log, revealing rows up to `visibleUpTo()` only. */
export function eventsRoute(
  log: ReturnType<typeof sessionEvent>[],
  visibleUpTo: () => number = () => Number.POSITIVE_INFINITY
) {
  return (_init: RequestInit | undefined, url: URL) => {
    const after = Number(url.searchParams.get('afterSeq') ?? 0)
    const items = log.filter(e => e.seq > after && e.seq <= visibleUpTo())
    return { items, nextSeq: items.at(-1)?.seq ?? after }
  }
}

/** A `text/event-stream` body of raw frames; `hang` keeps it open until the reader aborts. */
export function sseFrames(frames: { data: unknown; id?: number }[], { hang = false } = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        const id = frame.id !== undefined ? `id: ${frame.id}\n` : ''
        controller.enqueue(encoder.encode(`${id}data: ${JSON.stringify(frame.data)}\n\n`))
      }
      if (!hang) controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
