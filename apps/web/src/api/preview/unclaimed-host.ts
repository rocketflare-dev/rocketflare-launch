/**
 * The holding page of an unclaimed subdomain. A deployed Launch carries the Worker route
 * `*.<preview domain>/*` so session previews (`SESSION_PREVIEW_URL`) reach it; an app Launch
 * creates has its own custom domain on `<slug>.<domain>`, which wins over the route. Every OTHER
 * host under that zone — a typo, an archived app, `bob.<domain>` — would otherwise fall through to
 * the Launch app itself. Instead it gets a 404: a browser the rocket scene saying nothing has
 * launched there, with a way to Launch; anything else one line of plain text.
 *
 * `src/worker.ts` asks `unclaimedHostOf` AFTER `previewHostOf`, so a preview host never gets here.
 * It is decided from config alone — no database: whether a slug IS an app is Cloudflare's to say
 * (its custom domain answers first), so a host that reaches this Worker is not one. Never in
 * `development`, where every `*.localhost` host is the dev server's.
 *
 * The page runs no script, polls nothing and loads nothing; its CSP says so. The host is the
 * request's — attacker-controlled — so it is HTML-escaped and lands only in text nodes.
 */
import { type AppConfig, loadConfig } from '../../config'
import { escapeHtml, scenePage } from '../services/launch/rocketflare/placeholder-page'
import type { AppBindings } from '../types'

/** No script, no fetch, no frames: only the inline styles the scene is made of. */
export const UNCLAIMED_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export const UNCLAIMED_PLAIN = 'Nothing is launched at this address.'

/** An unclaimed host: the request's host (lower-cased) and where Launch itself lives. */
export interface UnclaimedHost {
  host: string
  appUrl: string
}

/** The zone suffix after `{label}` in the template's host — `.clewro.com` — or null. */
function zoneSuffix(template: string): string | null {
  const templateHost = template.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? ''
  if (!templateHost.startsWith('{label}')) return null
  const suffix = templateHost.slice('{label}'.length).toLowerCase()
  return suffix.startsWith('.') && suffix.length > 1 ? suffix : null
}

/**
 * The unclaimed host a request names, or null when the app should answer: in development, when
 * the config does not load or names no preview domain, for `APP_URL`'s own host, and for any host
 * outside the preview zone (`workers.dev`, `localhost`, the zone apex, another domain).
 */
export function unclaimedHostOf(request: Request, env: AppBindings): UnclaimedHost | null {
  let cfg: AppConfig
  try {
    cfg = loadConfig(env)
  } catch {
    return null
  }
  if (cfg.APP_ENV === 'development' || !cfg.SESSION_PREVIEW_URL) return null
  const suffix = zoneSuffix(cfg.SESSION_PREVIEW_URL)
  if (!suffix) return null
  const host = new URL(request.url).host.toLowerCase()
  if (host.length <= suffix.length || !host.endsWith(suffix)) return null
  if (host === new URL(cfg.APP_URL).host.toLowerCase()) return null
  return { host, appUrl: new URL(cfg.APP_URL).origin }
}

/** The holding page, with the host escaped into its text nodes. */
export function unclaimedHostPage(host: string, appUrl: string): string {
  const name = escapeHtml(host)
  return scenePage({
    title: 'Nothing has launched here yet',
    sign: name,
    css: `
.host{color:var(--ink);font-weight:600;overflow-wrap:anywhere}
.go-launch{display:inline-block;margin-top:1.1rem;padding:.6rem 1.1rem;border-radius:.6rem;background:var(--primary);color:var(--bg);font-weight:700;text-decoration:none}
.go-launch:hover{filter:brightness(1.08)}
.go-launch:focus-visible{outline:3px solid var(--violet);outline-offset:3px}
`,
    main: `<p class="kicker">Launch</p>
<h1>Nothing has launched here <span>yet</span></h1>
<p class="lede"><span class="host">${name}</span> isn’t in use. If you expected an app here, find it in Launch.</p>
<a class="go-launch" href="${escapeHtml(appUrl)}">Go to Launch</a>`,
  })
}

/**
 * The answer for an unclaimed host: the page to a browser (`GET`/`HEAD` accepting `text/html`),
 * plain text to anything else, both 404 and `noindex`.
 *
 * NEVER cached — `Cache-Control: no-store` for the browser and `CDN-Cache-Control: no-store` for
 * Cloudflare's edge, on both answers: the moment an app or a preview is deployed at this host it
 * must answer, and a kept 404 would hide the new app from the very person who just created it.
 * The page is a few KB built from a template, so there is nothing worth caching.
 */
export function handleUnclaimedHost(request: Request, unclaimed: UnclaimedHost): Response {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'CDN-Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
  const accept = request.headers.get('Accept') ?? ''
  const head = request.method === 'HEAD'
  if ((request.method === 'GET' || head) && accept.includes('text/html')) {
    return new Response(head ? null : unclaimedHostPage(unclaimed.host, unclaimed.appUrl), {
      status: 404,
      headers: {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': UNCLAIMED_PAGE_CSP,
      },
    })
  }
  return new Response(head ? null : UNCLAIMED_PLAIN, {
    status: 404,
    headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
