/**
 * Import an existing Rocketflare app into the registry (spec/06 "Importing existing apps"). The
 * phase-1 way an app enters Launch: nothing is provisioned, the repo is only READ.
 *
 * 1. **Find the GitHub App installation** that can read the repo. The installation id the setup
 *    check stored in the `github_app` credential's metadata is used when the repo belongs to the
 *    configured org (the `github_org` setting); otherwise — or when no id is stored yet — it is
 *    resolved from `GET /app/installations` by the repo owner's login.
 * 2. **Mint a token narrowed to this one repo and `contents: read`** — an import never needs the
 *    installation's write set.
 * 3. **Read the manifest** (`.rocketflare.json`, else `launch.plugins.json`) and **both tomls**,
 *    parsed by `rocketflare-manifest.ts`.
 * 4. **Check the slug** against spec/04's rules, then write `apps` (imported, live), one
 *    `app_environments` row per toml and the run's `app_operations` steps, plus the
 *    `app.imported` audit row — **in one transaction**, so a failed import leaves nothing behind.
 *    The slug's global uniqueness is the `apps_slug_key` constraint, mapped to 409 `slug_taken`.
 *
 * There is no Cloudflare verification in P1: the ids are recorded as the tomls declare them.
 * Every GitHub call goes through `opts.fetch`, so tests never reach GitHub.
 */
import type { ImportAppRequest } from '@launch/shared/launch-apps'
import { appSlugProblem } from '@launch/shared/launch-apps'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AppRow, appEnvironments, appOperations, apps } from '../../../db/schema'
import { ApiError, ConflictError, isUniqueViolation } from '../../utils/core/errors'
import { newId } from '../../utils/core/ids'
import { assertGroupInTenant } from './apps'
import { type AuditActor, recordAudit } from './audit'
import { getCredential, getSetting } from './credentials'
import {
  GITHUB_API_BASE,
  GITHUB_USER_AGENT,
  GitHubApiError,
  type GitHubAppAuth,
  type GitHubOptions,
  getRepoFile,
  installationToken,
  listInstallations,
} from './github-app'
import { ROCKETFLARE_CONTRACT_VERSION } from './rocketflare/adapter'
import {
  type AppIdentity,
  MANIFEST_PATHS,
  ManifestError,
  parseManifest,
  parseWranglerToml,
  WRANGLER_PATHS,
  type WranglerEnvironment,
} from './rocketflare-manifest'

/** The adapter contract version an import records — defined by the adapter, re-exported here. */
export { ROCKETFLARE_CONTRACT_VERSION }

/** The GitHub App credentials an import acts with; tests hand them in directly. */
export interface ImportGitHub {
  auth: GitHubAppAuth
  /** The installation id stored at setup, if any. */
  installationId: number | string | null
  /** The `github_org` setting, if any. */
  org: string | null
}

export interface ImportOptions extends Pick<GitHubOptions, 'fetch' | 'apiBase'> {
  /** Skip the credential store (tests). */
  github?: ImportGitHub
  clock?: () => Date
}

/** 422 with a stable code — the repo was reachable, but it is not an importable app. */
function unprocessable(message: string, code: string, details?: unknown): ApiError {
  return new ApiError(422, message, code, details)
}

/** The stored `github_app` credential and the org it was checked against. */
export async function loadImportGitHub(db: Database, cfg: AppConfig): Promise<ImportGitHub> {
  const stored = await getCredential(db, cfg, 'github_app')
  if (!stored) {
    throw new ConflictError(
      'Connect the GitHub App in Setup before importing an app',
      'github_app_not_configured'
    )
  }
  const meta = stored.metadata
  const raw = meta.installationId ?? meta.installation_id ?? null
  const installationId = typeof raw === 'number' || typeof raw === 'string' ? raw : null
  const org = await getSetting<string>(db, 'github_org')
  return { auth: stored.secret, installationId, org: typeof org === 'string' ? org : null }
}

/** The installation that can read `owner`'s repos. */
async function resolveInstallation(
  github: ImportGitHub,
  owner: string,
  opts: ImportOptions
): Promise<number | string> {
  const sameOrg = !github.org || github.org.toLowerCase() === owner.toLowerCase()
  if (github.installationId !== null && sameOrg) return github.installationId
  const installations = await listInstallations(github.auth, opts)
  const match = installations.find(i => i.account?.login.toLowerCase() === owner.toLowerCase())
  if (!match) {
    throw unprocessable(`The GitHub App is not installed on ${owner}`, 'github_app_not_installed', {
      owner,
    })
  }
  return match.id
}

/** `GET /repos/{owner}/{repo}` — its default branch, and proof the token can see it. */
async function repoDefaultBranch(
  token: string,
  owner: string,
  repo: string,
  opts: ImportOptions
): Promise<string> {
  const doFetch = opts.fetch ?? fetch
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const res = await doFetch(`${opts.apiBase ?? GITHUB_API_BASE}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': GITHUB_USER_AGENT,
    },
  })
  if (res.status === 404) {
    throw unprocessable(
      `${owner}/${repo} was not found, or the GitHub App cannot see it`,
      'repo_not_found'
    )
  }
  if (!res.ok) throw new GitHubApiError(res.status, `GitHub ${res.status}`, path)
  const body = (await res.json()) as { default_branch?: unknown }
  return typeof body.default_branch === 'string' ? body.default_branch : 'main'
}

interface RepoSnapshot {
  identity: AppIdentity
  manifestPath: string
  environments: Record<'production' | 'staging', WranglerEnvironment>
  ref: string
}

/** Everything the import reads, through a token that can read nothing else. */
async function readRepo(
  github: ImportGitHub,
  owner: string,
  repo: string,
  requestedRef: string | undefined,
  opts: ImportOptions
): Promise<RepoSnapshot> {
  const installationId = await resolveInstallation(github, owner, opts)
  let token: string
  try {
    token = (
      await installationToken(
        github.auth,
        installationId,
        { repositories: [repo], permissions: { contents: 'read' } },
        opts
      )
    ).token
  } catch (err) {
    // GitHub answers 422 when the repo is not among the installation's repositories.
    if (err instanceof GitHubApiError && (err.status === 422 || err.status === 404)) {
      throw unprocessable(
        `The GitHub App cannot read ${owner}/${repo}: ${err.message}`,
        'repo_not_accessible'
      )
    }
    throw err
  }
  const ref = requestedRef ?? (await repoDefaultBranch(token, owner, repo, opts))

  let manifestText: string | null = null
  let manifestPath: string = MANIFEST_PATHS[0]
  for (const path of MANIFEST_PATHS) {
    manifestText = await getRepoFile(token, owner, repo, path, ref, opts)
    if (manifestText !== null) {
      manifestPath = path
      break
    }
  }
  if (manifestText === null) {
    throw unprocessable(
      `${owner}/${repo}@${ref} has no ${MANIFEST_PATHS.join(' or ')} — is it a Rocketflare app?`,
      'manifest_missing',
      { files: [...MANIFEST_PATHS] }
    )
  }
  const [production, staging] = await Promise.all([
    getRepoFile(token, owner, repo, WRANGLER_PATHS.production, ref, opts),
    getRepoFile(token, owner, repo, WRANGLER_PATHS.staging, ref, opts),
  ])
  const missing = [
    production === null ? WRANGLER_PATHS.production : null,
    staging === null ? WRANGLER_PATHS.staging : null,
  ].filter(f => f !== null)
  if (missing.length > 0 || production === null || staging === null) {
    throw unprocessable(
      `${owner}/${repo}@${ref} is missing ${missing.join(' and ')}`,
      'wrangler_config_missing',
      {
        files: missing,
      }
    )
  }
  try {
    return {
      identity: parseManifest(manifestText, manifestPath),
      manifestPath,
      environments: {
        production: parseWranglerToml(production, WRANGLER_PATHS.production),
        staging: parseWranglerToml(staging, WRANGLER_PATHS.staging),
      },
      ref,
    }
  } catch (err) {
    if (err instanceof ManifestError) {
      throw unprocessable(err.message, 'manifest_invalid', { file: err.file })
    }
    throw err
  }
}

export interface ImportResult {
  app: AppRow
  runId: string
}

/** Import `input.repo` into `tenantId`. See the header for the steps and their failure codes. */
export async function importApp(
  db: Database,
  cfg: AppConfig,
  tenantId: string,
  input: ImportAppRequest,
  actor: AuditActor,
  opts: ImportOptions = {}
): Promise<ImportResult> {
  const [owner = '', repo = ''] = input.repo.split('/')
  if (input.ownerGroupId) await assertGroupInTenant(db, tenantId, input.ownerGroupId)
  const github = opts.github ?? (await loadImportGitHub(db, cfg))
  const now = opts.clock ?? (() => new Date())
  const startedAt = now()
  const snapshot = await readRepo(github, owner, repo, input.ref, opts)
  const { identity, environments } = snapshot

  const slug = identity.slug ?? repo.toLowerCase()
  const problem = appSlugProblem(slug)
  if (problem) {
    throw unprocessable(`Cannot import as "${slug}": ${problem}`, 'invalid_slug', { slug })
  }

  const runId = newId()
  const finishedAt = now()
  const envNames = ['staging', 'production'] as const
  try {
    const app = await db.transaction(async tx => {
      const [app] = await tx
        .insert(apps)
        .values({
          tenantId,
          slug,
          displayName: identity.displayName ?? slug,
          ownerGroupId: input.ownerGroupId ?? null,
          source: 'imported',
          template: 'rocketflare',
          templateContractVersion: ROCKETFLARE_CONTRACT_VERSION,
          templateVersion: identity.kitVersion,
          repoOwner: owner,
          repoName: repo,
          defaultBranch: snapshot.ref,
          status: 'live',
          createdByUserId: actor.actorUserId,
        })
        .returning()
      if (!app) throw new Error('apps insert returned no row')

      const envRows = await tx
        .insert(appEnvironments)
        .values(
          envNames.map(name => ({
            tenantId,
            appId: app.id,
            name,
            url: environments[name].url,
            workerName: environments[name].workerName,
            resources: environments[name].resources,
          }))
        )
        .returning({ id: appEnvironments.id, name: appEnvironments.name })

      // One run, three recorded steps — what the detail page's operations log shows. The ids are
      // what later phases act on (spec/06: never looked up by name).
      await tx.insert(appOperations).values([
        {
          tenantId,
          appId: app.id,
          runId,
          kind: 'import',
          step: 'read_repo',
          status: 'succeeded' as const,
          attempt: 1,
          externalIds: {
            repo: `${owner}/${repo}`,
            ref: snapshot.ref,
            manifest: snapshot.manifestPath,
            ...(identity.kitCommit ? { kitCommit: identity.kitCommit } : {}),
          },
          startedAt,
          finishedAt,
        },
        ...envNames.map(name => ({
          tenantId,
          appId: app.id,
          runId,
          kind: 'import',
          step: `register_${name}`,
          status: 'succeeded' as const,
          attempt: 1,
          externalIds: {
            environmentId: envRows.find(r => r.name === name)?.id ?? '',
            ...(environments[name].workerName ? { worker: environments[name].workerName } : {}),
            ...(environments[name].url ? { url: environments[name].url } : {}),
            ...(environments[name].placeholders.length
              ? { placeholders: environments[name].placeholders.join(',') }
              : {}),
          },
          startedAt: finishedAt,
          finishedAt,
        })),
      ])

      await recordAudit(tx, {
        tenantId,
        ...actor,
        action: 'app.imported',
        targetType: 'App',
        targetId: app.id,
        appId: app.id,
        summary: {
          after: {
            slug,
            repo: `${owner}/${repo}`,
            ref: snapshot.ref,
            kitVersion: identity.kitVersion,
            environments: envNames.filter(n => environments[n].url).length,
          },
        },
      })
      return app
    })
    return { app, runId }
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`The slug "${slug}" is already taken`, 'slug_taken', { slug })
    }
    throw err
  }
}
