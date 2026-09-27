/**
 * Who is calling `/ci/*` (Launch P2): a VERIFIED GitHub OIDC token (`verifyGitHubOidc`) mapped to
 * the app and environment it may act on, or a 403. The kit's DEPLOYER.md "Authentication" table,
 * enforced:
 *
 * - `repository_id` → the app (`apps.github_repo_id` — stable across renames), and `repository`
 *   must be that app's `owner/name` as Launch recorded it;
 * - `environment` → the app's `app_environments` row of that name (a job with no environment gets
 *   `defaultEnvironment` when the caller names one — the scaffold job — else a 403);
 * - `job_workflow_ref` must start with `<owner>/<repo>/.github/workflows/<workflowFile>@`, so no
 *   other workflow in the repo can ask;
 * - `ref` must be `refs/heads/<default branch>` or `refs/tags/*`.
 *
 * **This is a pre-tenant lookup by design** (allow-listed in `tests/config/unscoped-allowlist.test.ts`):
 * a CI job has no session, so the app is found by its GitHub repository id and the TENANT IS THEN
 * TAKEN FROM THE ROW. Every query after this one carries that tenant.
 */
import { APP_ENVIRONMENT_NAMES, type AppEnvironmentName } from '@launch/shared/launch-apps'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppEnvironmentRow, type AppRow, appEnvironments, apps } from '../../../../db/schema'
import { ForbiddenError } from '../../../utils/core/errors'
import type { GitHubOidcClaims } from './github-oidc'

export interface ResolveCallerOptions {
  /** The workflow file the job must be defined in, e.g. `deploy.yml` or `launch-scaffold.yml`. */
  workflowFile: string
  /** Used when the token carries no `environment` claim. Omit to require one. */
  defaultEnvironment?: AppEnvironmentName
}

export interface ResolvedCaller {
  tenantId: string
  app: AppRow
  environment: AppEnvironmentRow
  claims: GitHubOidcClaims
}

function refuse(message: string): never {
  throw new ForbiddenError(message, 'ci_caller_refused')
}

/** The app registered for a GitHub repository id — any tenant, because none is known yet. */
async function findAppByRepositoryId(db: Database, repositoryId: string): Promise<AppRow | null> {
  const [row] = await db.select().from(apps).where(eq(apps.githubRepoId, repositoryId)).limit(1)
  return row ?? null
}

/** One environment of an app already resolved from its repository. */
async function findEnvironment(
  db: Database,
  appId: string,
  name: AppEnvironmentName
): Promise<AppEnvironmentRow | null> {
  const [row] = await db
    .select()
    .from(appEnvironments)
    .where(and(eq(appEnvironments.appId, appId), eq(appEnvironments.name, name)))
    .limit(1)
  return row ?? null
}

/**
 * Map verified claims to `{ tenantId, app, environment }`, or throw 403 `ci_caller_refused` with
 * a sentence the job's log can show. Never a 404: whether a repo is registered is not the
 * caller's business either way.
 */
export async function resolveCaller(
  db: Database,
  claims: GitHubOidcClaims,
  opts: ResolveCallerOptions
): Promise<ResolvedCaller> {
  const app = await findAppByRepositoryId(db, claims.repository_id)
  if (!app || app.status === 'archived') refuse('This repository is not an app Launch deploys')
  const registered = app.repoOwner && app.repoName ? `${app.repoOwner}/${app.repoName}` : null
  if (!registered || registered.toLowerCase() !== claims.repository.toLowerCase()) {
    refuse(`The token's repository ${claims.repository} is not the app's registered repository`)
  }

  const envName = claims.environment ?? opts.defaultEnvironment
  if (!envName || !(APP_ENVIRONMENT_NAMES as readonly string[]).includes(envName)) {
    refuse('The job must target a GitHub environment: staging or production')
  }
  const environment = await findEnvironment(db, app.id, envName as AppEnvironmentName)
  if (!environment) refuse(`The app has no ${envName} environment`)

  const workflowPrefix = `${claims.repository}/.github/workflows/${opts.workflowFile}@`
  if (!claims.job_workflow_ref.startsWith(workflowPrefix)) {
    refuse(`Only ${opts.workflowFile} may call this (the job ran ${claims.job_workflow_ref})`)
  }

  const branchRef = `refs/heads/${app.defaultBranch ?? 'main'}`
  if (claims.ref !== branchRef && !claims.ref.startsWith('refs/tags/')) {
    refuse(`Only ${branchRef} or a tag may call this (the job ran on ${claims.ref})`)
  }

  return { tenantId: app.tenantId, app, environment, claims }
}
