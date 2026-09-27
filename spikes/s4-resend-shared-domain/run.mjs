// S4: one shared sending domain for every app (spec/04 Email, decided 2026-09-27).
// notifications.<zone> is created and verified once; each app gets its own sending_access key
// bound to it. Asserts what a key can and cannot do, and whether Resend records which key sent.
import { need } from '../lib/env.mjs'
import { cf, poll, resend, sleep } from '../lib/http.mjs'
import { record } from '../lib/created.mjs'

const e = need('CF_ZONE_ID', 'CF_ZONE_NAME', 'CF_ADMIN_TOKEN', 'RESEND_API_KEY')
const CF = cf(e.CF_ADMIN_TOKEN)
const R = async (...a) => {
  await sleep(600) // Resend's default rate limit is 2 requests per second
  return resend(e.RESEND_API_KEY)(...a)
}
const DOMAIN = `notifications.${e.CF_ZONE_NAME}`
const TO = 'delivered@resend.dev' // Resend's test sink: accepted and "delivered", reaches nobody

// 1. The shared domain, verified once (the setup wizard, not per app).
let domain = (await R('GET', '/domains')).json.data.find((d) => d.name === DOMAIN)
if (!domain) {
  const r = await R('POST', '/domains', { body: { name: DOMAIN } })
  if (!r.ok) throw new Error(r.text)
  domain = r.json
  record('resend.domain', domain.id, { name: DOMAIN })
  for (const rec of domain.records) {
    const name = rec.name.endsWith(e.CF_ZONE_NAME) ? rec.name : `${rec.name}.${e.CF_ZONE_NAME}`
    const d = await CF('POST', `/zones/${e.CF_ZONE_ID}/dns_records`, {
      body: { type: rec.type, name, content: rec.value, ttl: 1, proxied: false, ...(rec.priority !== undefined && { priority: rec.priority }), comment: 'rfspike resend' },
    })
    if (!d.ok) throw new Error(`dns ${rec.type} ${name}: ${d.text}`)
    record('cf.dns', d.json.result.id, { name })
  }
  console.log(`records written: ${domain.records.map((r) => `${r.record} ${r.type}`).join(', ')}`)
}
await R('POST', `/domains/${domain.id}/verify`)
const verified = await poll(async () => (await R('GET', `/domains/${domain.id}`)).json?.status === 'verified', { every: 10000, timeout: 900000 })
console.log(`domain ${DOMAIN}: ${verified.value ? 'verified' : 'NOT verified'} after ${Math.round(verified.ms / 1000)}s`)
if (!verified.value) process.exit(1)

// 2. One sending key per app, both bound to the shared domain.
const keys = {}
for (const app of ['rfspike-a', 'rfspike-b']) {
  const r = await R('POST', '/api-keys', { body: { name: app, permission: 'sending_access', domain_id: domain.id } })
  if (!r.ok) throw new Error(r.text)
  record('resend.key', r.json.id, { name: app })
  keys[app] = r.json
}
await sleep(3000)

const otherDomain = (await R('GET', '/domains')).json.data.find((d) => d.status === 'verified' && d.name !== DOMAIN)?.name
const send = async (key, from) => {
  await sleep(600)
  return resend(key.token)('POST', '/emails', {
    body: { from, to: [TO], subject: `rfspike S4 ${from}`, text: 'Launch spike S4. Safe to ignore.' },
  })
}

const cases = [
  ['A sends as its own address', keys['rfspike-a'], `rfspike-a@${DOMAIN}`, 'ok'],
  ['A sends as B (the known gap)', keys['rfspike-a'], `rfspike-b@${DOMAIN}`, 'ok'],
  ['A sends with a display name as B', keys['rfspike-a'], `"Payroll" <rfspike-b@${DOMAIN}>`, 'ok'],
  ...(otherDomain ? [['A sends from another verified domain', keys['rfspike-a'], `noreply@${otherDomain}`, 'refused']] : []),
]
const sent = []
for (const [label, key, from, want] of cases) {
  const r = await send(key, from)
  const got = r.ok ? 'ok' : 'refused'
  if (r.ok) sent.push({ id: r.json.id, from, key: key.id })
  console.log(`${got === want ? 'AS EXPECTED' : 'UNEXPECTED '} ${label}: ${r.status} ${r.ok ? '' : r.json?.message ?? r.text.slice(0, 120)}`)
}

// 3. A sending key must not read anything.
const readWithSendingKey = await resend(keys['rfspike-a'].token)('GET', '/domains')
console.log(`sending key can list domains: ${readWithSendingKey.ok} (${readWithSendingKey.status})`)

// 4. Can Launch tell, after the fact, which key sent each email?
await sleep(3000)
for (const s of sent) {
  const r = await R('GET', `/emails/${s.id}`)
  const keyFields = Object.keys(r.json ?? {}).filter((k) => /key|token|api/i.test(k))
  console.log(`email ${s.id} from ${s.from}: fields ${Object.keys(r.json ?? {}).join(',')} · key-ish fields: ${keyFields.join(',') || 'none'}`)
}
