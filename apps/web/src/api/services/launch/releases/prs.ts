/**
 * A release's pull requests (Launch P4, plan §1.8 / §1.10) — slice 4d builds it:
 * `compareCommits(previousTag…sha)`, then `listPullRequestsForCommit` per commit (capped at
 * `RELEASE_MAX_PRS`), merged PRs only, each matched to the Launch session that shipped it
 * (`sessions.pr_number`) when there is one.
 */
import type { ReleasePr } from '@launch/shared/launch-releases'
import { NotWiredError } from '../../approvals/types'
import type { GitHubOptions } from '../github-app'

export async function releasePullRequests(
  _input: {
    token: string
    owner: string
    repo: string
    base: string | null
    head: string
  },
  _opts: GitHubOptions = {}
): Promise<ReleasePr[]> {
  throw new NotWiredError('releases.releasePullRequests', '4d')
}
