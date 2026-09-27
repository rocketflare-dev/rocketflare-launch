// S5: deploying through Launch, from a private repo on a non-Enterprise GitHub org (spec/08).
//   node s5-deploy-via-launch/run.mjs setup   create everything
//   node s5-deploy-via-launch/run.mjs test    run scenarios A-D against it
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { need } from '../lib/env.mjs'
import { cf, gh, ghInstallationToken, neon, poll, publicGet, sleep } from '../lib/http.mjs'
import { ensureWildcard, uploadWorker } from '../lib/worker.mjs'
import { listCreated, record } from '../lib/created.mjs'

const e = need('CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_ZONE_NAME', 'CF_ADMIN_TOKEN', 'NEON_API_KEY', 'NEON_ORG_ID', 'GH_ORG', 'GH_APP_ID', 'GH_APP_PRIVATE_KEY_PATH', 'GH_APP_INSTALLATION_ID')
const acc = e.CF_ACCOUNT_ID
const ADMIN = cf(e.CF_ADMIN_TOKEN)
const N0 = neon(e.NEON_API_KEY)
const N = async (...a) => {
  for (let i = 0; ; i++) {
    const r = await N0(...a)
    if (r.status !== 423 || i > 30) return r
    await sleep(1000)
  }
}
const must = (r) => {
  if (!r.ok) throw new Error(`${r.status} ${r.text.slice(0, 400)}`)
  return r.json
}
const HERE = import.meta.dirname
const REPO = 'rfspike-deploy'
const STATE = join(HERE, '.state.json')
const host = (n) => `https://${n}.${e.CF_ZONE_NAME}`
const G = gh(await ghInstallationToken({ appId: e.GH_APP_ID, keyPath: e.GH_APP_PRIVATE_KEY_PATH, installationId: e.GH_APP_INSTALLATION_ID }))

async function setup() {
  // --- Neon: one project, main = production, staging branch; roles migrator (owner) + app --------
  const p = must(await N('POST', '/projects', { body: { project: { name: REPO, pg_version: 17, org_id: e.NEON_ORG_ID, region_id: 'aws-us-east-1' } } }))
  const pid = p.project.id
  record('neon.project', pid, { name: REPO })
  const main = p.branch.id
  for (const role of ['migrator', 'app']) must(await N('POST', `/projects/${pid}/branches/${main}/roles`, { body: { role: { name: role } } }))
  must(await N('POST', `/projects/${pid}/branches/${main}/databases`, { body: { database: { name: 'app', owner_name: 'migrator' } } }))
  const staging = must(await N('POST', `/projects/${pid}/branches`, { body: { branch: { name: 'staging', parent_id: main }, endpoints: [{ type: 'read_write' }] } })).branch.id
  for (const role of ['migrator', 'app']) must(await N('POST', `/projects/${pid}/branches/${staging}/roles/${role}/reset_password`))
  const appUri = async (b) => must(await N('GET', `/projects/${pid}/connection_uri?branch_id=${b}&database_name=app&role_name=app&pooled=true`)).uri

  // --- Cloudflare: KV per environment, plus another app's KV to try to steal -------------------
  const kv = {}
  for (const t of ['rfspike-app-kv', 'rfspike-app-staging-kv', 'rfspike-other-app-kv']) {
    kv[t] = must(await ADMIN('POST', `/accounts/${acc}/storage/kv/namespaces`, { body: { title: t } })).result.id
    record('cf.kv', kv[t], { name: t })
  }

  // --- Pipeline step 7 + 10: placeholder Workers, routes, secrets ------------------------------
  await ensureWildcard(e.CF_ADMIN_TOKEN, e.CF_ZONE_ID, e.CF_ZONE_NAME, record)
  for (const [script, branch] of [['rfspike-app', main], ['rfspike-app-staging', staging]]) {
    must(await uploadWorker(e.CF_ADMIN_TOKEN, acc, script))
    record('cf.worker', script)
    must(await ADMIN('PUT', `/accounts/${acc}/workers/scripts/${script}/secrets`, { body: { name: 'DATABASE_URL', text: await appUri(branch), type: 'secret_text' } }))
    const r = must(await ADMIN('POST', `/zones/${e.CF_ZONE_ID}/workers/routes`, { body: { pattern: `${script}.${e.CF_ZONE_NAME}/*`, script } }))
    record('cf.route', r.result.id, { pattern: `${script}.${e.CF_ZONE_NAME}/*` })
  }

  // --- The Launch stand-in ---------------------------------------------------------------------
  const registry = {
    repo: `${e.GH_ORG}/${REPO}`,
    environments: {
      staging: { script: 'rfspike-app-staging', policy: 'auto', kv: { RATE_LIMIT_KV: kv['rfspike-app-staging-kv'] }, neon: { project: pid, branch: staging } },
      production: { script: 'rfspike-app', policy: 'approval', kv: { RATE_LIMIT_KV: kv['rfspike-app-kv'] }, neon: { project: pid, branch: main } },
    },
  }
  const gwDir = join(HERE, 'gateway')
  writeFileSync(
    join(gwDir, 'wrangler.toml'),
    [
      'name = "rfspike-gw"',
      'main = "src/index.js"',
      'compatibility_date = "2026-09-01"',
      'workers_dev = false',
      '',
      '[vars]',
      `ACCOUNT_ID = "${acc}"`,
      'AUDIENCE = "rfspike-launch"',
      `REGISTRY = ${JSON.stringify(JSON.stringify(registry))}`,
      '',
      '[[durable_objects.bindings]]',
      'name = "TICKETS"',
      'class_name = "Tickets"',
      '',
      '[[migrations]]',
      'tag = "v1"',
      'new_sqlite_classes = ["Tickets"]',
      '',
    ].join('\n'),
  )
  execSync('pnpm dlx wrangler@latest deploy', { cwd: gwDir, stdio: 'inherit', env: { ...process.env, CLOUDFLARE_API_TOKEN: e.CF_ADMIN_TOKEN, CLOUDFLARE_ACCOUNT_ID: acc } })
  record('cf.worker', 'rfspike-gw')
  const adminKey = randomBytes(24).toString('hex')
  // In Launch this would be its own token for the apps account; the spike reuses the admin token.
  for (const [name, text] of [['CF_TOKEN', e.CF_ADMIN_TOKEN], ['NEON_API_KEY', e.NEON_API_KEY], ['ADMIN_KEY', adminKey]])
    must(await ADMIN('PUT', `/accounts/${acc}/workers/scripts/rfspike-gw/secrets`, { body: { name, text, type: 'secret_text' } }))
  const gwRoute = must(await ADMIN('POST', `/zones/${e.CF_ZONE_ID}/workers/routes`, { body: { pattern: `rfspike-gw.${e.CF_ZONE_NAME}/*`, script: 'rfspike-gw' } }))
  record('cf.route', gwRoute.result.id, { pattern: `rfspike-gw.${e.CF_ZONE_NAME}/*` })

  // --- The app repo: private, in the non-Enterprise org, no secrets anywhere --------------------
  const appDir = join(HERE, 'app-repo')
  const toml = (name, kvId) =>
    `name = "${name}"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\ncompatibility_flags = ["nodejs_compat"]\nworkers_dev = false\n\n[assets]\ndirectory = "./public"\nbinding = "ASSETS"\n\n[[kv_namespaces]]\nbinding = "RATE_LIMIT_KV"\nid = "${kvId}"\n`
  writeFileSync(join(appDir, 'wrangler.toml'), toml('rfspike-app', kv['rfspike-app-kv']))
  writeFileSync(join(appDir, 'wrangler.staging.toml'), toml('rfspike-app-staging', kv['rfspike-app-staging-kv']))
  // The attack from S1: the right Worker name, but another app's KV.
  writeFileSync(join(appDir, 'wrangler.evil.toml'), toml('rfspike-app-staging', kv['rfspike-other-app-kv']))

  must(await G('POST', `/orgs/${e.GH_ORG}/repos`, { body: { name: REPO, private: true, auto_init: true } }))
  record('gh.repo', REPO)
  await sleep(3000)
  const files = []
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (f === 'node_modules' || f === 'dist') continue
      if (statSync(p).isDirectory()) walk(p)
      else files.push(relative(appDir, p))
    }
  }
  walk(appDir)
  const ref = must(await G('GET', `/repos/${e.GH_ORG}/${REPO}/git/ref/heads/main`))
  const parent = must(await G('GET', `/repos/${e.GH_ORG}/${REPO}/git/commits/${ref.object.sha}`))
  const tree = must(
    await G('POST', `/repos/${e.GH_ORG}/${REPO}/git/trees`, {
      body: { base_tree: parent.tree.sha, tree: files.map((f) => ({ path: f, mode: '100644', type: 'blob', content: readFileSync(join(appDir, f), 'utf8') })) },
    }),
  )
  const commit = must(await G('POST', `/repos/${e.GH_ORG}/${REPO}/git/commits`, { body: { message: 'Start from the S5 spike app', tree: tree.sha, parents: [ref.object.sha] } }))
  must(await G('PATCH', `/repos/${e.GH_ORG}/${REPO}/git/refs/heads/main`, { body: { sha: commit.sha } }))
  for (const env of ['staging', 'production']) must(await G('PUT', `/repos/${e.GH_ORG}/${REPO}/environments/${env}`, { body: {} }))
  const v = await G('POST', `/repos/${e.GH_ORG}/${REPO}/actions/variables`, { body: { name: 'LAUNCH_URL', value: host('rfspike-gw') } })
  if (!v.ok) console.log(`repo variable: ${v.status} (the App needs the Variables permission); the workflow falls back to a default`)

  writeFileSync(STATE, JSON.stringify({ adminKey, pid, main, staging, kv }, null, 2))
  console.log(`\nsetup done: ${files.length} files pushed to ${e.GH_ORG}/${REPO}; gateway at ${host('rfspike-gw')}`)
}

// --- Scenarios ---------------------------------------------------------------------------------
const state = () => JSON.parse(readFileSync(STATE, 'utf8'))
const admin = (method, path) => publicGet(`${host('rfspike-gw')}/admin/${path}`, { 'x-admin-key': state().adminKey }, method)

async function dispatch(inputs) {
  const since = Date.now() - 5000
  for (let i = 0; i < 10; i++) {
    const r = await G('POST', `/repos/${e.GH_ORG}/${REPO}/actions/workflows/deploy.yml/dispatches`, { body: { ref: 'main', inputs } })
    if (r.ok) break
    await sleep(3000)
  }
  const { value } = await poll(
    async () => {
      const runs = (await G('GET', `/repos/${e.GH_ORG}/${REPO}/actions/workflows/deploy.yml/runs?per_page=10`)).json?.workflow_runs ?? []
      return runs.find((r) => Date.parse(r.created_at) >= since && !seen.has(r.id))
    },
    { every: 3000, timeout: 120000 },
  )
  seen.add(value.id)
  return value.id
}
const seen = new Set()

async function finished(runId) {
  const { value } = await poll(
    async () => {
      const r = (await G('GET', `/repos/${e.GH_ORG}/${REPO}/actions/runs/${runId}`)).json
      return r?.status === 'completed' && r
    },
    { every: 5000, timeout: 900000 },
  )
  const jobs = (await G('GET', `/repos/${e.GH_ORG}/${REPO}/actions/runs/${runId}/jobs`)).json.jobs
  const steps = jobs[0].steps.map((s) => `${s.conclusion === 'success' ? '✓' : s.conclusion === 'skipped' ? '·' : '✗'} ${s.name}`)
  const log = await G('GET', `/repos/${e.GH_ORG}/${REPO}/actions/jobs/${jobs[0].id}/logs`)
  return { conclusion: value.conclusion, steps, log: log.text ?? '' }
}
const logLines = (log, re) =>
  log
    .split('\n')
    .filter((l) => re.test(l))
    .map((l) => '      ' + l.replace(/^\S+Z /, '').slice(0, 220))
    .join('\n')

const appState = async (script) => (await publicGet(`${host(script)}/api/state`)).json
const results = []
const expectThat = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}`)
}

async function test() {
  // Local: a forged token.
  const forged = await publicGet(`${host('rfspike-gw')}/deploy/start`, { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJyZXBvc2l0b3J5IjoieCJ9.c2ln' }, 'POST')
  expectThat('a forged token is refused', forged.status === 401, `${forged.status} ${forged.text}`)

  // A: staging, automatic.
  console.log('\n--- A: staging (policy: automatic)')
  const a = await dispatch({ environment: 'staging' })
  const ra = await finished(a)
  console.log(ra.steps.join('\n'))
  console.log(logLines(ra.log, /another audience|ticket|upload:|activate:|migrated as|migrator password/))
  const sa = await appState('rfspike-app-staging')
  const html = (await publicGet(`${host('rfspike-app-staging')}/`)).text
  expectThat('A: run succeeded', ra.conclusion === 'success')
  expectThat('A: staging serves the static asset', /deployed through Launch/.test(html))
  expectThat('A: staging reads the row this run migrated, over its Worker secret (secret survived the deploy)', String(sa?.lastMigration?.run_id) === String(a), JSON.stringify(sa))
  expectThat('A: KV binding works', sa?.kv === true)

  // B: production waits for approval.
  console.log('\n--- B: production (policy: approval)')
  const b = await dispatch({ environment: 'production', wait_seconds: '600' })
  const pending = await poll(async () => (await admin('GET', 'tickets')).json?.find((t) => String(t.run_id) === String(b) && t.status === 'pending'), { every: 5000, timeout: 300000 })
  expectThat('B: the run opened a pending ticket in Launch', !!pending.value)
  await sleep(20000)
  const before = await publicGet(`${host('rfspike-app')}/api/state`)
  expectThat('B: production is untouched while waiting', before.json?.worker === 'rfspike-app' || before.json?.lastMigration === undefined, before.text.slice(0, 100))
  const t0 = Date.now()
  const approve = await admin('POST', `${pending.value.id}/approve`)
  expectThat('B: approved in Launch', approve.status === 200)
  const rb = await finished(b)
  console.log(rb.steps.join('\n'))
  const sb = await appState('rfspike-app')
  expectThat('B: run succeeded after approval', rb.conclusion === 'success', `${Math.round((Date.now() - t0) / 1000)}s from approval to done`)
  expectThat('B: production serves this run and its migration', String(sb?.lastMigration?.run_id) === String(b), JSON.stringify(sb))

  // C: production, never approved.
  console.log('\n--- C: production, never approved (a repo admin dispatching by hand gets this far)')
  const c = await dispatch({ environment: 'production', wait_seconds: '40' })
  const rc = await finished(c)
  console.log(rc.steps.join('\n'))
  console.log(logLines(rc.log, /no approval|waiting for approval/))
  const sc = await appState('rfspike-app')
  expectThat('C: run failed without approval', rc.conclusion === 'failure')
  expectThat('C: production still serves B, and no migration ran', String(sc?.lastMigration?.run_id) === String(b), JSON.stringify(sc?.lastMigration))

  // D: staging build that binds another app's KV.
  console.log("\n--- D: staging build binding another app's KV (the S1 attack)")
  const d = await dispatch({ environment: 'staging', toml: 'wrangler.evil.toml' })
  const rd = await finished(d)
  console.log(rd.steps.join('\n'))
  console.log(logLines(rd.log, /upload:/))
  const sd = await appState('rfspike-app-staging')
  expectThat('D: run failed at the hand-off', rd.conclusion === 'failure' && /refused|not registered/.test(rd.log))
  expectThat('D: staging still serves A, and no migration ran', String(sd?.lastMigration?.run_id) === String(a), JSON.stringify(sd?.lastMigration))

  const tickets = (await admin('GET', 'tickets')).json
  console.log('\ntickets:', tickets.map((t) => `${t.env}:${t.status}${t.result?.refused ? ' ' + t.result.refused.join(',') : ''}`).join(' · '))
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${bad.length ? `${bad.length} FAILED` : 'ALL PASS'} (${results.length} checks)`)
}

if (process.argv[2] === 'setup') await setup()
else if (process.argv[2] === 'test') await test()
else console.log('usage: run.mjs setup | test')
