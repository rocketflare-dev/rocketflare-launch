// S1: the per-app deploy token (spec/03, pipeline step 7).
// Launch mints an account token scoped to one app's two Workers (<slug>, <slug>-staging) with the
// "Individual Workers Editor" role, then we check what CI can and cannot do with it.
//
// Policy format (read back from a dashboard-made token, 2026-09-27):
//   resources: { "com.cloudflare.api.account.<acc>": { "com.cloudflare.edge.worker.script.<script tag>": "*" } }
//   permission group: "Individual Workers Editor" (scope com.cloudflare.edge.worker.script)
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { need } from '../lib/env.mjs'
import { cf, poll, publicGet, sleep } from '../lib/http.mjs'
import { echoWorker, ensureWildcard, uploadWorker } from '../lib/worker.mjs'
import { record } from '../lib/created.mjs'

const e = need('CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_ZONE_NAME', 'CF_ADMIN_TOKEN')
const acc = e.CF_ACCOUNT_ID
const zone = e.CF_ZONE_ID
const ADMIN = cf(e.CF_ADMIN_TOKEN)
const must = (r) => {
  if (!r.ok) throw new Error(`${r.status} ${r.text.slice(0, 300)}`)
  return r.json
}

// --- Setup, as Launch would do it with the admin token -------------------------------------
// The token names Workers by their script tag, so the Worker must exist before its token is minted:
// the pipeline has to upload a placeholder Worker before step 7, not wait for the first CI deploy.
for (const n of ['rfspike-a', 'rfspike-a-staging', 'rfspike-b']) {
  must(await uploadWorker(e.CF_ADMIN_TOKEN, acc, n, { label: 'admin' }))
  record('cf.worker', n)
}
const kv = must(await ADMIN('POST', `/accounts/${acc}/storage/kv/namespaces`, { body: { title: 'rfspike-a-kv' } })).result
record('cf.kv', kv.id, { name: 'rfspike-a-kv' })
await ensureWildcard(e.CF_ADMIN_TOKEN, zone, e.CF_ZONE_NAME, record)
const routes = {}
for (const n of ['rfspike-a', 'rfspike-b']) {
  const r = must(await ADMIN('POST', `/zones/${zone}/workers/routes`, { body: { pattern: `${n}.${e.CF_ZONE_NAME}/*`, script: n } })).result
  record('cf.route', r.id, { pattern: `${n}.${e.CF_ZONE_NAME}/*` })
  routes[n] = r.id
}

const scripts = must(await ADMIN('GET', `/accounts/${acc}/workers/scripts`)).result
const tag = (n) => scripts.find((s) => s.id === n).tag
const groups = must(await ADMIN('GET', `/accounts/${acc}/tokens/permission_groups`)).result
const EDITOR = groups.find((g) => g.name === 'Individual Workers Editor').id

const minted = must(
  await ADMIN('POST', `/accounts/${acc}/tokens`, {
    body: {
      name: 'rfspike-a deploy',
      policies: [
        {
          effect: 'allow',
          resources: {
            [`com.cloudflare.api.account.${acc}`]: {
              [`com.cloudflare.edge.worker.script.${tag('rfspike-a')}`]: '*',
              [`com.cloudflare.edge.worker.script.${tag('rfspike-a-staging')}`]: '*',
            },
          },
          permission_groups: [{ id: EDITOR }],
        },
      ],
    },
  }),
).result
record('cf.token', minted.id, { name: 'rfspike-a deploy' })
const TOKEN = minted.value
const APP = cf(TOKEN)
await sleep(5000)

// --- What can the app's token do? ---------------------------------------------------------
const results = []
const check = async (label, want, fn) => {
  const r = await fn()
  const got = r.ok ? 'allowed' : 'refused'
  results.push({ label, want, got, status: r.status })
  const err = r.ok ? '' : ` ${JSON.stringify(r.json?.errors?.[0]?.message ?? r.text?.slice(0, 120))}`
  console.log(`${got === want ? 'AS EXPECTED' : 'UNEXPECTED '} ${label}: ${got} (${r.status})${err}`)
}

await check('upload rfspike-a (REST)', 'allowed', () => uploadWorker(TOKEN, acc, 'rfspike-a'))
await check('upload rfspike-a-staging (REST)', 'allowed', () => uploadWorker(TOKEN, acc, 'rfspike-a-staging'))
await check('upload rfspike-a with a KV binding', 'allowed', () =>
  uploadWorker(TOKEN, acc, 'rfspike-a', { bindings: [{ type: 'kv_namespace', name: 'RATE_LIMIT_KV', namespace_id: kv.id }] }),
)
await check('upload rfspike-b (another app)', 'refused', () => uploadWorker(TOKEN, acc, 'rfspike-b'))
await check('create a new Worker rfspike-c', 'refused', () => uploadWorker(TOKEN, acc, 'rfspike-c'))
await check('read rfspike-b code', 'refused', () => APP('GET', `/accounts/${acc}/workers/scripts/rfspike-b/content/v2`))
await check('set a secret on rfspike-a', 'allowed', () =>
  APP('PUT', `/accounts/${acc}/workers/scripts/rfspike-a/secrets`, { body: { name: 'SPIKE', text: 'x', type: 'secret_text' } }),
)
await check('set a secret on rfspike-b', 'refused', () =>
  APP('PUT', `/accounts/${acc}/workers/scripts/rfspike-b/secrets`, { body: { name: 'SPIKE', text: 'x', type: 'secret_text' } }),
)
await check('delete rfspike-a-staging (Editor cannot delete)', 'refused', () => APP('DELETE', `/accounts/${acc}/workers/scripts/rfspike-a-staging`))
await check('create a route for rfspike-a', 'refused', () =>
  APP('POST', `/zones/${zone}/workers/routes`, { body: { pattern: `rfspike-a-extra.${e.CF_ZONE_NAME}/*`, script: 'rfspike-a' } }),
)
await check("point rfspike-b's route at rfspike-a (hijack)", 'refused', () =>
  APP('PUT', `/zones/${zone}/workers/routes/${routes['rfspike-b']}`, { body: { pattern: `rfspike-b.${e.CF_ZONE_NAME}/*`, script: 'rfspike-a' } }),
)
await check('read the KV namespace directly', 'refused', () => APP('GET', `/accounts/${acc}/storage/kv/namespaces/${kv.id}/keys`))

// --- The real CI path: wrangler deploy with the app's token --------------------------------
const dir = join(import.meta.dirname, 'wrangler-a')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'index.js'), echoWorker('rfspike-a').replace("worker: \"rfspike-a\"", 'worker: "rfspike-a", via: "wrangler"'))
writeFileSync(
  join(dir, 'wrangler.toml'),
  `name = "rfspike-a"\nmain = "index.js"\ncompatibility_date = "2026-09-01"\nworkers_dev = false\n\n[[kv_namespaces]]\nbinding = "RATE_LIMIT_KV"\nid = "${kv.id}"\n\n[vars]\nAPP_URL = "https://rfspike-a.${e.CF_ZONE_NAME}"\n`,
)
const wr = (cmd) => {
  try {
    const out = execSync(`pnpm dlx wrangler@latest ${cmd}`, {
      cwd: dir,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: acc, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
    return { ok: true, status: 0, text: out }
  } catch (err) {
    return { ok: false, status: err.status, text: `${err.stdout}${err.stderr}` }
  }
}
const dep = wr('deploy')
console.log(`${dep.ok ? 'AS EXPECTED' : 'UNEXPECTED '} wrangler deploy rfspike-a with the app token: ${dep.ok ? 'allowed' : 'refused'}`)
if (!dep.ok) console.log(dep.text.split('\n').filter((l) => /ERROR|error|Authentication|permission|403|10000/.test(l)).slice(0, 8).join('\n'))
results.push({ label: 'wrangler deploy', want: 'allowed', got: dep.ok ? 'allowed' : 'refused' })

const secret = wr('secret list')
console.log(`wrangler secret list with the app token: ${secret.ok ? 'allowed' : 'refused'}`)

// Did the route survive, and is the new code live?
const live = await poll(async () => (await publicGet(`https://rfspike-a.${e.CF_ZONE_NAME}/`)).json?.via === 'wrangler', { every: 2000, timeout: 60000 })
console.log(`rfspike-a serves the wrangler-deployed version via its Launch-owned route: ${!!live.value}`)
const tagAfter = must(await ADMIN('GET', `/accounts/${acc}/workers/scripts`)).result.find((s) => s.id === 'rfspike-a').tag
console.log(`script tag unchanged by redeploys (token stays valid): ${tagAfter === tag('rfspike-a')}`)

const bad = results.filter((r) => r.want !== r.got)
console.log(`\n${bad.length ? `${bad.length} UNEXPECTED` : 'ALL AS EXPECTED'} (${results.length} checks)`)
