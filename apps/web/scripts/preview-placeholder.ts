/**
 * Preview the placeholder Worker's launching page (issue #4) without launching an app:
 *
 *   pnpm web preview:placeholder [--name "Hola World"] [--port 4599] [--live-after 30]
 *
 * Serves the REAL generated module (`placeholderScript`) on localhost. Its `/api/health` answers
 * the placeholder's 503 until the app "goes live" — `GET /__preview/live` (or `--live-after <s>`)
 * — then 200, so an open page plays the lift-off and reloads into a stand-in app.
 * `GET /__preview/reset` puts it back on the pad. `curl` the same URL to see the plain-text 503.
 */
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'
import { placeholderScript } from '../src/api/services/launch/rocketflare/placeholder-worker'

const { values } = parseArgs({
  options: {
    name: { type: 'string', default: 'Hola World' },
    port: { type: 'string', default: '4599' },
    'live-after': { type: 'string' },
  },
})
const port = Number(values.port)
const origin = `http://localhost:${port}`

const toml = 'name = "preview"\ncompatibility_date = "2026-06-01"\n'
const source = String(placeholderScript(toml, { appName: values.name }).modules[0]?.content)
// The module as the runtime would run it, with `cloudflare:workers` stubbed.
const worker = new Function(
  source
    .replace(/^import .*$/m, 'class DurableObject {}; class WorkflowEntrypoint {}')
    .replace(/^export class /gm, 'class ')
    .replace(/^export default /m, 'return ')
)() as { fetch(request: Request): Promise<Response> }

let live = false
const goLive = () => {
  live = true
  console.log('→ live: /api/health now answers 200; an open page lifts off within ~12 s')
}
if (values['live-after']) setTimeout(goLive, Number(values['live-after']) * 1000)

const realApp = (name: string) =>
  `<!doctype html><meta charset="utf-8"><title>${name}</title><body style="font:18px system-ui;padding:3rem">
<h1>The real app would be here</h1><p>The deploy activated and the page reloaded into it.</p>
<p><a href="/__preview/reset">Back to the pad</a></p></body>`

createServer(async (req, res) => {
  const url = req.url ?? '/'
  if (url === '/__preview/live' || url === '/__preview/reset') {
    if (url.endsWith('live')) goLive()
    else live = false
    res.writeHead(302, { location: '/' }).end()
    return
  }
  if (live) {
    const health = url.startsWith('/api/')
    res.writeHead(200, { 'content-type': health ? 'application/json' : 'text/html' })
    res.end(health ? '{"status":"ok"}' : realApp(values.name))
    return
  }
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const response = await worker.fetch(new Request(origin + url, { method: req.method, headers }))
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(req.method === 'HEAD' ? undefined : await response.text())
}).listen(port, () => {
  console.log(`Placeholder preview for "${values.name}" (${source.length} bytes): ${origin}/`)
  console.log(`  ${origin}/__preview/live   simulate the first deploy activating`)
  console.log(`  ${origin}/__preview/reset  back to the pad`)
  console.log('  Light/dark and reduced motion follow your OS (or DevTools → Rendering).')
})
