// S1a: find the token-policy resource format for "Specified Workers" by trial.
// A token that is accepted proves nothing on its own, so each candidate is judged by behaviour:
// it must deploy rfspike-a and must be refused on rfspike-b.
import { need } from '../lib/env.mjs'
import { cf, sleep } from '../lib/http.mjs'
import { uploadWorker } from '../lib/worker.mjs'
import { record } from '../lib/created.mjs'

const { CF_ACCOUNT_ID: acc, CF_ADMIN_TOKEN: T } = need('CF_ACCOUNT_ID', 'CF_ADMIN_TOKEN')
const CF = cf(T)

const groups = (await CF('GET', `/accounts/${acc}/tokens/permission_groups`)).json.result
const group = (name) => groups.find((g) => g.name === name)
const scripts = (await CF('GET', `/accounts/${acc}/workers/scripts`)).json.result
const tag = (name) => scripts.find((s) => s.id === name).tag
const A = tag('rfspike-a')
const AS = tag('rfspike-a-staging')

const candidates = {
  'worker.<id>': { [`com.cloudflare.api.account.worker.${A}`]: '*', [`com.cloudflare.api.account.worker.${AS}`]: '*' },
  'worker.script.<id>': { [`com.cloudflare.api.account.worker.script.${A}`]: '*', [`com.cloudflare.api.account.worker.script.${AS}`]: '*' },
  'nested account → worker.<id>': {
    [`com.cloudflare.api.account.${acc}`]: { [`com.cloudflare.api.account.worker.${A}`]: '*', [`com.cloudflare.api.account.worker.${AS}`]: '*' },
  },
  'worker.<account>.<name>': { [`com.cloudflare.api.account.worker.${acc}.rfspike-a`]: '*', [`com.cloudflare.api.account.worker.${acc}.rfspike-a-staging`]: '*' },
}

const role = process.argv[2] ?? 'Workers Editor'
for (const [label, resources] of Object.entries(candidates)) {
  console.log(`\n=== ${label} (${role})`)
  const res = await CF('POST', `/accounts/${acc}/tokens`, {
    body: { name: `rfspike-probe ${label}`, policies: [{ effect: 'allow', resources, permission_groups: [{ id: group(role).id }] }] },
  })
  if (!res.ok) {
    console.log('  refused:', JSON.stringify(res.json?.errors ?? res.text).slice(0, 300))
    continue
  }
  record('cf.token', res.json.result.id, { name: `rfspike-probe ${label}` })
  const stored = (await CF('GET', `/accounts/${acc}/tokens/${res.json.result.id}`)).json.result.policies[0].resources
  console.log('  stored as:', JSON.stringify(stored))
  await sleep(5000) // token propagation
  const a = await uploadWorker(res.json.result.value, acc, 'rfspike-a', { label: 'probe→a' })
  const b = await uploadWorker(res.json.result.value, acc, 'rfspike-b', { label: 'probe→b' })
  const verdict = a.ok && b.status === 403 ? 'WORKS (a ok, b refused)' : `no (a ${a.status}, b ${b.status})`
  console.log(`  → ${verdict}`)
  if (!a.ok) console.log('    a error:', JSON.stringify(a.json?.errors).slice(0, 200))
}
