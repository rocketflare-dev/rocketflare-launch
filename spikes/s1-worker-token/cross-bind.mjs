// S1b: can app A's per-Worker token bind app B's resources into A's Worker and read them?
// Run after run.mjs (it reuses rfspike-a, rfspike-b, the minted token is re-minted here).
import { need } from '../lib/env.mjs'
import { cf, poll, publicGet, sleep } from '../lib/http.mjs'
import { uploadWorker } from '../lib/worker.mjs'
import { record } from '../lib/created.mjs'

const e = need('CF_ACCOUNT_ID', 'CF_ZONE_NAME', 'CF_ADMIN_TOKEN')
const acc = e.CF_ACCOUNT_ID
const ADMIN = cf(e.CF_ADMIN_TOKEN)
const must = (r) => {
  if (!r.ok) throw new Error(`${r.status} ${r.text.slice(0, 300)}`)
  return r.json
}

// App B's private data, put there by Launch/admin.
const kvB = must(await ADMIN('POST', `/accounts/${acc}/storage/kv/namespaces`, { body: { title: 'rfspike-b-kv' } })).result
record('cf.kv', kvB.id, { name: 'rfspike-b-kv' })
must(await ADMIN('PUT', `/accounts/${acc}/storage/kv/namespaces/${kvB.id}/values/secret`, { body: 'B-PRIVATE-DATA', headers: { 'content-type': 'text/plain' } }))
// App B's Worker, which trusts anything that reaches it (as apps behind their own routes might).
must(
  await uploadWorker(e.CF_ADMIN_TOKEN, acc, 'rfspike-b', {
    source: `export default { fetch() { return new Response('B-INTERNAL-RESPONSE') } }`,
  }),
)

// App A's token, as in run.mjs.
const tag = (n) => must(ADMIN_SCRIPTS).result.find((s) => s.id === n).tag
const ADMIN_SCRIPTS = await ADMIN('GET', `/accounts/${acc}/workers/scripts`)
const EDITOR = must(await ADMIN('GET', `/accounts/${acc}/tokens/permission_groups`)).result.find((g) => g.name === 'Individual Workers Editor').id
const minted = must(
  await ADMIN('POST', `/accounts/${acc}/tokens`, {
    body: {
      name: 'rfspike-a deploy (cross-bind)',
      policies: [
        {
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.${acc}`]: { [`com.cloudflare.edge.worker.script.${tag('rfspike-a')}`]: '*' } },
          permission_groups: [{ id: EDITOR }],
        },
      ],
    },
  }),
).result
record('cf.token', minted.id, { name: 'rfspike-a deploy (cross-bind)' })
await sleep(5000)

// A deploys itself with B's KV and a service binding to B.
const source = `export default {
  async fetch(req, env) {
    const kv = await env.B_KV.get('secret').catch((e) => 'error: ' + e.message)
    const svc = await env.B_SVC.fetch('https://internal/').then((r) => r.text()).catch((e) => 'error: ' + e.message)
    return Response.json({ worker: 'rfspike-a', stolenKv: kv, stolenService: svc })
  },
}`
const up = await uploadWorker(minted.value, acc, 'rfspike-a', {
  source,
  bindings: [
    { type: 'kv_namespace', name: 'B_KV', namespace_id: kvB.id },
    { type: 'service', name: 'B_SVC', service: 'rfspike-b' },
  ],
  label: 'app-token',
})
console.log(`A's token uploads A bound to B's KV + B's Worker: ${up.ok ? 'ALLOWED' : 'refused'} (${up.status}) ${up.ok ? '' : up.text.slice(0, 200)}`)
if (up.ok) {
  const r = await poll(async () => (await publicGet(`https://rfspike-a.${e.CF_ZONE_NAME}/`)).json?.stolenKv !== undefined && (await publicGet(`https://rfspike-a.${e.CF_ZONE_NAME}/`)).json, { every: 2000, timeout: 60000 })
  console.log('rfspike-a now returns:', JSON.stringify(r.value))
}
