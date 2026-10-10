/**
 * Import an existing app of a registered kit into the registry (spec/06 "Importing existing
 * apps"). The phase-1 way an app enters Launch: nothing is provisioned, the repo is only READ.
 *
 * 1. **Find the GitHub App installation** that can read the repo. The installation id the setup
 *    check stored in the `github_app` credential's metadata is used when the repo belongs to the
 *    configured org (the `github_org` setting); otherwise — or when no id is stored yet — it is
 *    resolved from `GET /app/installations` by the repo owner's login.
 * 2. **Mint a token narrowed to this one repo and `contents: read`** — an import never needs the
 *    installation's write set.
 * 3. **Detect the kit** (D36 K5, `kits/detect.ts`): the repo's `launch.kit.json`, else its app
 *    manifest's `kit.id` / `kit.name`, matched to a registered kit (a Rocketflare copy from before
 *    the contract is Rocketflare's); a kit Launch has not registered is 422 `kit_not_registered`.
 *    Then **read the app manifest** (that kit adapter's `paths.manifests`) and **both tomls**
 *    (`paths.tomls`), parsed by `kits/app-manifest.ts`. The app records that kit and its manifest
 *    (`kit_id`, `kit_manifest`). `detectImport` is steps 1–3 and the slug check alone, writing
 *    nothing — the Import dialog's preview and `launch apps import --dry-run`.
 * 4. **Check the slug** against spec/04's rules, then write `apps` (imported, live), one
 *    `app_environments` row per toml and the run's `app_operations` steps, plus the
 *    `app.imported` audit row — **in one transaction**, so a failed import leaves nothing behind.
 *    The slug's global uniqueness is the `apps_slug_key` constraint, mapped to 409 `slug_taken`.
 *
 * 5. **After commit, set `LAUNCH_GATE_APP_ID`** on the repo (issue #21, best-effort: an
 *    installation without `actions_variables: write` leaves it to the cron sweep).
 * 6. **Then scan the declared config** (Launch P5, `grants/detect.scanAppConfig`): the
 *    plugins' keys matched to shared resources, the app's owners told what to request. A scan
 *    failure is recorded on the scan row and never fails the import.
 *
 * There is no Cloudflare verification in P1: the ids are recorded as the tomls declare them.
 * Every GitHub call goes through `opts.fetch`, so tests never reach GitHub.
 */
import type {
  ImportAppRequest,
  ImportDetectRequest,
  ImportDetectResponse,
} from '@launch/shared/launch-apps'
import { appSlugProblem } from '@launch/shared/launch-apps'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type AppRow, appEnvironments, appOperations, apps } from '../../../db/schema'
import { ApiError, ConflictError, isUniqueViolation } from '../../utils/core/errors'
import { newId } from '../../utils/core/ids'
import { type Logger, loggerFor } from '../../utils/core/logger'
import { scanAppConfig } from '../grants/detect'
import type { Realtime } from '../realtime'
import { assertGroupInTenant } from './apps'
import { type AuditActor, recordAudit } from './audit'
import { getCredential, getSetting } from './credentials'
import { ensureAppGateVariable } from './gate-variable'
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
import {
  adapterForKit,
  kitManifestOf,
  ROCKETFLARE_CONTRACT_VERSION,
  type TemplateAdapter,
} from './kits/adapter'
import { type AppIdentity, ManifestError, type WranglerEnvironment } from './kits/app-manifest'
import { type DetectedKit, detectRepoKit } from './kits/detect'
import type { KitFileReader } from './kits/manifest'
import { ensureDefaultKit, listKits } from './kits/store'

/** The Rocketflare fallback's contract version — defined by the adapter, re-exported here. */
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
  /** For the post-import config scan: its log lines, and the bell's nudge for `grant_needed`. */
  logger?: Logger
  realtime?: Realtime
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

/** The repo at one ref, through a token that can read nothing else; each file fetched once. */
interface OpenRepo {
  read: KitFileReader
  ref: string
  /** `owner/repo@ref`, for the refusals. */
  label: string
}

async function openRepo(
  github: ImportGitHub,
  owner: string,
  repo: string,
  requestedRef: string | undefined,
  opts: ImportOptions
): Promise<OpenRepo> {
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
  const files = new Map<string, Promise<string | null>>()
  const read: KitFileReader = path => {
    let file = files.get(path)
    if (!file) {
      file = getRepoFile(token, owner, repo, path, ref, opts)
      files.set(path, file)
    }
    return file
  }
  return { read, ref, label: `${owner}/${repo}@${ref}` }
}

/** The app manifest and both tomls, as the detected kit's adapter names them. */
async function readSnapshot(
  { read, ref, label }: OpenRepo,
  adapter: TemplateAdapter
): Promise<RepoSnapshot> {
  const { manifests, tomls } = adapter.paths
  let manifestText: string | null = null
  let manifestPath: string = adapter.paths.manifest
  for (const path of manifests) {
    manifestText = await read(path)
    if (manifestText !== null) {
      manifestPath = path
      break
    }
  }
  if (manifestText === null) {
    throw unprocessable(
      `${label} has no ${manifests.join(' or ')} — is it a ${adapter.name} app?`,
      'manifest_missing',
      { files: [...manifests] }
    )
  }
  const [production, staging] = await Promise.all([read(tomls.production), read(tomls.staging)])
  const missing = [
    production === null ? tomls.production : null,
    staging === null ? tomls.staging : null,
  ].filter(f => f !== null)
  if (missing.length > 0 || production === null || staging === null) {
    throw unprocessable(`${label} is missing ${missing.join(' and ')}`, 'wrangler_config_missing', {
      files: missing,
    })
  }
  try {
    return {
      identity: adapter.parseManifest(manifestText, manifestPath),
      manifestPath,
      environments: {
        production: adapter.parseToml(production, tomls.production),
        staging: adapter.parseToml(staging, tomls.staging),
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

interface ReadForImport {
  owner: string
  repo: string
  detected: DetectedKit
  adapter: TemplateAdapter
  snapshot: RepoSnapshot
  slug: string
}

/**
 * Open the repo, detect its kit (`kits/detect.ts`) and read it with that kit's adapter: what both
 * the import and its dry run (`detectImport`) start with. Writes nothing.
 */
async function readForImport(
  db: Database,
  github: ImportGitHub,
  input: Pick<ImportAppRequest, 'repo' | 'ref'>,
  opts: ImportOptions
): Promise<ReadForImport> {
  const [owner = '', repo = ''] = input.repo.split('/')
  const opened = await openRepo(github, owner, repo, input.ref, opts)
  await ensureDefaultKit(db)
  const detected = await detectRepoKit(opened.read, await listKits(db), opened.label)
  const adapter = adapterForKit(detected.kit)
  const snapshot = await readSnapshot(opened, adapter)
  const slug = snapshot.identity.slug ?? repo.toLowerCase()
  const problem = appSlugProblem(slug)
  if (problem) {
    throw unprocessable(`Cannot import as "${slug}": ${problem}`, 'invalid_slug', { slug })
  }
  return { owner, repo, detected, adapter, snapshot, slug }
}

/**
 * What importing `input.repo` would record — the slug, the name, the kit it was built from — with
 * every refusal the import itself would give, and nothing written (`POST /api/apps/import/detect`).
 */
export async function detectImport(
  db: Database,
  cfg: AppConfig,
  input: ImportDetectRequest,
  opts: ImportOptions = {}
): Promise<ImportDetectResponse> {
  const github = opts.github ?? (await loadImportGitHub(db, cfg))
  const { owner, repo, detected, snapshot, slug } = await readForImport(db, github, input, opts)
  return {
    repo: `${owner}/${repo}`,
    ref: snapshot.ref,
    manifest: snapshot.manifestPath,
    slug,
    displayName: snapshot.identity.displayName ?? slug,
    kitVersion: snapshot.identity.kitVersion ?? null,
    kit: {
      id: detected.kit.id,
      slug: detected.kit.slug,
      name: detected.kit.name,
      detectedBy: detected.detectedBy,
    },
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
  if (input.ownerGroupId) await assertGroupInTenant(db, tenantId, input.ownerGroupId)
  const github = opts.github ?? (await loadImportGitHub(db, cfg))
  const now = opts.clock ?? (() => new Date())
  const startedAt = now()
  // D36 K5: the app joins the kit it was built from — detected from the repo (`kits/detect.ts`),
  // refused when the catalogue does not have it — and keeps that kit's manifest (K2); the kit's
  // adapter decides which files are read.
  const { owner, repo, detected, adapter, snapshot, slug } = await readForImport(
    db,
    github,
    input,
    opts
  )
  const { kit } = detected
  const kitManifest = kitManifestOf(kit)
  const { identity, environments } = snapshot

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
          template: adapter.id,
          kitId: kit.id,
          kitManifest,
          templateContractVersion: adapter.contractVersion,
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
            kit: kit.slug,
            kitDetectedBy: detected.detectedBy,
            environments: envNames.filter(n => environments[n].url).length,
          },
        },
      })
      return app
    })
    await scanAppConfig(
      {
        db,
        cfg,
        github,
        fetch: opts.fetch,
        now,
        logger: opts.logger ?? loggerFor(cfg, { component: 'grants' }),
        realtime: opts.realtime,
      },
      { tenantId, appId: app.id, ref: snapshot.ref, trigger: 'import' }
    ).catch(() => {})
    // Issue #21: CI trusts Launch's gate only once the repo names Launch's App — set it now when
    // the installation may write Actions variables; else the cron sweep tries again hourly
    // (`sweepGateVariables`). Never fails the import.
    await ensureAppGateVariable(db, cfg, app, {
      github,
      fetch: opts.fetch,
      apiBase: opts.apiBase,
    }).catch(err =>
      (opts.logger ?? loggerFor(cfg, { component: 'import' })).warn(
        { appId: app.id, err: err instanceof Error ? err.message : String(err) },
        'import: could not set LAUNCH_GATE_APP_ID; the sweep retries'
      )
    )
    return { app, runId }
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`The slug "${slug}" is already taken`, 'slug_taken', { slug })
    }
    throw err
  }
}
