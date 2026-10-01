/**
 * The placeholder Worker's generated module, RUN (issue #4): a browser gets the launching page,
 * still a 503; everything else gets today's plain-text 503. The DO-migration and Workflow-stub
 * metadata are covered against the kit's real tomls in `rocketflare-adapter.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import { escapeHtml, launchingPage } from '@/api/services/launch/rocketflare/placeholder-page'
import { placeholderScript } from '@/api/services/launch/rocketflare/placeholder-worker'

const TOML = `
name = "shop"
main = "src/worker.ts"
compatibility_date = "2026-06-01"

[[durable_objects.bindings]]
name = "HUB"
class_name = "Hub"

[[migrations]]
tag = "v1"
new_classes = ["Hub"]

[[workflows]]
name = "shop-flow"
binding = "FLOW"
class_name = "Flow"
`

const PLAIN = 'This app is being set up by Launch. Try again in a few minutes.'
const HOSTILE = `</script><script>alert("x")</script>'\`\${1} `

interface Handlers {
  fetch(request: Request): Promise<Response>
  queue(batch: { retryAll(o: unknown): void }): Promise<void>
  scheduled(): Promise<void>
}

function source(appName?: string): string {
  return String(
    placeholderScript(TOML, appName === undefined ? {} : { appName }).modules[0]?.content
  )
}

/** Evaluate the module as the runtime would, with `cloudflare:workers` stubbed. */
function load(appName?: string): Handlers {
  const body = source(appName)
    .replace(/^import .*$/m, 'class DurableObject {}; class WorkflowEntrypoint {}')
    .replace(/^export class /gm, 'class ')
    .replace(/^export default /m, 'return ')
  return new Function(body)() as Handlers
}

const get = (accept: string | null, path = '/', method = 'GET') =>
  new Request(`https://shop-staging.clewro.com${path}`, {
    method,
    headers: accept === null ? {} : { accept },
  })

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

describe('placeholder fetch', () => {
  it('serves a browser the launching page, still as an uncached 503', async () => {
    const res = await load('Hola World').fetch(get(BROWSER, '/dashboard'))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    // Launch's health probe tells "nothing deployed yet" from "down" by this header.
    expect(res.headers.get('x-launch-placeholder')).toBe('1')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await res.text()
    expect(html).toContain('<h1><span>Hola World</span> is launching</h1>')
    expect(html).toContain('<title>Hola World is launching</title>')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('<div class="sky" aria-hidden="true">')
    expect(html).toContain('fetch("/api/health"')
    expect(html).toContain('prefers-reduced-motion:reduce')
    expect(html).toContain('prefers-color-scheme:dark')
  })

  it('loads nothing from anywhere: no URLs, links, sources or fonts', async () => {
    const html = await (await load('Shop').fetch(get(BROWSER))).text()
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/<link|<img|\ssrc=|@import|@font-face|url\((?!#)/)
  })

  it.each([
    ['*/*', '/'],
    ['application/json', '/'],
    [null, '/'],
    [BROWSER, '/api/health'],
    [BROWSER, '/api/ready'],
  ])('answers %s on %s with today’s plain-text 503', async (accept, path) => {
    const res = await load('Shop').fetch(get(accept, path))
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('x-launch-placeholder')).toBe('1')
    expect(res.headers.get('retry-after')).toBe('60')
    expect(await res.text()).toBe(PLAIN)
  })

  it('answers a non-GET browser request with the plain text too', async () => {
    const res = await load('Shop').fetch(get(BROWSER, '/', 'POST'))
    expect(await res.text()).toBe(PLAIN)
  })

  it('keeps a hostile display name inert in the module and the page', async () => {
    // The module parsed at all (load), so the name did not break out of its JS string.
    const html = await (await load(HOSTILE).fetch(get(BROWSER))).text()
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;')
    expect(html.match(/<script>/g)).toHaveLength(1)
    // The page's own script compiles.
    const inline = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'))
    expect(() => new Function(inline)).not.toThrow()
  })

  it('falls back to a generic name, and escapes every HTML special', () => {
    expect(launchingPage('  ')).toContain('<h1><span>Your app</span> is launching</h1>')
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
    )
  })

  it('stays under the 30 KB budget, even with a long name', () => {
    expect(new TextEncoder().encode(source('x'.repeat(200))).length).toBeLessThan(30 * 1024)
  })

  it('keeps the queue retrying and the cron a no-op', async () => {
    const worker = load('Shop')
    const retryAll = vi.fn()
    await worker.queue({ retryAll })
    expect(retryAll).toHaveBeenCalledWith({ delaySeconds: 300 })
    await expect(worker.scheduled()).resolves.toBeUndefined()
  })
})
