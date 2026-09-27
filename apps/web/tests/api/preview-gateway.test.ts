/**
 * The preview gateway (Launch P3 slice 3d, plan §1.6): the grant → cookie exchange, the cookie on
 * every request, the proxy into the sandbox, and the headers that let Launch frame it — driven
 * through `handlePreview` with a `FakeSandbox` behind the ports, and through the real
 * `POST /api/sessions/:id/preview-grant` route.
 */
import { previewLabel, previewUrl } from '@launch/shared/launch-sessions'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearPreviewStatusCache, handlePreview, previewHostOf } from '@/api/preview/gateway'
import { mintCookie, mintGrant, verifyCookie, verifyGrant } from '@/api/services/sessions/preview'
import { loadConfig } from '@/config'
import type { SessionRow } from '@/db/schema'
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
  return handlePreview(req, env, createExecutionContext(), host, {
    ports: () => ports,
    ...(now ? { now: () => now } : {}),
  })
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

    const forged = await cookieFor(row, f.user.id)
    const tampered = forged.Cookie.replace(
      /launch-preview=([^.]+)\.(\w)/,
      (_m, p, c) => `launch-preview=${p}.${c === 'A' ? 'B' : 'A'}`
    )
    expect(
      (await gateway(previewEnv(), ports, `http://${host}/`, { headers: { Cookie: tampered } }))
        .status
    ).toBe(401)

    // Another session's cookie, presented on this host (its own host, and this host with its sid).
    const theirs = await cookieFor(other, f.user.id)
    expect(
      (await gateway(previewEnv(), ports, `http://${host}/`, { headers: theirs })).status
    ).toBe(401)
    const cfg = loadConfig(previewEnv())
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
