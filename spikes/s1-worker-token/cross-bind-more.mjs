// S1c: the same cross-app binding test for R2, Queues and Hyperdrive.
// Hyperdrive matters most: Launch keeps it for its own registry, and a Hyperdrive binding hands the
// Worker a connection string with credentials.
import { need } from '../lib/env.mjs'
import { cf, neon, poll, publicGet, sleep } from '../lib/http.mjs'
import { uploadWorker } from '../lib/worker.mjs'
import { record } from '../lib/created.mjs'

const e = need('CF_ACCOUNT_ID', 'CF_ZONE_NAME', 'CF_ADMIN_TOKEN', 'NEON_API_KEY', 'NEON_ORG_ID')
const acc = e.CF_ACCOUNT_ID
const ADMIN = cf(e.CF_ADMIN_TOKEN)
const must = (r) => {
  if (!r.ok) throw new Error(`${r.status} ${r.text.slice(0, 300)}`)
  return r.json
}

// "Launch's" (or app B's) resources.
must(await ADMIN('POST', `/accounts/${acc}/r2/buckets`, { body: { name: 'rfspike-b-files' } }))
record('cf.r2', 'rfspike-b-files')
must(await ADMIN('PUT', `/accounts/${acc}/r2/buckets/rfspike-b-files/objects/private.txt`, { body: 'B-PRIVATE-FILE', headers: { 'content-type': 'text/plain' } }))
const q = must(await ADMIN('POST', `/accounts/${acc}/queues`, { body: { queue_name: 'rfspike-b-jobs' } })).result
record('cf.queue', q.queue_id, { name: 'rfspike-b-jobs' })

const N = neon(e.NEON_API_KEY)
const proj = must(await N('POST', '/projects', { body: { project: { name: 'rfspike-launch-registry', pg_version: 17, org_id: e.NEON_ORG_ID } } }))
record('neon.project', proj.project.id, { name: 'rfspike-launch-registry' })
const u = new URL(proj.connection_uris[0].connection_uri)
let hd
for (let i = 0; i < 20 && !hd; i++) {
  const r = await ADMIN('POST', `/accounts/${acc}/hyperdrive/configs`, {
    body: { name: 'rfspike-launch-registry', origin: { scheme: 'postgres', host: u.hostname.replace('-pooler', ''), port: 5432, database: u.pathname.slice(1), user: u.username, password: decodeURIComponent(u.password) } },
  })
  if (r.ok) hd = r.json.result
  else await sleep(3000)
}
record('cf.hyperdrive', hd.id, { name: 'rfspike-launch-registry' })

const scripts = must(await ADMIN('GET', `/accounts/${acc}/workers/scripts`)).result
const EDITOR = must(await ADMIN('GET', `/accounts/${acc}/tokens/permission_groups`)).result.find((g) => g.name === 'Individual Workers Editor').id
const minted = must(
  await ADMIN('POST', `/accounts/${acc}/tokens`, {
    body: {
      name: 'rfspike-a deploy (cross-bind-more)',
      policies: [
        {
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.${acc}`]: { [`com.cloudflare.edge.worker.script.${scripts.find((s) => s.id === 'rfspike-a').tag}`]: '*' } },
          permission_groups: [{ id: EDITOR }],
        },
      ],
    },
  }),
).result
record('cf.token', minted.id, { name: 'rfspike-a deploy (cross-bind-more)' })
await sleep(5000)

const source = `export default {
  async fetch(req, env) {
    const out = { worker: 'rfspike-a' }
    out.r2 = await env.B_FILES.get('private.txt').then((o) => o ? o.text() : null).catch((e) => 'error: ' + e.message)
    out.queue = await env.B_JOBS.send({ injected: true }).then(() => 'sent into B\\'s queue').catch((e) => 'error: ' + e.message)
    const cs = env.LAUNCH_DB.connectionString
    out.hyperdrive = cs ? 'got a connection string for ' + new URL(cs).username + '@' + env.LAUNCH_DB.host : 'none'
    return Response.json(out)
  },
}`
const up = await uploadWorker(minted.value, acc, 'rfspike-a', {
  source,
  bindings: [
    { type: 'r2_bucket', name: 'B_FILES', bucket_name: 'rfspike-b-files' },
    { type: 'queue', name: 'B_JOBS', queue_name: 'rfspike-b-jobs' },
    { type: 'hyperdrive', name: 'LAUNCH_DB', id: hd.id },
  ],
  label: 'app-token',
})
console.log(`A's token uploads A bound to B's R2 + B's Queue + Launch's Hyperdrive: ${up.ok ? 'ALLOWED' : 'refused'} (${up.status}) ${up.ok ? '' : up.text.slice(0, 300)}`)
if (up.ok) {
  const r = await poll(async () => {
    const j = (await publicGet(`https://rfspike-a.${e.CF_ZONE_NAME}/`)).json
    return j?.r2 !== undefined && j
  }, { every: 2000, timeout: 60000 })
  console.log('rfspike-a now returns:', JSON.stringify(r.value))
}
