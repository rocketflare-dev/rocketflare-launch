/**
 * A release's pull requests (Launch P4, plan §1.8 / §1.10): `compareCommits(previousTag…sha)`,
 * then `listPullRequestsForCommit` per commit, merged PRs only, oldest merge first, capped at
 * `RELEASE_MAX_PRS`. This is what catches every PR a person merged in GitHub — Launch only polls
 * its own sessions' PRs (`sessions.checks`), so a release's compare is the net for the rest.
 *
 * Pure GitHub: the caller (`release.ts`) matches each PR to the Launch session that shipped it
 * (`sessions.pr_number`), because that needs the database. With no base (an app's first release,
 * with no earlier tag anywhere) there is nothing to compare against and this returns `[]` — the
 * caller falls back to the session PRs Launch recorded as merged.
 */
import { RELEASE_MAX_PRS, type ReleasePr } from '@launch/shared/launch-releases'
import { compareCommits, type GitHubOptions, listPullRequestsForCommit } from '../github-app'

export async function releasePullRequests(
  input: {
    token: string
    owner: string
    repo: string
    base: string | null
    head: string
  },
  opts: GitHubOptions = {}
): Promise<ReleasePr[]> {
  if (!input.base) return []
  const { token, owner, repo } = input
  const comparison = await compareCommits(token, owner, repo, input.base, input.head, opts)
  const found = new Map<number, ReleasePr>()
  for (const commit of comparison.commits) {
    if (found.size >= RELEASE_MAX_PRS) break
    const pulls = await listPullRequestsForCommit(token, owner, repo, commit.sha, opts)
    for (const pull of pulls) {
      if (found.has(pull.number) || !pull.merged_at) continue
      // Merged PRs only (above): a PR still open whose head happens to be in the range is not in
      // the release.
      found.set(pull.number, {
        number: pull.number,
        title: pull.title ?? `#${pull.number}`,
        author: pull.user?.login ?? null,
        mergedAt: new Date(pull.merged_at).toISOString(),
        mergeSha: pull.merge_commit_sha ?? null,
        url: pull.html_url ?? null,
        sessionId: null,
      })
      if (found.size >= RELEASE_MAX_PRS) break
    }
  }
  return [...found.values()].sort((a, b) => (a.mergedAt ?? '').localeCompare(b.mergedAt ?? ''))
}
