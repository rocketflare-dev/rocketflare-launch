/**
 * `GitHubRepoHost` — the `RepoHostPort` on GitHub (`SESSION_BACKEND=cloud`).
 *
 * - `gitUpstream` is `https://github.com`.
 * - `gitAuth` mints an installation token scoped to the ONE repo (`contents: write`,
 *   `pull_requests: write`, 1 hour) from the sealed `github_app` credential
 *   (`loadImportGitHub(db, cfg)`, `services/launch/import.ts`). The egress handler seals it onto
 *   the session row and re-mints under 10 minutes left; nothing else ever sees it.
 * - `openPullRequest` is `createPullRequest`; a 422 (one is already open from that head — a retried
 *   ship step) finds the open one instead.
 * - `getChecks` folds `listCheckRuns` and `getCombinedStatus` on the head sha (`foldChecks`).
 *
 * The API calls use their own short-lived tokens, narrowed to the one repo and to what the call
 * needs, and revoked when done — the sandbox's token is never reused Launch-side.
 */
import type { PrCheckState, PrChecks } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import { ConflictError } from '../../../utils/core/errors'
import {
  createPullRequest,
  findOpenPullRequest,
  type GitHubApiError,
  type GitHubCheckRun,
  type GitHubCombinedStatus,
  type GitHubOptions,
  type GitHubPermissions,
  getCombinedStatus,
  installationToken,
  listCheckRuns,
  listInstallations,
  revokeInstallationToken,
} from '../../launch/github-app'
import { type ImportGitHub, loadImportGitHub } from '../../launch/import'
import type { GitAuth, OpenPullRequestInput, RepoHostPort, RepoRef } from '../ports'

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

  async gitAuth(repo: RepoRef): Promise<GitAuth | null> {
    const minted = await this.token(repo, { contents: 'write', pull_requests: 'write' })
    return { token: minted.token, expiresAt: new Date(minted.expires_at) }
  }

  openPullRequest(
    repo: RepoRef,
    input: OpenPullRequestInput
  ): Promise<{ number: number; url: string }> {
    return this.withToken(repo, { pull_requests: 'write' }, async token => {
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
}
