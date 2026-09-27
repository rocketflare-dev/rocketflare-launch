import { cf } from './http.mjs'

/** A tiny module Worker that reports which Worker served the request, and echoes cookies. */
export function echoWorker(name) {
  return `export default {
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/set-cookie') {
      return new Response('set', { headers: { 'set-cookie': '__Host-session=' + ${JSON.stringify(name)} + '; Path=/; Secure; HttpOnly; SameSite=Lax' } })
    }
    return Response.json({ worker: ${JSON.stringify(name)}, host: url.host, cookie: req.headers.get('cookie') })
  },
}
`
}

/** Upload a module Worker over the REST API (what wrangler deploy does), with optional bindings. */
export async function uploadWorker(token, accountId, name, { source = echoWorker(name), bindings = [], label } = {}) {
  const form = new FormData()
  form.append(
    'metadata',
    new Blob([JSON.stringify({ main_module: 'index.js', compatibility_date: '2026-09-01', bindings })], {
      type: 'application/json',
    }),
  )
  form.append('index.js', new Blob([source], { type: 'application/javascript+module' }), 'index.js')
  return cf(token)('PUT', `/accounts/${accountId}/workers/scripts/${name}`, { body: form, label })
}

/** The apps zone's one proxied wildcard record (spec/04); created once at setup in the real product. */
export async function ensureWildcard(token, zoneId, zoneName, record) {
  const CF = cf(token)
  const existing = (await CF('GET', `/zones/${zoneId}/dns_records?name=*.${zoneName}`)).json.result
  if (existing.length) return existing[0].id
  const r = await CF('POST', `/zones/${zoneId}/dns_records`, {
    body: { type: 'AAAA', name: '*', content: '100::', proxied: true, comment: 'rfspike wildcard' },
  })
  if (!r.ok) throw new Error(r.text)
  record('cf.dns', r.json.result.id, { name: `*.${zoneName}` })
  return r.json.result.id
}
