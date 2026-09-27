// S2: flat, first-level hosts on the dedicated apps domain (spec/04).
// One proxied wildcard DNS record, a Worker route per app host, and a catch-all route to Launch.
// Asserts: each app host reaches its own Worker, unknown and preview-shaped hosts reach Launch,
// and TLS is valid everywhere via the zone's Universal SSL wildcard.
import { connect } from 'node:tls'
import { need } from '../lib/env.mjs'
import { cf, poll, publicGet, publicLookup } from '../lib/http.mjs'
import { record } from '../lib/created.mjs'
import { ensureWildcard } from '../lib/worker.mjs'

const { CF_ZONE_ID: zone, CF_ZONE_NAME: domain, CF_ADMIN_TOKEN: T } = need('CF_ZONE_ID', 'CF_ZONE_NAME', 'CF_ADMIN_TOKEN')
const CF = cf(T)

// 1. Wildcard DNS: a proxied AAAA to the discard prefix; the Worker routes answer, not an origin.
await ensureWildcard(T, zone, domain, record)

// 2. Routes. Launch's catch-all is created first, to show that order doesn't matter: specificity does.
const routes = [
  [`*.${domain}/*`, 'rfspike-launch'],
  [`rfspike-a.${domain}/*`, 'rfspike-a'],
  [`rfspike-a-staging.${domain}/*`, 'rfspike-a-staging'],
  [`rfspike-b.${domain}/*`, 'rfspike-b'],
]
const have = (await CF('GET', `/zones/${zone}/workers/routes`)).json.result
for (const [pattern, script] of routes) {
  if (have.some((r) => r.pattern === pattern)) continue
  const r = await CF('POST', `/zones/${zone}/workers/routes`, { body: { pattern, script } })
  if (!r.ok) throw new Error(r.text)
  record('cf.route', r.json.result.id, { pattern, script })
}

// 3. Who answers each host, and with what certificate?
function cert(host) {
  return new Promise((resolve) => {
    const s = connect({ host, port: 443, servername: host, lookup: publicLookup }, () => {
      const c = s.getPeerCertificate()
      resolve({ authorized: s.authorized, issuer: c.issuer?.O, san: c.subjectaltname })
      s.end()
    })
    s.on('error', (e) => resolve({ authorized: false, error: e.code ?? e.message }))
  })
}

const expect = [
  [`rfspike-a.${domain}`, 'rfspike-a'],
  [`rfspike-a-staging.${domain}`, 'rfspike-a-staging'],
  [`rfspike-b.${domain}`, 'rfspike-b'],
  [`nope-unknown.${domain}`, 'rfspike-launch'],
  [`3000-abc123def-tok16chars00000.${domain}`, 'rfspike-launch'],
]

let failures = 0
const t0 = Date.now()
for (const [host, want] of expect) {
  const { value, ms } = await poll(
    async () => {
      const r = await publicGet(`https://${host}/`)
      return r.status === 200 ? r.json : undefined
    },
    { every: 3000, timeout: 180000 },
  )
  const c = await cert(host)
  const ok = value?.worker === want && c.authorized
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${host} → ${value?.worker ?? 'no answer'} (want ${want}) · ready after ${ms}ms · TLS ${c.authorized ? 'valid' : 'INVALID ' + (c.error ?? '')} · ${c.issuer ?? ''} · ${c.san ?? ''}`,
  )
}
console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASS'} in ${Math.round((Date.now() - t0) / 1000)}s`)
process.exit(failures ? 1 : 0)
