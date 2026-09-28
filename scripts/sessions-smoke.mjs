#!/usr/bin/env node
/**
 * `pnpm sessions:smoke` — drive ONE coding session through a running Launch, the way a person
 * would from the session page (Launch P3, `docs/SESSIONS-LOCAL.md`): start it, watch it boot,
 * send a message, open the gated preview, optionally ship, then end it — printing the events and
 * the timings as it goes. It speaks only Launch's HTTP API.
 *
 *   node scripts/sessions-smoke.mjs --app <slug> [--message "<text>"] [--ship]
 *     [--server http://localhost:3001] [--key <api key> | LAUNCH_API_KEY] [--keep]
 *
 * - No `--message`: no turn (useful without an Anthropic key — the boot, the preview and the end
 *   are still exercised).
 * - `--keep` leaves the session running (the URL is printed); the default is to end it.
 * - The API key is the one `pnpm seed` prints (or `~/.launch/config.json`'s after `pnpm cli login`).
 *
 * Exit 0 when every phase it was asked for worked, 1 otherwise.
 */
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const [key, inline] = arg.slice(2).split('=', 2)
    flags[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true')
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))
if (!flags.app) {
  process.stdout.write(
    'usage: sessions-smoke --app <slug> [--message "<text>"] [--ship] [--server URL] [--key KEY] [--keep]\n'
  )
  process.exit(2)
}

function storedConfig() {
  const file = path.join(os.homedir(), '.launch', 'config.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

const stored = storedConfig()
const server = (
  flags.server ??
  process.env.LAUNCH_URL ??
  stored.serverUrl ??
  'http://localhost:3001'
).replace(/\/+$/, '')
const key = flags.key ?? process.env.LAUNCH_API_KEY ?? stored.apiKey
if (!key) {
  process.stderr.write('sessions-smoke: no API key (--key, LAUNCH_API_KEY, or `pnpm cli login`)\n')
  process.exit(2)
}

const t0 = Date.now()
const since = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`
const say = text => process.stdout.write(`${since()}  ${text}\n`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function api(method, pathname, body) {
  const res = await fetch(`${server}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 300) }
  }
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${JSON.stringify(json)}`)
  return json
}

let afterSeq = 0
async function printEvents(sessionId) {
  const { items, nextSeq } = await api(
    'GET',
    `/api/sessions/${sessionId}/events?afterSeq=${afterSeq}`
  )
  afterSeq = nextSeq ?? afterSeq
  for (const e of items) {
    const d = e.data ?? {}
    const detail =
      e.type === 'step'
        ? `${d.label} — ${d.status}${d.detail ? ` (${d.detail})` : ''}`
        : e.type === 'text'
          ? String(d.text ?? d.delta ?? '').slice(0, 160)
          : JSON.stringify(d).slice(0, 200)
    say(`  #${e.seq} ${e.type.padEnd(16)} ${detail}`)
  }
  return items
}

async function waitFor(sessionId, done, { timeoutMs = 600_000, label } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await printEvents(sessionId)
    const { session } = await api('GET', `/api/sessions/${sessionId}`)
    const verdict = done(session)
    if (verdict) return session
    if (['failed', 'ended'].includes(session.status) && label !== 'end') {
      throw new Error(`session is ${session.status}: ${session.error ?? ''}`)
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(1500)
  }
}

let sessionId = null
let ok = true
try {
  const app = await api('GET', `/api/apps/${encodeURIComponent(flags.app)}`)
  say(`app ${app.slug} (${app.id}) → ${app.repoOwner}/${app.repoName}`)
  const created = await api('POST', `/api/apps/${app.id}/sessions`, { title: 'sessions:smoke' })
  sessionId = created.session.id
  say(`session ${sessionId} (${created.session.branch}) — ${created.session.status}`)

  const bootStart = Date.now()
  await waitFor(sessionId, s => s.status === 'ready', { label: 'ready' })
  say(`READY after ${((Date.now() - bootStart) / 1000).toFixed(1)}s`)

  if (flags.message && flags.message !== 'true') {
    await api('POST', `/api/sessions/${sessionId}/turns`, { message: flags.message })
    say(`turn sent: ${flags.message}`)
    const turnStart = Date.now()
    const before = created.session.turnCount
    const s = await waitFor(
      sessionId,
      x => x.status === 'ready' && x.turnCount > before && !x.pendingMessage,
      { label: 'turn' }
    )
    say(
      `turn done after ${((Date.now() - turnStart) / 1000).toFixed(1)}s — cost ${s.costMicrocents} µ¢, head ${s.headSha}`
    )
  }

  // The preview, through Launch's gate: a grant → the cookie → the app.
  const grant = await api('POST', `/api/sessions/${sessionId}/preview-grant`)
  const exchange = await fetch(grant.url, { redirect: 'manual' })
  const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0]
  const origin = new URL(grant.url).origin
  const page = await fetch(`${origin}/`, { headers: { cookie } })
  const html = await page.text()
  const anon = await fetch(`${origin}/`)
  const health = await fetch(`${origin}/api/health`, { headers: { cookie } })
  say(
    `preview ${origin}: grant ${exchange.status}, with cookie ${page.status} (${/<div id="root"|<script/.test(html) ? 'the app shell' : html.slice(0, 60)}), without ${anon.status}, /api/health ${health.status}`
  )
  if (page.status !== 200 || anon.status !== 401) ok = false

  if (flags.ship === 'true') {
    await api('POST', `/api/sessions/${sessionId}/ship`)
    say('ship requested')
    const s = await waitFor(
      sessionId,
      x => x.status === 'shipped' || (x.status === 'ready' && !x.requestedAction),
      {
        label: 'ship',
        timeoutMs: 1_800_000,
      }
    )
    say(`ship: ${s.status} ${s.prUrl ?? ''}`)
    if (s.status !== 'shipped') ok = false
  }
} catch (err) {
  ok = false
  say(`FAILED: ${err instanceof Error ? err.message : String(err)}`)
}

if (sessionId && flags.keep !== 'true') {
  try {
    const { session } = await api('GET', `/api/sessions/${sessionId}`)
    if (!['ended', 'failed', 'shipped'].includes(session.status)) {
      await api('POST', `/api/sessions/${sessionId}/end`)
    }
    const s = await waitFor(
      sessionId,
      x => ['ended', 'failed', 'shipped'].includes(x.status) && x.endedAt,
      {
        label: 'end',
        timeoutMs: 300_000,
      }
    )
    say(`session ${s.status}; container ${s.containerSeconds}s`)
  } catch (err) {
    ok = false
    say(`could not end the session: ${err instanceof Error ? err.message : String(err)}`)
  }
} else if (sessionId) {
  say(`kept: ${server}/api/sessions/${sessionId}`)
}
say(ok ? 'OK' : 'FAILED')
process.exit(ok ? 0 : 1)
