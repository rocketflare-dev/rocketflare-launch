/**
 * The preview gateway (Launch P3 slice 3d, plan §1.6): the grant → cookie exchange, the cookie on
 * every request, the proxy into the sandbox, and the headers that let Launch frame it — driven
 * through `handlePreview` with a `FakeSandbox` behind the ports, and through the real
 * `POST /api/sessions/:id/preview-grant` route.
 */
import { previewLabel, previewUrl } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  bumpPreviewActivity,
  clearPreviewStatusCache,
  handlePreview,
  PREVIEW_ACTIVITY_THROTTLE_MS,
  previewHostOf,
} from '@/api/preview/gateway'
import { mintCookie, mintGrant, verifyCookie, verifyGrant } from '@/api/services/sessions/preview'
import { loadConfig } from '@/config'
import { type SessionRow, sessions } from '@/db/schema'
import worker from '@/worker'
import {
  createTestSession,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { json, request } from '../helpers/request'
import { createFakeSessionPorts, insertSession, seedSessionApp } from '../helpers/sessions'
import {
  createExecutionContext,
  createTestEnv,
  type TestEnv,
  waitOnExecutionContext,
} from '../mocks/bindings'

const db = setupTestDatabase()
const TEMPLATE = 'http://{label}.localhost:3001'

function previewEnv(): TestEnv {
  return createTestEnv({ SESSION_PREVIEW_URL: TEMPLATE })
}

function hostOf(row: Pick<SessionRow, 'shortId' | 'previewToken'>, port = 5173): string {
  return new URL(previewUrl(TEMPLATE, previewLabel(port, row.shortId, row.previewToken))).host
}

/** Drive the gateway as `worker.ts` would, with the fake ports behind it. */
async function gateway(
  env: TestEnv,
  ports: ReturnType<typeof createFakeSessionPorts>,
  url: string,
  init: RequestInit = {},
  now?: Date
): Promise<Response> {
  const req = new Request(url, init)
  const host = previewHostOf(req, env)
  if (!host) throw new Error(`not a preview host: ${url}`)
  const ctx = createExecutionContext()
  const res = await handlePreview(req, env, ctx, host, {
    ports: () => ports,
    ...(now ? { now: () => now } : {}),
  })
  // The activity bump runs in `waitUntil`; settle it so a test reads what it wrote.
  await waitOnExecutionContext(ctx)
  return res
}

async function activityOf(row: SessionRow): Promise<Date | null> {
  const [latest] = await db
    .select({ at: sessions.lastActivityAt })
    .from(sessions)
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
  return latest?.at ?? null
}

async function setActivity(row: SessionRow, at: Date | null) {
  await db
    .update(sessions)
    .set({ lastActivityAt: at })
    .where(and(eq(sessions.tenantId, row.tenantId), eq(sessions.id, row.id)))
}

async function seeded(status: SessionRow['status'] = 'ready') {
  const f = await seedSessionApp(db, createFakeCloud())
  const row = await insertSession(db, f, { status })
  const ports = createFakeSessionPorts().script(sandbox =>
    sandbox.onPort(5173, req => {
      const cookie = req.headers.get('Cookie')
      return new Response(
        `<h1>app</h1><!-- cookie:${cookie ?? ''} path:${new URL(req.url).pathname} -->`,
        {
          headers: {
            'content-type': 'text/html',
            // What the kit's own worker would add; the gateway must take it off.
            'X-Frame-Options': 'DENY',
            'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
            // Cacheable, as Cloudflare's zone default makes a `.css`: a live preview never is.
            'Cache-Control': 'max-age=14400',
          },
        }
      )
    })
  )
  return { f, row, ports, host: hostOf(row) }
}

/** A cookie header for `row` as a successful exchange would leave it. */
async function cookieFor(row: SessionRow, userId: string, host = hostOf(row)) {
  const cfg = loadConfig(previewEnv())
  const { token } = await mintCookie(cfg, { sessionId: row.id, userId, host })
  return { Cookie: `launch-preview=${token}; other=1` }
}

/**
 * `token` with one bit of its MAC flipped — a forgery by construction. It works on the decoded
 * bytes, never on a character: a regex over the base64url text misses a MAC starting with `-`
 * (not a `\w`), and changing a trailing character can decode to the same bytes.
 */
function tamperMac(token: string): string {
  const [payload, mac] = token.split('.')
  const bytes = Buffer.from(mac ?? '', 'base64url')
  bytes[0] = (bytes[0] ?? 0) ^ 0x01
  const forged = `${payload}.${bytes.toString('base64url')}`
  if (forged === token) throw new Error('tamperMac left the token unchanged')
  return forged
}

beforeEach(() => clearPreviewStatusCache())

describe('preview grants and cookies', () => {
  it('a grant verifies only on its host, before it expires, and never as a cookie', async () => {
    const cfg = loadConfig(previewEnv())
    const now = new Date('2026-09-28T10:00:00Z')
    const { token, expiresAt } = await mintGrant(cfg, {
      sessionId: 's1',
      userId: 'u1',
      host: 'X.localhost:3001',
      now,
    })
    expect(expiresAt.getTime() - now.getTime()).toBe(60_000)
    expect(await verifyGrant(cfg, token, { host: 'x.localhost:3001', now })).toMatchObject({
      sid: 's1',
      uid: 'u1',
    })
    expect(await verifyGrant(cfg, token, { host: 'y.localhost:3001', now })).toBeNull()
    expect(
      await verifyGrant(cfg, token, {
        host: 'x.localhost:3001',
        now: new Date(now.getTime() + 61_000),
      })
    ).toBeNull()
    expect(await verifyCookie(cfg, token, { host: 'x.localhost:3001', now })).toBeNull()
    const [payload, mac] = token.split('.')
    expect(
      await verifyGrant(cfg, `${payload}.${mac?.slice(1)}A`, { host: 'x.localhost:3001', now })
    ).toBeNull()
    expect(await verifyGrant(cfg, 'garbage', { host: 'x.localhost:3001', now })).toBeNull()
  })

  it('a cookie with any bit of its MAC flipped is refused, whatever character the MAC starts with', async () => {
    // Fixed inputs make the MACs deterministic; walk session ids until the MAC starts with each
    // non-`\w` base64url character — the `-` case once let a "tampered" test cookie through
    // unchanged, 1 run in 64.
    const cfg = loadConfig(previewEnv())
    const now = new Date('2026-09-28T10:00:00Z')
    const host = 'x.localhost:3001'
    const seen = new Set<string>()
    for (let i = 0; i < 2000 && !(seen.has('-') && seen.has('_')); i++) {
      const { token } = await mintCookie(cfg, { sessionId: `s${i}`, userId: 'u1', host, now })
      const first = token.split('.')[1]?.[0] ?? ''
      if (first !== '-' && first !== '_') continue
      seen.add(first)
      expect(await verifyCookie(cfg, token, { host, now })).toMatchObject({ sid: `s${i}` })
      expect(await verifyCookie(cfg, tamperMac(token), { host, now })).toBeNull()
    }
    expect([...seen].sort()).toEqual(['-', '_'])
  })
})

describe('the gateway', () => {
  it('no cookie → 401, without the app’s X-Frame-Options', async () => {
    const { ports, host } = await seeded()
    const res = await gateway(previewEnv(), ports, `http://${host}/`)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'preview_unauthorized' })
    expect(res.headers.get('X-Frame-Options')).toBeNull()
  })

  it('a forged cookie, or another session’s, → 401', async () => {
    const { f, row, ports, host } = await seeded()
    const other = await insertSession(db, f, { status: 'ready' })

    const cfg = loadConfig(previewEnv())
    const genuine = (await mintCookie(cfg, { sessionId: row.id, userId: f.user.id, host })).token
    const tampered = `launch-preview=${tamperMac(genuine)}; other=1`
    expect(
      (await gateway(previewEnv(), ports, `http://${host}/`, { headers: { Cookie: tampered } }))
        .status
    ).toBe(401)

    // Another session's cookie, presented on this host (its own host, and this host with its sid).
    const theirs = await cookieFor(other, f.user.id)
    expect(
      (await gateway(previewEnv(), ports, `http://${host}/`, { headers: theirs })).status
    ).toBe(401)
    const { token } = await mintCookie(cfg, { sessionId: other.id, userId: f.user.id, host })
    const res = await gateway(previewEnv(), ports, `http://${host}/`, {
      headers: { Cookie: `launch-preview=${token}` },
    })
    expect(res.status).toBe(401)
    expect(ports.sandboxes.get(row.id)?.fetches ?? []).toHaveLength(0)
  })

  it('a grant replayed on another host → 401; an expired one → 401', async () => {
    const { f, row, ports, host } = await seeded()
    const other = await insertSession(db, f, { status: 'ready' })
    const cfg = loadConfig(previewEnv())
    const { token } = await mintGrant(cfg, { sessionId: row.id, userId: f.user.id, host })

    const elsewhere = await gateway(
      previewEnv(),
      ports,
      `http://${hostOf(other)}/__launch/grant?g=${token}`
    )
    expect(elsewhere.status).toBe(401)
    expect(await elsewhere.json()).toMatchObject({ code: 'preview_grant_invalid' })
    // The same session's other port is another host too.
    expect(
      (await gateway(previewEnv(), ports, `http://${hostOf(row, 8787)}/__launch/grant?g=${token}`))
        .status
    ).toBe(401)

    const late = new Date(Date.now() + 61_000)
    expect(
      (await gateway(previewEnv(), ports, `http://${host}/__launch/grant?g=${token}`, {}, late))
        .status
    ).toBe(401)
  })

  it('a valid grant → 302 + a host-only cookie, then the app is proxied, framable by Launch', async () => {
    const { f, row, ports, host } = await seeded()
    const cfg = loadConfig(previewEnv())
    const { token } = await mintGrant(cfg, { sessionId: row.id, userId: f.user.id, host })

    const exchanged = await gateway(previewEnv(), ports, `http://${host}/__launch/grant?g=${token}`)
    expect(exchanged.status).toBe(302)
    expect(exchanged.headers.get('Location')).toBe('/')
    expect(exchanged.headers.get('Referrer-Policy')).toBe('no-referrer')
    const setCookie = exchanged.headers.get('Set-Cookie') ?? ''
    // Development: `launch-preview`, Lax, not Secure; never a Domain (host-only).
    expect(setCookie).toMatch(
      /^launch-preview=[\w-]+\.[\w-]+; Path=\/; HttpOnly; Max-Age=\d+; SameSite=Lax$/
    )
    expect(setCookie).not.toMatch(/Domain=/i)
    const cookie = setCookie.split(';')[0] as string

    const page = await gateway(previewEnv(), ports, `http://${host}/src/main.tsx`, {
      headers: { Cookie: `${cookie}; theme=dark` },
    })
    expect(page.status).toBe(200)
    const body = await page.text()
    expect(body).toContain('<h1>app</h1>')
    // The app sees its own cookies, never Launch's.
    expect(body).toContain('cookie:theme=dark ')
    expect(body).toContain('path:/src/main.tsx')
    expect(page.headers.get('X-Frame-Options')).toBeNull()
    expect(page.headers.get('Content-Security-Policy')).toBe(
      "default-src 'self'; frame-ancestors http://localhost:3001"
    )
    // Never cached — not by the browser, not at the edge: a reload after a resume must not get
    // the stylesheet from before the session's edits (HMR only ever fetched fresh `?t=` URLs).
    expect(page.headers.get('Cache-Control')).toBe('no-store, private')
    expect(page.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(ports.sandboxes.get(row.id)?.fetches).toEqual([
      { port: 5173, url: `http://${host}/src/main.tsx`, method: 'GET' },
    ])
  })

  it('in production the cookie is __Host-, Secure, SameSite=None and Partitioned', async () => {
    const { f, row, ports, host } = await seeded()
    const env = createTestEnv({
      SESSION_PREVIEW_URL: TEMPLATE,
      APP_ENV: 'staging',
    } as Partial<TestEnv>)
    const cfg = loadConfig(env)
    const { token } = await mintGrant(cfg, { sessionId: row.id, userId: f.user.id, host })
    const res = await gateway(env, ports, `http://${host}/__launch/grant?g=${token}`)
    expect(res.headers.get('Set-Cookie')).toMatch(
      /^__Host-launch-preview=.+; Path=\/; HttpOnly; Max-Age=\d+; Secure; SameSite=None; Partitioned$/
    )
  })

  it('an ended session → 410; a suspended one → 503; the SDK’s own port is never reachable', async () => {
    const { f, row, ports, host } = await seeded('suspended')
    const cookie = await cookieFor(row, f.user.id)
    const suspended = await gateway(previewEnv(), ports, `http://${host}/`, { headers: cookie })
    expect(suspended.status).toBe(503)
    expect(await suspended.json()).toMatchObject({ code: 'preview_unavailable' })

    const ended = await insertSession(db, f, { status: 'ended', endedAt: new Date() })
    const gone = await gateway(previewEnv(), ports, `http://${hostOf(ended)}/`, {
      headers: await cookieFor(ended, f.user.id),
    })
    expect(gone.status).toBe(410)

    const ready = await insertSession(db, f, { status: 'ready' })
    const control = await gateway(previewEnv(), ports, `http://${hostOf(ready, 3000)}/`, {
      headers: await cookieFor(ready, f.user.id, hostOf(ready, 3000)),
    })
    expect(control.status).toBe(404)
    expect(ports.sandboxes.get(ready.id)?.fetches ?? []).toHaveLength(0)
  })

  it('caches a session’s status for 15 s in the isolate', async () => {
    const { f, row, ports, host } = await seeded()
    const cookie = await cookieFor(row, f.user.id)
    expect(
      (await gateway(previewEnv(), ports, `http://${host}/`, { headers: cookie })).status
    ).toBe(200)
    const { sessions } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.update(sessions).set({ status: 'ended' }).where(eq(sessions.id, row.id))
    expect(
      (await gateway(previewEnv(), ports, `http://${host}/`, { headers: cookie })).status
    ).toBe(200)
    const later = new Date(Date.now() + 16_000)
    expect(
      (await gateway(previewEnv(), ports, `http://${host}/`, { headers: cookie }, later)).status
    ).toBe(410)
  })

  it('hands a WebSocket upgrade (Vite HMR) to the sandbox and returns its answer untouched', async () => {
    const { f, row, ports, host } = await seeded()
    const upgrade = new Response('switching', {
      status: 200,
      headers: { 'X-Frame-Options': 'DENY' },
    })
    ports.sandbox(row.id)
    ports.sandboxes.get(row.id)?.onPort(5173, () => upgrade)
    const res = await gateway(previewEnv(), ports, `http://${host}/`, {
      headers: {
        ...(await cookieFor(row, f.user.id)),
        Upgrade: 'websocket',
        Connection: 'Upgrade',
      },
    })
    expect(res).toBe(upgrade)
  })

  it('worker.ts routes a preview host to the gateway: no cookie is a 401 envelope', async () => {
    const { host } = await seeded()
    const ctx = createExecutionContext()
    const res = await worker.fetch(
      new Request(`http://${host}/`) as Request<unknown, IncomingRequestCfProperties>,
      previewEnv(),
      ctx
    )
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
    expect(res.headers.get('X-Request-Id')).toBeNull()
  })
})

describe('the preview is the person’s activity', () => {
  const HOUR_AGO = () => new Date(Date.now() - 60 * 60_000)

  it('a proxied request moves a ready session’s last_activity_at, at most once a minute per isolate', async () => {
    const { f, row, ports, host } = await seeded('ready')
    const cookie = await cookieFor(row, f.user.id)
    await setActivity(row, HOUR_AGO())
    const t0 = new Date()
    expect(
      (await gateway(previewEnv(), ports, `http://${host}/`, { headers: cookie }, t0)).status
    ).toBe(200)
    expect((await activityOf(row))?.getTime()).toBe(t0.getTime())

    // Put it back: a second request inside the minute writes nothing (the isolate throttle).
    await setActivity(row, HOUR_AGO())
    const t1 = new Date(t0.getTime() + 10_000)
    await gateway(previewEnv(), ports, `http://${host}/app.js`, { headers: cookie }, t1)
    expect((await activityOf(row))?.getTime()).toBeLessThan(t0.getTime())

    // A minute on, it writes again.
    const t2 = new Date(t0.getTime() + PREVIEW_ACTIVITY_THROTTLE_MS + 1_000)
    await gateway(previewEnv(), ports, `http://${host}/`, { headers: cookie }, t2)
    expect((await activityOf(row))?.getTime()).toBe(t2.getTime())
  })

  it('an unauthenticated request, or a working session (the turn’s heartbeat), moves nothing', async () => {
    const { row, ports, host } = await seeded('ready')
    const old = HOUR_AGO()
    await setActivity(row, old)
    expect((await gateway(previewEnv(), ports, `http://${host}/`)).status).toBe(401)
    expect((await activityOf(row))?.getTime()).toBe(old.getTime())

    const working = await seeded('working')
    await setActivity(working.row, old)
    const cookie = await cookieFor(working.row, working.f.user.id)
    expect(
      (await gateway(previewEnv(), working.ports, `http://${working.host}/`, { headers: cookie }))
        .status
    ).toBe(200)
    expect((await activityOf(working.row))?.getTime()).toBe(old.getTime())
  })

  it('the write itself is throttled in the database, tenant-first and status-guarded', async () => {
    const { row } = await seeded('ready')
    const now = new Date()
    await setActivity(row, new Date(now.getTime() - 30_000))
    expect(await bumpPreviewActivity(db, row, now)).toBe(false)
    await setActivity(row, null)
    expect(await bumpPreviewActivity(db, { ...row, tenantId: crypto.randomUUID() }, now)).toBe(
      false
    )
    expect(await bumpPreviewActivity(db, row, now)).toBe(true)
    expect((await activityOf(row))?.getTime()).toBe(now.getTime())
    const { row: suspended } = await seeded('suspended')
    expect(await bumpPreviewActivity(db, suspended, now)).toBe(false)
  })
})

describe('POST /api/sessions/:id/preview-grant', () => {
  const post = (id: string, headers: Record<string, string>, env = previewEnv()) =>
    request(
      `/api/sessions/${id}/preview-grant`,
      { method: 'POST', headers: { ...headers, 'X-Requested-With': 'fetch' } },
      { env }
    )

  it('mints a grant the gateway exchanges; a stranger gets the same 404 as a missing session', async () => {
    const { f, row, ports, host } = await seeded()
    const res = await post(row.id, f.cookie)
    expect(res.status).toBe(200)
    const body = await json<{ url: string; expiresAt: string }>(res)
    const url = new URL(body.url)
    expect(url.host).toBe(host)
    expect(url.pathname).toBe('/__launch/grant')
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())

    const exchanged = await gateway(previewEnv(), ports, body.url)
    expect(exchanged.status).toBe(302)

    const stranger = await createTestUser(db)
    await linkUserToTenant(db, stranger.id, f.tenant.id, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, stranger.id, f.tenant.id))
    const hidden = await post(row.id, cookie)
    expect(hidden.status).toBe(404)
    expect(await json(hidden)).toMatchObject({ code: 'session_not_found' })
  })

  it('503 without SESSION_PREVIEW_URL; 409 once the session has ended', async () => {
    const { f, row } = await seeded()
    const off = await post(row.id, f.cookie, createTestEnv())
    expect(off.status).toBe(503)
    expect(await json(off)).toMatchObject({ code: 'previews_not_configured' })

    const ended = await insertSession(db, f, { status: 'shipped' })
    const res = await post(ended.id, f.cookie)
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'session_ended' })
  })
})
