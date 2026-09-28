/**
 * Is Launch reachable from the internet at its public URL? The scaffold job and every app's
 * deploy job run on GitHub's runners and call Launch BACK (`POST /ci/scaffold/token`,
 * `/ci/deploy/*`) at the URL they were given — Launch's `APP_URL` (`issuerOf(cfg)`; the same
 * value is the jobs' OIDC audience, `DEPLOYER_URL` and every app's `OIDC_ISSUER`). A Launch at
 * `http://localhost:3000` dispatches jobs that can only die, so the routes that would dispatch one
 * refuse first (409 `launch_not_reachable`, `requirePublicUrl`).
 *
 * **The check** (`checkPublicUrl`), two probes:
 *
 * - `url` — static: `https`, and a host the internet can resolve to us: not `localhost` /
 *   `*.localhost`, not `.local` / `.internal` / `.home.arpa` / a dotless name, not a loopback,
 *   private, CGNAT, link-local or unspecified IPv4/IPv6 literal. Failing it skips the probe.
 * - `probe` — live: Launch fetches `<APP_URL>/ci/ping?nonce=<random>` through the internet and
 *   expects `{ nonce, proof }` where `proof` is an HMAC of the nonce under this deployment's
 *   `OAUTH_ENCRYPTION_KEY` (`pingProof`) — so an answer proves the hostname routes back to THIS
 *   Launch (through a cfld tunnel locally), not merely to something. A wrong proof is `failed`.
 *   Unreachable is `failed` under `APP_ENV=development` and a `warning` in a deployment, whose
 *   static check has already passed: a Worker fetching its own hostname is a platform question
 *   (a same-zone Route, unlike a Custom Domain, does not loop back), and refusing every create on
 *   it would be worse than the warning.
 *
 * **The cache.** The result is stored as `launch_settings.public_url_check` for the URL it was
 * run against. `requirePublicUrl` reuses a passing result for `OK_TTL_MS` and a failing one for
 * `FAILED_TTL_MS` (so starting the tunnel shows up within a minute), and re-probes otherwise; the
 * wizard's "Check now" always probes. `fetch` is injected: tests route it to the app in-process.
 */
import {
  type CredentialCheck,
  type CredentialCheckStatus,
  LAUNCH_NOT_REACHABLE,
  type PublicUrlCheck,
  publicUrlCheckSchema,
  publicUrlPingResponseSchema,
} from '@launch/shared/launch-setup'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { ConflictError } from '../../utils/core/errors'
import { getSetting, overallCheckStatus, putSetting } from './credentials'
import { issuerOf } from './oidc-clients'

/** A passing result is trusted this long before `requirePublicUrl` probes again. */
export const OK_TTL_MS = 10 * 60_000
/** A failing one this long — short, so fixing the URL (starting the tunnel) is noticed quickly. */
export const FAILED_TTL_MS = 30_000
/** The live probe's budget. */
export const PROBE_TIMEOUT_MS = 8_000

const URL_LABEL = 'Public URL'
const PROBE_LABEL = 'Reachable from the internet'

// ---- the static half -------------------------------------------------------------------------------

function ipv4Private(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function ipv6Private(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h.includes(':')) return false
  if (h === '::' || h === '::1') return true
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return ipv4Private(mapped[1] as string)
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h)
}

/**
 * Why the internet cannot reach `url`, or null when nothing static rules it out. Pure — the
 * create modal's hint and the tests use it as is.
 */
export function publicUrlProblem(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `${url} is not a URL`
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    ipv4Private(host) ||
    ipv6Private(host)
  if (local) {
    return `${parsed.origin} is only reachable from this machine or network, so GitHub's runners cannot call Launch back. Run Launch behind a public HTTPS URL (locally: pnpm dev:tunnel, then restart pnpm dev).`
  }
  if (!host.includes('.') && !host.includes(':')) {
    return `${parsed.origin} is not a public hostname, so GitHub's runners cannot call Launch back.`
  }
  if (parsed.protocol !== 'https:') {
    return `${parsed.origin} is not HTTPS; the CI jobs call Launch over HTTPS only.`
  }
  return null
}

// ---- the proof ---------------------------------------------------------------------------------------

async function hmacKey(cfg: AppConfig): Promise<CryptoKey> {
  // Without the encryption key (a bare local run) the proof falls back to the URL: it still shows
  // the answer came from a Launch configured with this APP_URL.
  const material = cfg.OAUTH_ENCRYPTION_KEY ?? `launch-public-url:${issuerOf(cfg)}`
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(material),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
}

/** The HMAC `/ci/ping` answers for `nonce`: base64url, never the key. */
export async function pingProof(cfg: AppConfig, nonce: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(cfg),
    new TextEncoder().encode(`launch-ping:${nonce}`)
  )
  let binary = ''
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---- the check ---------------------------------------------------------------------------------------

export interface PublicUrlOptions {
  fetch?: typeof fetch
  now?: () => Date
  /** Tests pin it. */
  nonce?: string
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function liveProbe(cfg: AppConfig, opts: PublicUrlOptions): Promise<CredentialCheck> {
  const base = issuerOf(cfg)
  const nonce = opts.nonce ?? randomNonce()
  const unreachable = (detail: string): CredentialCheck => ({
    id: 'probe',
    label: PROBE_LABEL,
    status: cfg.APP_ENV === 'development' ? 'failed' : 'warning',
    detail,
  })
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${base}/ci/ping?nonce=${encodeURIComponent(nonce)}`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return unreachable(`Launch could not reach itself at ${base}: ${message.slice(0, 200)}`)
  }
  if (!res.ok) {
    return unreachable(`${base}/ci/ping answered ${res.status}, not Launch's ping`)
  }
  const parsed = publicUrlPingResponseSchema.safeParse(await res.json().catch(() => null))
  if (!parsed.success || parsed.data.nonce !== nonce) {
    return {
      id: 'probe',
      label: PROBE_LABEL,
      status: 'failed',
      detail: `Something answered at ${base}, but not Launch's ping — the hostname routes somewhere else`,
    }
  }
  if (parsed.data.proof !== (await pingProof(cfg, nonce))) {
    return {
      id: 'probe',
      label: PROBE_LABEL,
      status: 'failed',
      detail: `A different Launch answered at ${base} (its proof does not match this deployment's key)`,
    }
  }
  return { id: 'probe', label: PROBE_LABEL, status: 'ok', detail: `${base} routes back to Launch` }
}

/** Run both probes against `APP_URL` now. Never throws. */
export async function checkPublicUrl(
  cfg: AppConfig,
  opts: PublicUrlOptions = {}
): Promise<PublicUrlCheck> {
  const url = issuerOf(cfg)
  const now = (opts.now ?? (() => new Date()))()
  const problem = publicUrlProblem(url)
  const checks: CredentialCheck[] = problem
    ? [{ id: 'url', label: URL_LABEL, status: 'failed', detail: problem }]
    : [{ id: 'url', label: URL_LABEL, status: 'ok', detail: url }, await liveProbe(cfg, opts)]
  return { url, status: overallCheckStatus(checks), checks, checkedAt: now }
}

/** The stored result, when it is for the current `APP_URL`. */
export async function storedPublicUrlCheck(
  db: Database,
  cfg: AppConfig
): Promise<PublicUrlCheck | null> {
  const parsed = publicUrlCheckSchema.safeParse(await getSetting(db, 'public_url_check'))
  if (!parsed.success || parsed.data.url !== issuerOf(cfg)) return null
  return parsed.data
}

/** Probe now and store the result (the wizard's "Check now", and a stale cache). */
export async function runPublicUrlCheck(
  db: Database,
  cfg: AppConfig,
  userId: string | null,
  opts: PublicUrlOptions = {}
): Promise<PublicUrlCheck> {
  const result = await checkPublicUrl(cfg, opts)
  await putSetting(
    db,
    'public_url_check',
    { ...result, checkedAt: result.checkedAt.toISOString() },
    userId
  )
  return result
}

/** The overview's view: the stored result for this URL, else the static half alone. */
export async function publicUrlOverview(
  db: Database,
  cfg: AppConfig
): Promise<{
  url: string
  status: CredentialCheckStatus | null
  checks: CredentialCheck[]
  checkedAt: Date | null
}> {
  const url = issuerOf(cfg)
  const stored = await storedPublicUrlCheck(db, cfg)
  if (stored) return stored
  const problem = publicUrlProblem(url)
  return problem
    ? {
        url,
        status: 'failed',
        checks: [{ id: 'url', label: URL_LABEL, status: 'failed', detail: problem }],
        checkedAt: null,
      }
    : { url, status: null, checks: [], checkedAt: null }
}

/**
 * The gate: refuse (409 `launch_not_reachable`) unless the public-URL check passes — from the
 * cache when it is fresh enough, else by probing now. A `warning` passes.
 */
export async function requirePublicUrl(
  db: Database,
  cfg: AppConfig,
  opts: PublicUrlOptions = {}
): Promise<PublicUrlCheck> {
  const url = issuerOf(cfg)
  const problem = publicUrlProblem(url)
  let result: PublicUrlCheck
  if (problem) {
    // No probe can change this answer, so neither the cache nor the network is consulted.
    result = {
      url,
      status: 'failed',
      checks: [{ id: 'url', label: URL_LABEL, status: 'failed', detail: problem }],
      checkedAt: (opts.now ?? (() => new Date()))(),
    }
  } else {
    const now = (opts.now ?? (() => new Date()))().getTime()
    const stored = await storedPublicUrlCheck(db, cfg)
    const age = stored ? now - stored.checkedAt.getTime() : Number.POSITIVE_INFINITY
    const fresh =
      stored && age >= 0 && age < (stored.status === 'failed' ? FAILED_TTL_MS : OK_TTL_MS)
    result = fresh && stored ? stored : await runPublicUrlCheck(db, cfg, null, opts)
  }
  if (result.status === 'failed') {
    const failed = result.checks.filter(check => check.status === 'failed')
    throw new ConflictError(
      `Launch is not reachable from the internet at ${url}, so the GitHub jobs that build an app could not call it back. ${failed[0]?.detail ?? ''}`.trim(),
      LAUNCH_NOT_REACHABLE,
      { url, checks: result.checks }
    )
  }
  return result
}
