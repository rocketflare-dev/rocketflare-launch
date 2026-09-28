/**
 * The one way the release services reach an app's repo (Launch P4, plan §4d): the GitHub App's
 * installation on the repo's owner (`installationFor`), a token narrowed to that ONE repo and the
 * permissions the call needs (`installationToken`), revoked afterwards whatever happened
 * (`revokeInstallationToken`). Release, Promote's publish, the "Deploy to production" dispatch and
 * the merge follower all go through `withRepoToken`, so none of them holds a token past its call.
 */
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import type { AppRow } from '../../../../db/schema'
import { ConflictError } from '../../../utils/core/errors'
import {
  type GitHubOptions,
  type GitHubPermissions,
  installationToken,
  listInstallations,
  revokeInstallationToken,
} from '../github-app'
import { type ImportGitHub, loadImportGitHub } from '../import'

/** The workflow file every deploy runs (DEPLOYER.md; `resolveCaller` checks the same name). */
export const DEPLOY_WORKFLOW_FILE = 'deploy.yml'

/** What a caller may inject: a test's `fetch` / `apiBase`, or the App credentials themselves. */
export interface RepoGitHubOptions extends Pick<GitHubOptions, 'fetch' | 'apiBase'> {
  github?: ImportGitHub
}

/** The installation that can act on `owner`'s repos; 409 when the App is not installed there. */
export async function installationFor(
  github: ImportGitHub,
  owner: string,
  opts: GitHubOptions = {}
): Promise<number | string> {
  const sameOrg = !github.org || github.org.toLowerCase() === owner.toLowerCase()
  if (github.installationId !== null && sameOrg) return github.installationId
  const match = (await listInstallations(github.auth, opts)).find(
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

/** An app's repository coordinates, or 409 `app_repo_missing`. */
export function repoOf(app: Pick<AppRow, 'repoOwner' | 'repoName' | 'defaultBranch'>): {
  owner: string
  repo: string
  branch: string
} {
  if (!app.repoOwner || !app.repoName) {
    throw new ConflictError('This app has no repository', 'app_repo_missing')
  }
  return { owner: app.repoOwner, repo: app.repoName, branch: app.defaultBranch ?? 'main' }
}

/**
 * Run `fn` with a token for `app`'s repo alone, narrowed to `permissions`, and revoke it after —
 * whatever `fn` did.
 */
export async function withRepoToken<T>(
  db: Database,
  cfg: AppConfig,
  app: Pick<AppRow, 'repoOwner' | 'repoName' | 'defaultBranch'>,
  permissions: GitHubPermissions,
  fn: (token: string, repo: { owner: string; repo: string; branch: string }) => Promise<T>,
  opts: RepoGitHubOptions = {}
): Promise<T> {
  const repo = repoOf(app)
  const github = opts.github ?? (await loadImportGitHub(db, cfg))
  const installationId = await installationFor(github, repo.owner, opts)
  const { token } = await installationToken(
    github.auth,
    installationId,
    { repositories: [repo.repo], permissions },
    opts
  )
  try {
    return await fn(token, repo)
  } finally {
    await revokeInstallationToken(token, opts).catch(() => {})
  }
}
