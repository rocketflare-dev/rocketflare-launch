/**
 * The preview bridge (plan §4): how Launch learns which page its preview frame is on. The frame is
 * another origin, so Launch cannot read its `location`; instead the gateway (`gateway.ts`) injects
 * `<script src="/__launch/bridge.js">` into every HTML page it proxies, and that script posts the
 * page's path to Launch's window — on load, after `history.pushState` / `replaceState`, and on
 * `popstate` / `hashchange`. `PreviewFrame` checks the sender and keeps the path: the address pill
 * shows it, a reload mints its grant with it (`to=`), and a screenshot can be taken of it.
 *
 * - **The target origin is baked in** from `APP_URL` when the script is served — never `'*'`, so a
 *   page framed anywhere else posts to nobody. The message is `previewLocationMessageSchema`.
 * - **Same-origin, so `'self'` covers it**: the script is served by the preview host itself. An
 *   app whose CSP `script-src` (or `script-src-elem`, or `default-src` without either) leaves out
 *   `'self'` — or carries `'strict-dynamic'`, which makes `'self'` ignored — blocks it; the page
 *   still works, and Launch just does not learn its path (the pill shows the host alone).
 * - **What is rewritten**: a 200 `text/html` answer to a GET, not encoded (`Content-Encoding`
 *   absent or `identity` — a dev server does not compress; a compressed body is passed through
 *   rather than risk a rewrite of bytes it cannot read). It loses `Content-Length`, which the
 *   rewrite makes wrong. Everything else — modules, assets, HMR upgrades, event streams — streams
 *   through untouched.
 * - **Where**: first thing in `<head>`, so it runs before the app's own scripts patch `history`;
 *   with no `<head>`, first in `<body>`; with neither (a fragment), at the end of the document.
 */
import { PREVIEW_LOCATION_MESSAGE } from '@launch/shared/launch-sessions'

/** Where the gateway serves the script. Namespaced with the grant, never an app route. */
export const PREVIEW_BRIDGE_PATH = '/__launch/bridge.js'
/** The tag injected into HTML pages. */
export const PREVIEW_BRIDGE_TAG = `<script src="${PREVIEW_BRIDGE_PATH}"></script>`
/** The script only changes with `APP_URL` (a deploy); a few minutes in the browser is plenty. */
export const PREVIEW_BRIDGE_MAX_AGE_S = 300

/** The script's source, posting to `targetOrigin` only. Pure; ES5 so any page can run it. */
export function bridgeScript(targetOrigin: string): string {
  return `(function () {
  if (window.parent === window || window.__launchPreviewBridge) return;
  window.__launchPreviewBridge = true;
  var target = ${JSON.stringify(targetOrigin)};
  var last = null;
  function post() {
    var path = location.pathname + location.search + location.hash;
    if (path === last) return;
    last = path;
    try {
      window.parent.postMessage({ type: ${JSON.stringify(PREVIEW_LOCATION_MESSAGE)}, path: path }, target);
    } catch (e) {}
  }
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function () {
      var result = original.apply(this, arguments);
      post();
      return result;
    };
  });
  window.addEventListener('popstate', post);
  window.addEventListener('hashchange', post);
  post();
})();
`
}

/** `GET /__launch/bridge.js`: the script for Launch at `appOrigin`. */
export function bridgeResponse(appOrigin: string): Response {
  return new Response(bridgeScript(appOrigin), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': `private, max-age=${PREVIEW_BRIDGE_MAX_AGE_S}`,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/** Whether `res` (the answer to `req`) is a page the bridge goes into. */
export function shouldInjectBridge(req: Request, res: Response): boolean {
  if (req.method !== 'GET' || res.status !== 200 || !res.body) return false
  const type = res.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
  if (type !== 'text/html') return false
  const encoding = res.headers.get('Content-Encoding')?.trim().toLowerCase()
  return !encoding || encoding === 'identity'
}

/**
 * `res` with the bridge's tag first in `<head>` (else `<body>`, else at the end). The caller has
 * already dropped `Content-Length`. Streams: HTMLRewriter never buffers the page.
 */
export function injectBridge(res: Response): Response {
  let injected = false
  const prepend: HTMLRewriterElementContentHandlers = {
    element(el) {
      if (injected) return
      injected = true
      el.prepend(PREVIEW_BRIDGE_TAG, { html: true })
    },
  }
  return new HTMLRewriter()
    .on('head', prepend)
    .on('body', prepend)
    .onDocument({
      end(end) {
        if (!injected) end.append(PREVIEW_BRIDGE_TAG, { html: true })
      },
    })
    .transform(res)
}
