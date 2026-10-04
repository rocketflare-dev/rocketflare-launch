/**
 * The holding page of an unclaimed subdomain: a deployed Launch's `*.<domain>/*` route brings every
 * host under the preview zone to this Worker, and one that is neither a session preview nor
 * `APP_URL`'s own gets a 404 — the rocket scene for a browser, one line of text otherwise — never
 * the Launch app. Driven through `worker.fetch`, as Cloudflare would.
 */
import { previewLabel, previewUrl } from '@launch/shared/launch-sessions'
import { describe, expect, it } from 'vitest'
import {
  UNCLAIMED_PAGE_CSP,
  UNCLAIMED_PLAIN,
  unclaimedHostOf,
  unclaimedHostPage,
} from '@/api/preview/unclaimed-host'
import worker from '@/worker'
import {
  createExecutionContext,
  createTestEnv,
  type TestEnv,
  waitOnExecutionContext,
} from '../mocks/bindings'

const TEMPLATE = 'https://{label}.clewro.com'
const APP_URL = 'https://launch.clewro.com'
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

function deployedEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return createTestEnv({
    APP_ENV: 'staging',
    APP_URL,
    SESSION_PREVIEW_URL: TEMPLATE,
    ...overrides,
  })
}

async function fetchVia(env: TestEnv, url: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request(url, init) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx
  )
  await waitOnExecutionContext(ctx)
  return res
}

describe('an unclaimed host under the preview zone', () => {
  it('gives a browser the holding page: a 404, uncached, noindex, under a script-free CSP', async () => {
    const res = await fetchVia(deployedEnv(), 'https://bob.clewro.com/some/path', {
      headers: { Accept: BROWSER },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex')
    // The Hono app never ran: none of its middleware's headers.
    expect(res.headers.get('X-Request-Id')).toBeNull()
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toBe(UNCLAIMED_PAGE_CSP)
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain('connect-src')
    expect(csp).not.toContain('script-src')
    expect(csp).toContain("frame-ancestors 'none'")

    const html = await res.text()
    expect(html).toContain('<p class="kicker">Launch</p>')
    expect(html).toContain('<h1>Nothing has launched here <span>yet</span></h1>')
    expect(html).toContain('<span class="host">bob.clewro.com</span> isn’t in use.')
    expect(html).toContain('<a class="go-launch" href="https://launch.clewro.com">Go to Launch</a>')
    expect(html).toContain('<div class="sky" aria-hidden="true">')
    expect(html).toContain('prefers-reduced-motion:reduce')
    expect(html).toContain('prefers-color-scheme:dark')
  })

  it('runs no script and polls nothing: no checklist, no health check, no reload', async () => {
    const html = await (
      await fetchVia(deployedEnv(), 'https://bob.clewro.com/', { headers: { Accept: BROWSER } })
    ).text()
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/fetch\(|\/api\/health|location\.reload|setInterval/)
    expect(html).not.toContain('class="checks"')
    // The only URL on the page is the way to Launch.
    expect(html.match(/https?:\/\/[^"<\s]+/g)).toEqual([APP_URL])
    expect(html).not.toMatch(/<link|<img|\ssrc=|@import|@font-face|url\((?!#)/)
  })

  it.each([
    ['*/*', 'GET'],
    ['application/json', 'GET'],
    [null, 'GET'],
    [BROWSER, 'POST'],
  ])('answers %s on %s with the plain-text 404', async (accept, method) => {
    const res = await fetchVia(deployedEnv(), 'https://bob.clewro.com/api/health', {
      method,
      headers: accept === null ? {} : { Accept: accept },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(await res.text()).toBe(UNCLAIMED_PLAIN)
  })

  it('answers HEAD with the page’s headers and no body', async () => {
    const res = await fetchVia(deployedEnv(), 'https://bob.clewro.com/', {
      method: 'HEAD',
      headers: { Accept: BROWSER },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(await res.text()).toBe('')
  })

  it('treats a deeper or upper-cased host under the zone the same', async () => {
    const res = await fetchVia(deployedEnv(), 'https://A.B.Clewro.COM/', {
      headers: { Accept: BROWSER },
    })
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('<span class="host">a.b.clewro.com</span>')
  })

  it('keeps a hostile host inert: escaped, in text nodes only', async () => {
    // The URL parser lets these through in a host; `<` and `>` it refuses outright.
    const res = await fetchVia(deployedEnv(), `https://a&b"c'd\`e.clewro.com/`, {
      headers: { Accept: BROWSER },
    })
    const html = await res.text()
    expect(html).toContain('<span class="host">a&amp;b&quot;c&#39;d`e.clewro.com</span>')
    expect(html).toContain('<div class="sign">a&amp;b&quot;c&#39;d`e.clewro.com</div>')
    expect(html).not.toContain(`a&b"c'd`)

    // And the page builder escapes what a URL could never carry.
    const page = unclaimedHostPage('<img src=x onerror=alert(1)>.clewro.com', APP_URL)
    expect(page).not.toContain('<img')
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;.clewro.com')
  })
})

describe('everything else reaches the app or the gateway unchanged', () => {
  it('APP_URL’s own host is the Launch app', async () => {
    const res = await fetchVia(deployedEnv(), `${APP_URL}/api/health`, {
      headers: { Accept: BROWSER },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
    expect(await res.json()).toMatchObject({ status: 'ok', env: 'staging' })
  })

  it('a session preview host goes to the preview gateway, not the holding page', async () => {
    const label = previewLabel(5173, 'abcdefghijkl', '0123456789')
    const res = await fetchVia(deployedEnv(), `${previewUrl(TEMPLATE, label)}/`, {
      headers: { Accept: BROWSER },
    })
    // No such session: the gateway's own JSON 404, never the page.
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'preview_not_found' })
  })

  it.each([
    ['a workers.dev host', 'https://launch.acme.workers.dev/api/health'],
    ['localhost', 'http://localhost:3001/api/health'],
    ['the zone apex', 'https://clewro.com/api/health'],
    ['another domain', 'https://bob.example.com/api/health'],
    ['a look-alike suffix', 'https://bobclewro.com/api/health'],
  ])('%s is the Launch app', async (_, url) => {
    const res = await fetchVia(deployedEnv(), url)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
  })

  it('in development every host is the app', async () => {
    const env = deployedEnv({ APP_ENV: 'development' })
    expect(unclaimedHostOf(new Request('https://bob.clewro.com/'), env)).toBeNull()
    const res = await fetchVia(env, 'https://bob.clewro.com/api/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
  })

  it('without a preview domain, or with a config that does not load, nothing is unclaimed', () => {
    const req = new Request('https://bob.clewro.com/')
    expect(unclaimedHostOf(req, deployedEnv({ SESSION_PREVIEW_URL: undefined }))).toBeNull()
    expect(unclaimedHostOf(req, deployedEnv({ APP_URL: 'not a url' }))).toBeNull()
    expect(unclaimedHostOf(req, deployedEnv())).toEqual({
      host: 'bob.clewro.com',
      appUrl: APP_URL,
    })
  })
})
