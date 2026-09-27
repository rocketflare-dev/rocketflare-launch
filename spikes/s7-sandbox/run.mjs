// S7: session sandbox cold start (spec/07), with a Neon branch per session instead of local Postgres.
//   node s7-sandbox/run.mjs setup           Neon project + dev branch, KV, deploy Worker + image
//   node s7-sandbox/run.mjs time <id> [cold] time a session from nothing to a live preview
//   node s7-sandbox/run.mjs locked          egress allowlist, Neon TCP, Claude Code via the metering handler
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { need } from '../lib/env.mjs'
import { request as httpsRequest } from 'node:https'
import { cf, neon, poll, publicGet, publicLookup, sleep } from '../lib/http.mjs'
import { ensureWildcard } from '../lib/worker.mjs'
import { record } from '../lib/created.mjs'

const e = need('CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_ZONE_NAME', 'CF_ADMIN_TOKEN', 'NEON_API_KEY', 'NEON_ORG_ID', 'ANTHROPIC_API_KEY')
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
const STATE = join(HERE, '.state.json')
const state = () => JSON.parse(readFileSync(STATE, 'utf8'))
const API = `https://rfspike-sbx.${e.CF_ZONE_NAME}`
const KIT_TAG = '0.13.0'

async function setup() {
  const p = must(await N('POST', '/projects', { body: { project: { name: 'rfspike-sbx', pg_version: 17, org_id: e.NEON_ORG_ID, region_id: 'aws-us-east-1' } } }))
  record('neon.project', p.project.id, { name: 'rfspike-sbx' })
  // `dev`: the parent every session branches from. In Launch it would be seeded, never production data.
  const dev = must(await N('POST', `/projects/${p.project.id}/branches`, { body: { branch: { name: 'dev', parent_id: p.branch.id } } })).branch
  const kv = must(await ADMIN('POST', `/accounts/${acc}/storage/kv/namespaces`, { body: { title: 'rfspike-sbx-meter' } })).result
  record('cf.kv', kv.id, { name: 'rfspike-sbx-meter' })

  const dir = join(HERE, 'worker')
  // SSH for debugging a live session: a spike-only ed25519 key (spikes/.ssh, gitignored).
  const pub = readFileSync(join(HERE, '../.ssh/rfspike_ed25519.pub'), 'utf8').trim()
  const container = (cls) => `[[containers]]\nclass_name = "${cls}"\nimage = "./Dockerfile"\ninstance_type = "standard-3"\nmax_instances = 4\nssh = { enabled = true }\n[[containers.authorized_keys]]\nname = "rfspike"\npublic_key = "${pub}"\n`
  writeFileSync(
    join(dir, 'wrangler.toml'),
    [
      'name = "rfspike-sbx"',
      'main = "src/index.js"',
      'compatibility_date = "2026-09-01"',
      'compatibility_flags = ["nodejs_compat"]',
      'workers_dev = false',
      '',
      container('OpenSession'),
      container('LockedSession'),
      '[[durable_objects.bindings]]\nname = "OPEN"\nclass_name = "OpenSession"\n',
      '[[durable_objects.bindings]]\nname = "LOCKED"\nclass_name = "LockedSession"\n',
      '[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["OpenSession", "LockedSession"]\n',
      `[[kv_namespaces]]\nbinding = "METER"\nid = "${kv.id}"\n`,
      '[observability]\nenabled = true\n',
    ].join('\n'),
  )
  const t0 = Date.now()
  execSync('pnpm dlx wrangler@latest deploy', { cwd: dir, stdio: 'inherit', env: { ...process.env, CLOUDFLARE_API_TOKEN: e.CF_ADMIN_TOKEN, CLOUDFLARE_ACCOUNT_ID: acc } })
  console.log(`wrangler deploy (image build + push) took ${Math.round((Date.now() - t0) / 1000)}s`)
  record('cf.worker', 'rfspike-sbx')
  const adminKey = randomBytes(24).toString('hex')
  for (const [name, text] of [['ANTHROPIC_API_KEY', e.ANTHROPIC_API_KEY], ['ADMIN_KEY', adminKey]])
    must(await ADMIN('PUT', `/accounts/${acc}/workers/scripts/rfspike-sbx/secrets`, { body: { name, text, type: 'secret_text' } }))
  await ensureWildcard(e.CF_ADMIN_TOKEN, e.CF_ZONE_ID, e.CF_ZONE_NAME, record)
  // Previews ride Launch's catch-all: route wildcards are only allowed at the start of the hostname.
  for (const pattern of [`rfspike-sbx.${e.CF_ZONE_NAME}/*`, `*.${e.CF_ZONE_NAME}/*`]) {
    const r = must(await ADMIN('POST', `/zones/${e.CF_ZONE_ID}/workers/routes`, { body: { pattern, script: 'rfspike-sbx' } }))
    record('cf.route', r.result.id, { pattern })
  }
  writeFileSync(STATE, JSON.stringify({ adminKey, project: p.project.id, dev: dev.id, kv: kv.id }, null, 2))
  console.log('setup done')
}

const call = async (cls, id, op, body) => {
  const r = await publicGet(`${API}/x/${cls}/${id}/${op}`, { 'x-admin-key': state().adminKey, 'content-type': 'application/json' }, body ? 'POST' : 'GET', body && JSON.stringify(body))
  return r.json ?? { error: `${r.status} ${r.text?.slice(0, 300) ?? r.error}` }
}

let lastBranch
/** POST to the Worker's streaming exec; logs nothing, returns the NDJSON lines with their arrival times. */
function streamCall(cls, id, body) {
  return new Promise((resolve) => {
    const lines = []
    let buf = ''
    const req = httpsRequest(
      `${API}/x/${cls}/${id}/stream`,
      { method: 'POST', lookup: publicLookup, headers: { 'x-admin-key': state().adminKey, 'content-type': 'application/json' } },
      (res) => {
        res.on('data', (d) => {
          buf += d
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const l = buf.slice(0, i)
            buf = buf.slice(i + 1)
            try {
              lines.push(JSON.parse(l))
            } catch {}
          }
        })
        res.on('end', () => resolve(lines))
      },
    )
    req.on('error', (e) => resolve([{ error: e.message }]))
    req.end(JSON.stringify(body))
  })
}

/** A Neon branch for one session, from `dev`: returns its direct URI and host. */
async function sessionBranch(name, prepared) {
  const { project, dev: emptyDev, preparedDev } = state()
  const dev = prepared ? preparedDev : emptyDev
  const t0 = Date.now()
  const b = must(await N('POST', `/projects/${project}/branches`, { body: { branch: { name, parent_id: dev }, endpoints: [{ type: 'read_write' }] } }))
  record('neon.branch', `${project}/${b.branch.id}`, { name })
  lastBranch = b.branch.id
  const uri = must(await N('GET', `/projects/${project}/connection_uri?branch_id=${b.branch.id}&database_name=neondb&role_name=neondb_owner&pooled=false`)).uri
  const u = new URL(uri)
  if (!u.searchParams.has('sslmode')) u.searchParams.set('sslmode', 'require')
  return { uri: u.toString(), host: u.hostname, ms: Date.now() - t0 }
}

async function time(id, coldStore, prepared) {
  const cls = 'open'
  const steps = []
  const step = async (label, fn) => {
    const t0 = Date.now()
    const r = await fn()
    const ms = Date.now() - t0
    steps.push([label, ms])
    const bad = r?.error || (r?.exitCode !== undefined && r.exitCode !== 0)
    console.log(`${bad ? 'FAIL' : 'ok  '} ${label.padEnd(44)} ${(ms / 1000).toFixed(1).padStart(6)}s${bad ? `\n${JSON.stringify(r).slice(0, 1500)}` : ''}`)
    if (bad) throw new Error(label)
    return r
  }
  // The base image's Node 22 sits first on PATH (/usr/local/bin); the image's Node 24 is /usr/bin.
  // Fix for the real image: symlink it in the Dockerfile. Here: put /usr/bin first.
  const PATHENV = { PATH: '/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/bin', CI: '1' }
  const exec = (cmd, extra = {}) => call(cls, id, 'exec', { cmd, ...extra, env: { ...PATHENV, ...extra.env } })
  const T0 = Date.now()
  const db = await step(`neon: session branch from ${prepared ? 'a migrated + seeded dev' : 'an empty dev'}`, () => sessionBranch(`session-${id}`, prepared))
  await step('container start (first exec)', () => exec('node -v && pnpm -v && claude --version'))
  await step(`git clone kit ${KIT_TAG} (depth 1)`, () => exec(`git clone -q --depth 1 --branch ${KIT_TAG} https://github.com/rocketflare-dev/rocketflare /workspace/app`))
  await step(`pnpm install (${coldStore ? 'empty store' : 'warm store in image'})`, () =>
    exec(`pnpm install --frozen-lockfile ${coldStore ? '--store-dir /tmp/empty-store' : '--prefer-offline'} --reporter=silent`, { cwd: '/workspace/app', timeout: 900000 }),
  )
  await step('.dev.vars + offline AI (bootstrap --offline)', () =>
    exec(
      [
        'cp apps/web/.dev.vars.example apps/web/.dev.vars',
        // Node, not sed: the URI carries '&', which sed's replacement would expand.
        `node -e "const f='apps/web/.dev.vars',fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/^DATABASE_URL=.*$/m,'DATABASE_URL='+process.env.DB).replace(/^OAUTH_ENCRYPTION_KEY=.*$/m,'OAUTH_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex')))"`,
        "sed -i 's/^\\[ai\\]/# [ai]/; s/^binding = \"AI\"/# binding = \"AI\"/; s/^remote = true/# remote = true/' apps/web/wrangler.toml",
        // Kit bug on Neon (to report): only a superuser may set SUPERUSER/BYPASSRLS/REPLICATION, even to NO,
        // and Neon's owner is not one. CREATE ROLE already defaults to all three off.
        "sed -i 's/NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION/NOCREATEDB NOCREATEROLE/' apps/web/scripts/db-roles.ts",
      ].join(' && '),
      { cwd: '/workspace/app', env: { DB: db.uri } },
    ),
  )
  await step(`pnpm db:migrate (${prepared ? 'branch already migrated: no-op' : 'fresh Neon branch'})`, () => exec('pnpm db:migrate', { cwd: '/workspace/app' }))
  if (!prepared) await step('pnpm seed', () => exec('pnpm seed', { cwd: '/workspace/app', env: { SEED_ALLOW_REMOTE: '1' } }))
  // `pnpm dev` can't run as-is: the kit pins Vite to :3000, which the Sandbox SDK's control server
  // holds. Start its two halves directly: wrangler dev on :3001 and Vite on :5173.
  await step('start wrangler dev :3001 + vite :5173', async () => {
    await exec('mkdir -p apps/web/dist/ui', { cwd: '/workspace/app' })
    const api = await call(cls, id, 'bg', {
      cmd: 'pnpm --filter @rocketflare/web exec wrangler dev --port 3001',
      cwd: '/workspace/app',
      env: { ...PATHENV, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: db.uri },
    })
    const ui = await call(cls, id, 'bg', { cmd: 'pnpm --filter @rocketflare/web exec vite --port 5173 --strictPort --host 0.0.0.0', cwd: '/workspace/app', env: { ...PATHENV, __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `.${e.CF_ZONE_NAME}` } })
    return api.error || ui.error ? { error: api.error ?? ui.error } : { api, ui }
  })
  const waitFor = (url, label) =>
    step(label, () =>
      // In a subshell: exec runs in a persistent session shell, and a bare `exit` would end it.
      exec(`bash -c 'for i in $(seq 1 240); do c=$(curl -s -o /dev/null -w "%{http_code}" -m 2 ${url}); [ "$c" = "200" ] && exit 0; sleep 0.5; done; exit 1'`, { timeout: 180000 }),
    )
  await waitFor('http://localhost:3001/api/health', 'api ready (:3001/api/health = 200)')
  await waitFor('http://localhost:5173/', 'ui ready (:5173 = 200)')
  const total = Date.now() - T0

  // The preview, through the Worker: refused without a Launch session, served with one.
  const pvHost = `https://rfspike-pv-${cls}-${id}.${e.CF_ZONE_NAME}`
  const anon = await publicGet(`${pvHost}/`)
  const signedIn = await publicGet(`${pvHost}/`, { cookie: `pv=${state().adminKey}` })
  const apiViaPreview = await publicGet(`${pvHost}/api/health`, { cookie: `pv=${state().adminKey}` })
  console.log(`preview without a Launch session: ${anon.status} · with one: ${signedIn.status} (${/<div id="root"|<script/.test(signedIn.text ?? '') ? 'the app shell' : (signedIn.text ?? '').slice(0, 80)}) · /api/health via Vite proxy: ${apiViaPreview.status} ${apiViaPreview.text?.slice(0, 80)}`)
  console.log(`\nTOTAL from nothing to a live preview: ${(total / 1000).toFixed(1)}s`)
  // The first full run leaves a migrated + seeded branch: it becomes the prepared `dev` parent.
  if (!prepared && !state().preparedDev) writeFileSync(STATE, JSON.stringify({ ...state(), preparedDev: lastBranch }, null, 2))
  writeFileSync(join(HERE, `timing-${id}.json`), JSON.stringify({ id, coldStore: !!coldStore, prepared: !!prepared, steps, total, preview: { anon: anon.status, signedIn: signedIn.status, api: apiViaPreview.status } }, null, 2))
}

async function locked(id = 'l1') {
  const cls = 'locked'
  const exec = (cmd, extra = {}) => call(cls, id, 'exec', { cmd, ...extra })
  const show = (label, r) => console.log(`${label}: ${r.error ?? `exit ${r.exitCode} ${(r.stdout || r.stderr || '').trim().slice(0, 300)}`}`)
  show('container start', await exec('node -v'))
  show('https://example.com (not allowed)', await exec('curl -sS -m 10 -o /dev/null -w "%{http_code}" https://example.com'))
  show('https://registry.npmjs.org (allowed)', await exec('curl -sS -m 10 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/'))

  const db = await sessionBranch(`session-${id}`)
  const pg = `bun -e 'import { SQL } from "bun"; const sql = new SQL(process.env.U); console.log(JSON.stringify(await sql\`select current_user, version()\`))'`
  show(`Postgres TCP to ${db.host} (before allowing it)`, await exec(`timeout 20 ${pg}`, { env: { U: db.uri } }))
  const base = ['registry.npmjs.org', 'github.com', 'codeload.github.com', 'api.anthropic.com']
  await call(cls, id, 'allow', { hosts: [...base, db.host] })
  show('Postgres TCP after allowing the host', await exec(`timeout 20 ${pg}`, { env: { U: db.uri } }))
  await call(cls, id, 'allow', { hosts: [...base, db.host, `${db.host}:5432`] })
  show('Postgres TCP after also allowing host:5432', await exec(`timeout 20 ${pg}`, { env: { U: db.uri } }))
  // Neon's serverless driver speaks HTTPS, which the allowlist does cover.
  show('Neon over HTTPS (serverless driver protocol)', await exec(`curl -sS -m 15 -o /dev/null -w "%{http_code}" https://${db.host}/sql -H "Neon-Connection-String: $U" -H "content-type: application/json" -d '{"query":"select 1","params":[]}'`, { env: { U: db.uri } }))

  // The chat loop (spec/07): each user message is one Claude Code turn, streamed back as it runs and
  // resumed by session id, so the conversation carries on. The sandbox holds only a placeholder key;
  // the Worker's outbound handler swaps in the real one and meters every call.
  const claudeEnv = {
    PATH: '/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/bin',
    ANTHROPIC_API_KEY: 'sk-ant-api03-PLACEHOLDER-not-a-real-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    NODE_USE_SYSTEM_CA: '1',
  }
  await exec('mkdir -p /workspace/chat')
  const turn = async (label, prompt, resume) => {
    const cmd = `claude -p ${JSON.stringify(prompt)} ${resume ? `--resume ${resume}` : ''} --output-format stream-json --verbose --permission-mode acceptEdits --max-turns 6`
    const lines = await streamCall(cls, id, { cmd, cwd: '/workspace/chat', env: claudeEnv, timeout: 300000 })
    const events = []
    for (const l of lines) {
      if (l.data) for (const raw of l.data.split('\n')) {
        try {
          events.push({ t: l.t, ...JSON.parse(raw) })
        } catch {}
      }
    }
    const init = events.find((x) => x.type === 'system' && x.subtype === 'init')
    const result = events.find((x) => x.type === 'result')
    const kinds = events.map((x) => `${x.type}${x.subtype ? ':' + x.subtype : ''}@${(x.t / 1000).toFixed(1)}s`)
    console.log(`${label}: ${events.length} events streamed [${kinds.join(', ')}]`)
    console.log(`  result: ${result ? JSON.stringify(result.result).slice(0, 160) : 'none'} · exit ${lines.at(-1)?.exitCode ?? lines.at(-1)?.error}`)
    if (!result) console.log('  raw tail:', JSON.stringify(lines.slice(-3)).slice(0, 1200))
    return { sessionId: init?.session_id ?? result?.session_id, result: result?.result ?? '' }
  }
  const t1 = await turn('turn 1', 'Create a file notes.txt containing just the word alpha. Then reply: done.')
  const onDisk = await exec('cat /workspace/chat/notes.txt')
  console.log(`  notes.txt in the sandbox: ${JSON.stringify(onDisk.stdout)}`)
  const t2 = await turn('turn 2 (resumed)', 'Which word did you just write to notes.txt? Reply with only that word.', t1.sessionId)
  console.log(`chat carried context across turns: ${/alpha/i.test(t2.result)} (session ${t1.sessionId})`)

  await sleep(5000)
  const keys = (await ADMIN('GET', `/accounts/${acc}/storage/kv/namespaces/${state().kv}/keys`)).json?.result ?? []
  for (const k of keys) {
    const v = await ADMIN('GET', `/accounts/${acc}/storage/kv/namespaces/${state().kv}/values/${encodeURIComponent(k.name)}`)
    console.log(`meter ${k.name}: ${v.text}`)
  }
  show('env inside the sandbox has no real key', await exec('env | grep -c "sk-ant-api03-[A-Za-z0-9_-]\\{40,\\}" || true'))
}

const [cmd, a1, a2] = process.argv.slice(2)
if (cmd === 'setup') await setup()
else if (cmd === 'time') await time(a1 ?? 's1', /cold/.test(a2 ?? ''), /prepared/.test(a2 ?? ''))
else if (cmd === 'locked') await locked(a1)
else console.log('usage: setup | time <id> [cold] | locked')
