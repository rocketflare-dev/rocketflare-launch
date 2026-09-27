/**
 * `LocalRepoHost` — the `RepoHostPort` on the laptop (`SESSION_BACKEND=local`): the sandbox still
 * clones `https://github.com/<o>/<r>.git`, and the GitHub egress handler rewrites it to
 * `SESSION_LOCAL_GIT_URL` (`pnpm sessions:local-git serve`, git smart-HTTP on :9420) — so the
 * checkout and the Workflow are identical in both backends. No token (`gitAuth` → null);
 * `openPullRequest` writes the PR fields as `local://<o>/<r>/pull/<n>`; `getChecks` reports the
 * ship gate's own result.
 *
 * **Slice 3d owns this file.** From 3a it is a stub: `gitUpstream` and `gitAuth` are real, the
 * PR and checks methods throw `NotWiredError`.
 */
import type { PrChecks } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../../config'
import {
  type GitAuth,
  NotWiredError,
  type OpenPullRequestInput,
  type RepoHostPort,
  type RepoRef,
} from '../ports'

export class LocalRepoHost implements RepoHostPort {
  constructor(readonly cfg: AppConfig) {}

  gitUpstream(_repo: RepoRef): string {
    return (this.cfg.SESSION_LOCAL_GIT_URL ?? 'http://localhost:9420').replace(/\/+$/, '')
  }

  async gitAuth(_repo: RepoRef): Promise<GitAuth | null> {
    return null
  }

  openPullRequest(
    _repo: RepoRef,
    _input: OpenPullRequestInput
  ): Promise<{ number: number; url: string }> {
    throw new NotWiredError('LocalRepoHost.openPullRequest', '3d')
  }

  getChecks(_repo: RepoRef, _input: { prNumber: number; headSha: string }): Promise<PrChecks> {
    throw new NotWiredError('LocalRepoHost.getChecks', '3d')
  }
}
