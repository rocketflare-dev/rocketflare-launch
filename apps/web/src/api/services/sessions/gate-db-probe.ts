/**
 * The ship gate's DATABASE PROBE and its one retry (rocketflare-launch#7, docs/CONCEPTS.md §18.13):
 * before `pnpm gate test`, Launch checks from INSIDE the container that the gate branch answers
 * `select 1` over the app's own `@neondatabase/serverless` `Pool` — the WebSocket the kit's test
 * setup opens first (`db-roles`, then the migrator) — and says plainly what failed when it does
 * not, instead of a vitest "No test files found" under an empty `ErrorEvent`.
 *
 * **Why.** Node's WebSocket reports a failed connection as `ErrorEvent { type: 'error' }` with no
 * message and no cause, and the neon driver rejects the query with exactly that — so a DNS
 * failure, a refused or dropped TCP/TLS connection and a non-101 upgrade all look the same in the
 * kit's output, and the kit's test setup has no retry on that first connection (its migrator's
 * `waitForDatabase` comes after `db-roles`). Measured 2026-10-06: a session container on the
 * LOCAL sandbox (`wrangler dev`) loses its direct internet when Launch's `wrangler dev` reloads
 * while the container runs — workerd re-attaches to the container with the new egress port but
 * without its internet setting, so the hosts Launch handles (Anthropic, GitHub) keep working and
 * everything else (the Neon endpoint) fails at once: `curl` "unexpected eof while reading", a
 * WebSocket "Received network error or non-101 status code". Only a new container gets it back.
 *
 * **What it does** ({@link GATE_DB_PROBE_SCRIPT}, run with `node` in `apps/web` so `require`
 * finds the app's own driver): up to {@link GATE_DB_PROBE_BUDGET_MS} of attempts, each with its
 * own deadline, on a capped backoff — a compute still waking, or a blip, is ridden out. When none
 * answers it diagnoses the endpoint host: DNS, then plain HTTPS to it (any HTTP status means the
 * network path is fine), and prints one verdict line ({@link GATE_DB_PROBE_VERDICT}). Exit 0 =
 * ready (or nothing to probe — an app without the driver, or no URL — never blocks the gate),
 * {@link GATE_DB_PROBE_UNREACHABLE} = the container cannot reach the endpoint at all,
 * {@link GATE_DB_PROBE_REFUSED} = the network is fine but the database did not answer. The URL
 * stays in the environment (`DATABASE_URL`, the test command's own); only the HOST is printed.
 *
 * **The retry** ({@link isSetupConnectionFailure}): a red test run whose log shows vitest's
 * globalSetup dying on a connection error, with no test having failed, is run ONCE more — a
 * connection that dropped between the probe and the suite. A real test failure is never retried.
 */
import { SESSION_LAUNCH_DIR, SESSION_WORKSPACE } from './rocketflare-dev'

/** Where the probe script is written in the container. */
export const GATE_DB_PROBE_PATH = `${SESSION_LAUNCH_DIR}/gate-db-probe.cjs`
/** Where it runs: the app's web package, whose `node_modules` has the driver. */
export const GATE_DB_PROBE_CWD = `${SESSION_WORKSPACE}/apps/web`
/** The probe as a command line — no credential in it. */
export const GATE_DB_PROBE_COMMAND = `node ${GATE_DB_PROBE_PATH}`
/** How long the probe keeps trying before it diagnoses and gives up. */
export const GATE_DB_PROBE_BUDGET_MS = 45_000
/** One attempt's deadline. */
export const GATE_DB_PROBE_ATTEMPT_MS = 10_000
/** The probe's own hard deadline in `runInBackground` (budget, one attempt, the diagnosis). */
export const GATE_DB_PROBE_TIMEOUT_MS = 90_000
/** Exit code: the container cannot reach the endpoint (DNS, TCP or TLS failed). */
export const GATE_DB_PROBE_UNREACHABLE = 3
/** Exit code: the endpoint is reachable but the database never answered `select 1`. */
export const GATE_DB_PROBE_REFUSED = 4
/** The probe's last line starts with this; the ship panel leads with it. */
export const GATE_DB_PROBE_VERDICT = 'gate db probe verdict:'

/**
 * The probe (CommonJS, Node 18+, no dependency but the app's driver). Reads `DATABASE_URL`,
 * `LAUNCH_PROBE_BUDGET_MS` and `LAUNCH_PROBE_ATTEMPT_MS`; prints only the host, never the URL.
 * It always `process.exit`s: a closed database WebSocket may never release the process
 * (docs/plans/sandbox-websocket-close.md).
 */
export const GATE_DB_PROBE_SCRIPT = `// Launch: the ship gate's database probe (gate-db-probe.ts). Prints the host, never the URL.
'use strict'
const dns = require('node:dns/promises')
const https = require('node:https')
const { createRequire } = require('node:module')
const say = s => console.log('gate db probe: ' + s)
const verdict = (code, s) => { console.log('${GATE_DB_PROBE_VERDICT} ' + s); process.exit(code) }
const url = process.env.DATABASE_URL || ''
const budget = Number(process.env.LAUNCH_PROBE_BUDGET_MS) || ${GATE_DB_PROBE_BUDGET_MS}
const perAttempt = Number(process.env.LAUNCH_PROBE_ATTEMPT_MS) || ${GATE_DB_PROBE_ATTEMPT_MS}
let host = ''
try { host = new URL(url).hostname } catch {}
if (!host) { say('no DATABASE_URL to probe; skipped'); process.exit(0) }
let driver
try { driver = createRequire(process.cwd() + '/package.json')('@neondatabase/serverless') } catch {}
const Pool = driver && driver.Pool
if (typeof Pool !== 'function') { say('the app has no @neondatabase/serverless in apps/web; skipped'); process.exit(0) }
// The kit's local-proxy switch. The gate never sets it (GATE_FORBIDDEN_ENV); a probe run by hand,
// or by Launch's tests, may.
if (process.env.NEON_LOCAL_PROXY) {
  const target = new URL(process.env.NEON_LOCAL_PROXY)
  driver.neonConfig.wsProxy = () => target.host + '/v2'
  driver.neonConfig.useSecureWebSocket = target.protocol === 'https:'
  driver.neonConfig.pipelineConnect = false
}
const secs = ms => (ms / 1000).toFixed(1) + ' s'
const describe = e => {
  if (!e) return 'unknown error'
  if (e.type === 'error' && !e.message) return 'the WebSocket failed before Postgres answered (the driver gives no detail)'
  const code = e.code ? ' (' + e.code + ')' : ''
  return String(e.message || e).split('\\n')[0].slice(0, 200) + code
}
const withDeadline = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + ' timed out after ' + secs(ms))), ms))])
async function once() {
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: perAttempt })
  pool.on('error', () => {})
  try { await withDeadline(pool.query('select 1'), perAttempt, 'select 1') } finally { pool.end().catch(() => {}) }
}
function httpsStatus() {
  return new Promise(resolve => {
    const req = https.get({ host, path: '/', timeout: 8000 }, res => { res.resume(); resolve({ ok: true, status: res.statusCode }) })
    req.on('timeout', () => req.destroy(new Error('timed out after 8 s')))
    req.on('error', e => resolve({ ok: false, error: describe(e) }))
  })
}
;(async () => {
  const started = Date.now()
  let last = null
  for (let n = 1; ; n++) {
    const t = Date.now()
    try {
      await once()
      say('the gate branch (' + host + ') answered select 1 after ' + n + ' attempt' + (n === 1 ? '' : 's') + ', ' + secs(Date.now() - started))
      process.exit(0)
    } catch (e) {
      last = e
      const left = budget - (Date.now() - started)
      const wait = Math.min(5000, 500 * 2 ** (n - 1))
      if (left <= wait) { say('attempt ' + n + ' failed after ' + secs(Date.now() - t) + ': ' + describe(e)); break }
      say('attempt ' + n + ' failed after ' + secs(Date.now() - t) + ': ' + describe(e) + '; retrying in ' + secs(wait))
      await new Promise(r => setTimeout(r, wait))
    }
  }
  const tried = 'for ' + secs(Date.now() - started)
  try { await dns.lookup(host) } catch (e) {
    verdict(${GATE_DB_PROBE_UNREACHABLE}, 'the container cannot resolve ' + host + ' (' + describe(e) + '), tried ' + tried + '.')
  }
  const probe = await httpsStatus()
  if (!probe.ok) {
    verdict(${GATE_DB_PROBE_UNREACHABLE}, 'the container cannot reach ' + host + ' over HTTPS either (' + probe.error + '), so its network path to Neon is down, not the database; tried ' + tried + '.')
  }
  verdict(${GATE_DB_PROBE_REFUSED}, host + ' answers HTTPS (HTTP ' + probe.status + ') but the database never answered select 1 (' + describe(last) + '), tried ' + tried + '.')
})().catch(e => verdict(${GATE_DB_PROBE_REFUSED}, 'the probe itself failed: ' + describe(e)))
`

/** The verdict line of a probe's log (without its prefix), or null. */
export function gateDbProbeVerdict(log: string): string | null {
  const line = log
    .split('\n')
    .reverse()
    .find(l => l.trim().startsWith(GATE_DB_PROBE_VERDICT))
  return line ? line.trim().slice(GATE_DB_PROBE_VERDICT.length).trim() : null
}

/**
 * The sentence the ship panel leads with when the probe gave up. `unreachable` adds what to do:
 * the network path is the container's, and only a new container gets it back.
 */
export function gateDbProbeMessage(exitCode: number | null, verdict: string | null): string {
  const what = verdict ? ` Launch's probe: ${verdict}` : ''
  if (exitCode === GATE_DB_PROBE_UNREACHABLE) {
    return (
      "The session's container could not reach its test database, so the tests did not run." +
      what +
      ' This is the container, not the code: on a local sandbox it is what a reload of ' +
      "Launch's `wrangler dev` does to a container that was running (workerd keeps Launch's own " +
      'hosts and drops the internet). Suspend and resume the session — or start a new one — and ' +
      'ship again.'
    )
  }
  return (
    'The test database did not answer, so the tests did not run.' +
    what +
    ' Ship again; if it keeps failing, check the app’s Neon project.'
  )
}

/** A connection error as Node, undici's WebSocket or the neon driver print one. */
const CONNECTION_ERROR =
  /ErrorEvent \{|All attempts to open a WebSocket|Received network error or non-101|Connection terminated unexpectedly|\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE)\b|fetch failed|socket hang up/
/** vitest's globalSetup in a stack, or the kit's test setup file. */
const GLOBAL_SETUP = /_initializeGlobalSetup|globalSetup|tests\/setup\.ts/
/** A failed TEST (vitest's `FAIL  <project> <file> > <test>` header, or a failed-count summary). */
const TEST_FAILED = /^\s*FAIL\s.*>|^\s*Tests\s+\d+\s+failed/m

/**
 * A red test run that failed in vitest's globalSetup on a database CONNECTION error before any
 * test failed — the one kind of red Launch runs again (once). Pure; takes the raw log.
 */
export function isSetupConnectionFailure(log: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes from vitest's output
  const clean = log.replace(/\u001b\[[0-9;]*m/g, '')
  return CONNECTION_ERROR.test(clean) && GLOBAL_SETUP.test(clean) && !TEST_FAILED.test(clean)
}

/** What the ship panel says, before the second run's output, when the tests were run twice. */
export function gateSetupRetryNote(firstError: string): string {
  return (
    'Launch ran the tests twice: the first run failed before any test ran, on a database ' +
    "connection error in the kit's test setup (vitest's globalSetup), so Launch retried it " +
    `once. The first run's error: ${firstError}. The second run:`
  )
}
