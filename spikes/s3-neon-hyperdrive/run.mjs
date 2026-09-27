// S3: pipeline steps 4-5 for one app (spec/06), timed.
// Neon: project (PG17) → app role + database → staging branch → direct/pooled URIs → project-scoped key.
// Cloudflare: Hyperdrive config on the direct URI → a Worker that queries through it, directly, and over HTTP.
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { need } from '../lib/env.mjs'
import { cf, neon, poll, publicGet } from '../lib/http.mjs'
import { ensureWildcard } from '../lib/worker.mjs'
import { record } from '../lib/created.mjs'
import postgres from './worker/node_modules/postgres/src/index.js'

const e = need('CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_ZONE_NAME', 'CF_ADMIN_TOKEN', 'NEON_API_KEY', 'NEON_ORG_ID')
const CF = cf(e.CF_ADMIN_TOKEN)
const neonRaw = neon(e.NEON_API_KEY)
// Neon locks a project while an operation runs and answers 423; a pipeline step must retry.
let locked423 = 0
const N = async (...args) => {
  for (let i = 0; ; i++) {
    const r = await neonRaw(...args)
    if (r.status !== 423 || i === 60) return r
    locked423++
    await new Promise((res) => setTimeout(res, 1000))
  }
}
const acc = e.CF_ACCOUNT_ID
const SLUG = 'rfspike-db'
const timings = {}
const time = async (label, fn) => {
  const t0 = Date.now()
  const out = await fn()
  timings[label] = Date.now() - t0
  return out
}
const must = (r) => {
  if (!r.ok) throw new Error(`${r.status} ${r.text.slice(0, 400)}`)
  return r.json
}
// Neon refuses mutations while an operation runs on the project (423), so wait for them.
const settle = (pid) =>
  poll(async () => (await N('GET', `/projects/${pid}/operations`)).json?.operations?.every((o) => ['finished', 'skipped', 'cancelled'].includes(o.status)), {
    every: 1000,
    timeout: 120000,
  })

// --- Neon ---------------------------------------------------------------------------------
const created = await time('neon: create project', async () =>
  must(await N('POST', '/projects', { body: { project: { name: SLUG, pg_version: 17, org_id: e.NEON_ORG_ID } } })),
)
const pid = created.project.id
record('neon.project', pid, { name: SLUG })
const main = created.branch
console.log(`project ${pid} region ${created.project.region_id}, main branch ${main.id}`)
await settle(pid)

await time('neon: role + database on main', async () => {
  const role = must(await N('POST', `/projects/${pid}/branches/${main.id}/roles`, { body: { role: { name: 'app' } } }))
  globalThis.mainPassword = role.role.password
  await settle(pid)
  must(await N('POST', `/projects/${pid}/branches/${main.id}/databases`, { body: { database: { name: 'app', owner_name: 'app' } } }))
  await settle(pid)
})

const staging = await time('neon: staging branch', async () => {
  const b = must(await N('POST', `/projects/${pid}/branches`, { body: { branch: { name: 'staging', parent_id: main.id }, endpoints: [{ type: 'read_write' }] } }))
  await settle(pid)
  return b.branch
})

const uri = async (branch, pooled) =>
  must(await N('GET', `/projects/${pid}/connection_uri?branch_id=${branch}&database_name=app&role_name=app&pooled=${pooled}`)).uri

const mainDirect = await uri(main.id, false)
const mainPooled = await uri(main.id, true)
const stagingDirectBefore = await uri(staging.id, false)

// Does the staging branch inherit main's role *with the same password*? If so, the spec's
// "dedicated role per branch" needs an explicit password reset after branching.
const stagingPw = new URL(stagingDirectBefore).password
console.log(`staging inherits main's app password: ${stagingPw === globalThis.mainPassword}`)
const reset = must(await N('POST', `/projects/${pid}/branches/${staging.id}/roles/app/reset_password`))
await settle(pid)
const stagingDirect = await uri(staging.id, false)
console.log(`after reset, staging password differs: ${new URL(stagingDirect).password !== globalThis.mainPassword} (${reset.role.name})`)

// Can the app role run migrations (the deploy job does, spec/06 step 10)?
await time('migrate as app role (direct)', async () => {
  const sql = postgres(mainDirect, { max: 1, onnotice: () => {} })
  await sql`create table if not exists spike (id serial primary key, note text)`
  await sql`create extension if not exists vector`
  await sql`insert into spike (note) values ('hello')`
  console.log('migrate: ok, rows =', (await sql`select count(*)::int as n from spike`)[0].n)
  await sql.end()
})
// And is main's old password really dead on staging?
try {
  const sql = postgres(stagingDirect.replace(new URL(stagingDirect).password, globalThis.mainPassword), { max: 1, connect_timeout: 10 })
  await sql`select 1`
  console.log('WARNING: main password still works on staging')
  await sql.end()
} catch (err) {
  console.log('main password refused on staging: yes (' + String(err.message).slice(0, 60) + ')')
}

// Project-scoped API key (spec/03 "optionally a project-scoped Neon API key").
const pkey = await N('POST', `/organizations/${e.NEON_ORG_ID}/api_keys`, { body: { key_name: SLUG, project_id: pid } })
if (!pkey.ok) {
  console.log(`project-scoped key with the org key: refused ${pkey.status}: ${pkey.json?.message}`)
} else {
  record('neon.apikey', String(pkey.json.id), { name: SLUG })
  const P = neon(pkey.json.key)
  const others = (await N('GET', `/projects?org_id=${e.NEON_ORG_ID}`)).json.projects.filter((p) => p.id !== pid)
  const own = await P('GET', `/projects/${pid}`)
  const other = others[0] ? await P('GET', `/projects/${others[0].id}`) : { status: 'n/a' }
  console.log(`project key: own project ${own.status}, other project ${other.status}`)
}

// --- Cloudflare ---------------------------------------------------------------------------
const u = new URL(mainDirect)
const hd = await time('hyperdrive: create config', async () =>
  must(
    await CF('POST', `/accounts/${acc}/hyperdrive/configs`, {
      body: {
        name: SLUG,
        origin: { scheme: 'postgres', host: u.hostname, port: 5432, database: 'app', user: 'app', password: decodeURIComponent(u.password) },
      },
    }),
  ).result,
)
record('cf.hyperdrive', hd.id, { name: SLUG })

const dir = join(import.meta.dirname, 'worker')
writeFileSync(
  join(dir, 'wrangler.toml'),
  `name = "${SLUG}"\nmain = "index.js"\ncompatibility_date = "2026-09-01"\ncompatibility_flags = ["nodejs_compat"]\nworkers_dev = false\n\n[[hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "${hd.id}"\n`,
)
await time('worker: wrangler deploy', async () =>
  execSync('pnpm dlx wrangler@latest deploy', {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: e.CF_ADMIN_TOKEN, CLOUDFLARE_ACCOUNT_ID: acc },
  }),
)
record('cf.worker', SLUG)

// Pipeline step 11: Worker secrets over the API on a Worker that now exists.
await time('worker: set secret via API', async () =>
  must(await CF('PUT', `/accounts/${acc}/workers/scripts/${SLUG}/secrets`, { body: { name: 'DATABASE_URL_POOLED', text: mainPooled, type: 'secret_text' } })),
)
await ensureWildcard(e.CF_ADMIN_TOKEN, e.CF_ZONE_ID, e.CF_ZONE_NAME, record)
const route = must(await CF('POST', `/zones/${e.CF_ZONE_ID}/workers/routes`, { body: { pattern: `${SLUG}.${e.CF_ZONE_NAME}/*`, script: SLUG } }))
record('cf.route', route.result.id, { pattern: `${SLUG}.${e.CF_ZONE_NAME}/*` })

const host = `https://${SLUG}.${e.CF_ZONE_NAME}`
const ready = await poll(async () => (await publicGet(`${host}/http`)).status === 200, { every: 2000, timeout: 120000 })
console.log(`host answering ${ready.ms}ms after route creation`)
const runs = { '/hyperdrive': [], '/direct': [], '/http': [], '/ws': [], '/http-tx': [] }
for (let i = 0; i < 5; i++) {
  for (const path of Object.keys(runs)) {
    const r = (await publicGet(host + path)).json ?? { error: 'no json' }
    runs[path].push(r)
  }
}
console.log('\nper-request query latency inside the Worker (ms, first query / second query / tenant-scope transaction):')
for (const [path, rs] of Object.entries(runs)) {
  const err = rs.find((r) => r.error)
  const fmt = (r) => [r.first, r.second, r.tx].filter((x) => x !== undefined).join('/')
  console.log(`  ${path.padEnd(12)} ${err ? 'ERROR ' + err.error : rs.map(fmt).join('  ')}  ${rs[0].tenant ? 'tenant=' + rs[0].tenant : ''}`)
}
console.log(`\nNeon 423 (project locked) retries: ${locked423}`)
console.log('\ntimings (ms):', JSON.stringify(timings, null, 1))
