// @vitest-isolate
// FakeCloud is the only fetch, the platform credential store is mocked, deployer.mjs runs as a child.
/**
 * Creating an app end to end, with no cloud (Launch P2, plan §4). Every real piece is wired
 * together and only the vendors are simulated — ONE FakeCloud answers every vendor call Launch
 * makes and serves the new app's host:
 *
 * - `POST /api/apps` through the real app, as an admin — the route validates, writes the rows and
 *   starts `APP_LAUNCH_WORKFLOW` (a recorder; the test then drives the real `AppLaunchWorkflow`
 *   class with `createFakeWorkflowStep`, the real adapter ports and the mocked credential store).
 * - The scaffold job is played in `onWait`: `/ci/scaffold/token` with a GitHub Actions OIDC token,
 *   a push — with the installation token that route issued — of the kit 0.15 fixture files as the
 *   kit's own rename leaves them for the slug, then `/ci/scaffold/done`.
 * - The staging deploy is the kit's REAL `scripts/deployer.mjs` (start → upload → activate →
 *   finish) as a child process, speaking to Launch through a `node:http` bridge to `app.request`
 *   (which also serves `ACTIONS_ID_TOKEN_REQUEST_URL`), with `DEPLOYER_URL` / `DEPLOYER_AUDIENCE`
 *   read from the repo variables `github_env` set, and `TOML` = the file `write_config` committed.
 * - The health probe reaches the staging host, which FakeCloud serves from the deployed version.
 *
 * Variants: an evil toml (403, no migrator credential), a production release approved on the app
 * page, a failure at `placeholders` then a retry (no duplicates; the job event reaches the retried
 * instance), and teardown (nothing left, the repo archived).
 */
import { execFile } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AppEnvironmentName } from '@launch/shared/launch-apps'
import {
  type AppLaunchParams,
  type AppTeardownParams,
  createAppResponseSchema,
  DEPLOY_FINISHED_EVENT,
  pipelineViewSchema,
  retryPipelineResponseSchema,
  SCAFFOLD_FINISHED_EVENT,
} from '@launch/shared/launch-pipeline'
import { DEFAULT_TEMPLATE_PIN } from '@launch/shared/launch-setup'
import { and, asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { app } from '@/api/index'
import type { GitHubOidcClaims } from '@/api/services/launch/ci/github-oidc'
import { CloudflareClient } from '@/api/services/launch/cloudflare'
import { putCredential, putSetting } from '@/api/services/launch/credentials'
import { commitFiles, revokeInstallationToken } from '@/api/services/launch/github-app'
import { AppLaunchWorkflow } from '@/api/workflows/app-launch'
import { AppTeardownWorkflow } from '@/api/workflows/app-teardown'
import { loadConfig } from '@/config'
import {
  appEnvironments,
  appOperations,
  apps,
  auditEvents,
  deployTickets,
  oidcClients,
} from '@/db/schema'
import { applyReplacements, deriveNames } from '../../../../scripts/lib/rename-lib.mjs'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { actionsClaims, mintActionsToken } from '../helpers/github-oidc'
import { forgetApps, uniqueSlug } from '../helpers/launch-apps'
import { request } from '../helpers/request'
import {
  createExecutionContext,
  createTestEnv,
  stubs,
  type TestEnv,
  waitOnExecutionContext,
} from '../mocks/bindings'
import { createFakeWorkflowStep, type RecordedWait } from '../mocks/cloudflare-workers'

/** The platform credentials, in memory (`credential-store.ts`): no global table is written. */
const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const SCRIPT = path.resolve(__dirname, '../../../../scripts/deployer.mjs')
const KIT = path.resolve(__dirname, '../fixtures/rocketflare-0.15')
const REQUEST_TOKEN = 'actions-request-token'
const TOML_PATHS: Record<AppEnvironmentName, string> = {
  production: 'apps/web/wrangler.toml',
  staging: 'apps/web/wrangler.staging.toml',
}

const db = setupTestDatabase()
const cloud = createFakeCloud()
const { org, domain } = cloud.opts
let restoreFetch: () => void
let server: Server
let base = ''
let env: TestEnv
let admin: { tenantId: string; userId: string; email: string; cookie: Record<string, string> }
/** The claims the bridge's token endpoint signs — the job currently "running". */
let claims: Partial<GitHubOidcClaims> = {}
const tenantIds: string[] = []
let runCounter = 7_000_000

// ---- the bridge: the job's network ---------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function bridge(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', base)
  if (url.pathname === '/actions-token') {
    if (req.headers.authorization !== `bearer ${REQUEST_TOKEN}`) return reply(res, 401, {})
    const audience = url.searchParams.get('audience') ?? ''
    return reply(res, 200, { value: await mintActionsToken(claims, { audience }) })
  }
  const raw = await readBody(req)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value)
  }
  const ctx = createExecutionContext()
  const answer = await app.request(
    `${url.pathname}${url.search}`,
    { method: req.method, headers, body: raw.length > 0 ? new Uint8Array(raw) : undefined },
    env,
    ctx
  )
  await waitOnExecutionContext(ctx)
  res.writeHead(answer.status, Object.fromEntries(answer.headers))
  res.end(Buffer.from(await answer.arrayBuffer()))
}

// ---- seed ----------------------------------------------------------------------------------------

const { privateKey: GITHUB_APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

beforeAll(async () => {
  restoreFetch = cloud.install()
  server = createServer((req, res) => {
    bridge(req, res).catch(error => reply(res, 500, { error: String(error) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // Launch's APP_URL is the bridge: the OIDC issuer the apps get, `DEPLOYER_URL`'s origin and
  // `DEPLOYER_AUDIENCE` all follow from it.
  env = createTestEnv({ APP_URL: base })
  const cfg = loadConfig(env)

  const { user, tenant } = await createTestTenantWithUser(db, 'admin')
  tenantIds.push(tenant.id)
  admin = {
    tenantId: tenant.id,
    userId: user.id,
    email: user.email,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }

  // Setup, as the wizard does it: four credentials and the settings beside them.
  await putCredential(
    db,
    cfg,
    'cloudflare_api_token',
    { apiToken: `cf-${'t'.repeat(40)}` },
    { zoneId: cloud.opts.zoneId },
    user.id
  )
  await putCredential(
    db,
    cfg,
    'neon_org_api_key',
    { apiKey: `neon-${'k'.repeat(40)}` },
    {},
    user.id
  )
  await putCredential(
    db,
    cfg,
    'resend_api_key',
    { apiKey: 're_full_access_0123456789' },
    { domainId: cloud.opts.resendDomainId },
    user.id
  )
  await putCredential(
    db,
    cfg,
    'github_app',
    { appId: String(cloud.opts.appId), privateKey: GITHUB_APP_PEM },
    { installationId: cloud.opts.installationId },
    user.id
  )
  await putSetting(db, 'apps_domain', domain, user.id)
  await putSetting(db, 'cloudflare_account_id', cloud.opts.accountId, user.id)
  await putSetting(db, 'neon_region_id', 'aws-us-east-2', user.id)
  await putSetting(db, 'neon_org_id', 'org-launch-1', user.id)
  await putSetting(db, 'github_org', org, user.id)
})

afterAll(async () => {
  restoreFetch()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await forgetApps(db, tenantIds)
})

// ---- the jobs ------------------------------------------------------------------------------------

interface Launched {
  appId: string
  runId: string
  slug: string
  params: AppLaunchParams
}

async function appRow(appId: string) {
  const [row] = await db.select().from(apps).where(eq(apps.id, appId))
  if (!row) throw new Error(`no app ${appId}`)
  return row
}

async function environments(appId: string) {
  const rows = await db.select().from(appEnvironments).where(eq(appEnvironments.appId, appId))
  const pick = (name: AppEnvironmentName) => {
    const row = rows.find(r => r.name === name)
    if (!row) throw new Error(`no ${name} environment`)
    return row
  }
  return { staging: pick('staging'), production: pick('production') }
}

/** `POST /api/apps` as the admin: 202 and a recorded Workflow instance. */
async function requestLaunch(): Promise<Launched> {
  const slug = uniqueSlug('shop')
  const res = await request(
    '/api/apps',
    { method: 'POST', headers: admin.cookie },
    { env, json: { slug, displayName: 'Shop', options: { deployStaging: true } } }
  )
  expect(res.status, await res.clone().text()).toBe(202)
  const { app: created, runId } = createAppResponseSchema.parse(await res.json())
  expect(created.status).toBe('requested')
  const instance = stubs(env).launchWorkflow?.created.find(c => c.id === runId)
  expect(instance).toBeDefined()
  return { appId: created.id, runId, slug, params: instance?.params as AppLaunchParams }
}

/** The scaffold job: trade the OIDC token, push the renamed kit with the issued token, report. */
async function scaffoldJob(launched: Launched) {
  const row = await appRow(launched.appId)
  const repository = `${org}/${launched.slug}`
  const jobClaims = actionsClaims({
    repository,
    repositoryId: row.githubRepoId ?? '',
    workflowFile: 'launch-scaffold.yml',
    runId: String(runCounter++),
  })
  const bearer = {
    Authorization: `Bearer ${await mintActionsToken(jobClaims, { audience: base })}`,
  }
  const issued = await request(
    '/ci/scaffold/token',
    { method: 'POST', headers: bearer },
    { env, json: {} }
  )
  expect(issued.status, await issued.clone().text()).toBe(200)
  const { token, plan } = (await issued.json()) as {
    token: string
    plan: { slug: string; domain: string; tag: string; commit: string }
  }
  expect(plan).toMatchObject({
    slug: launched.slug,
    domain,
    tag: DEFAULT_TEMPLATE_PIN.tag,
    commit: DEFAULT_TEMPLATE_PIN.commit,
  })

  // What `node scripts/rename.mjs <slug> Shop --domain <domain> --force` leaves of the kit.
  const names = deriveNames(launched.slug, 'Shop', { domain })
  const renamed = (file: string) =>
    applyReplacements(readFileSync(path.join(KIT, file), 'utf8'), names).text
  const manifest = JSON.parse(readFileSync(path.join(KIT, '.rocketflare.json'), 'utf8'))
  manifest.kit.commit = plan.commit
  manifest.app = { slug: launched.slug, display: 'Shop', domain }
  const commit = await commitFiles(
    token,
    org,
    launched.slug,
    'main',
    [
      { path: '.rocketflare.json', content: JSON.stringify(manifest, null, 2) },
      { path: TOML_PATHS.production, content: renamed('wrangler.toml') },
      { path: TOML_PATHS.staging, content: renamed('wrangler.staging.toml') },
      { path: '.github/workflows/deploy.yml', content: 'name: Deploy\non: workflow_dispatch\n' },
      { path: '.github/workflows/launch-scaffold.yml', content: null },
      { path: '.launch/scaffold.mjs', content: null },
    ],
    `Start from Rocketflare ${plan.tag}`
  )
  await revokeInstallationToken(token)

  const done = await request(
    '/ci/scaffold/done',
    { method: 'POST', headers: bearer },
    { env, json: { commit: commit.sha } }
  )
  expect(done.status, await done.clone().text()).toBe(200)
}

interface Job {
  dir: string
  githubEnv: string
  toml: string
  vars: Record<string, string>
}

/** A deploy job's workspace: the toml `write_config` committed (`tamper`ed), and a build. */
async function deployWorkspace(
  launched: Launched,
  environment: AppEnvironmentName,
  tamper?: (committed: string) => string
): Promise<Job> {
  const dir = mkdtempSync(path.join(tmpdir(), 'launch-e2e-'))
  const githubEnv = path.join(dir, 'github-env')
  writeFileSync(githubEnv, '')
  const web = path.join(dir, 'apps/web')
  mkdirSync(path.join(web, 'dist/deploy'), { recursive: true })
  mkdirSync(path.join(web, 'dist/ui'), { recursive: true })
  writeFileSync(
    path.join(web, 'dist/deploy/worker.js'),
    'export default { fetch() { return new Response("shop") } }'
  )
  writeFileSync(path.join(web, 'dist/deploy/worker.js.map'), '{}')
  writeFileSync(path.join(web, 'dist/ui/index.html'), '<!doctype html><title>shop</title>')
  const committed = cloud.github.readFile(org, launched.slug, TOML_PATHS[environment])
  if (!committed) throw new Error(`no ${TOML_PATHS[environment]} in the repo`)
  const toml = path.join(dir, TOML_PATHS[environment])
  writeFileSync(toml, tamper ? tamper(committed) : committed)
  const repo = cloud.github.repo(org, launched.slug)
  const vars = Object.fromEntries(
    [...(repo?.variables ?? new Map()).entries()].map(([k, v]) => [
      k,
      typeof v === 'string' ? v : (v as { value: string }).value,
    ])
  )
  // What `github_env` set: Launch's `/ci` surface, with Launch's origin as the audience.
  expect(vars).toMatchObject({ DEPLOYER_URL: `${base}/ci`, DEPLOYER_AUDIENCE: base })
  const row = await appRow(launched.appId)
  claims = actionsClaims({
    repository: `${org}/${launched.slug}`,
    repositoryId: row.githubRepoId ?? '',
    environment,
    workflowFile: 'deploy.yml',
    runId: String(runCounter++),
  })
  return { dir, githubEnv, toml, vars }
}

function exported(job: Job): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(job.githubEnv, 'utf8').split('\n').filter(Boolean)) {
    const at = line.indexOf('=')
    out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

/** One `deployer.mjs` command, as `deploy.yml` runs it: the repo variables and a bare env. */
function deployer(job: Job, command: string, version = '0.1.0') {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    DEPLOYER_URL: job.vars.DEPLOYER_URL ?? '',
    DEPLOYER_AUDIENCE: job.vars.DEPLOYER_AUDIENCE ?? '',
    ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/actions-token?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    GITHUB_ENV: job.githubEnv,
    TOML: job.toml,
    RELEASE_VERSION: version,
    WAIT_SECONDS: '20',
    DEPLOYER_POLL_SECONDS: '0.05',
    ...exported(job),
  }
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const options = { env: childEnv as unknown as NodeJS.ProcessEnv, cwd: job.dir }
    execFile(process.execPath, [SCRIPT, command], options, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** The whole staging deploy job. Returns each command's result. */
async function stagingDeploy(launched: Launched, tamper?: (committed: string) => string) {
  const job = await deployWorkspace(launched, 'staging', tamper)
  const results: Record<string, { code: number; stdout: string; stderr: string }> = {}
  try {
    for (const command of ['start', 'upload', 'activate']) {
      results[command] = await deployer(job, command)
      if (results[command].code !== 0) break
    }
    // `deploy.yml` runs `finish` `if: always()`.
    results.finish = await deployer(job, 'finish')
    results.ticket = { code: 0, stdout: exported(job).DEPLOYER_TICKET ?? '', stderr: '' }
  } finally {
    rmSync(job.dir, { recursive: true, force: true })
  }
  return results
}

interface Driven {
  outcome: Awaited<ReturnType<AppLaunchWorkflow['run']>>
  names: string[]
  results: unknown[]
  deploys: Awaited<ReturnType<typeof stagingDeploy>>[]
}

/** One instance of the real Workflow, the jobs played when it waits for them. */
async function drive(
  launched: Launched,
  instanceId: string,
  opts: { tamper?: (committed: string) => string } = {}
): Promise<Driven> {
  const wf = new AppLaunchWorkflow(createExecutionContext(), env)
  // Only the clock is faked: Neon's operation polls and the health probe's timeout.
  wf.overrides = { sleep: async () => {}, health: { timeoutMs: 2000 } }
  const deploys: Driven['deploys'] = []
  const fake = createFakeWorkflowStep({
    onWait: async (wait: RecordedWait) => {
      if (wait.type === SCAFFOLD_FINISHED_EVENT) {
        await scaffoldJob(launched)
        return { ticketId: 'from-the-event' }
      }
      if (wait.type === DEPLOY_FINISHED_EVENT) {
        deploys.push(await stagingDeploy(launched, opts.tamper))
        return { ticketId: 'from-the-event' }
      }
      return undefined
    },
  })
  const results: unknown[] = []
  const inner = fake.step.do.bind(fake.step) as (...args: unknown[]) => Promise<unknown>
  fake.step.do = (async (...args: unknown[]) => {
    const value = await inner(...args)
    results.push(value)
    return value
  }) as typeof fake.step.do
  const outcome = await wf.run(
    {
      payload: launched.params,
      timestamp: new Date(),
      instanceId,
      workflowName: 'launch-app-create',
    },
    fake.step as unknown as Parameters<AppLaunchWorkflow['run']>[1]
  )
  return { outcome, names: fake.names, results, deploys }
}

async function pipeline(appId: string, kind: 'create' | 'teardown' = 'create') {
  const res = await request(
    `/api/apps/${appId}/pipeline?kind=${kind}`,
    { headers: admin.cookie },
    {
      env,
    }
  )
  expect(res.status).toBe(200)
  return pipelineViewSchema.parse(await res.json())
}

async function auditTrail(appId: string) {
  const rows = await db
    .select({ action: auditEvents.action, summary: auditEvents.summary })
    .from(auditEvents)
    .where(eq(auditEvents.appId, appId))
    .orderBy(asc(auditEvents.at))
  return rows
}

/** A launch that went live: the first `it`'s result, reused by the variants that need one. */
let live: (Launched & { driven: Driven }) | null = null

async function liveApp(): Promise<Launched & { driven: Driven }> {
  if (live) return live
  const launched = await requestLaunch()
  const driven = await drive(launched, launched.runId)
  expect(driven.outcome, JSON.stringify(await pipeline(launched.appId))).toMatchObject({
    status: 'live',
  })
  live = { ...launched, driven }
  return live
}

// ---- the tests -----------------------------------------------------------------------------------

describe('create an app, end to end against the FakeCloud', () => {
  it('goes live: every step, the recorded ids, secrets by name, the deployed version, the audit chain', async () => {
    const launched = await liveApp()
    const { slug, appId, runId, driven } = launched

    // The app is live and every step says so; `production` waits for the first release.
    expect((await appRow(appId)).status).toBe('live')
    const view = await pipeline(appId)
    expect(view).toMatchObject({ runId, kind: 'create', status: 'succeeded' })
    for (const s of view.steps) {
      expect([s.step, s.status]).toEqual([
        s.step,
        s.step === 'production' ? 'skipped' : 'succeeded',
      ])
    }
    expect(new Set(driven.names).size).toBe(driven.names.length)

    // The staging deploy ran through the real client, every command green.
    expect(driven.deploys).toHaveLength(1)
    const deploy = driven.deploys[0] ?? {}
    for (const command of ['start', 'upload', 'activate', 'finish']) {
      expect(deploy[command]?.code, `${command}: ${deploy[command]?.stderr}`).toBe(0)
    }

    // The ids in app_environments are FakeCloud's, and each route points at its own Worker.
    const envs = await environments(appId)
    const cf = cloud.cloudflare
    for (const env of ['staging', 'production'] as const) {
      const row = envs[env]
      const sfx = env === 'staging' ? '-staging' : ''
      expect(row.workerName).toBe(`${slug}${sfx}`)
      expect(row.url).toBe(`https://${slug}${sfx}.${domain}`)
      const kv = row.resources.kv?.[0]
      expect(kv && cf.kv.get(kv.id)?.title).toBe(`${slug}-rate-limit${sfx}`)
      const queue = row.resources.queues?.[0]
      expect(queue && cf.queues.get(queue.id ?? '')?.queue_name).toBe(`${slug}-jobs${sfx}`)
      expect(cf.r2.has(row.resources.r2?.[0]?.bucketName ?? '')).toBe(true)
      expect(row.resources.doMigrationTag).toBe('v1')
      expect(cf.scripts.get(`${slug}${sfx}`)?.migrationTag).toBe('v1')
      expect(row.routeIds).toHaveLength(1)
      const route = cf.routes.get(row.routeIds?.[0] ?? '')
      expect(route).toMatchObject({ pattern: `${slug}${sfx}.${domain}/*`, script: `${slug}${sfx}` })
      expect(cf.workflows.get(`${slug}-agent-run${sfx}`)?.script_name).toBe(`${slug}${sfx}`)
      expect(cloud.neon.projects.get(row.neon?.projectId ?? '')?.name).toBe(slug)
      expect(row.resendKeyId && cloud.resend.apiKeys.get(row.resendKeyId)?.name).toBe(
        `${slug}${sfx}`
      )
    }

    // Secrets reached each Worker by name; no value is in a step result, a row or the audit log.
    for (const worker of [slug, `${slug}-staging`]) {
      const script = cf.scripts.get(worker)
      expect([...new Set(script?.secretPuts)].sort()).toEqual([
        'BOOTSTRAP_ADMIN_EMAILS',
        'DATABASE_URL',
        'OAUTH_ENCRYPTION_KEY',
        'OIDC_CLIENT_SECRET',
        'RESEND_API_KEY',
      ])
      expect(script?.secrets.get('BOOTSTRAP_ADMIN_EMAILS')).toBe(admin.email)
    }
    const secretValues = [slug, `${slug}-staging`].flatMap(w =>
      [...(cf.scripts.get(w)?.secrets.entries() ?? [])]
        .filter(([name]) => name !== 'BOOTSTRAP_ADMIN_EMAILS')
        .map(([, value]) => String(value))
    )
    const operations = await db.select().from(appOperations).where(eq(appOperations.appId, appId))
    const haystack = JSON.stringify([driven.results, operations, await auditTrail(appId)])
    for (const secret of secretValues) expect(haystack).not.toContain(secret)

    // The active staging deployment is the version the job uploaded, keeping the secrets.
    const [ticket] = await db
      .select()
      .from(deployTickets)
      .where(
        and(
          eq(deployTickets.appId, appId),
          eq(deployTickets.environmentId, envs.staging.id),
          eq(deployTickets.purpose, 'deploy')
        )
      )
    expect(ticket).toMatchObject({ status: 'finished', version: '0.1.0' })
    const active = cf.activeVersion(`${slug}-staging`)
    expect(active?.id).toBe(ticket?.cfVersionId)
    expect(active?.metadata.keep_bindings).toEqual(['secret_text'])
    expect(active?.bindings).toEqual(
      expect.arrayContaining([
        { type: 'plain_text', name: 'RELEASE_VERSION', text: '0.1.0' },
        expect.objectContaining({ type: 'secret_text', name: 'DATABASE_URL' }),
      ])
    )
    // The config the job deployed is the one `write_config` committed: Launch's sign-in, single
    // tenant, the KV Launch created, no workers.dev.
    expect(active?.bindings).toEqual(
      expect.arrayContaining([
        { type: 'plain_text', name: 'OIDC_ISSUER', text: base },
        { type: 'plain_text', name: 'AUTH_OIDC_ONLY', text: 'true' },
        { type: 'plain_text', name: 'TENANCY_MODE', text: 'single' },
        { type: 'plain_text', name: 'APP_URL', text: `https://${slug}-staging.${domain}` },
      ])
    )
    expect(cf.scripts.get(`${slug}-staging`)?.workersDev).toBe(false)
    // The staging host answers healthy with the release.
    expect(envs.staging.healthStatus).toBe('up')
    expect(envs.staging.lastDeployVersion).toBe('0.1.0')

    // The migrator's password on staging: reset when the branch was cut, when the job got it,
    // and when activate revoked it.
    const project = envs.staging.neon?.projectId ?? ''
    const stagingBranch = cloud.neon.projects
      .get(project)
      ?.branches.get(envs.staging.neon?.branchId ?? '')
    expect(stagingBranch?.roles.get('migrator')?.resets).toBe(3)

    // Sign-in through Launch: one client with both environments' callbacks.
    const [client] = await db.select().from(oidcClients).where(eq(oidcClients.appId, appId))
    expect(client?.redirectUris).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`https://${slug}-staging.${domain}/`),
        expect.stringContaining(`https://${slug}.${domain}/`),
      ])
    )

    // The audit chain, in order.
    const actions = (await auditTrail(appId)).map(a => a.action)
    const at = (action: string) => actions.indexOf(action)
    expect(at('app.create.requested')).toBe(0)
    expect(at('deploy.activated')).toBeGreaterThan(at('app.create.requested'))
    expect(at('app.launched')).toBeGreaterThan(at('deploy.activated'))
  })

  it('refuses an evil toml at upload: 403, no migrator credential, and the launch fails', async () => {
    // Another app's KV namespace — the S1/S5 attack.
    const victim = await new CloudflareClient('cf-seed-token-0123456789', {
      fetch: cloud.fetch,
    }).createKvNamespace(cloud.opts.accountId, 'victim-rate-limit')
    const launched = await requestLaunch()
    let resetsBefore = -1
    // Every password reset of the app's `migrator` role, read synchronously off the FakeNeon.
    const migratorResets = () => {
      const project = [...cloud.neon.projects.entries()].find(([, p]) => p.name === launched.slug)
      return project ? cloud.neon.resetCount(project[0], 'migrator') : -1
    }
    const driven = await drive(launched, launched.runId, {
      tamper: committed => {
        resetsBefore = migratorResets()
        return `${committed}\n[[kv_namespaces]]\nbinding = "VICTIM"\nid = "${victim.id}"\n`
      },
    })

    const deploy = driven.deploys[0] ?? {}
    expect(deploy.start?.code).toBe(0)
    expect(deploy.upload?.code).toBe(1)
    expect(deploy.upload?.stderr).toContain('upload refused: 403')
    expect(deploy.finish?.stdout).toContain('finished: failed')
    const [ticket] = await db
      .select()
      .from(deployTickets)
      .where(and(eq(deployTickets.appId, launched.appId), eq(deployTickets.purpose, 'deploy')))
    expect(ticket?.refused).toEqual([`kv_namespaces VICTIM=${victim.id}`])
    // No credential was issued: the migrator's password was not touched by the job.
    expect(resetsBefore).toBeGreaterThan(0)
    expect(migratorResets()).toBe(resetsBefore)
    expect(ticket?.credentialsIssuedAt).toBeNull()
    // The launch stops at the wait with the refusal as its reason.
    expect(driven.outcome.status).toBe('failed')
    expect((await appRow(launched.appId)).status).toBe('failed')
    const wait = (await pipeline(launched.appId)).steps.find(s => s.step === 'deploy_staging.wait')
    expect(wait).toMatchObject({ status: 'failed' })
    expect(wait?.error).toContain('VICTIM')
  })

  it('releases to production once an admin approves it on the app page', async () => {
    const launched = await liveApp()
    const envs = await environments(launched.appId)
    const job = await deployWorkspace(launched, 'production')
    try {
      const starting = deployer(job, 'start', '1.0.0')
      let pending: typeof deployTickets.$inferSelect | undefined
      for (let i = 0; i < 400 && !pending; i++) {
        ;[pending] = await db
          .select()
          .from(deployTickets)
          .where(
            and(
              eq(deployTickets.environmentId, envs.production.id),
              eq(deployTickets.status, 'pending')
            )
          )
        if (!pending) await new Promise(r => setTimeout(r, 25))
      }
      if (!pending) throw new Error('the production job never opened a pending ticket')
      const decide = await request(
        `/api/apps/${launched.appId}/deploys/${pending.id}/decide`,
        { method: 'POST', headers: admin.cookie },
        { env, json: { decision: 'approve' } }
      )
      expect(decide.status, await decide.clone().text()).toBe(200)
      const start = await starting
      expect(start.code, start.stderr).toBe(0)
      expect(start.stdout).toContain('waiting for approval (status pending)')
      for (const command of ['upload', 'activate', 'finish']) {
        const step = await deployer(job, command, '1.0.0')
        expect(step.code, `${command}: ${step.stderr}`).toBe(0)
      }
      const [row] = await db.select().from(deployTickets).where(eq(deployTickets.id, pending.id))
      expect(row).toMatchObject({ status: 'finished', version: '1.0.0', decisionSource: 'user' })
      expect(cloud.cloudflare.activeVersion(launched.slug)?.id).toBe(row?.cfVersionId)
      const actions = (await auditTrail(launched.appId)).map(a => a.action)
      expect(actions).toEqual(expect.arrayContaining(['deploy.production.approved']))
    } finally {
      rmSync(job.dir, { recursive: true, force: true })
    }
  })

  it('fails at placeholders, then a retry finishes with no duplicate resource', async () => {
    const launched = await requestLaunch()
    const { slug, appId, runId } = launched
    // The staging route: AFTER the staging script was uploaded with its DO migration.
    cloud.failNext(({ method, url }) => method === 'POST' && url.includes('/workers/routes'), 500)
    const first = await drive(launched, runId)
    expect(first.outcome.status).toBe('failed')
    expect((await appRow(appId)).status).toBe('failed')
    const failed = (await pipeline(appId)).steps.find(s => s.step === 'placeholders')
    expect(failed).toMatchObject({ status: 'failed' })

    const retry = await request(
      `/api/apps/${appId}/pipeline/retry`,
      { method: 'POST', headers: admin.cookie },
      { env, json: { kind: 'create' } }
    )
    expect(retry.status, await retry.clone().text()).toBe(202)
    const { instanceId } = retryPipelineResponseSchema.parse(await retry.json())
    expect(instanceId).toBe(`${runId}-r1`)
    expect((await appRow(appId)).launchInstanceId).toBe(instanceId)

    const second = await drive(launched, instanceId)
    expect(second.outcome.status).toBe('live')
    expect((await pipeline(appId)).status).toBe('succeeded')
    // The retry resumed: the scaffold job ran once, and the deploy after the retry woke the
    // retried instance, not the failed one.
    expect(second.names).not.toContain('scaffold.wait#0')
    const events = stubs(env).launchWorkflow?.events.filter(e => e.type === DEPLOY_FINISHED_EVENT)
    expect(events?.at(-1)?.instanceId).toBe(instanceId)

    // Exactly one of everything.
    const count = <T>(items: Iterable<T>, pred: (item: T) => boolean) =>
      [...items].filter(pred).length
    const cf = cloud.cloudflare
    for (const sfx of ['', '-staging']) {
      expect(count(cf.kv.values(), k => k.title === `${slug}-rate-limit${sfx}`)).toBe(1)
      expect(count(cf.queues.values(), q => q.queue_name === `${slug}-jobs${sfx}`)).toBe(1)
      expect(count(cf.routes.values(), r => r.pattern === `${slug}${sfx}.${domain}/*`)).toBe(1)
      expect(
        cf.queues.get(
          [...cf.queues.values()].find(q => q.queue_name === `${slug}-jobs${sfx}`)?.queue_id ?? ''
        )?.consumers
      ).toHaveLength(1)
    }
    expect(count(cloud.neon.projects.values(), p => p.name === slug)).toBe(1)
    expect(count(cloud.resend.apiKeys.values(), k => k.name.startsWith(slug))).toBe(2)
    expect(
      count(cloud.github.runs, r => r.repo === slug && r.workflow === 'launch-scaffold.yml')
    ).toBe(1)
    // The staging script was uploaded twice; the second did not send the applied migration again.
    const puts = cloud.calls.filter(
      c => c.method === 'PUT' && c.path.endsWith(`/workers/scripts/${slug}-staging`)
    )
    expect(puts).toHaveLength(2)
    expect(cf.scripts.get(`${slug}-staging`)?.migrationTag).toBe('v1')
  })

  it('tears down: nothing left in any vendor, the repo archived, the app archived', async () => {
    const launched = await liveApp()
    const { slug, appId } = launched
    expect(cloud.resourcesFor(slug).length).toBeGreaterThan(0)
    const res = await request(
      `/api/apps/${appId}/teardown`,
      { method: 'POST', headers: admin.cookie },
      { env, json: { confirmSlug: slug } }
    )
    expect(res.status, await res.clone().text()).toBe(202)
    const instance = stubs(env).teardownWorkflow?.created.at(-1)
    expect(instance).toBeDefined()
    const wf = new AppTeardownWorkflow(createExecutionContext(), env)
    wf.overrides = { sleep: async () => {} }
    const params = instance?.params as AppTeardownParams
    await wf.run(
      { payload: params, timestamp: new Date(), instanceId: instance?.id ?? '', workflowName: 'x' },
      createFakeWorkflowStep().step as unknown as Parameters<AppTeardownWorkflow['run']>[1]
    )
    expect(cloud.resourcesFor(slug)).toEqual([])
    expect(cloud.github.repo(org, slug)?.archived).toBe(true)
    const row = await appRow(appId)
    expect(row.status).toBe('archived')
    expect(row.archivedAt).not.toBeNull()
    expect((await pipeline(appId, 'teardown')).status).toBe('succeeded')
    expect((await auditTrail(appId)).map(a => a.action)).toContain('app.archived')
    live = null
  })
})
