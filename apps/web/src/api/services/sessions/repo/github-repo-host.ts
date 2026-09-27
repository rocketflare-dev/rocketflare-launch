/**
 * `GitHubRepoHost` — the `RepoHostPort` on GitHub (`SESSION_BACKEND=cloud`): `gitUpstream` is
 * `https://github.com`; `gitAuth` mints an installation token scoped to the ONE repo
 * (`installationToken(auth, installationId, { repositories: [repo], permissions: { contents:
 * 'write', pull_requests: 'write' } })`, 1 hour) from the sealed `github_app` credential
 * (`loadImportGitHub(db, cfg)` in `services/launch/import.ts`); `openPullRequest` is
 * `createPullRequest` (finding the open one on a 422 "already exists"); `getChecks` folds
 * `listCheckRuns` and `getCombinedStatus` on the head sha (`services/launch/github-app.ts`).
 *
 * **Slice 3d owns this file.** From 3a it is a stub whose every method throws `NotWiredError`.
 */
import type { PrChecks } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import type { GitHubOptions } from '../../launch/github-app'
import {
  type GitAuth,
  NotWiredError,
  type OpenPullRequestInput,
  type RepoHostPort,
  type RepoRef,
} from '../ports'

export class GitHubRepoHost implements RepoHostPort {
  constructor(
    readonly db: Database,
    readonly cfg: AppConfig,
    /** Injected `fetch` / `apiBase` / `now` for tests. */
    readonly opts: GitHubOptions = {}
  ) {}

  gitUpstream(_repo: RepoRef): string {
    return 'https://github.com'
  }

  gitAuth(_repo: RepoRef): Promise<GitAuth | null> {
    throw new NotWiredError('GitHubRepoHost.gitAuth', '3d')
  }

  openPullRequest(
    _repo: RepoRef,
    _input: OpenPullRequestInput
  ): Promise<{ number: number; url: string }> {
    throw new NotWiredError('GitHubRepoHost.openPullRequest', '3d')
  }

  getChecks(_repo: RepoRef, _input: { prNumber: number; headSha: string }): Promise<PrChecks> {
    throw new NotWiredError('GitHubRepoHost.getChecks', '3d')
  }
}
