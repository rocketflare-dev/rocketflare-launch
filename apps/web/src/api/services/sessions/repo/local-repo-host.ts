/**
 * `LocalRepoHost` — the `RepoHostPort` on the laptop (`SESSION_BACKEND=local`): the sandbox still
 * clones `https://github.com/<o>/<r>.git`, and the GitHub egress handler rewrites it to
 * `SESSION_LOCAL_GIT_URL` (`pnpm sessions:local-git serve`, git smart-HTTP on :9420) — so the
 * checkout and the Workflow are identical in both backends.
 *
 * - `gitAuth` → null: the local git server takes no credential.
 * - `openPullRequest` has nowhere to open one, so it answers a stable synthetic PR —
 *   `local://<o>/<r>/pull/<n>`, `n` derived from the head branch — which `ship()` writes onto the
 *   session row exactly as it writes GitHub's.
 * - `getChecks` reports the ship gate's own result: `ship()` only opens a PR after Launch ran the
 *   gate green on that head, so the one check a local PR has is that gate, passed.
 * - Issue #5: `SESSION_BACKEND=local` always ships in `pr` mode, so nothing lands: there is no PR
 *   to read (`getPullRequest` → null), none to merge (`mergePullRequest` → `refused`), and no
 *   failing check (`failedCheckLog` → null).
 */
import type { PrChecks } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../../config'
import type {
  FailedCheckLog,
  GitAuth,
  MergePullRequestResult,
  MergeShipPullRequestInput,
  OpenPullRequestInput,
  RepoHostPort,
  RepoPullRequest,
  RepoRef,
} from '../ports'

/** The check a local PR reports: the gate `ship()` ran before opening it. */
export const LOCAL_SHIP_GATE_CHECK = 'Launch ship gate'

/** A stable positive PR number for a head branch (FNV-1a, folded under 1 000 000). */
function syntheticNumber(head: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < head.length; i++) {
    hash ^= head.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash % 999_999) + 1
}

export class LocalRepoHost implements RepoHostPort {
  constructor(
    readonly cfg: AppConfig,
    readonly now: () => Date = () => new Date()
  ) {}

  gitUpstream(_repo: RepoRef): string {
    return (this.cfg.SESSION_LOCAL_GIT_URL ?? 'http://localhost:9420').replace(/\/+$/, '')
  }

  async gitAuth(_repo: RepoRef): Promise<GitAuth | null> {
    return null
  }

  async openPullRequest(
    repo: RepoRef,
    input: OpenPullRequestInput
  ): Promise<{ number: number; url: string }> {
    const number = syntheticNumber(input.head)
    return { number, url: `local://${repo.owner}/${repo.repo}/pull/${number}` }
  }

  async getChecks(_repo: RepoRef, input: { prNumber: number; headSha: string }): Promise<PrChecks> {
    return {
      state: 'success',
      headSha: input.headSha,
      checkedAt: this.now(),
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      checks: [{ name: LOCAL_SHIP_GATE_CHECK, source: 'check_run', state: 'success', url: null }],
    }
  }

  async getPullRequest(_repo: RepoRef, _prNumber: number): Promise<RepoPullRequest | null> {
    return null
  }

  async mergePullRequest(
    _repo: RepoRef,
    _input: MergeShipPullRequestInput
  ): Promise<MergePullRequestResult> {
    return {
      merged: false,
      code: 'refused',
      message:
        'A local session has no pull request to merge: SESSION_BACKEND=local ships in pr mode',
    }
  }

  async failedCheckLog(
    _repo: RepoRef,
    _input: { headSha: string }
  ): Promise<FailedCheckLog | null> {
    return null
  }
}
