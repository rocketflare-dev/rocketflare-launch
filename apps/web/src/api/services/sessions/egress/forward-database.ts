/**
 * The database RELAY — how a session container reaches its own Neon endpoint (`*.neon.tech`)
 * through the egress interception, with nothing of Launch's database or config, so the sandbox
 * host Worker (`src/sandbox-host/`) bundles it too. Both sandbox classes map `*.neon.tech` to
 * {@link forwardDatabase}; the allow-list still decides WHICH endpoint (`sessionDbEgressHosts` —
 * exactly the session's own), since `ContainerProxy` checks it before any handler runs.
 *
 * **Why a handler at all.** An allow-listed host with no handler is passed through as
 * `fetch(request)`, and that is fine for HTTP (the neon driver's `/sql`). For the WebSocket pool
 * (`wss://…/v2`) it is not, on real Cloudflare containers (`wrangler dev`'s local containers show
 * neither problem):
 *
 * 1. **The 101 came back with `Upgrade` and `Connection` TWICE** — the origin's copies and the
 *    runtime's own — which Node's clients reject ("Invalid Upgrade header", close 1006).
 * 2. **A close never completed** (2026-09-29): with the origin's socket passed straight through,
 *    the container's `close()` went on to Neon, but no close frame ever came back and the
 *    container's TCP connection was never shut, so the socket sat in CLOSING for ever. Node does
 *    not exit while a socket is open: the kit's `migrate.ts`, `db-roles.ts` and `seed.ts` (which
 *    end their pool and let Node exit, unlike `db:check`, which calls `process.exit`) finished
 *    their work and then never exited — the "hang" in the bootstrap's step 5.
 *
 * So the handler TERMINATES the WebSocket here instead of passing the origin's through: a
 * `WebSocketPair` towards the container, the origin's socket accepted towards Neon, messages
 * relayed both ways, and a close on either side answered on BOTH ({@link relaySockets}). The
 * runtime writes the container's 101 itself, so there is one `Upgrade` and one `Connection`.
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

function closeQuietly(socket: RelaySocket, code?: number, reason?: string): void {
  try {
    // A close reason is at most 123 bytes; Neon's are short, a long one is dropped.
    socket.close(sendableCloseCode(code), reason && reason.length <= 123 ? reason : undefined)
  } catch {
    // Already closed (or closing): nothing left to say.
  }
}

/**
 * Relay two ACCEPTED sockets both ways: each message on to the other side; a close on either
 * side answered on that side (completing its handshake — the part the passthrough never did)
 * and passed on to the other; an error closes both.
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
      closeQuietly(from, event.code, event.reason)
      closeQuietly(to, event.code, event.reason)
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
  theirs.accept()
  server.accept()
  relaySockets(server, theirs)
  return (options.answer ?? workersAnswer)(client, upstream.headers.get('sec-websocket-protocol'))
}

function warnUpgradeTimeout(host: string, ms: number): void {
  console.warn(`database egress: ${host} did not answer a WebSocket upgrade within ${ms} ms`)
}

/** The `outboundByHost` pattern both sandbox classes map to {@link forwardDatabase}. */
export const DATABASE_EGRESS_PATTERN = '*.neon.tech'
