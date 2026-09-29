/**
 * The database RELAY — a WebSocket-terminating forwarder for a session container's database
 * traffic, with nothing of Launch's database or config, so the sandbox host Worker
 * (`src/sandbox-host/`) can bundle it too. **No sandbox class maps a host to it today**: the Neon
 * endpoint is in neither `outboundByHost` (a static key makes the SDK intercept that host even
 * with no allow-list), so under `SESSION_EGRESS=open` the database goes direct, and under
 * `allowlist` an allow-listed endpoint is passed through as `fetch(request)`. It is kept as the
 * core of the next probe: plain `ws://` through the HTTP interception to a made-up host, upgraded
 * to `wss://` here (docs/plans/sandbox-websocket-close.md, Part 2).
 *
 * **Why a handler at all.** An intercepted host with no handler is passed through as
 * `fetch(request)`, and that is fine for HTTP (the neon driver's `/sql`). For the WebSocket pool
 * (`wss://…/v2`) it is not, on real Cloudflare containers (`wrangler dev`'s local containers show
 * neither problem):
 *
 * 1. **The 101 came back with `Upgrade` and `Connection` TWICE** — the origin's copies and the
 *    runtime's own — which Node's clients reject ("Invalid Upgrade header", close 1006).
 * 2. **A close never completes** (2026-09-29): the interception never ends the container's
 *    TCP/TLS stream after a WebSocket closes, so its socket sits in CLOSING and Node cannot exit.
 *    The relay does NOT fix this one; the interception itself never ends the stream.
 *
 * So the handler TERMINATES the WebSocket here instead of passing the origin's through: a
 * `WebSocketPair` towards the container, the origin's socket accepted towards Neon, messages and
 * closes relayed both ways ({@link relaySockets}). The runtime writes the container's 101 itself,
 * so there is one `Upgrade` and one `Connection`.
 */

/** The WebSocket surface the relay needs — the Workers `WebSocket`, or a test's fake. */
export interface RelaySocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
}

/** Codes a close frame may not carry (RFC 6455 §7.4.1): "no status", "abnormal", TLS failure. */
const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015])

/** A code `close()` accepts: the peer's own, or 1000 for one that may not be sent. */
export function sendableCloseCode(code: number | undefined): number {
  if (code === undefined || RESERVED_CLOSE_CODES.has(code)) return 1000
  return code === 1000 || (code >= 3000 && code <= 4999) || (code >= 1001 && code <= 1014)
    ? code
    : 1000
}

/** Close `socket`; false when it was already closed (so nothing was sent). */
function closeQuietly(socket: RelaySocket, code?: number, reason?: string): boolean {
  try {
    // A close reason is at most 123 bytes; Neon's are short, a long one is dropped.
    socket.close(sendableCloseCode(code), reason && reason.length <= 123 ? reason : undefined)
    return true
  } catch {
    // Already closed: nothing left to say.
    return false
  }
}

/**
 * Relay two ACCEPTED sockets both ways: each message on to the other side; an error closes both.
 *
 * A close is passed on to the OTHER side only. Both sockets are accepted with
 * `allowHalfOpen: true` ({@link forwardDatabase}), so the runtime does not answer a close frame
 * itself (from compatibility date 2026-04-07 it does, unless told not to): the side that closed
 * waits in CLOSING until the other side's answer comes back through here, and that answer
 * completes its handshake — once, in order. If the other side is already closed there is no
 * answer to wait for, so the side that closed is answered at once.
 */
export function relaySockets(a: RelaySocket, b: RelaySocket): void {
  const wire = (from: RelaySocket, to: RelaySocket) => {
    from.addEventListener('message', event => {
      try {
        to.send(event.data as string | ArrayBuffer)
      } catch {
        closeQuietly(from, 1011, 'relay failed')
      }
    })
    from.addEventListener('close', event => {
      if (!closeQuietly(to, event.code, event.reason)) closeQuietly(from, event.code, event.reason)
    })
    from.addEventListener('error', () => {
      closeQuietly(from, 1011)
      closeQuietly(to, 1011)
    })
  }
  wire(a, b)
  wire(b, a)
}

/**
 * How long a WebSocket upgrade may wait for Neon's answer. An upgrade that never answered would
 * hang the kit's scripts for the bootstrap's whole 15 minutes (the neon driver has no connect
 * timeout); a 504 instead fails the connection at once, so a retry gets another try.
 */
export const DATABASE_UPGRADE_TIMEOUT_MS = 20_000

/** Is this the neon driver's `wss://…/v2` pool connection (an HTTP upgrade), not a `/sql` query? */
export function isUpgradeRequest(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket'
}

/** The container's end and ours, from a `WebSocketPair`. */
export type SocketPair = { client: WebSocket; server: WebSocket }

export interface ForwardDatabaseOptions {
  upgradeTimeoutMs?: number
  fetch?: typeof fetch
  /** Told when an upgrade gives up — the one line the host's logs need to show it happened. */
  onUpgradeTimeout?: (host: string, ms: number) => void
  /** Tests: the pair, and the 101 that hands the container its end (neither exists under Node). */
  pair?: () => SocketPair
  answer?: (client: WebSocket, protocol: string | null) => Response
}

const workersPair = (): SocketPair => {
  const pair = new WebSocketPair()
  return { client: pair[0], server: pair[1] }
}

const workersAnswer = (client: WebSocket, protocol: string | null): Response =>
  new Response(null, {
    status: 101,
    webSocket: client,
    ...(protocol ? { headers: { 'Sec-WebSocket-Protocol': protocol } } : {}),
  })

/**
 * The session's database traffic: a `/sql` query sent on unchanged (never timed — a long
 * statement is the app's business); a WebSocket upgrade relayed through a pair of our own
 * ({@link relaySockets}), or answered 504 when Neon does not answer it within
 * {@link DATABASE_UPGRADE_TIMEOUT_MS}. Anything but a 101 from Neon goes back as it came.
 */
export async function forwardDatabase(
  request: Request,
  options: ForwardDatabaseOptions = {}
): Promise<Response> {
  const send = options.fetch ?? fetch
  if (!isUpgradeRequest(request)) return send(request)
  const ms = options.upgradeTimeoutMs ?? DATABASE_UPGRADE_TIMEOUT_MS
  // A timer of our own, cleared once Neon answers: a signal on the fetch itself could still
  // fire on the upgraded socket after it.
  const abort = new AbortController()
  const timer = setTimeout(
    () => abort.abort(new DOMException('upgrade timed out', 'TimeoutError')),
    ms
  )
  let upstream: Response
  try {
    upstream = await send(request, { signal: abort.signal })
  } catch (err) {
    if (!(err instanceof Error) || (err.name !== 'TimeoutError' && err.name !== 'AbortError')) {
      throw err
    }
    const host = new URL(request.url).host
    ;(options.onUpgradeTimeout ?? warnUpgradeTimeout)(host, ms)
    return new Response(`The database did not answer the WebSocket upgrade within ${ms} ms`, {
      status: 504,
    })
  } finally {
    clearTimeout(timer)
  }
  const theirs = upstream.webSocket
  if (upstream.status !== 101 || !theirs) return upstream
  const { client, server } = (options.pair ?? workersPair)()
  // Half-open on both: a close is answered by the far side's answer, not by the runtime (above).
  theirs.accept({ allowHalfOpen: true })
  server.accept({ allowHalfOpen: true })
  relaySockets(server, theirs)
  return (options.answer ?? workersAnswer)(client, upstream.headers.get('sec-websocket-protocol'))
}

function warnUpgradeTimeout(host: string, ms: number): void {
  console.warn(`database egress: ${host} did not answer a WebSocket upgrade within ${ms} ms`)
}
