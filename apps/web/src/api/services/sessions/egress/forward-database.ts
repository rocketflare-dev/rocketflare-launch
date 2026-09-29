/**
 * The database PASSTHROUGH — how a session container reaches its own Neon endpoint (`*.neon.tech`)
 * through the egress interception, with nothing of Launch's database or config, so the sandbox
 * host Worker (`src/sandbox-host/`) bundles it too. Both sandbox classes map `*.neon.tech` to
 * {@link forwardDatabase}; the allow-list still decides WHICH endpoint (`sessionDbEgressHosts` —
 * exactly the session's own), since `ContainerProxy` checks it before any handler runs.
 *
 * **Why a handler at all.** An allow-listed host with no handler is passed through as
 * `fetch(request)`, and that is fine for HTTP (the neon driver's `/sql`). For the WebSocket pool
 * (`wss://…/v2`) it is not, on real Cloudflare containers: the 101 comes back with `Upgrade` and
 * `Connection` TWICE — the origin's copies from the response's headers, and the runtime's own —
 * Node's parser joins them to `websocket, websocket`, and both `ws` and Node's built-in WebSocket
 * reject the upgrade ("Invalid Upgrade header", close 1006). So the kit's `db:check`, its
 * migrations and every transaction failed in a remote sandbox (`wrangler dev`'s local containers
 * do not duplicate them). Re-wrapping the 101 without the origin's hop-by-hop headers — the usual
 * Workers WebSocket proxy — leaves one of each.
 */

/** Hop-by-hop headers the runtime writes itself on a 101; the origin's copies would duplicate them. */
const UPGRADE_HOP_HEADERS = ['upgrade', 'connection'] as const

/** A 101's headers without the origin's `Upgrade` / `Connection` (the runtime writes its own). */
export function upgradeAnswerHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream)
  for (const name of UPGRADE_HOP_HEADERS) headers.delete(name)
  return headers
}

/** An upstream 101 re-wrapped with {@link upgradeAnswerHeaders}; anything else as is. */
export function withoutDuplicateUpgradeHeaders(response: Response): Response {
  if (response.status !== 101 || !response.webSocket) return response
  const headers = upgradeAnswerHeaders(response.headers)
  return new Response(null, { status: 101, webSocket: response.webSocket, headers })
}

/**
 * How long a WebSocket upgrade may wait for Neon's answer. An upgrade that never answered hung the
 * kit's `db-roles` for the bootstrap's whole 15 minutes (2026-09-29, remote): the neon driver has
 * no connect timeout, and nothing reached Postgres. A 504 instead fails the connection at once, so
 * the kit's own retry, or the step's, gets another try.
 */
export const DATABASE_UPGRADE_TIMEOUT_MS = 20_000

/** Is this the neon driver's `wss://…/v2` pool connection (an HTTP upgrade), not a `/sql` query? */
export function isUpgradeRequest(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket'
}

export interface ForwardDatabaseOptions {
  upgradeTimeoutMs?: number
  fetch?: typeof fetch
  /** Told when an upgrade gives up — the one line the host's logs need to show it happened. */
  onUpgradeTimeout?: (host: string, ms: number) => void
}

/**
 * The session's database traffic: sent on unchanged, a WebSocket upgrade's answer re-wrapped —
 * and an upgrade Neon does not answer within {@link DATABASE_UPGRADE_TIMEOUT_MS} answered 504.
 * A `/sql` query is never timed here: a long statement is the app's business.
 */
export async function forwardDatabase(
  request: Request,
  options: ForwardDatabaseOptions = {}
): Promise<Response> {
  const send = options.fetch ?? fetch
  if (!isUpgradeRequest(request)) return send(request)
  const ms = options.upgradeTimeoutMs ?? DATABASE_UPGRADE_TIMEOUT_MS
  try {
    return withoutDuplicateUpgradeHeaders(await send(request, { signal: AbortSignal.timeout(ms) }))
  } catch (err) {
    if (!(err instanceof Error) || (err.name !== 'TimeoutError' && err.name !== 'AbortError')) {
      throw err
    }
    const host = new URL(request.url).host
    ;(options.onUpgradeTimeout ?? warnUpgradeTimeout)(host, ms)
    return new Response(`The database did not answer the WebSocket upgrade within ${ms} ms`, {
      status: 504,
    })
  }
}

function warnUpgradeTimeout(host: string, ms: number): void {
  console.warn(`database egress: ${host} did not answer a WebSocket upgrade within ${ms} ms`)
}

/** The `outboundByHost` pattern both sandbox classes map to {@link forwardDatabase}. */
export const DATABASE_EGRESS_PATTERN = '*.neon.tech'
