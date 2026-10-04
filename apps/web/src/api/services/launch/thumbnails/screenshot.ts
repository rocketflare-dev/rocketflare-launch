/**
 * The thumbnail capture's PORT: "render this URL and give me a picture". The `app.thumbnail` job
 * (`queues/handlers/app-thumbnail.ts`) is written against `ScreenshotPort`, so its tests hand in a
 * fake and never touch a browser; `browserRenderingScreenshots` is the one real adapter.
 *
 * **The binding (`[browser] binding = "BROWSER"`, both tomls) is OPTIONAL in code**: without it
 * `defaultScreenshotPort` answers null, the job logs and acks, and apps show their initial. It is
 * the "check presence, don't crash" kind (`.claude/rules/cloudflare.md`) because a missing picture
 * loses nothing. Deployed it needs Workers Paid for sensible limits; under `wrangler dev` the binding
 * is local (wrangler downloads a headless Chrome on the first capture) unless `remote = true`.
 *
 * `@cloudflare/puppeteer` is imported in THIS file only, and lazily — the Node test run loads every
 * handler, and nothing there should load a browser client it never calls.
 *
 * What a capture does: a fresh browser (no cookies, no credentials — the app's unauthenticated `/`,
 * so an app behind sign-in shows its login page), a 1280×800 viewport, `goto` until `load` within
 * the timeout (a failure here THROWS: the job retries), then up to the rest of the budget for the
 * network to go quiet (a page that polls never does — it is captured as it stands), then one WebP
 * of the viewport (or a PNG, `format: 'png'` — a session's preview screenshot,
 * `services/sessions/preview-screenshot.ts`, which reuses this port). The browser is closed in `finally`, whatever happened, so a failed capture never
 * holds a session until its keep-alive runs out.
 */
import type { AppBindings } from '../../../types'

export interface ScreenshotRequest {
  /** Already validated by the caller (`captureTarget`): https, public, the app's own host. */
  url: string
  viewport: { width: number; height: number }
  /** The whole capture's budget, navigation included. */
  timeoutMs: number
  /**
   * `webp` (the default — a thumbnail) or lossless `png` (a session's preview screenshot, read by a
   * model: small text must survive).
   */
  format?: 'webp' | 'png'
}

export interface Screenshot {
  bytes: Uint8Array
  contentType: string
  /** Where the page ended up after redirects — logged, never navigated to again. */
  finalUrl: string
}

export interface ScreenshotPort {
  capture(request: ScreenshotRequest): Promise<Screenshot>
}

/** WebP quality: a 1280×800 page lands around 30–120 KB, which a list of thumbnails can afford. */
export const THUMBNAIL_WEBP_QUALITY = 70

/** How long the network must be quiet to count as idle (puppeteer's `idleTime`). */
const NETWORK_IDLE_MS = 500

/** What `puppeteer.launch` needs of the binding: its `fetch`. Structural, so a stub fits. */
export interface BrowserBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

/** A promise that rejects after `ms` — the hard stop around the whole capture. */
function deadline(
  ms: number,
  what: string
): { promise: Promise<never>; clear: () => void; expired: () => boolean } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let fired = false
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      fired = true
      reject(new Error(`${what} timed out after ${ms} ms`))
    }, ms)
  })
  // Raced, never awaited alone: a cleared deadline must not surface as an unhandled rejection.
  promise.catch(() => {})
  return { promise, clear: () => clearTimeout(timer), expired: () => fired }
}

/** How long a browser may take to come up before the capture fails (and the job retries). */
export const BROWSER_LAUNCH_TIMEOUT_MS = 30_000

/** The real adapter: Cloudflare Browser Rendering through `@cloudflare/puppeteer`. */
export function browserRenderingScreenshots(binding: BrowserBinding): ScreenshotPort {
  return {
    async capture({ url, viewport, timeoutMs, format = 'webp' }) {
      const { default: puppeteer } = await import('@cloudflare/puppeteer')
      // `BrowserWorker` is `{ fetch: typeof fetch }`; the binding's `fetch` is the same call with
      // the platform's narrower overloads, which TypeScript cannot see are compatible.
      // The launch has its own deadline: a browser that never comes up (a broken local Chrome under
      // `wrangler dev`, an exhausted concurrency limit) would otherwise hold the queue batch for ever.
      const launching = puppeteer.launch(binding as Parameters<typeof puppeteer.launch>[0])
      const launchStop = deadline(BROWSER_LAUNCH_TIMEOUT_MS, 'thumbnail browser launch')
      // A launch that loses the race but succeeds later still opens a browser: close it.
      launching.then(b => (launchStop.expired() ? b.close() : undefined)).catch(() => {})
      let browser: Awaited<typeof launching>
      try {
        browser = await Promise.race([launching, launchStop.promise])
      } finally {
        launchStop.clear()
      }
      // Started AFTER the launch: a cold browser is the platform's time, not the page's.
      const started = Date.now()
      const stop = deadline(timeoutMs + 5_000, 'thumbnail capture')
      try {
        const run = async (): Promise<Screenshot> => {
          const page = await browser.newPage()
          await page.setViewport(viewport)
          await page.goto(url, { waitUntil: 'load', timeout: timeoutMs })
          const left = Math.max(0, timeoutMs - (Date.now() - started))
          if (left > NETWORK_IDLE_MS) {
            // Best effort: a page holding a socket or polling never goes idle, and is pictured
            // as it stands when the budget runs out.
            await page
              .waitForNetworkIdle({ idleTime: NETWORK_IDLE_MS, timeout: left })
              .catch(() => {})
          }
          const shot =
            format === 'png'
              ? await page.screenshot({ type: 'png' })
              : await page.screenshot({ type: 'webp', quality: THUMBNAIL_WEBP_QUALITY })
          return {
            bytes: new Uint8Array(shot),
            contentType: format === 'png' ? 'image/png' : 'image/webp',
            finalUrl: page.url(),
          }
        }
        const work = run()
        // When the deadline wins, the page's own call rejects later, once the browser is closed:
        // that rejection is already accounted for and must not surface as an unhandled one.
        work.catch(() => {})
        return await Promise.race([work, stop.promise])
      } finally {
        stop.clear()
        await browser.close().catch(() => {})
      }
    },
  }
}

/** The binding's adapter, or null when this deployment has no `BROWSER` — the feature is absent. */
export function defaultScreenshotPort(env: Pick<AppBindings, 'BROWSER'>): ScreenshotPort | null {
  const binding = (env as { BROWSER?: BrowserBinding }).BROWSER
  return binding ? browserRenderingScreenshots(binding) : null
}
