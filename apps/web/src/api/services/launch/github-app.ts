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
 *
 * P2 adds the writes creating an app needs, all under an INSTALLATION token (never the app JWT):
 *
 * - Repos: `POST /orgs/{org}/repos` (private, `auto_init` so `main` exists to commit onto),
 *   `GET|PATCH {archived}|DELETE /repos/{o}/{r}`.
 * - Git Data, so a commit needs no clone: `GET …/git/ref/heads/{b}` → the head commit →
 *   its tree; `POST …/git/trees {base_tree, tree:[{path, mode, type:'blob', content}]}` (inline
 *   content, `sha: null` deletes), `POST …/git/commits`, `PATCH …/git/refs/heads/{b}`.
 *   `commitFiles` is the four in a row.
 * - Actions: `POST …/actions/workflows/{file}/dispatches {ref, inputs}` (204; a workflow file
 *   GitHub has not registered yet is a 404, which the pipeline retries) and `GET …/runs`.
 * - Settings: `PUT …/environments/{name}`, repository variables (`PATCH`, falling back to `POST`
 *   when the variable does not exist yet), and `DELETE /installation/token` — a job revoking the
 *   token it was handed.
 *
 * P3 adds what shipping a coding session needs, under an installation token scoped to the one repo:
 *
 * - `POST …/pulls {title, head, base, body}` (`pull_requests: write`; 422 "A pull request already
 *   exists" for a second one from the same head — `findOpenPullRequest` is the way back to it) and
 *   `GET …/pulls/{n}`.
 * - CI on the head commit, which is TWO APIs: `GET …/commits/{ref}/check-runs` (Actions and other
 *   Checks apps — `checks: read`) and `GET …/commits/{ref}/status`, the combined commit status
 *   (older integrations — `statuses: read`). A PR is green only when both are.
 *
 * P4 adds what Launch's own release dance needs (plan §1.8), under the same narrowed token:
 *
 * - `POST …/git/refs {ref: 'refs/tags/X.Y.Z', sha}` — the tag that starts `deploy.yml` staging
 *   (`contents: write`; 422 "Reference already exists" for a second one).
 * - `POST …/releases {tag_name}` — publishing the Release that starts production, and `GET
 *   …/releases/tags/{tag}` (null on 404), which is what makes publishing idempotent.
 * - `GET …/compare/{base}...{head}` — the commits a release adds — and `GET …/commits/{sha}/pulls`,
 *   the pull requests a commit belongs to (a merge commit → the PR it merged; `merged_at`,
 *   `merge_commit_sha` and `user.login` on each).
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

/** One authenticated GitHub call; the raw `Response`, whatever its status. */
export async function githubRequest(
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

/** True for a GitHub 404 — what teardown counts as "already gone". */
export function isGitHubNotFound(err: unknown): boolean {
  return err instanceof GitHubApiError && err.status === 404
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

/** One call whose 2xx body is JSON; anything else throws `GitHubApiError`. */
export async function githubJson<T>(
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

// ---- P2: repos --------------------------------------------------------------------------------

export interface GitHubRepo {
  /** Numeric and stable across renames — the OIDC `repository_id` claim. */
  id: number
  name: string
  full_name: string
  private: boolean
  archived?: boolean
  default_branch: string
  html_url?: string
  owner: { login: string }
}

const repoPath = (owner: string, repo: string) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`

/** A call whose success has no body worth reading (204s, or a body nobody needs). */
async function githubVoid(
  path: string,
  init: { method: string; token: string; body?: unknown },
  opts: GitHubOptions
): Promise<void> {
  const res = await githubRequest(path, init, opts)
  if (!res.ok) throw await failure(res, path)
  await res.body?.cancel().catch(() => {})
}

/** A new repository in the org. `autoInit` gives it a `main` with one commit to build on. */
export function createOrgRepo(
  token: string,
  org: string,
  input: { name: string; description?: string; private?: boolean; autoInit?: boolean },
  opts: GitHubOptions = {}
): Promise<GitHubRepo> {
  return githubJson<GitHubRepo>(
    `/orgs/${encodeURIComponent(org)}/repos`,
    {
      method: 'POST',
      token,
      body: {
        name: input.name,
        description: input.description,
        private: input.private ?? true,
        auto_init: input.autoInit ?? true,
      },
    },
    opts
  )
}

/** The repository, or null when it does not exist (or the token cannot see it). */
export async function getRepo(
  token: string,
  owner: string,
  repo: string,
  opts: GitHubOptions = {}
): Promise<GitHubRepo | null> {
  const path = repoPath(owner, repo)
  const res = await githubRequest(path, { token }, opts)
  if (res.status === 404) return null
  if (!res.ok) throw await failure(res, path)
  return (await res.json()) as GitHubRepo
}

/** Archive (read-only, kept) — teardown's default. */
export function archiveRepo(
  token: string,
  owner: string,
  repo: string,
  opts: GitHubOptions = {}
): Promise<GitHubRepo> {
  return githubJson<GitHubRepo>(
    repoPath(owner, repo),
    { method: 'PATCH', token, body: { archived: true } },
    opts
  )
}

/** Delete for good — teardown only when the person ticked "delete repository". */
export function deleteRepo(
  token: string,
  owner: string,
  repo: string,
  opts: GitHubOptions = {}
): Promise<void> {
  return githubVoid(repoPath(owner, repo), { method: 'DELETE', token }, opts)
}

// ---- P2: Git Data -----------------------------------------------------------------------------

export interface GitHubRef {
  ref: string
  object: { sha: string; type: string }
}

export interface GitHubCommit {
  sha: string
  tree: { sha: string }
  parents?: { sha: string }[]
  message?: string
}

/**
 * One file to write: `content` inline (UTF-8), or `null` to delete the path. `mode` defaults to
 * `100644`; `100755` for an executable.
 */
export interface CommitFile {
  path: string
  content: string | null
  mode?: '100644' | '100755'
}

/** `ref` without the `refs/` prefix, e.g. `heads/main`. */
export function getRef(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  opts: GitHubOptions = {}
): Promise<GitHubRef> {
  return githubJson<GitHubRef>(`${repoPath(owner, repo)}/git/ref/${ref}`, { token }, opts)
}

export function getCommit(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  opts: GitHubOptions = {}
): Promise<GitHubCommit> {
  return githubJson<GitHubCommit>(
    `${repoPath(owner, repo)}/git/commits/${encodeURIComponent(sha)}`,
    { token },
    opts
  )
}

/** A tree on top of `baseTree` with `files` written (inline content) or removed. */
export function createTree(
  token: string,
  owner: string,
  repo: string,
  input: { baseTree?: string; files: readonly CommitFile[] },
  opts: GitHubOptions = {}
): Promise<{ sha: string }> {
  return githubJson<{ sha: string }>(
    `${repoPath(owner, repo)}/git/trees`,
    {
      method: 'POST',
      token,
      body: {
        ...(input.baseTree ? { base_tree: input.baseTree } : {}),
        tree: input.files.map(f =>
          f.content === null
            ? { path: f.path, mode: f.mode ?? '100644', type: 'blob', sha: null }
            : { path: f.path, mode: f.mode ?? '100644', type: 'blob', content: f.content }
        ),
      },
    },
    opts
  )
}

export function createCommit(
  token: string,
  owner: string,
  repo: string,
  input: { message: string; tree: string; parents: string[] },
  opts: GitHubOptions = {}
): Promise<GitHubCommit> {
  return githubJson<GitHubCommit>(
    `${repoPath(owner, repo)}/git/commits`,
    { method: 'POST', token, body: input },
    opts
  )
}

/** Move `ref` (e.g. `heads/main`) to `sha`. Not forced: a concurrent push makes this fail. */
export function updateRef(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  sha: string,
  opts: GitHubOptions & { force?: boolean } = {}
): Promise<GitHubRef> {
  return githubJson<GitHubRef>(
    `${repoPath(owner, repo)}/git/refs/${ref}`,
    { method: 'PATCH', token, body: { sha, force: opts.force ?? false } },
    opts
  )
}

/**
 * Commit `files` onto the tip of `branch` in one commit, with no clone: ref → head commit → its
 * tree → a new tree on top → a commit → move the ref. Returns the new commit's sha.
 */
export async function commitFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  files: readonly CommitFile[],
  message: string,
  opts: GitHubOptions = {}
): Promise<{ sha: string }> {
  const ref = await getRef(token, owner, repo, `heads/${branch}`, opts)
  const head = await getCommit(token, owner, repo, ref.object.sha, opts)
  const tree = await createTree(token, owner, repo, { baseTree: head.tree.sha, files }, opts)
  const commit = await createCommit(
    token,
    owner,
    repo,
    { message, tree: tree.sha, parents: [head.sha] },
    opts
  )
  await updateRef(token, owner, repo, `heads/${branch}`, commit.sha, opts)
  return { sha: commit.sha }
}

// ---- P2: Actions ------------------------------------------------------------------------------

export interface GitHubWorkflowRun {
  id: number
  run_attempt?: number
  status: string | null
  conclusion: string | null
  head_sha?: string
  head_branch?: string | null
  event?: string
  created_at?: string
  html_url?: string
}

/**
 * `workflow_dispatch` on `workflowFile` (e.g. `deploy.yml`) at `ref`. GitHub answers 204 and no
 * run id — find the run with `listWorkflowRuns`. A 404 means the file is not registered (yet).
 */
export function dispatchWorkflow(
  token: string,
  owner: string,
  repo: string,
  workflowFile: string,
  input: { ref: string; inputs?: Record<string, string> },
  opts: GitHubOptions = {}
): Promise<void> {
  return githubVoid(
    `${repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
    { method: 'POST', token, body: { ref: input.ref, inputs: input.inputs ?? {} } },
    opts
  )
}

/** The workflow's most recent runs, newest first. */
export async function listWorkflowRuns(
  token: string,
  owner: string,
  repo: string,
  workflowFile: string,
  query: { branch?: string; event?: string; perPage?: number } = {},
  opts: GitHubOptions = {}
): Promise<GitHubWorkflowRun[]> {
  const params = new URLSearchParams({ per_page: String(query.perPage ?? 10) })
  if (query.branch) params.set('branch', query.branch)
  if (query.event) params.set('event', query.event)
  const body = await githubJson<{ workflow_runs?: GitHubWorkflowRun[] }>(
    `${repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?${params}`,
    { token },
    opts
  )
  return body.workflow_runs ?? []
}

// ---- P2: settings -----------------------------------------------------------------------------

/** Create or update a deployment environment (it scopes the OIDC `environment` claim). */
export function putEnvironment(
  token: string,
  owner: string,
  repo: string,
  name: string,
  settings: Record<string, unknown> = {},
  opts: GitHubOptions = {}
): Promise<{ id: number; name: string }> {
  return githubJson<{ id: number; name: string }>(
    `${repoPath(owner, repo)}/environments/${encodeURIComponent(name)}`,
    { method: 'PUT', token, body: settings },
    opts
  )
}

/** Set a repository Actions VARIABLE (not a secret): update, or create when it does not exist. */
export async function upsertRepoVariable(
  token: string,
  owner: string,
  repo: string,
  name: string,
  value: string,
  opts: GitHubOptions = {}
): Promise<void> {
  const base = `${repoPath(owner, repo)}/actions/variables`
  const res = await githubRequest(
    `${base}/${encodeURIComponent(name)}`,
    { method: 'PATCH', token, body: { name, value } },
    opts
  )
  if (res.ok) {
    await res.body?.cancel().catch(() => {})
    return
  }
  if (res.status !== 404) throw await failure(res, `${base}/${name}`)
  await githubVoid(base, { method: 'POST', token, body: { name, value } }, opts)
}

/** Revoke the installation token making the call — a job ending its own access. */
export function revokeInstallationToken(token: string, opts: GitHubOptions = {}): Promise<void> {
  return githubVoid('/installation/token', { method: 'DELETE', token }, opts)
}

// ---- P3: pull requests and CI -----------------------------------------------------------------

export interface GitHubPullRequest {
  number: number
  html_url: string
  state: 'open' | 'closed' | string
  merged?: boolean
  draft?: boolean
  title?: string
  head: { ref: string; sha: string }
  base: { ref: string }
  /** P4: set once merged (ISO); what `pr.merged` records. */
  merged_at?: string | null
  /** P4: the merge commit on the base branch, once merged. */
  merge_commit_sha?: string | null
  /** P4: the author's login (the App's bot for a session PR). */
  user?: { login: string } | null
}

/** Open a pull request from `head` into `base`. A second one from the same head is a 422. */
export function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  input: { title: string; head: string; base: string; body?: string; draft?: boolean },
  opts: GitHubOptions = {}
): Promise<GitHubPullRequest> {
  return githubJson<GitHubPullRequest>(
    `${repoPath(owner, repo)}/pulls`,
    {
      method: 'POST',
      token,
      body: {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body ?? '',
        draft: input.draft ?? false,
      },
    },
    opts
  )
}

/** One pull request, or null when it does not exist. */
export async function getPullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
  opts: GitHubOptions = {}
): Promise<GitHubPullRequest | null> {
  const path = `${repoPath(owner, repo)}/pulls/${number}`
  const res = await githubRequest(path, { token }, opts)
  if (res.status === 404) return null
  if (!res.ok) throw await failure(res, path)
  return (await res.json()) as GitHubPullRequest
}

/** The OPEN pull request from `head` (a branch in the same repo), or null. */
export async function findOpenPullRequest(
  token: string,
  owner: string,
  repo: string,
  head: string,
  opts: GitHubOptions = {}
): Promise<GitHubPullRequest | null> {
  const params = new URLSearchParams({ state: 'open', head: `${owner}:${head}`, per_page: '1' })
  const pulls = await githubJson<GitHubPullRequest[]>(
    `${repoPath(owner, repo)}/pulls?${params}`,
    { token },
    opts
  )
  return pulls[0] ?? null
}

export interface GitHubCheckRun {
  id: number
  name: string
  status: 'queued' | 'in_progress' | 'completed' | string
  /** Null until `completed`; then `success`, `failure`, `neutral`, `skipped`, `cancelled`… */
  conclusion: string | null
  html_url?: string | null
  details_url?: string | null
}

/** The check runs on `ref` (a sha or branch) — the first 100, which is every CI a PR has. */
export async function listCheckRuns(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  opts: GitHubOptions = {}
): Promise<GitHubCheckRun[]> {
  const body = await githubJson<{ total_count: number; check_runs?: GitHubCheckRun[] }>(
    `${repoPath(owner, repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    { token },
    opts
  )
  return body.check_runs ?? []
}

export interface GitHubCommitStatus {
  context: string
  state: 'pending' | 'success' | 'failure' | 'error' | string
  target_url?: string | null
  description?: string | null
}

export interface GitHubCombinedStatus {
  /** GitHub answers `pending` with `total_count: 0` for a commit nobody reported a status on. */
  state: 'pending' | 'success' | 'failure' | 'error' | string
  sha: string
  total_count: number
  statuses: GitHubCommitStatus[]
}

/** The combined commit status of `ref` (every status context's latest state, folded). */
export function getCombinedStatus(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  opts: GitHubOptions = {}
): Promise<GitHubCombinedStatus> {
  return githubJson<GitHubCombinedStatus>(
    `${repoPath(owner, repo)}/commits/${encodeURIComponent(ref)}/status`,
    { token },
    opts
  )
}

// ---- P4: tags, releases, compare --------------------------------------------------------------

/**
 * Create a ref — `refs/tags/X.Y.Z` for a release (a lightweight tag on `sha`). A ref that already
 * exists is GitHub's 422 "Reference already exists".
 */
export function createRef(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  sha: string,
  opts: GitHubOptions = {}
): Promise<GitHubRef> {
  return githubJson<GitHubRef>(
    `${repoPath(owner, repo)}/git/refs`,
    { method: 'POST', token, body: { ref, sha } },
    opts
  )
}

export interface GitHubRelease {
  id: number
  tag_name: string
  name: string | null
  body?: string | null
  draft: boolean
  prerelease: boolean
  html_url: string
  target_commitish?: string
  published_at: string | null
}

/**
 * Publish a GitHub Release on `tagName` — for a kit app, the `release: published` event that
 * starts the production deploy job. A second release on the same tag is a 422
 * (`already_exists`); callers check `getReleaseByTag` first.
 */
export function createRelease(
  token: string,
  owner: string,
  repo: string,
  input: {
    tagName: string
    name?: string
    body?: string
    /** Only used when the tag does not exist yet (GitHub then creates it here). */
    targetCommitish?: string
    draft?: boolean
    prerelease?: boolean
  },
  opts: GitHubOptions = {}
): Promise<GitHubRelease> {
  return githubJson<GitHubRelease>(
    `${repoPath(owner, repo)}/releases`,
    {
      method: 'POST',
      token,
      body: {
        tag_name: input.tagName,
        name: input.name ?? input.tagName,
        body: input.body ?? '',
        draft: input.draft ?? false,
        prerelease: input.prerelease ?? false,
        ...(input.targetCommitish ? { target_commitish: input.targetCommitish } : {}),
      },
    },
    opts
  )
}

/** The release on `tag`, or null when there is none. */
export async function getReleaseByTag(
  token: string,
  owner: string,
  repo: string,
  tag: string,
  opts: GitHubOptions = {}
): Promise<GitHubRelease | null> {
  const path = `${repoPath(owner, repo)}/releases/tags/${encodeURIComponent(tag)}`
  const res = await githubRequest(path, { token }, opts)
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.ok) throw await failure(res, path)
  return (await res.json()) as GitHubRelease
}

export interface GitHubCompareCommit {
  sha: string
  parents?: { sha: string }[]
  commit: { message: string; author?: { name?: string; date?: string } | null }
}

export interface GitHubComparison {
  status: 'ahead' | 'behind' | 'identical' | 'diverged' | string
  ahead_by: number
  behind_by: number
  total_commits: number
  html_url: string
  /** Oldest first; GitHub returns at most 250. */
  commits: GitHubCompareCommit[]
}

/** `base...head` (a tag, branch or sha each) — the commits `head` adds over `base`. */
export function compareCommits(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
  opts: GitHubOptions = {}
): Promise<GitHubComparison> {
  return githubJson<GitHubComparison>(
    `${repoPath(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    { token },
    opts
  )
}

/** The pull requests `sha` belongs to — for a merge commit, the PR it merged. */
export function listPullRequestsForCommit(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  opts: GitHubOptions = {}
): Promise<GitHubPullRequest[]> {
  return githubJson<GitHubPullRequest[]>(
    `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/pulls?per_page=100`,
    { token },
    opts
  )
}
