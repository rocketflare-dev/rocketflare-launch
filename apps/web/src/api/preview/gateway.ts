/**
 * The preview gateway (Launch P3, plan §1.6): a session's live preview is served by Launch's own
 * Worker at `<port>-<shortId>-<token>.<preview domain>` (`SESSION_PREVIEW_URL`), gated by the
 * viewer's Launch session and proxied into the container with `containerFetch` — never a public
 * tunnel (S7: 401 without a session, the app with one).
 *
 * `src/worker.ts` asks `previewHostOf(request, env)` BEFORE the Hono app sees anything, and sends a
 * preview host here — so none of the app's middleware runs (no `X-Frame-Options: DENY`: the page is
 * framed by Launch's session screen). `[assets] run_worker_first = true` in both tomls is what gets
 * a navigation to `/` on a preview host this far instead of Launch's own `index.html`.
 *
 * The full flow (slice 3d):
 *
 * 1. `POST /api/sessions/:id/preview-grant` mints a 60 s HMAC grant `{ sid, uid, host }`.
 * 2. The iframe loads `https://<preview host>/__launch/grant?g=…`, which sets the host-only cookie
 *    `__Host-launch-preview` (HttpOnly, Secure, SameSite=None; `launch-preview`, Lax, not Secure in
 *    development) and 302s to `/`.
 * 3. Every later request checks the cookie's signature and that the host belongs to the session,
 *    with a 15 s in-isolate status cache; no cookie → 401, an ended session → 410.
 * 4. `SandboxPort.fetch(port, req)` (`containerFetch`), WebSocket upgrades attempted for Vite HMR,
 *    and `Content-Security-Policy: frame-ancestors <APP_URL>` on the response.
 *
 * **Pre-tenant by design**: the host names the session by `short_id` and nothing else, so the
 * lookup names no tenant and the tenant is then taken from the row (the entry for this file in
 * `tests/config/unscoped-allowlist.test.ts`). Who may VIEW is decided from that row: the creator,
 * the app's owners and admins.
 *
 * **Slice 3d owns this file.** From 3a it is real up to the lookup: a preview host whose session
 * does not exist — or whose token does not match — is a JSON 404, and a real one answers 503 until
 * 3d wires the grant, the cookie and the proxy.
 */
import {
  type PreviewHost,
  parsePreviewHost,
  TERMINAL_SESSION_STATUSES,
} from '@launch/shared/launch-sessions'
import { eq } from 'drizzle-orm'
import { type AppConfig, loadConfig } from '../../config'
import { type Database, openDatabase } from '../../db/client'
import { type SessionRow, sessions } from '../../db/schema'
import type { AppBindings } from '../types'

/** The error envelope, without the Hono app (none of its middleware runs for a preview host). */
function envelope(status: number, error: string, code: string): Response {
  return Response.json({ error, statusCode: status, code }, { status })
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

export async function handlePreview(
  _request: Request,
  env: AppBindings,
  _ctx: ExecutionContext,
  host: PreviewHost
): Promise<Response> {
  const cfg = loadConfig(env)
  const handle = openDatabase({ ...cfg, HYPERDRIVE: env.HYPERDRIVE })
  try {
    const session = await sessionForPreview(handle.db, host)
    if (!session) return envelope(404, 'No such preview', 'preview_not_found')
    if ((TERMINAL_SESSION_STATUSES as readonly string[]).includes(session.status)) {
      return envelope(410, 'This session has ended', 'session_ended')
    }
    return envelope(503, 'Previews are not wired yet (P3 slice 3d)', 'preview_not_configured')
  } finally {
    await handle.close()
  }
}
