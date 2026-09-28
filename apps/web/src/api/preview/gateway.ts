/**
 * The preview gateway (Launch P3, plan §1.6): a session's live preview is served by Launch's own
 * Worker at `<port>-<shortId>-<token>.<preview domain>` (`SESSION_PREVIEW_URL`), gated by a signed
 * cookie and proxied into the container with `containerFetch` — never a public tunnel (S7: 401
 * without a session, the app with one).
 *
 * `src/worker.ts` asks `previewHostOf(request, env)` BEFORE the Hono app sees anything, and sends a
 * preview host here — so none of the app's middleware runs (no `X-Frame-Options: DENY`: the page is
 * framed by Launch's session screen). `[assets] run_worker_first = true` in both tomls is what gets
 * a navigation to `/` on a preview host this far instead of Launch's own `index.html`.
 *
 * The flow:
 *
 * 1. `POST /api/sessions/:id/preview-grant` checks who may see the session and mints a 60 s HMAC
 *    grant `{ sid, uid, host }` (`services/sessions/preview.ts`).
 * 2. The iframe loads `https://<preview host>/__launch/grant?g=…`: a genuine, unexpired grant for
 *    THIS host and THIS session sets the host-only cookie `__Host-launch-preview` (HttpOnly,
 *    Secure, SameSite=None, Partitioned; in development `launch-preview`, Lax, not Secure — a
 *    `__Host-` cookie needs Secure, which `http://*.localhost` cannot give) and 302s to `/`.
 *    Anything else is a 401.
 * 3. Every later request needs that cookie, signed for this host and naming this session: no
 *    cookie, a forged one, or another session's → 401. An ended session → 410 (before the cookie:
 *    the host itself is a secret, and the page should say "ended", not "sign in").
 * 4. A session that is running (`ready`, `working`, `blocked`, `shipping`) is proxied with
 *    `SandboxPort.fetch(port, req)`; one still booting, suspended or ending is a 503. Only the
 *    preview ports are reachable (`PREVIEW_PORTS`): `:3000` inside a sandbox is the SDK's own
 *    control server and must never be.
 * 5. The response loses any `X-Frame-Options` and gets `frame-ancestors <APP_URL>` — its own CSP
 *    kept, with that one directive replaced. A WebSocket upgrade (Vite HMR) is passed through
 *    untouched: a 101's headers are immutable and re-wrapping it drops the socket.
 *
 * **The status cache**: the session a host names is read once per `PREVIEW_STATUS_CACHE_MS` (15 s)
 * per isolate, because a Vite page is a hundred module requests. An ended session is therefore
 * served for up to 15 s more — by the sandbox that is being destroyed anyway.
 *
 * **The person's use counts as activity**: an idle session is suspended by its Workflow once
 * `last_activity_at` is `idleSuspendMinutes` old (`suspendStep` in `steps.ts`), and when no chat
 * turn runs nothing but a preview request says the person is still there — so an authenticated
 * request to a `ready` / `blocked` session's preview moves `last_activity_at` to now, off the hot
 * path (`ctx.waitUntil`), at most once per `PREVIEW_ACTIVITY_THROTTLE_MS` (60 s) per session per
 * isolate — and in the database too (the update only lands on a stamp older than that), so many
 * isolates cost about one write a minute. Never while `working`: there `last_activity_at` is the
 * turn's heartbeat, which `reconcile.ts` reads to find a dead turn, and a preview must not mask
 * one. The status cache may be 15 s stale; the update re-checks the status itself.
 *
 * **Pre-tenant by design**: the host names the session by `short_id` and nothing else, so the
 * lookup names no tenant and the tenant is then taken from the row (the entry for this file in
 * `tests/config/unscoped-allowlist.test.ts`). Who may VIEW was decided when the grant was minted.
 */
import {
  type PreviewHost,
  parsePreviewHost,
  type SessionStatus,
  TERMINAL_SESSION_STATUSES,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { type AppConfig, loadConfig } from '../../config'
import { type Database, type DatabaseHandle, openDatabase } from '../../db/client'
import { type SessionRow, sessions } from '../../db/schema'
import { defaultSessionPorts, type SessionPorts } from '../services/sessions/ports'
import {
  mintCookie,
  PREVIEW_COOKIE_TTL_S,
  PREVIEW_GRANT_PATH,
  PREVIEW_UI_PORT,
  verifyCookie,
  verifyGrant,
} from '../services/sessions/preview'
import type { AppBindings } from '../types'

/** The cookie a grant is exchanged for; host-only by construction (`__Host-`). */
export const PREVIEW_COOKIE = '__Host-launch-preview'
/** The development variant: `http://*.localhost` cannot hold a Secure (so `__Host-`) cookie. */
export const DEV_PREVIEW_COOKIE = 'launch-preview'
/** The container ports a preview host may name: the dev UI and the API behind it. Never `:3000`. */
export const PREVIEW_PORTS: readonly number[] = [PREVIEW_UI_PORT, 8787]
/** How long a session's status is trusted in one isolate. */
export const PREVIEW_STATUS_CACHE_MS = 15_000
/** At most one `last_activity_at` write per session per this long (per isolate, and in the DB). */
export const PREVIEW_ACTIVITY_THROTTLE_MS = 60_000

/** The statuses whose sandbox is up and serving. */
const SERVING_STATUSES: readonly SessionStatus[] = ['ready', 'working', 'blocked', 'shipping']
/** The statuses whose idle clock a preview request moves: the live ones the Workflow waits in. */
const ACTIVITY_STATUSES: readonly SessionStatus[] = ['ready', 'blocked']

/** Everything the gateway reaches, injectable so a test drives it with fakes. */
export interface PreviewGatewayDeps {
  openDb: (env: AppBindings, cfg: AppConfig) => DatabaseHandle
  ports: (env: AppBindings, cfg: AppConfig) => Pick<SessionPorts, 'sandbox'>
  now: () => Date
}

const defaultDeps = (): PreviewGatewayDeps => ({
  openDb: (env, cfg) => openDatabase({ ...cfg, HYPERDRIVE: env.HYPERDRIVE }),
  ports: (env, cfg) => defaultSessionPorts(env, cfg),
  now: () => new Date(),
})

/** The error envelope, without the Hono app (none of its middleware runs for a preview host). */
function envelope(status: number, error: string, code: string): Response {
  return Response.json(
    { error, statusCode: status, code },
    { status, headers: { 'Cache-Control': 'no-store' } }
  )
}

/**
 * The preview a request is for, or null when its host is not a preview host — including when the
 * config does not load or `SESSION_PREVIEW_URL` is unset, so the Hono app answers as it always did.
 */
export function previewHostOf(request: Request, env: AppBindings): PreviewHost | null {
  let cfg: AppConfig
  try {
    cfg = loadConfig(env)
  } catch {
    return null
  }
  if (!cfg.SESSION_PREVIEW_URL) return null
  return parsePreviewHost(new URL(request.url).host, cfg.SESSION_PREVIEW_URL)
}

/**
 * The session a preview host names, or null. PRE-TENANT: the short id is unique and the token is
 * compared here, so a guessed short id alone finds nothing; the tenant is taken from the row.
 */
export async function sessionForPreview(
  db: Database,
  host: PreviewHost
): Promise<SessionRow | null> {
  const [row] = await db.select().from(sessions).where(eq(sessions.shortId, host.shortId)).limit(1)
  if (!row || row.previewToken !== host.token) return null
  return row
}

// ---- the in-isolate status cache ---------------------------------------------------------------

/** What the gateway needs of a session row — nothing secret beyond the token it already matched. */
interface PreviewView {
  id: string
  tenantId: string
  status: SessionStatus
  previewToken: string
}

const statusCache = new Map<string, { view: PreviewView; at: number }>()

/** When this isolate last wrote each session's activity (session id → ms). */
const activityBumps = new Map<string, number>()

/** Forget every cached status and activity stamp (tests; a deploy starts with an empty isolate). */
export function clearPreviewStatusCache(): void {
  statusCache.clear()
  activityBumps.clear()
}

async function lookup(
  env: AppBindings,
  cfg: AppConfig,
  deps: PreviewGatewayDeps,
  host: PreviewHost,
  now: number
): Promise<PreviewView | null> {
  const cached = statusCache.get(host.shortId)
  if (cached && now - cached.at < PREVIEW_STATUS_CACHE_MS) {
    return cached.view.previewToken === host.token ? cached.view : null
  }
  const handle = deps.openDb(env, cfg)
  try {
    const row = await sessionForPreview(handle.db, host)
    if (!row) {
      statusCache.delete(host.shortId)
      return null
    }
    const view = {
      id: row.id,
      tenantId: row.tenantId,
      status: row.status,
      previewToken: row.previewToken,
    }
    statusCache.set(host.shortId, { view, at: now })
    // Keep the map bounded: a busy isolate sees many previews, each is re-read after 15 s anyway.
    if (statusCache.size > 1000) {
      for (const [key, entry] of statusCache) {
        if (now - entry.at >= PREVIEW_STATUS_CACHE_MS) statusCache.delete(key)
      }
    }
    return view
  } finally {
    await handle.close()
  }
}

// ---- the person's activity ---------------------------------------------------------------------

/**
 * Move a live session's `last_activity_at` to `now` — only while it is `ready` / `blocked` and only
 * when the stamp is older than {@link PREVIEW_ACTIVITY_THROTTLE_MS}. Tenant-first (the tenant is
 * the row's, found by the lookup above). True when the write landed.
 */
export async function bumpPreviewActivity(
  db: Database,
  view: Pick<PreviewView, 'id' | 'tenantId'>,
  now: Date
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - PREVIEW_ACTIVITY_THROTTLE_MS)
  const landed = await db
    .update(sessions)
    .set({ lastActivityAt: now })
    .where(
      and(
        eq(sessions.tenantId, view.tenantId),
        eq(sessions.id, view.id),
        inArray(sessions.status, [...ACTIVITY_STATUSES]),
        or(isNull(sessions.lastActivityAt), lt(sessions.lastActivityAt, cutoff))
      )
    )
    .returning({ id: sessions.id })
  return landed.length > 0
}

/** The throttled bump, handed to `waitUntil`; never throws (a missed stamp costs nothing). */
function noteActivity(
  env: AppBindings,
  cfg: AppConfig,
  deps: PreviewGatewayDeps,
  ctx: ExecutionContext,
  view: PreviewView,
  now: Date
): void {
  if (!ACTIVITY_STATUSES.includes(view.status)) return
  const last = activityBumps.get(view.id)
  if (last !== undefined && now.getTime() - last < PREVIEW_ACTIVITY_THROTTLE_MS) return
  activityBumps.set(view.id, now.getTime())
  if (activityBumps.size > 1000) {
    for (const [key, at] of activityBumps) {
      if (now.getTime() - at >= PREVIEW_ACTIVITY_THROTTLE_MS) activityBumps.delete(key)
    }
  }
  const write = (async () => {
    const handle = deps.openDb(env, cfg)
    try {
      await bumpPreviewActivity(handle.db, view, now)
    } finally {
      await handle.close()
    }
  })().catch(() => {})
  ctx.waitUntil(write)
}

// ---- cookies and headers -----------------------------------------------------------------------

function cookieName(cfg: AppConfig): string {
  return cfg.APP_ENV === 'development' ? DEV_PREVIEW_COOKIE : PREVIEW_COOKIE
}

/** The value of cookie `name` in a `Cookie` header, or null. */
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return null
}

/** The `Cookie` header without `name` — the app behind the preview never sees Launch's cookie. */
function withoutCookie(header: string | null, name: string): string | null {
  if (!header) return null
  const kept = header
    .split(';')
    .map(part => part.trim())
    .filter(part => part && part.slice(0, part.indexOf('=')).trim() !== name)
  return kept.length ? kept.join('; ') : null
}

function setCookieHeader(cfg: AppConfig, value: string): string {
  const base = `${cookieName(cfg)}=${value}; Path=/; HttpOnly; Max-Age=${PREVIEW_COOKIE_TTL_S}`
  // SameSite=None + Partitioned: the preview is framed by Launch, which may sit on another site
  // (spec/04's two-domain layout); Partitioned keeps it working where third-party cookies are off.
  return cfg.APP_ENV === 'development'
    ? `${base}; SameSite=Lax`
    : `${base}; Secure; SameSite=None; Partitioned`
}

/** `frame-ancestors` for Launch's own origin, replacing any the app set. */
function frameAncestors(existing: string | null, appOrigin: string): string {
  const directive = `frame-ancestors ${appOrigin}`
  if (!existing) return directive
  const kept = existing
    .split(';')
    .map(d => d.trim())
    .filter(d => d && !/^frame-ancestors(\s|$)/i.test(d))
  return [...kept, directive].join('; ')
}

function isUpgrade(req: Request): boolean {
  return req.headers.get('Upgrade')?.toLowerCase() === 'websocket'
}

// ---- the handler -------------------------------------------------------------------------------

async function exchangeGrant(
  req: Request,
  cfg: AppConfig,
  view: PreviewView,
  host: string,
  now: Date
): Promise<Response> {
  const grant = new URL(req.url).searchParams.get('g')
  const claims = await verifyGrant(cfg, grant, { host, now })
  if (!claims || claims.sid !== view.id) {
    return envelope(
      401,
      'This preview link has expired; open it again from Launch',
      'preview_grant_invalid'
    )
  }
  const { token } = await mintCookie(cfg, { sessionId: view.id, userId: claims.uid, host, now })
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': setCookieHeader(cfg, token),
      'Cache-Control': 'no-store',
      // The grant is in this URL; never hand it to the app as a Referer.
      'Referrer-Policy': 'no-referrer',
    },
  })
}

async function proxy(
  req: Request,
  env: AppBindings,
  cfg: AppConfig,
  deps: PreviewGatewayDeps,
  view: PreviewView,
  port: number
): Promise<Response> {
  const headers = new Headers(req.headers)
  const cookie = withoutCookie(req.headers.get('Cookie'), cookieName(cfg))
  if (cookie) headers.set('Cookie', cookie)
  else headers.delete('Cookie')
  const forwarded = new Request(req.url, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? null : req.body,
    redirect: 'manual',
    // @ts-expect-error — `duplex` is required by Node's fetch for a streamed body, unknown to the Workers types.
    duplex: 'half',
  })
  const sandbox = deps.ports(env, cfg).sandbox(view.id)
  let res: Response
  try {
    res = await sandbox.fetch(port, forwarded)
  } catch {
    return envelope(502, 'The preview is not answering', 'preview_unreachable')
  }
  // Vite HMR: hand the upgrade back untouched (a 101's headers are immutable).
  if (res.status === 101 || isUpgrade(req)) return res

  const out = new Headers(res.headers)
  out.delete('X-Frame-Options')
  out.set(
    'Content-Security-Policy',
    frameAncestors(out.get('Content-Security-Policy'), new URL(cfg.APP_URL).origin)
  )
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}

export async function handlePreview(
  request: Request,
  env: AppBindings,
  ctx: ExecutionContext,
  host: PreviewHost,
  overrides: Partial<PreviewGatewayDeps> = {}
): Promise<Response> {
  const deps = { ...defaultDeps(), ...overrides }
  const cfg = loadConfig(env)
  const now = deps.now()
  const requestHost = new URL(request.url).host

  const view = await lookup(env, cfg, deps, host, now.getTime())
  if (!view) return envelope(404, 'No such preview', 'preview_not_found')
  if ((TERMINAL_SESSION_STATUSES as readonly string[]).includes(view.status)) {
    return envelope(410, 'This session has ended', 'session_ended')
  }

  if (new URL(request.url).pathname === PREVIEW_GRANT_PATH) {
    return exchangeGrant(request, cfg, view, requestHost, now)
  }

  const claims = await verifyCookie(
    cfg,
    readCookie(request.headers.get('Cookie'), cookieName(cfg)),
    {
      host: requestHost,
      now,
    }
  )
  if (!claims || claims.sid !== view.id) {
    return envelope(401, 'Open this preview from its session in Launch', 'preview_unauthorized')
  }

  if (!PREVIEW_PORTS.includes(host.port)) {
    return envelope(404, 'No such preview', 'preview_not_found')
  }
  if (!SERVING_STATUSES.includes(view.status)) {
    return envelope(
      503,
      `The session is ${view.status}; the preview is not running`,
      'preview_unavailable'
    )
  }
  noteActivity(env, cfg, deps, ctx, view, now)
  return proxy(request, env, cfg, deps, view, host.port)
}
