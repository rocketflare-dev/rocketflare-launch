/**
 * `GitHubRepoHost` — the `RepoHostPort` on GitHub (`SESSION_BACKEND=cloud`).
 *
 * - `gitUpstream` is `https://github.com`.
 * - `gitAuth` mints an installation token scoped to the ONE repo (`contents: write`,
 *   `pull_requests: write`, plus `workflows: write` when asked — a kit upgrade session — 1 hour)
 *   from the sealed `github_app` credential
 *   (`loadImportGitHub(db, cfg)`, `services/launch/import.ts`). The egress handler seals it onto
 *   the session row and re-mints under 10 minutes left; nothing else ever sees it.
 * - `openPullRequest` is `createPullRequest`; a 422 (one is already open from that head — a retried
 *   ship step) finds the open one instead.
 * - `getChecks` folds `listCheckRuns` and `getCombinedStatus` on the head sha (`foldChecks`).
 * - Issue #5: `getPullRequest` reads the PR fresh; `mergePullRequest` squash-merges on the gate
 *   SHA and maps GitHub's 409 to `head_moved`, 405/422 to `refused`; `failedCheckLog` names the
 *   first failing check (`Gate` first) with the tail of its Actions job log, else its annotations.
 * - Issue #9: `createCheckRun` posts Launch's `launch/gate` attestation — after reading the head's
 *   runs, so a retried step finds the run its first try posted (same name and `external_id`).
 *
 * The API calls use their own short-lived tokens, narrowed to the one repo and to what the call
 * needs, and revoked when done — the sandbox's token is never reused Launch-side.
 */
import { KIT_REQUIRED_CHECK } from '@launch/shared/launch-apps'
import type { PrCheckState, PrChecks } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { ConflictError } from '../../../utils/core/errors'
import {
  createCheckRun,
  createPullRequest,
  findOpenPullRequest,
  GITHUB_TOKEN_PERMISSIONS,
  GitHubApiError,
  type GitHubCheckAnnotation,
  type GitHubCheckRun,
  type GitHubCombinedStatus,
  type GitHubOptions,
  type GitHubPermissions,
  type GitHubPullRequest,
  getCombinedStatus,
  getJobLogs,
  getPullRequest,
  installationToken,
  listCheckRunAnnotations,
  listCheckRuns,
  listInstallations,
  mergePullRequest,
  revokeInstallationToken,
} from '../../launch/github-app'
import { type ImportGitHub, loadImportGitHub } from '../../launch/import'
import type {
  CreateCheckRunInput,
  CreateCheckRunResult,
  FailedCheckLog,
  GitAuth,
  GitAuthOptions,
  MergePullRequestResult,
  MergeShipPullRequestInput,
  OpenPullRequestInput,
  RepoHostPort,
  RepoPullRequest,
  RepoRef,
} from '../ports'

export interface GitHubRepoHostOptions extends GitHubOptions {
  /** Skip the credential store (tests). */
  github?: ImportGitHub
}

/** A check-run conclusion that does not fail a PR. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])

function checkRunState(run: GitHubCheckRun): PrCheckState {
  if (run.status !== 'completed') return 'pending'
  return run.conclusion && PASSING_CONCLUSIONS.has(run.conclusion) ? 'success' : 'failure'
}

function statusState(state: string): PrCheckState {
  if (state === 'success') return 'success'
  if (state === 'pending') return 'pending'
  return 'failure'
}

/**
 * Check runs plus the combined status, folded to one verdict: any failure fails, else anything
 * pending is pending, else success — and nothing reported at all is `none` (a repo with no CI).
 */
export function foldChecks(
  runs: readonly GitHubCheckRun[],
  combined: GitHubCombinedStatus | null,
  headSha: string | null,
  now: Date
): PrChecks {
  const checks: PrChecks['checks'] = [
    ...runs.map(run => ({
      name: run.name,
      source: 'check_run' as const,
      state: checkRunState(run),
      url: run.html_url ?? run.details_url ?? null,
    })),
    ...(combined?.statuses ?? []).map(status => ({
      name: status.context,
      source: 'status' as const,
      state: statusState(status.state),
      url: status.target_url ?? null,
    })),
  ]
  const count = (state: PrCheckState) => checks.filter(c => c.state === state).length
  const failed = count('failure')
  const pending = count('pending')
  const passed = count('success')
  const state: PrCheckState =
    checks.length === 0 ? 'none' : failed > 0 ? 'failure' : pending > 0 ? 'pending' : 'success'
  return { state, headSha, checkedAt: now, total: checks.length, passed, failed, pending, checks }
}

export class GitHubRepoHost implements RepoHostPort {
  constructor(
    readonly db: Database,
    readonly cfg: AppConfig,
    /** Injected `fetch` / `apiBase` / `now` / `github` for tests. */
    readonly opts: GitHubRepoHostOptions = {}
  ) {}

  private github: Promise<ImportGitHub> | null = null

  private loadGitHub(): Promise<ImportGitHub> {
    if (this.opts.github) return Promise.resolve(this.opts.github)
    this.github ??= loadImportGitHub(this.db, this.cfg)
    return this.github
  }

  /** The installation that can reach `owner`'s repos. */
  private async installationFor(github: ImportGitHub, owner: string): Promise<number | string> {
    const sameOrg = !github.org || github.org.toLowerCase() === owner.toLowerCase()
    if (github.installationId !== null && sameOrg) return github.installationId
    const match = (await listInstallations(github.auth, this.opts)).find(
      i => i.account?.login.toLowerCase() === owner.toLowerCase()
    )
    if (!match) {
      throw new ConflictError(
        `The GitHub App is not installed on ${owner}`,
        'github_app_not_installed'
      )
    }
    return match.id
  }

  private async token(repo: RepoRef, permissions: GitHubPermissions) {
    const github = await this.loadGitHub()
    const installationId = await this.installationFor(github, repo.owner)
    return installationToken(
      github.auth,
      installationId,
      { repositories: [repo.repo], permissions },
      this.opts
    )
  }

  /** Run `fn` with a one-call token, and revoke it after, whatever happened. */
  private async withToken<T>(
    repo: RepoRef,
    permissions: GitHubPermissions,
    fn: (token: string) => Promise<T>
  ): Promise<T> {
    const { token } = await this.token(repo, permissions)
    try {
      return await fn(token)
    } finally {
      await revokeInstallationToken(token, this.opts).catch(() => {})
    }
  }

  gitUpstream(_repo: RepoRef): string {
    return 'https://github.com'
  }

  async gitAuth(repo: RepoRef, opts: GitAuthOptions = {}): Promise<GitAuth | null> {
    const minted = await this.token(repo, {
      contents: 'write',
      pull_requests: 'write',
      ...(opts.workflows ? { workflows: 'write' as const } : {}),
    })
    return { token: minted.token, expiresAt: new Date(minted.expires_at) }
  }

  openPullRequest(
    repo: RepoRef,
    input: OpenPullRequestInput
  ): Promise<{ number: number; url: string }> {
    return this.withToken(repo, { contents: 'read', pull_requests: 'write' }, async token => {
      try {
        const pr = await createPullRequest(token, repo.owner, repo.repo, input, this.opts)
        return { number: pr.number, url: pr.html_url }
      } catch (err) {
        if ((err as GitHubApiError).status !== 422) throw err
        const open = await findOpenPullRequest(token, repo.owner, repo.repo, input.head, this.opts)
        if (!open) throw err
        return { number: open.number, url: open.html_url }
      }
    })
  }

  getChecks(repo: RepoRef, input: { prNumber: number; headSha: string }): Promise<PrChecks> {
    return this.withToken(repo, { checks: 'read', statuses: 'read' }, async token => {
      const [runs, combined] = await Promise.all([
        listCheckRuns(token, repo.owner, repo.repo, input.headSha, this.opts),
        getCombinedStatus(token, repo.owner, repo.repo, input.headSha, this.opts),
      ])
      const seconds = this.opts.now?.()
      const now = seconds === undefined ? new Date() : new Date(seconds * 1000)
      return foldChecks(runs, combined, input.headSha, now)
    })
  }

  getPullRequest(repo: RepoRef, prNumber: number): Promise<RepoPullRequest | null> {
    return this.withToken(repo, GITHUB_TOKEN_PERMISSIONS.readPullRequest, async token => {
      const pr = await getPullRequest(token, repo.owner, repo.repo, prNumber, this.opts)
      return pr ? toRepoPullRequest(pr) : null
    })
  }

  mergePullRequest(
    repo: RepoRef,
    input: MergeShipPullRequestInput
  ): Promise<MergePullRequestResult> {
    return this.withToken(repo, GITHUB_TOKEN_PERMISSIONS.merge, async token => {
      try {
        const merged = await mergePullRequest(
          token,
          repo.owner,
          repo.repo,
          input.prNumber,
          {
            sha: input.sha,
            mergeMethod: 'squash',
            commitTitle: input.commitTitle,
            commitMessage: input.commitMessage,
          },
          this.opts
        )
        if (!merged.merged) return { merged: false, code: 'refused', message: merged.message }
        return { merged: true, sha: merged.sha }
      } catch (err) {
        if (!(err instanceof GitHubApiError)) throw err
        if (err.status === 409) return { merged: false, code: 'head_moved', message: err.message }
        if (err.status === 405 || err.status === 422) {
          return { merged: false, code: 'refused', message: err.message }
        }
        throw err
      }
    })
  }

  createCheckRun(repo: RepoRef, input: CreateCheckRunInput): Promise<CreateCheckRunResult> {
    return this.withToken(repo, GITHUB_TOKEN_PERMISSIONS.checkRun, async token => {
      const runs = await listCheckRuns(token, repo.owner, repo.repo, input.headSha, this.opts)
      const earlier = runs.find(r => r.name === input.name && r.external_id === input.externalId)
      if (earlier) return { id: earlier.id, created: false }
      const run = await createCheckRun(token, repo.owner, repo.repo, input, this.opts)
      return { id: run.id, created: true }
    })
  }

  failedCheckLog(repo: RepoRef, input: { headSha: string }): Promise<FailedCheckLog | null> {
    const permissions = { ...GITHUB_TOKEN_PERMISSIONS.checks, ...GITHUB_TOKEN_PERMISSIONS.jobLogs }
    return this.withToken(repo, permissions, async token => {
      const runs = await listCheckRuns(token, repo.owner, repo.repo, input.headSha, this.opts)
      const failing = runs.filter(run => checkRunState(run) === 'failure')
      const run = failing.find(r => r.name === KIT_REQUIRED_CHECK) ?? failing[0]
      if (run) {
        return {
          name: run.name,
          url: run.html_url ?? run.details_url ?? null,
          logTail: await this.checkRunLogTail(token, repo, run),
        }
      }
      const combined = await getCombinedStatus(
        token,
        repo.owner,
        repo.repo,
        input.headSha,
        this.opts
      )
      const status = combined.statuses.find(s => statusState(s.state) === 'failure')
      if (!status) return null
      return {
        name: status.context,
        url: status.target_url ?? null,
        logTail: status.description ?? null,
      }
    })
  }

  /** An Actions job's log tail, else the run's annotations; null when neither says anything. */
  private async checkRunLogTail(
    token: string,
    repo: RepoRef,
    run: GitHubCheckRun
  ): Promise<string | null> {
    if (run.app?.slug === 'github-actions') {
      const log = await getJobLogs(token, repo.owner, repo.repo, run.id, this.opts).catch(
        () => null
      )
      if (log?.trim()) return logTail(log)
    }
    const annotations = await listCheckRunAnnotations(
      token,
      repo.owner,
      repo.repo,
      run.id,
      this.opts
    ).catch(() => [])
    if (annotations.length === 0) return null
    return logTail(annotations.map(formatAnnotation).join('\n'))
  }
}

// ---- issue #5 helpers --------------------------------------------------------------------------

/** How many lines of a failed check's log `failedCheckLog` keeps (plan §1.7). */
export const FAILED_CHECK_LOG_LINES = 80
/** And at most this many characters of them. */
export const FAILED_CHECK_LOG_MAX_CHARS = 16_000

/** The timestamp GitHub Actions prefixes every log line with. */
const ACTIONS_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/

/** The last `FAILED_CHECK_LOG_LINES` lines, timestamps stripped, capped. Not redacted. */
export function logTail(log: string): string {
  const lines = log
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(ACTIONS_TIMESTAMP_RE, ''))
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()
  const tail = lines.slice(-FAILED_CHECK_LOG_LINES).join('\n')
  return tail.length > FAILED_CHECK_LOG_MAX_CHARS ? tail.slice(-FAILED_CHECK_LOG_MAX_CHARS) : tail
}

function formatAnnotation(a: GitHubCheckAnnotation): string {
  const where = `${a.path}:${a.start_line}`
  const title = a.title ? `${a.title}: ` : ''
  return `${where} [${a.annotation_level}] ${title}${a.message}`
}

function toRepoPullRequest(pr: GitHubPullRequest): RepoPullRequest {
  const merged = pr.merged ?? Boolean(pr.merged_at)
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title ?? '',
    state: pr.state === 'open' ? 'open' : 'closed',
    merged,
    headSha: pr.head.sha,
    mergeSha: merged ? (pr.merge_commit_sha ?? null) : null,
    mergedAt: pr.merged_at ?? null,
  }
}
