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
 *   GitHub has not registered yet is a 404, which the pipeline retries), `GET …/runs`, and
 *   `GET …/actions/runs/{id}` — one run, which the deploy progress read polls — and
 *   `GET …/actions/runs/{id}/jobs`, a release tag's run's jobs (the pipeline strip).
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
 *   …/releases/tags/{tag}` (null on 404), which is what makes publishing idempotent. Issue #12
 *   adds `GET …/releases` (drafts included) and `PATCH …/releases/{id}`: publishing the DRAFT the
 *   kit's staging job attached its build-once bundle to, and writing Live's version into the notes.
 * - `GET …/compare/{base}...{head}` — the commits a release adds — and `GET …/commits/{sha}/pulls`,
 *   the pull requests a commit belongs to (a merge commit → the PR it merged; `merged_at`,
 *   `merge_commit_sha` and `user.login` on each).
 *
 * Issue #9 adds `POST …/check-runs` (`createCheckRun`, `checks: write`): the `launch/gate` check run
 * a green ship posts on its pushed head, so the kit's CI can skip the gate Launch already ran.
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
    const body = (await res.json()) as { message?: unknown; errors?: unknown }
    if (typeof body.message === 'string') message = body.message
    // A 422's `message` is only "Validation Failed"; the WHY is in `errors[]`.
    const details = validationDetails(body.errors)
    if (details) message = `${message} (${details})`
  } catch {
    // Not JSON — the status is all there is.
  }
  return new GitHubApiError(res.status, message, path)
}

/**
 * GitHub's `errors[]` as one line: each entry's own `message`, or `resource.field: code`. Bounded,
 * because it ends up in an event a person reads.
 */
export function validationDetails(errors: unknown): string | null {
  if (!Array.isArray(errors)) return null
  const parts = errors
    .map(e => {
      if (typeof e === 'string') return e
      if (!e || typeof e !== 'object') return null
      const { message, resource, field, code } = e as Record<string, unknown>
      if (typeof message === 'string' && message) return message
      const where = [resource, field].filter(x => typeof x === 'string' && x).join('.')
      return [where, typeof code === 'string' ? code : null].filter(Boolean).join(': ') || null
    })
    .filter((x): x is string => Boolean(x))
  return parts.length ? parts.join('; ').slice(0, 300) : null
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

/**
 * `commitFiles`, but only when `files` change the branch: GitHub's trees are content-addressed,
 * so a tree equal to the head's means the files are already there and nothing is committed.
 */
export async function commitFilesIfChanged(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  files: readonly CommitFile[],
  message: string,
  opts: GitHubOptions = {}
): Promise<{ sha: string; changed: boolean }> {
  const ref = await getRef(token, owner, repo, `heads/${branch}`, opts)
  const head = await getCommit(token, owner, repo, ref.object.sha, opts)
  const tree = await createTree(token, owner, repo, { baseTree: head.tree.sha, files }, opts)
  if (tree.sha === head.tree.sha) return { sha: head.sha, changed: false }
  const commit = await createCommit(
    token,
    owner,
    repo,
    { message, tree: tree.sha, parents: [head.sha] },
    opts
  )
  await updateRef(token, owner, repo, `heads/${branch}`, commit.sha, opts)
  return { sha: commit.sha, changed: true }
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

/**
 * Issue #21: every Actions run on commit `sha`, across the repo's workflows, newest first
 * (`GET …/actions/runs?head_sha=`, `actions: read`) — the merge commit's CI a stalled landing
 * re-runs.
 */
export async function listCommitWorkflowRuns(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  opts: GitHubOptions = {}
): Promise<GitHubWorkflowRun[]> {
  const params = new URLSearchParams({ head_sha: sha, per_page: '30' })
  const body = await githubJson<{ workflow_runs?: GitHubWorkflowRun[] }>(
    `${repoPath(owner, repo)}/actions/runs?${params}`,
    { token },
    opts
  )
  return body.workflow_runs ?? []
}

/** One run by id (its LATEST attempt's status), or null when the repo has no such run. */
export async function getWorkflowRun(
  token: string,
  owner: string,
  repo: string,
  runId: string,
  opts: GitHubOptions = {}
): Promise<GitHubWorkflowRun | null> {
  const path = `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}`
  const res = await githubRequest(path, { token }, opts)
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.ok) throw await failure(res, path)
  return (await res.json()) as GitHubWorkflowRun
}

export interface GitHubWorkflowJob {
  id: number
  name: string
  status: string | null
  conclusion: string | null
  started_at?: string | null
  completed_at?: string | null
  html_url?: string | null
}

/**
 * The jobs of a run's LATEST attempt, in the order GitHub lists them (`GET …/actions/runs/{id}/jobs`,
 * `actions: read`). The fix for a tag's deploy run (`releases/tag-run.ts`): which job it is on,
 * and which one failed.
 */
export async function listWorkflowRunJobs(
  token: string,
  owner: string,
  repo: string,
  runId: number | string,
  opts: GitHubOptions = {}
): Promise<GitHubWorkflowJob[]> {
  const body = await githubJson<{ jobs?: GitHubWorkflowJob[] }>(
    `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(String(runId))}/jobs?per_page=100`,
    { token },
    opts
  )
  return body.jobs ?? []
}

/**
 * App page P2 (stage-aware Retry): GitHub's "Re-run failed jobs" on a COMPLETED run
 * (`POST …/actions/runs/{id}/rerun-failed-jobs`, `actions: write`) — the failed and cancelled jobs
 * and everything that depends on them run again as the run's next attempt (`run_attempt + 1`),
 * on the same commit. GitHub answers 201 with no body; a run still going is its 403.
 */
export function rerunFailedJobs(
  token: string,
  owner: string,
  repo: string,
  runId: number | string,
  opts: GitHubOptions = {}
): Promise<void> {
  return githubVoid(
    `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(String(runId))}/rerun-failed-jobs`,
    { method: 'POST', token, body: {} },
    opts
  )
}

/**
 * App page P2 (Cancel release): cancel a run in progress (`POST …/actions/runs/{id}/cancel`,
 * `actions: write`). GitHub answers 202; a run that already completed is its 409.
 */
export function cancelWorkflowRun(
  token: string,
  owner: string,
  repo: string,
  runId: number | string,
  opts: GitHubOptions = {}
): Promise<void> {
  return githubVoid(
    `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(String(runId))}/cancel`,
    { method: 'POST', token },
    opts
  )
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

/** A repository Actions variable's value, or null when there is none. `actions_variables: read`. */
export async function getRepoVariable(
  token: string,
  owner: string,
  repo: string,
  name: string,
  opts: GitHubOptions = {}
): Promise<string | null> {
  const path = `${repoPath(owner, repo)}/actions/variables/${encodeURIComponent(name)}`
  const res = await githubRequest(path, { token }, opts)
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.ok) throw await failure(res, path)
  const body = (await res.json()) as { value?: unknown }
  return body.value == null ? '' : String(body.value)
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
  /**
   * Issue #5: the GitHub App that reported it. `github-actions` means the run IS an Actions job
   * (its id is the job id), so `getJobLogs(id)` reads its log; anything else has only annotations.
   */
  app?: { slug: string; id?: number } | null
  /** Issue #9: the reporter's own id for the run — `launch/gate`'s is `tree:<sha>`. */
  external_id?: string | null
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

/** Issue #9: what `createCheckRun` posts — always a completed run with its output. */
export interface CreateCheckRunInput {
  name: string
  headSha: string
  externalId: string
  conclusion: 'success' | 'failure' | 'neutral'
  output: { title: string; summary: string; text?: string }
}

/**
 * Issue #9: `POST …/check-runs` — a COMPLETED check run on `headSha` from the App whose
 * installation token this is (`checks: write`). Only a GitHub App may create one.
 */
export async function createCheckRun(
  token: string,
  owner: string,
  repo: string,
  input: CreateCheckRunInput,
  opts: GitHubOptions = {}
): Promise<GitHubCheckRun> {
  return githubJson<GitHubCheckRun>(
    `${repoPath(owner, repo)}/check-runs`,
    {
      method: 'POST',
      token,
      body: {
        name: input.name,
        head_sha: input.headSha,
        external_id: input.externalId,
        status: 'completed',
        conclusion: input.conclusion,
        completed_at: new Date((opts.now?.() ?? Date.now() / 1000) * 1000).toISOString(),
        output: input.output,
      },
    },
    opts
  )
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
  /** Issue #12: the release's assets — the kit's `launch-bundle-<tag>.tgz` on a build-once tag. */
  assets?: { id: number; name: string }[]
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

/**
 * Issue #12: the repository's releases, newest first — the first 100, drafts included (a token with
 * `contents: write` sees them; `GET …/releases/tags/{tag}` answers 404 for a draft).
 */
export function listReleases(
  token: string,
  owner: string,
  repo: string,
  opts: GitHubOptions = {}
): Promise<GitHubRelease[]> {
  return githubJson<GitHubRelease[]>(
    `${repoPath(owner, repo)}/releases?per_page=100`,
    { token },
    opts
  )
}

/**
 * Issue #21: a release asset's bytes as a stream (`GET …/releases/assets/{id}`, `Accept:
 * application/octet-stream`, `contents: read` — a draft's asset needs `contents: write`). GitHub
 * answers a redirect to a short-lived signed URL; it is followed WITHOUT the token, which belongs
 * to api.github.com only. The caller reads what it needs and cancels the rest.
 */
export async function downloadReleaseAsset(
  token: string,
  owner: string,
  repo: string,
  assetId: number,
  opts: GitHubOptions = {}
): Promise<ReadableStream<Uint8Array>> {
  const doFetch = opts.fetch ?? fetch
  const path = `${repoPath(owner, repo)}/releases/assets/${assetId}`
  const res = await doFetch(`${opts.apiBase ?? GITHUB_API_BASE}${path}`, {
    headers: {
      Accept: 'application/octet-stream',
      Authorization: `Bearer ${token}`,
      'User-Agent': GITHUB_USER_AGENT,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
    redirect: 'manual',
  })
  let body = res
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    await res.body?.cancel().catch(() => {})
    if (!location) throw new GitHubApiError(res.status, 'GitHub sent a redirect with no location', path)
    body = await doFetch(location, { headers: { 'User-Agent': GITHUB_USER_AGENT } })
  }
  if (!body.ok || !body.body) throw await failure(body, path)
  return body.body
}

/**
 * Issue #12: `PATCH …/releases/{id}` — publish a draft (`draft: false`, which fires `release:
 * published` exactly once) or rewrite a release's notes. Never moves `tag_name`.
 */
export function updateRelease(
  token: string,
  owner: string,
  repo: string,
  id: number,
  input: { draft?: boolean; name?: string; body?: string },
  opts: GitHubOptions = {}
): Promise<GitHubRelease> {
  return githubJson<GitHubRelease>(
    `${repoPath(owner, repo)}/releases/${id}`,
    { method: 'PATCH', token, body: input },
    opts
  )
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

export interface GitHubTag {
  name: string
  commit: { sha: string }
}

/** The repo's tags, first page (GitHub orders them by name, not by semver — sort yourself). */
export function listTags(
  token: string,
  owner: string,
  repo: string,
  opts: GitHubOptions = {}
): Promise<GitHubTag[]> {
  return githubJson<GitHubTag[]>(`${repoPath(owner, repo)}/tags?per_page=100`, { token }, opts)
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

// ---- Issue #5: merge, CI logs, rulesets (`docs/plans/i5-ship-to-staging.md`) --------------------

/**
 * The narrowed installation-token permissions each issue #5 call needs (plan §1.13). A token is
 * always minted for one repo and only these, within `REQUIRED_GITHUB_PERMISSIONS` (`setup.ts`) —
 * issue #9's `checkRun` is the one that raised it (`checks: read` → `write`).
 */
export const GITHUB_TOKEN_PERMISSIONS = {
  /** The squash merge (and the re-read of the PR right before it). */
  merge: { contents: 'write', pull_requests: 'write' },
  /** Reading a pull request only. */
  readPullRequest: { pull_requests: 'read' },
  /** A failed check's job log (`getJobLogs`). */
  jobLogs: { actions: 'read' },
  /** A release tag's deploy run and its jobs (`listWorkflowRuns`, `listWorkflowRunJobs`). */
  tagRun: { actions: 'read' },
  /** The check runs, statuses and annotations on a head (`failedCheckLog`). */
  checks: { checks: 'read', statuses: 'read' },
  /** Issue #9: posting Launch's `launch/gate` check run (and reading the head's runs first). */
  checkRun: { checks: 'write' },
  /** Creating or updating Launch's ruleset. */
  rulesetsWrite: { administration: 'write' },
  /** The branch-protection diagnosis: rulesets and classic protection, read only. */
  rulesetsRead: { administration: 'read' },
  /** Issue #10: reading the repo's `LAUNCH_GATE_APP_ID` Actions variable. */
  gateVariableRead: { actions_variables: 'read' },
  /** Issue #10: setting it (`github_env`, Apply, the start of a kit upgrade). */
  gateVariableWrite: { actions_variables: 'write' },
  /** App page P2: a release run's re-run of its failed jobs, or its cancel (and the reads around). */
  releaseRun: { actions: 'write', contents: 'read' },
  /** App page P2: re-pushing a release's tag (and reading its runs). */
  releaseTag: { contents: 'write', actions: 'read' },
  /** Issue #21: re-running a stalled landing's merge-commit CI (and listing its runs). */
  rerunCommitRuns: { actions: 'write' },
} as const satisfies Record<string, GitHubPermissions>

export interface MergePullRequestInput {
  /** The head the merge must be on: GitHub answers 409 when the PR's head is anything else. */
  sha: string
  mergeMethod?: 'squash' | 'merge' | 'rebase'
  commitTitle?: string
  commitMessage?: string
}

export interface GitHubMergeResult {
  sha: string
  merged: boolean
  message: string
}

/**
 * Merge a pull request (squash by default). 200 → merged, `sha` the merge commit. Throws
 * `GitHubApiError` otherwise — 409 the head is not `sha`, 405 not mergeable (a required check or
 * review missing, a conflict), 422 invalid — with GitHub's message; the caller maps them.
 */
export function mergePullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
  input: MergePullRequestInput,
  opts: GitHubOptions = {}
): Promise<GitHubMergeResult> {
  return githubJson<GitHubMergeResult>(
    `${repoPath(owner, repo)}/pulls/${number}/merge`,
    {
      method: 'PUT',
      token,
      body: {
        merge_method: input.mergeMethod ?? 'squash',
        sha: input.sha,
        ...(input.commitTitle !== undefined ? { commit_title: input.commitTitle } : {}),
        ...(input.commitMessage !== undefined ? { commit_message: input.commitMessage } : {}),
      },
    },
    opts
  )
}

/**
 * An Actions job's plain-text log (GitHub redirects to a short-lived download URL, which `fetch`
 * follows), or null when GitHub has none (404, or 410 once expired). Needs `actions: read`. The
 * whole log: the caller keeps the tail and redacts it.
 */
export async function getJobLogs(
  token: string,
  owner: string,
  repo: string,
  jobId: number,
  opts: GitHubOptions = {}
): Promise<string | null> {
  const path = `${repoPath(owner, repo)}/actions/jobs/${jobId}/logs`
  const res = await githubRequest(path, { token }, opts)
  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.ok) throw await failure(res, path)
  return res.text()
}

export interface GitHubCheckAnnotation {
  path: string
  start_line: number
  end_line?: number
  annotation_level: 'notice' | 'warning' | 'failure' | string
  title?: string | null
  message: string
  raw_details?: string | null
}

/** A check run's annotations (the first 50) — the only "log" a non-Actions check has. */
export function listCheckRunAnnotations(
  token: string,
  owner: string,
  repo: string,
  checkRunId: number,
  opts: GitHubOptions = {}
): Promise<GitHubCheckAnnotation[]> {
  return githubJson<GitHubCheckAnnotation[]>(
    `${repoPath(owner, repo)}/check-runs/${checkRunId}/annotations?per_page=50`,
    { token },
    opts
  )
}

/** One rule of a ruleset: `pull_request`, `required_status_checks`, `non_fast_forward`, … */
export interface GitHubRulesetRule {
  type: string
  parameters?: Record<string, unknown>
}

export interface GitHubRulesetBypassActor {
  /** The App id for `Integration`; null for `OrganizationAdmin`. */
  actor_id: number | null
  actor_type: 'Integration' | 'OrganizationAdmin' | 'RepositoryRole' | 'Team' | 'DeployKey' | string
  bypass_mode: 'always' | 'pull_request' | string
}

export interface GitHubRuleset {
  id: number
  name: string
  target?: 'branch' | 'tag' | 'push' | string
  /** `Repository` for the repo's own; `Organization` for one inherited from the org. */
  source_type?: 'Repository' | 'Organization' | string
  source?: string
  enforcement: 'active' | 'evaluate' | 'disabled' | string
  bypass_actors?: GitHubRulesetBypassActor[]
  conditions?: { ref_name?: { include: string[]; exclude: string[] } } | null
  /** Present on `getRuleset`; the list answer omits it. */
  rules?: GitHubRulesetRule[]
  /** Whether the CALLER (the installation token's App) may bypass it. */
  current_user_can_bypass?: 'always' | 'pull_requests_only' | 'never' | 'exempt' | string
}

/** What `createRuleset` / `updateRuleset` send. */
export interface GitHubRulesetInput {
  name: string
  target: 'branch'
  enforcement: 'active' | 'evaluate' | 'disabled'
  bypass_actors: GitHubRulesetBypassActor[]
  conditions: { ref_name: { include: string[]; exclude: string[] } }
  rules: GitHubRulesetRule[]
}

/**
 * The rulesets that apply to the repo, the org's included (`includes_parents`). A 404 or 403 — a
 * plan with no rulesets on this repo (a private repo outside GitHub Team) — is thrown for the
 * caller to read as `unavailable`. Needs `administration: read`.
 */
export function listRulesets(
  token: string,
  owner: string,
  repo: string,
  opts: GitHubOptions = {}
): Promise<GitHubRuleset[]> {
  return githubJson<GitHubRuleset[]>(
    `${repoPath(owner, repo)}/rulesets?includes_parents=true&per_page=100`,
    { token },
    opts
  )
}

/** One ruleset with its `rules` and `current_user_can_bypass`; null when it does not exist. */
export async function getRuleset(
  token: string,
  owner: string,
  repo: string,
  rulesetId: number,
  opts: GitHubOptions = {}
): Promise<GitHubRuleset | null> {
  const path = `${repoPath(owner, repo)}/rulesets/${rulesetId}`
  const res = await githubRequest(path, { token }, opts)
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.ok) throw await failure(res, path)
  return (await res.json()) as GitHubRuleset
}

/** Create a repository ruleset. Needs `administration: write`; 403/404 when the plan has none. */
export function createRuleset(
  token: string,
  owner: string,
  repo: string,
  input: GitHubRulesetInput,
  opts: GitHubOptions = {}
): Promise<GitHubRuleset> {
  return githubJson<GitHubRuleset>(
    `${repoPath(owner, repo)}/rulesets`,
    { method: 'POST', token, body: input },
    opts
  )
}

/** Replace a repository ruleset's settings (`PUT`). Needs `administration: write`. */
export function updateRuleset(
  token: string,
  owner: string,
  repo: string,
  rulesetId: number,
  input: GitHubRulesetInput,
  opts: GitHubOptions = {}
): Promise<GitHubRuleset> {
  return githubJson<GitHubRuleset>(
    `${repoPath(owner, repo)}/rulesets/${rulesetId}`,
    { method: 'PUT', token, body: input },
    opts
  )
}

/** Classic branch protection, as far as the diagnosis reads it. */
export interface GitHubBranchProtection {
  required_status_checks?: {
    strict?: boolean
    contexts?: string[]
    checks?: { context: string; app_id: number | null }[]
  } | null
  required_pull_request_reviews?: { required_approving_review_count?: number } | null
  enforce_admins?: { enabled: boolean } | null
}

/**
 * The branch's CLASSIC protection, or null when it has none (GitHub's 404 "Branch not
 * protected"). Launch never writes it: a classic required check cannot be bypassed by an App, so
 * the diagnosis reports `blocks` and the admin removes it. Needs `administration: read`.
 */
export async function getBranchProtection(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  opts: GitHubOptions = {}
): Promise<GitHubBranchProtection | null> {
  const path = `${repoPath(owner, repo)}/branches/${encodeURIComponent(branch)}/protection`
  const res = await githubRequest(path, { token }, opts)
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.ok) throw await failure(res, path)
  return (await res.json()) as GitHubBranchProtection
}
