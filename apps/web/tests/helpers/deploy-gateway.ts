/**
 * Fixtures for the deploy gateway suites (Launch P2, `/ci/deploy`): an app as the launch pipeline
 * leaves it, written straight into the registry (slice 2c builds the real pipeline) and into a
 * FakeCloud — a GitHub repo carrying `deploy.yml`, per environment a KV namespace, queue, R2 bucket,
 * a placeholder Worker that applied DO migration `v1`, its Workflow, and a Neon project whose
 * `staging` branch was cut from `main` with the `migrator` role owning database `app`.
 *
 * Plus the platform credentials the gateway acts with (`fillDeployCredentials`, into a
 * `credential-store.ts` store), the job's GitHub
 * OIDC claims (`deployClaims`), and the staging toml a kit app would send (`appToml`).
 */
import { generateKeyPairSync } from 'node:crypto'
import type { AppEnvironmentName, AppEnvironmentResources } from '@launch/shared/launch-apps'
import type { GitHubOidcClaims } from '@/api/services/launch/ci/github-oidc'
import { CloudflareClient } from '@/api/services/launch/cloudflare'
import { createOrgRepo } from '@/api/services/launch/github-app'
import { NeonClient } from '@/api/services/launch/neon'
import type { Database } from '@/db/client'
import { type AppEnvironmentRow, type AppRow, appEnvironments, apps } from '@/db/schema'
import { type CredentialStore, storeCredential } from './credential-store'
import type { FakeCloud } from './fake-cloud'
import { actionsClaims } from './github-oidc'
import { uniqueSlug } from './launch-apps'

const { privateKey: GITHUB_APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

/**
 * Fill `store` with what the gateway loads: the Cloudflare token, the Neon key, the GitHub App
 * (with its installation id), and the account / org settings — all FakeCloud's.
 */
export function fillDeployCredentials(store: CredentialStore, cloud: FakeCloud): void {
  store.credentials.clear()
  store.settings.clear()
  storeCredential(store, 'cloudflare_api_token', { apiToken: `cf-${'t'.repeat(40)}` })
  storeCredential(store, 'neon_org_api_key', { apiKey: `neon-${'k'.repeat(40)}` })
  storeCredential(
    store,
    'github_app',
    { appId: String(cloud.opts.appId), privateKey: GITHUB_APP_PEM },
    { installationId: cloud.opts.installationId }
  )
  store.settings.set('cloudflare_account_id', cloud.opts.accountId)
  store.settings.set('github_org', cloud.opts.org)
}

/** Resource names per `names.ts`'s table (plan §1 "Naming"). */
export function namesFor(slug: string, env: AppEnvironmentName) {
  const suffix = env === 'staging' ? '-staging' : ''
  return {
    worker: `${slug}${suffix}`,
    kvTitle: `${slug}-rate-limit${suffix}`,
    queue: `${slug}-jobs${suffix}`,
    bucket: `${slug}-files${suffix}`,
    workflow: `${slug}-agent-run${suffix}`,
  }
}

export interface DeployableApp {
  app: AppRow
  staging: AppEnvironmentRow
  production: AppEnvironmentRow
  /** `owner/name`. */
  repository: string
  repositoryId: string
  projectId: string
  mainBranchId: string
  stagingBranchId: string
}

export interface SeedDeployableAppOptions {
  slug?: string
  status?: AppRow['status']
  launchRunId?: string | null
}

/** An app that `placeholders` + `worker_secrets` left ready for its first deploy. */
export async function seedDeployableApp(
  db: Database,
  cloud: FakeCloud,
  tenantId: string,
  opts: SeedDeployableAppOptions = {}
): Promise<DeployableApp> {
  const slug = opts.slug ?? uniqueSlug('shop')
  const { org, accountId } = cloud.opts
  const fetch = cloud.fetch

  // GitHub: the repo, with the kit's deploy workflow on `main`.
  const token = cloud.github.issueToken()
  const repo = await createOrgRepo(token.token, org, { name: slug }, { fetch })
  const repositoryId = String(repo.id)
  cloud.github.pushCommit(org, slug, { '.github/workflows/deploy.yml': 'name: Deploy\n' })

  // Neon: `main` (production) and `staging` cut from it, `migrator` owning `app`.
  const neon = new NeonClient('neon-seed', { fetch, sleep: async () => {} })
  const created = await neon.createProject({ name: slug, regionId: 'aws-us-east-2' })
  const projectId = created.project.id
  const mainBranchId = created.branch.id
  // As the neon step makes them: in SQL, by `neondb_owner` — not the API's `neon_superuser` roles.
  cloud.neon.sqlRole(projectId, mainBranchId, 'migrator', { canCreateRole: true })
  cloud.neon.sqlRole(projectId, mainBranchId, 'app')
  cloud.neon.grant(projectId, mainBranchId, 'migrator', 'app')
  await neon.createDatabase(projectId, mainBranchId, { name: 'app', ownerName: 'migrator' })
  const { branch } = await neon.createBranch(projectId, { name: 'staging', parentId: mainBranchId })

  // Cloudflare: per environment, what `cloudflare` + `placeholders` create.
  const cf = new CloudflareClient('cf-seed', { fetch })
  const resourcesFor = async (env: AppEnvironmentName): Promise<AppEnvironmentResources> => {
    const n = namesFor(slug, env)
    const kv = await cf.createKvNamespace(accountId, n.kvTitle)
    const queue = await cf.createQueue(accountId, n.queue)
    await cf.createR2Bucket(accountId, n.bucket)
    await cf.putWorkerScript(
      accountId,
      n.worker,
      {
        main_module: 'worker.js',
        compatibility_date: '2026-06-01',
        migrations: { new_tag: 'v1', steps: [{ new_classes: ['NotificationsHub'] }] },
      },
      [{ name: 'worker.js', content: 'export default { fetch() { return new Response("") } }' }]
    )
    await cf.putWorkerSecret(accountId, n.worker, 'DATABASE_URL', 'postgresql://app:secret@x/app')
    await cf.putWorkflow(accountId, n.workflow, {
      scriptName: n.worker,
      className: 'AgentRunWorkflow',
    })
    return {
      kv: [{ binding: 'RATE_LIMIT_KV', id: kv.id, title: n.kvTitle }],
      queues: [{ binding: 'JOBS_QUEUE', queue: n.queue, id: queue.queue_id }],
      r2: [{ binding: 'FILES', bucketName: n.bucket }],
      durableObjects: [{ binding: 'NOTIFICATIONS_HUB', className: 'NotificationsHub' }],
      workflows: [
        { binding: 'AGENT_RUN_WORKFLOW', name: n.workflow, className: 'AgentRunWorkflow' },
      ],
      doMigrationTag: 'v1',
    }
  }
  const stagingResources = await resourcesFor('staging')
  const productionResources = await resourcesFor('production')

  const [app] = await db
    .insert(apps)
    .values({
      tenantId,
      slug,
      displayName: `Shop ${slug}`,
      source: 'created',
      templateVersion: '0.15.0',
      repoOwner: org,
      repoName: slug,
      defaultBranch: 'main',
      githubRepoId: repositoryId,
      status: opts.status ?? 'live',
      launchRunId: opts.launchRunId ?? null,
    })
    .returning()
  if (!app) throw new Error('seedDeployableApp: no app row')
  const neonFor = (branchId: string) => ({
    projectId,
    branchId,
    databaseName: 'app',
    roleName: 'app',
    migratorRole: 'migrator',
    appRole: 'app',
  })
  const rows = await db
    .insert(appEnvironments)
    .values([
      {
        tenantId,
        appId: app.id,
        name: 'staging' as const,
        url: `https://${slug}-staging.${cloud.opts.domain}`,
        workerName: namesFor(slug, 'staging').worker,
        resources: stagingResources,
        neon: neonFor(branch.id),
      },
      {
        tenantId,
        appId: app.id,
        name: 'production' as const,
        url: `https://${slug}.${cloud.opts.domain}`,
        workerName: namesFor(slug, 'production').worker,
        resources: productionResources,
        neon: neonFor(mainBranchId),
      },
    ])
    .returning()
  const staging = rows.find(r => r.name === 'staging')
  const production = rows.find(r => r.name === 'production')
  if (!staging || !production) throw new Error('seedDeployableApp: no environment rows')
  return {
    app,
    staging,
    production,
    repository: `${org}/${slug}`,
    repositoryId,
    projectId,
    mainBranchId,
    stagingBranchId: branch.id,
  }
}

/** The claims of a `deploy.yml` job in the app's repo, targeting `environment`. */
export function deployClaims(
  seeded: Pick<DeployableApp, 'repository' | 'repositoryId'>,
  environment: AppEnvironmentName,
  over: { runId?: string; runAttempt?: string; ref?: string; workflowFile?: string } = {}
): Partial<GitHubOidcClaims> {
  return actionsClaims({
    repository: seeded.repository,
    repositoryId: seeded.repositoryId,
    environment,
    workflowFile: over.workflowFile ?? 'deploy.yml',
    ref: over.ref,
    runId: over.runId,
    runAttempt: over.runAttempt,
  })
}

/** The wrangler config a kit app sends for `env`: its recorded names, plus `extra` tables. */
export function appToml(
  seeded: Pick<DeployableApp, 'app' | 'staging' | 'production'>,
  env: AppEnvironmentName,
  extra = ''
): string {
  const row = env === 'staging' ? seeded.staging : seeded.production
  const r = row.resources
  const n = namesFor(seeded.app.slug, env)
  return `name = "${n.worker}"
main = "src/worker.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

[vars]
APP_ENV = "${env}"
RELEASE_VERSION = "dev"

[assets]
directory = "./dist/ui"
binding = "ASSETS"
not_found_handling = "single-page-application"

[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "${r.kv?.[0]?.id}"

[triggers]
crons = ["0 4 * * *"]

[[queues.producers]]
binding = "JOBS_QUEUE"
queue = "${n.queue}"

[[queues.consumers]]
queue = "${n.queue}"
max_batch_size = 10

[[durable_objects.bindings]]
name = "NOTIFICATIONS_HUB"
class_name = "NotificationsHub"

[[migrations]]
tag = "v1"
new_classes = ["NotificationsHub"]

[[r2_buckets]]
binding = "FILES"
bucket_name = "${n.bucket}"

[ai]
binding = "AI"

[[workflows]]
name = "${n.workflow}"
binding = "AGENT_RUN_WORKFLOW"
class_name = "AgentRunWorkflow"
${extra}`
}

const b64 = (s: string) => Buffer.from(s).toString('base64')

/** A DEPLOYER.md upload body for `toml`: one module and one asset. */
export function uploadBody(toml: string, version = '1.0.0') {
  return {
    protocol: 1,
    version,
    main: 'worker.js',
    toml,
    modules: { 'worker.js': b64('export default { fetch() { return new Response("ok") } }') },
    assets: { '/index.html': b64('<!doctype html><title>shop</title>') },
  }
}
