/**
 * The GitHub App client (spec/03, spec/06): how Launch reads a repo and, later, writes to it. Worker-
 * safe — WebCrypto through `jose`, no Octokit, no Node — and every call takes an injected `fetch`
 * (`opts.fetch ?? fetch`) so no test reaches GitHub.
 *
 * Two GitHub details this module exists to absorb:
 *
 * - **GitHub issues PKCS#1 keys** (`-----BEGIN RSA PRIVATE KEY-----`). WebCrypto and `jose` import
 *   only PKCS#8, so `toPkcs8Pem` wraps the PKCS#1 DER in a PKCS#8 `PrivateKeyInfo` — a fixed
 *   `rsaEncryption` AlgorithmIdentifier and an OCTET STRING — with no parsing of the key itself.
 * - **The app JWT is short-lived and clock-skewed on purpose**: `iat` is now − 60 s (GitHub's
 *   clock may be behind ours) and `exp` now + 540 s (GitHub refuses more than ten minutes).
 *
 * GitHub rejects a request with no `User-Agent`, so every call sends one. Callers get the app's
 * credentials from `getCredential(db, cfg, 'github_app')` — `GitHubAppAuth` is that payload's shape.
 */
import { importPKCS8, SignJWT } from 'jose'

export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_USER_AGENT = 'rocketflare-launch'
const GITHUB_API_VERSION = '2022-11-28'

/** The sealed `github_app` credential: the numeric app id and the PEM GitHub issued. */
export interface GitHubAppAuth {
  appId: string
  privateKey: string
}

export interface GitHubOptions {
  fetch?: typeof fetch
  /** Override for tests and GitHub Enterprise; no trailing slash. */
  apiBase?: string
  /** Seconds since the epoch; tests pin it. */
  now?: () => number
}

/** A non-2xx from GitHub. `message` is GitHub's own `message` field, never a token. */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string
  ) {
    super(message)
    this.name = 'GitHubApiError'
  }
}

/** GitHub App permission levels, as GitHub names them (`contents: 'read'`). */
export type GitHubPermissions = Record<string, 'read' | 'write' | 'admin' | string>

export interface GitHubApp {
  id: number
  slug: string
  name: string
  owner: { login: string; type?: string } | null
  permissions: GitHubPermissions
}

export interface GitHubInstallation {
  id: number
  account: { login: string; type?: string } | null
  permissions: GitHubPermissions
  repository_selection?: 'all' | 'selected'
  suspended_at?: string | null
}

export interface GitHubInstallationToken {
  token: string
  expires_at: string
  permissions?: GitHubPermissions
  repository_selection?: 'all' | 'selected'
}

// ---- PKCS#1 → PKCS#8 ------------------------------------------------------------------------

/** `rsaEncryption` (1.2.840.113549.1.1.1) with NULL parameters, DER-encoded. */
const RSA_ALGORITHM_IDENTIFIER = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]

function derLength(length: number): number[] {
  if (length < 0x80) return [length]
  const bytes: number[] = []
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff)
  return [0x80 | bytes.length, ...bytes]
}

function pemBody(pem: string): Uint8Array {
  const base64 = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '')
  return Uint8Array.from(atob(base64), ch => ch.charCodeAt(0))
}

function toPem(der: Uint8Array, label: string): string {
  let binary = ''
  for (const b of der) binary += String.fromCharCode(b)
  const lines = btoa(binary).match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/**
 * A PKCS#8 PEM for `pem`, which may be PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub downloads) or
 * already PKCS#8 (`BEGIN PRIVATE KEY`, returned normalised). Anything else throws.
 */
export function toPkcs8Pem(pem: string): string {
  const text = pem.trim().replace(/\\n/g, '\n')
  if (text.includes('-----BEGIN PRIVATE KEY-----')) return toPem(pemBody(text), 'PRIVATE KEY')
  if (!text.includes('-----BEGIN RSA PRIVATE KEY-----')) {
    throw new Error(
      'Not an RSA private key PEM (expected BEGIN RSA PRIVATE KEY or BEGIN PRIVATE KEY)'
    )
  }
  const pkcs1 = pemBody(text)
  // PrivateKeyInfo ::= SEQUENCE { version INTEGER (0), algorithm AlgorithmIdentifier,
  //                               privateKey OCTET STRING (the PKCS#1 RSAPrivateKey) }
  const body = [
    0x02,
    0x01,
    0x00,
    ...RSA_ALGORITHM_IDENTIFIER,
    0x04,
    ...derLength(pkcs1.length),
    ...pkcs1,
  ]
  return toPem(Uint8Array.from([0x30, ...derLength(body.length), ...body]), 'PRIVATE KEY')
}

// ---- the app JWT ------------------------------------------------------------------------------

/** The app's own JWT (RS256, `iss` = app id, `iat` now − 60, `exp` now + 540). */
export async function appJwt(
  appId: string | number,
  pem: string,
  opts: Pick<GitHubOptions, 'now'> = {}
): Promise<string> {
  const now = opts.now?.() ?? Math.floor(Date.now() / 1000)
  const key = await importPKCS8(toPkcs8Pem(pem), 'RS256')
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(String(appId))
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .sign(key)
}

// ---- REST -------------------------------------------------------------------------------------

async function githubRequest(
  path: string,
  init: { method?: string; token: string; accept?: string; body?: unknown },
  opts: GitHubOptions
): Promise<Response> {
  const doFetch = opts.fetch ?? fetch
  const headers: Record<string, string> = {
    Accept: init.accept ?? 'application/vnd.github+json',
    Authorization: `Bearer ${init.token}`,
    'User-Agent': GITHUB_USER_AGENT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  return doFetch(`${opts.apiBase ?? GITHUB_API_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

async function failure(res: Response, path: string): Promise<GitHubApiError> {
  let message = `GitHub ${res.status}`
  try {
    const body = (await res.json()) as { message?: unknown }
    if (typeof body.message === 'string') message = body.message
  } catch {
    // Not JSON — the status is all there is.
  }
  return new GitHubApiError(res.status, message, path)
}

async function githubJson<T>(
  path: string,
  init: { method?: string; token: string; body?: unknown },
  opts: GitHubOptions
): Promise<T> {
  const res = await githubRequest(path, init, opts)
  if (!res.ok) throw await failure(res, path)
  return (await res.json()) as T
}

/** `GET /app` — the app the credential belongs to (the setup check's first probe). */
export async function getApp(auth: GitHubAppAuth, opts: GitHubOptions = {}): Promise<GitHubApp> {
  const token = await appJwt(auth.appId, auth.privateKey, opts)
  return githubJson<GitHubApp>('/app', { token }, opts)
}

/** `GET /app/installations` — every account the app is installed on (first 100). */
export async function listInstallations(
  auth: GitHubAppAuth,
  opts: GitHubOptions = {}
): Promise<GitHubInstallation[]> {
  const token = await appJwt(auth.appId, auth.privateKey, opts)
  return githubJson<GitHubInstallation[]>('/app/installations?per_page=100', { token }, opts)
}

export interface InstallationTokenScope {
  /** Repository NAMES (not owner/name) the token may touch; omitted = every installed repo. */
  repositories?: string[]
  /** A narrowing of the installation's permissions, e.g. `{ contents: 'read' }`. */
  permissions?: GitHubPermissions
}

/**
 * A short-lived installation token (an hour), narrowed to `scope`. Always narrow it: an import
 * needs `contents: read` on one repo, not the installation's full write set.
 */
export async function installationToken(
  auth: GitHubAppAuth,
  installationId: number | string,
  scope: InstallationTokenScope = {},
  opts: GitHubOptions = {}
): Promise<GitHubInstallationToken> {
  const token = await appJwt(auth.appId, auth.privateKey, opts)
  const body: Record<string, unknown> = {}
  if (scope.repositories) body.repositories = scope.repositories
  if (scope.permissions) body.permissions = scope.permissions
  return githubJson<GitHubInstallationToken>(
    `/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
    { method: 'POST', token, body },
    opts
  )
}

/**
 * One file's raw contents at `ref` (default branch when omitted), or null when it does not exist.
 * Asks for `application/vnd.github.raw+json`, so the body IS the file — no base64 envelope.
 */
export async function getRepoFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
  opts: GitHubOptions = {}
): Promise<string | null> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${query}`
  const res = await githubRequest(url, { token, accept: 'application/vnd.github.raw+json' }, opts)
  if (res.status === 404) return null
  if (!res.ok) throw await failure(res, url)
  return res.text()
}
