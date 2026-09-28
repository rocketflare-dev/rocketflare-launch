// @vitest-isolate
// Installs a FakeCloud as the global fetch, mocks the credential store, spies on console and stdout, runs deployer.mjs.
/**
 * The P5 exit test (`docs/plans/p5-grants.md` §4, spec/11 P5): an app that installs the M365
 * connector is prompted to request M365; the owner team approves it and the app works; one rotation
 * updates every app that holds the grant. Every step goes through the real surfaces — the `/api`
 * routes as each person, the real approvals engine and `grant.request` kind, `GrantPushWorkflow`
 * driven step by step (`createFakeWorkflowStep`) through the REAL Cloudflare backing (the platform
 * credential from the store, the FakeCloud as the global fetch, its 10053 clash ON), and the kit's
 * REAL `scripts/deployer.mjs` as the GitHub job (a child process over a `node:http` bridge to
 * `app.request`, as the P4 exit test runs it). Nothing P5 is mocked.
 *
 * Setup: alice owns `shop`, `crm` and `erp`; the "IT Identity" team (carol and dan) owns M365,
 * whose production policy needs TWO approvals. `shop`'s repo carries the M365 connector, and both
 * of its Workers already bind the connector's two vars as `plain_text` (the plugin install).
 *
 * 1. The admin creates M365; carol sets staging and production values (nobody holds it: 200, no push).
 * 2. Alice cuts a Release: the scan at the tag finds the three keys, alice gets `grant_needed`,
 *    `/config` shows M365 needed; the staging deploy of the tag (deployer.mjs) leaves the vars
 *    live as `plain_text`; the connector answers 503.
 * 3. Alice requests M365 for staging and production: two approvals; carol and dan are told, the
 *    admin is not, and the admin (not in the team) is refused.
 * 4. Carol approves staging → a `grant` push → the live version still binds the vars as plain
 *    text, so the backing's 10053 remedy replaces them in ONE new version (`shadowedVars` on the
 *    target and in `grant.var_shadowed`); the connector answers 200. Production waits for dan too.
 * 5. A new staging deploy through deployer.mjs: the gateway drops the toml's shadowed vars
 *    (`shadowedVars` on the ticket), `keep_bindings` keeps the secrets, the connector stays 200.
 * 6. `crm` and `erp` get production grants the same way: three holders.
 * 7. Carol rotates the production secret (the other two fields blank → kept): ONE push to all
 *    three; `crm`'s write fails once → `partial`, the old version stays `retiring`; Retry → the
 *    same push id, `succeeded`, only crm written again; the old version `retired`; carol and dan
 *    told to revoke it at the vendor; "Azure" revokes it and every holder still connects.
 * 8. Alice revokes crm's production grant: its secrets are deleted from crm's Worker only.
 * 9. `audit.seal` (scoped to the tenant) and verify.
 *
 * Asserted throughout: no secret sentinel in any response, row (except the sealed blob), audit
 * summary, step result, notification, log line or deployer output; every grant's audit rows carry
 * the approval id.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { approvalDetailSchema } from '@launch/shared/launch-approvals'
import { auditVerifySchema } from '@launch/shared/launch-audit'
import {
  appConfigSchema,
  GRANT_NOTIFICATION_TYPES,
  type GrantPushParams,
  grantActionResponseSchema,
  grantPushSchema,
  putSharedResourceValuesResponseSchema,
  requestGrantResponseSchema,
  sharedResourceDetailSchema,
} from '@launch/shared/launch-grants'
import { releaseSchema } from '@launch/shared/launch-releases'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { app } from '@/api/index'
import { dispatchScheduled } from '@/api/scheduled'
import { auditSealTask } from '@/api/services/launch/audit-chain'
import type { GitHubOidcClaims } from '@/api/services/launch/ci/github-oidc'
import { CloudflareClient } from '@/api/services/launch/cloudflare'
import { GrantPushWorkflow } from '@/api/workflows/grant-push'
import {
  appConfigScans,
  appGrants,
  approvalRequests,
  auditEvents,
  deployTickets,
  grantPushes,
  grantPushTargets,
  notifications,
  sharedResources,
  sharedResourceValues,
} from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  appToml,
  type DeployableApp,
  deployClaims,
  fillDeployCredentials,
  seedDeployableApp,
} from '../helpers/deploy-gateway'
import { createFakeCloud } from '../helpers/fake-cloud'
import { mintActionsToken } from '../helpers/github-oidc'
import {
  FakeAzure,
  M365_ITEMS,
  M365_TOML_PLACEHOLDER,
  M365_VALUES,
  m365Files,
  m365Host,
  withM365Vars,
} from '../helpers/grants'
import { forgetApps, uniqueSlug } from '../helpers/launch-apps'
import { addTestAppOwner, createTestGroup } from '../helpers/oidc'
import { type ReleasableApp, seedReleasableApp } from '../helpers/releases'
import { request } from '../helpers/request'
import {
  createExecutionContext,
  createTestEnv,
  stubs,
  type TestEnv,
  waitOnExecutionContext,
} from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

const SCRIPT = path.resolve(__dirname, '../../../../scripts/deployer.mjs')
const REQUEST_TOKEN = 'actions-request-token'

/** The sentinels: each environment's secret, and the rotated one. None may ever be echoed. */
const STAGING_SECRET = 'sentinel-staging-m365-secret-never-echoed'
const PRODUCTION_SECRET = M365_VALUES.M365_CLIENT_SECRET
const ROTATED_SECRET = 'sentinel-rotated-m365-secret-never-echoed'
const SENTINELS = [STAGING_SECRET, PRODUCTION_SECRET, ROTATED_SECRET]

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

// Every log line the app writes, whichever way it writes it — searched for the sentinels.
const logged: string[] = []
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
const capture =
  (write: (...args: never[]) => unknown) =>
  (...args: unknown[]) => {
    logged.push(args.map(a => (typeof a === 'string' ? a : safeJson(a))).join(' '))
    return (write as (...a: unknown[]) => unknown)(...args)
  }
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  vi.spyOn(console, level).mockImplementation(capture(() => undefined))
}
vi.spyOn(process.stdout, 'write').mockImplementation(capture(() => true) as never)

const db = setupTestDatabase()
const cloud = createFakeCloud()
const azure = new FakeAzure()
let restoreFetch: () => void
let server: Server
let base = ''
let env: TestEnv
let dir = ''
/** The claims the bridge's token endpoint signs — the job currently "running". */
let claims: Partial<GitHubOidcClaims> = {}
const tenantIds: string[] = []
/** Every response body and every step result — searched for the sentinels at the end. */
const bodies: string[] = []
const stepResults: unknown[] = []
const deployerOutput: string[] = []

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
  const out = Buffer.from(await answer.arrayBuffer())
  bodies.push(out.toString('utf8'))
  res.writeHead(answer.status, Object.fromEntries(answer.headers))
  res.end(out)
}

beforeAll(async () => {
  restoreFetch = cloud.install()
  azure.install(cloud)
  server = createServer((req, res) => {
    bridge(req, res).catch(error => reply(res, 500, { error: String(error) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // Loud, so the log search below has lines to search (stdout is swallowed above).
  env = createTestEnv({ APP_URL: base, LOG_LEVEL: 'debug' })
  fillDeployCredentials(store, cloud)
  dir = mkdtempSync(path.join(tmpdir(), 'launch-p5-e2e-'))
  mkdirSync(path.join(dir, 'web/dist/deploy'), { recursive: true })
  mkdirSync(path.join(dir, 'web/dist/ui'), { recursive: true })
  writeFileSync(
    path.join(dir, 'web/dist/deploy/worker.js'),
    'export default { fetch() { return new Response("ok") } }'
  )
  writeFileSync(path.join(dir, 'web/dist/ui/index.html'), '<!doctype html><title>shop</title>')
})
afterAll(async () => {
  restoreFetch()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
  await forgetApps(db, tenantIds)
})

// ---- people and calls --------------------------------------------------------------------------

interface Person {
  id: string
  email: string
  cookie: Record<string, string>
}

async function person(tenantId: string, role: 'owner' | 'admin' | 'member'): Promise<Person> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenantId))
  return { id: user.id, email: user.email, cookie }
}

/** A route call as `who`; the body is kept for the sentinel search. */
async function call(
  who: Person,
  method: string,
  url: string,
  json?: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await request(
    url,
    { method, headers: who.cookie },
    { env, ...(json === undefined ? {} : { json }) }
  )
  const text = await res.text()
  bodies.push(text)
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function ok<T>(
  who: Person,
  method: string,
  url: string,
  json: unknown,
  status: number,
  schema: { parse(v: unknown): T }
): Promise<T> {
  const res = await call(who, method, url, json)
  expect(res.status, JSON.stringify(res.body)).toBe(status)
  return schema.parse(res.body)
}

// ---- the push Workflow --------------------------------------------------------------------------

/** Run the GRANT_PUSH instance created for `pushId` (the latest one: a retry is `<pushId>-rN`). */
async function drivePush(pushId: string) {
  const created = stubs(env).grantPushWorkflow?.created ?? []
  const instance = [...created].reverse().find(c => (c.params as GrantPushParams).pushId === pushId)
  if (!instance) throw new Error(`no GRANT_PUSH instance for ${pushId}`)
  const fake = createFakeWorkflowStep()
  const recording = {
    ...fake.step,
    async do(name: string, config: unknown, fn: () => Promise<unknown>) {
      const result = await fake.step.do(name, config as never, fn as never)
      stepResults.push(result)
      return result
    },
  }
  const workflow = new GrantPushWorkflow(createExecutionContext(), env)
  const outcome = await workflow.run(
    {
      payload: instance.params as GrantPushParams,
      timestamp: new Date(),
      instanceId: instance.id,
      workflowName: 'launch-grant-push',
    },
    recording as unknown as Parameters<GrantPushWorkflow['run']>[1]
  )
  // Step names are distinct (the platform replays a repeated name's recorded result).
  expect(new Set(fake.names).size).toBe(fake.names.length)
  return { outcome, instanceId: instance.id }
}

async function pushOfApproval(approvalId: string) {
  const [row] = await db.select().from(grantPushes).where(eq(grantPushes.approvalId, approvalId))
  if (!row) throw new Error(`no push for approval ${approvalId}`)
  return row
}

// ---- the deploy job ------------------------------------------------------------------------------

/** One `deploy.yml` job: the real deployer script, one command per call, sharing GITHUB_ENV. */
function deployJob(
  seeded: DeployableApp,
  environment: 'staging' | 'production',
  ref: string,
  toml: string
) {
  const githubEnv = path.join(dir, `github-env-${Math.random().toString(36).slice(2)}`)
  writeFileSync(githubEnv, '')
  const tomlFile = path.join(
    dir,
    environment === 'staging' ? 'web/wrangler.staging.toml' : 'web/wrangler.toml'
  )
  writeFileSync(tomlFile, toml)
  const jobClaims = deployClaims(seeded, environment, { ref })
  const exported = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of readFileSync(githubEnv, 'utf8').split('\n').filter(Boolean)) {
      const at = line.indexOf('=')
      out[line.slice(0, at)] = line.slice(at + 1)
    }
    return out
  }
  const run = (command: string) => {
    claims = jobClaims
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      DEPLOYER_URL: `${base}/ci`,
      DEPLOYER_AUDIENCE: base,
      ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/actions-token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
      GITHUB_ENV: githubEnv,
      TOML: tomlFile,
      RELEASE_VERSION: ref.replace('refs/tags/', ''),
      WAIT_SECONDS: '20',
      DEPLOYER_POLL_SECONDS: '0.05',
      ...exported(),
    }
    return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      const options = { env: childEnv as unknown as NodeJS.ProcessEnv, cwd: dir }
      execFile(process.execPath, [SCRIPT, command], options, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        deployerOutput.push(String(stdout), String(stderr))
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      })
    })
  }
  return { run, ticketId: () => exported().DEPLOYER_TICKET }
}

async function deployToEnd(job: ReturnType<typeof deployJob>) {
  for (const command of ['start', 'upload', 'activate', 'finish']) {
    const step = await job.run(command)
    expect(step.code, `${command}: ${step.stderr}`).toBe(0)
  }
}

// ---- the world ---------------------------------------------------------------------------------

const cf = () => new CloudflareClient('cf-seed', { fetch: cloud.fetch })

/** A live version of `script` binding `vars` as plain text — what an earlier deploy left running. */
async function goLive(script: string, vars: Record<string, string>) {
  const { accountId } = cloud.opts
  const version = await cf().createVersion(
    accountId,
    script,
    {
      main_module: 'worker.js',
      compatibility_date: '2026-06-01',
      bindings: Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
      keep_bindings: ['secret_text'],
    },
    [{ name: 'worker.js', content: 'export default { fetch() { return new Response("ok") } }' }]
  )
  await cf().createDeployment(accountId, script, version.id)
}

function hostOf(url: string | null): string {
  return new URL(url as string).host
}

async function connector(url: string | null): Promise<number> {
  return (await cloud.fetch(`https://${hostOf(url)}/api/connectors/m365/status`)).status
}

const envOf = (script: string | null) => cloud.cloudflare.envOf(script as string) ?? {}

async function world() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const admin: Person = {
    id: user.id,
    email: user.email,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
  const alice = await person(tenant.id, 'member')
  const carol = await person(tenant.id, 'member')
  const dan = await person(tenant.id, 'member')
  const identity = await createTestGroup(db, tenant.id, 'IT Identity', [carol.id, dan.id])

  const shop: ReleasableApp = await seedReleasableApp(db, cloud, tenant.id)
  const crm = await seedDeployableApp(db, cloud, tenant.id, { slug: uniqueSlug('crm') })
  const erp = await seedDeployableApp(db, cloud, tenant.id, { slug: uniqueSlug('erp') })
  for (const a of [shop, crm, erp]) {
    await addTestAppOwner(db, tenant.id, a.app.id, alice.id)
    for (const e of [a.staging, a.production]) {
      m365Host(cloud, { host: hostOf(e.url), script: e.workerName as string })
    }
  }
  // shop installs the connector: its repo carries the plugin; its production Worker is live with
  // the connector's vars as plain text (its staging one goes live through the deployer in step 2).
  cloud.github.pushCommit(shop.owner, shop.repo, m365Files(shop.app.slug), 'Add the M365 connector')
  await goLive(shop.production.workerName as string, {
    RELEASE_VERSION: '0.1.0',
    M365_TENANT_ID: M365_TOML_PLACEHOLDER,
    M365_CLIENT_ID: M365_TOML_PLACEHOLDER,
  })
  // crm and erp are live without the connector's vars (their code reads env either way).
  for (const a of [crm, erp]) {
    await goLive(a.production.workerName as string, { RELEASE_VERSION: '1.0.0' })
  }
  azure.valid.add(STAGING_SECRET)
  azure.valid.add(PRODUCTION_SECRET)
  return { tenantId: tenant.id, admin, alice, carol, dan, identity, shop, crm, erp }
}

type World = Awaited<ReturnType<typeof world>>

/** Step 1: the admin creates M365 (production needs two of the team); carol sets both values. */
async function createM365(w: World) {
  const resource = await ok(
    w.admin,
    'POST',
    '/api/shared-resources',
    {
      slug: `m365-${w.shop.app.slug.slice(-8)}`,
      displayName: 'M365 (company tenant)',
      description: 'The company Entra app registration',
      ownerGroupId: w.identity.id,
      items: M365_ITEMS,
      policies: {
        production: {
          approvers: { appOwners: false, admins: false, groupIds: [], userIds: [] },
          minApprovals: 2,
          allowSelfApproval: false,
          expiresAfterMinutes: 7 * 24 * 60,
          autoApproveRole: null,
        },
      },
    },
    201,
    sharedResourceDetailSchema
  )
  for (const [environment, secret] of [
    ['staging', STAGING_SECRET],
    ['production', PRODUCTION_SECRET],
  ] as const) {
    const set = await ok(
      w.carol,
      'PUT',
      `/api/shared-resources/${resource.id}/values/${environment}`,
      { values: { ...M365_VALUES, M365_CLIENT_SECRET: secret } },
      200,
      putSharedResourceValuesResponseSchema
    )
    expect(set).toMatchObject({ version: 1, pushId: null })
  }
  return resource
}

async function decide(approvalId: string, who: Person) {
  return call(who, 'POST', `/api/approvals/${approvalId}/decide`, { decision: 'approve' })
}

/** Alice asks for production, carol and dan approve, the push runs; returns the grant id. */
async function grantProduction(w: World, target: DeployableApp, resourceId: string) {
  const asked = await ok(
    w.alice,
    'POST',
    `/api/apps/${target.app.id}/grants`,
    { resourceId, environments: ['production'], reason: `${target.app.slug} syncs the directory` },
    202,
    requestGrantResponseSchema
  )
  const [grant] = asked.grants
  if (!grant?.approvalId) throw new Error('no approval opened')
  expect((await decide(grant.approvalId, w.carol)).status).toBe(200)
  expect((await decide(grant.approvalId, w.dan)).status).toBe(200)
  const push = await pushOfApproval(grant.approvalId)
  expect((await drivePush(push.id)).outcome.status).toBe('succeeded')
  return grant.id
}

// ---- the exit test -------------------------------------------------------------------------------

describe('P5 exit: request M365, the owner team approves, the app works; one rotation reaches every holder', () => {
  it('detect → request → approve → push → deploy → rotate → revoke, sealed; no secret anywhere', async () => {
    const w = await world()
    const { tenantId, admin, alice, carol, dan, shop, crm, erp } = w

    // 1. The admin creates M365, owned by IT Identity; production needs two of the team. Carol
    // sets both environments' values; nobody holds it yet, so no push (200, pushId null).
    const resource = await createM365(w)

    // 2. Alice cuts a Release; the scan at the tag finds the connector's keys and tells her.
    const cut = await ok(
      alice,
      'POST',
      `/api/apps/${shop.app.id}/releases`,
      { bump: 'patch' },
      201,
      releaseSchema
    )
    expect(cut.tag).toBe('0.1.1')
    const [scan] = await db
      .select()
      .from(appConfigScans)
      .where(eq(appConfigScans.appId, shop.app.id))
    expect(scan).toMatchObject({ ref: '0.1.1', needs: [resource.id], error: null })
    const needed = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.type, GRANT_NOTIFICATION_TYPES.needed)
        )
      )
    expect(needed.map(n => n.userId)).toEqual([alice.id])
    expect(needed[0]?.data).toMatchObject({ appSlug: shop.app.slug, resourceIds: [resource.id] })
    const config = await ok(
      alice,
      'GET',
      `/api/apps/${shop.app.id}/config`,
      undefined,
      200,
      appConfigSchema
    )
    expect(config.needs).toEqual([resource.id])
    expect(config.matched[0]?.keys.sort()).toEqual(M365_ITEMS.map(i => i.key).sort())
    expect(config.matched[0]?.declaredBy).toEqual(['m365-connector'])

    // The staging deploy of the tag: the plugin put the two vars in the toml, so they go live
    // as plain text; the connector has no secret and answers 503.
    const stagingToml = withM365Vars(appToml(shop, 'staging'))
    await deployToEnd(deployJob(shop, 'staging', 'refs/tags/0.1.1', stagingToml))
    const shopStaging = shop.staging.workerName as string
    const shopProduction = shop.production.workerName as string
    expect(envOf(shopStaging)).toMatchObject({
      RELEASE_VERSION: '0.1.1',
      M365_TENANT_ID: M365_TOML_PLACEHOLDER,
    })
    expect(await connector(shop.staging.url)).toBe(503)
    expect(await connector(shop.production.url)).toBe(503)

    // 3. Alice requests M365 for both environments: two approvals.
    const requested = await ok(
      alice,
      'POST',
      `/api/apps/${shop.app.id}/grants`,
      { resourceId: resource.id, environments: ['staging', 'production'], reason: 'Mail sync' },
      202,
      requestGrantResponseSchema
    )
    const byEnv = Object.fromEntries(requested.grants.map(g => [g.environment, g]))
    const stagingApproval = byEnv.staging?.approvalId as string
    const productionApproval = byEnv.production?.approvalId as string
    expect(stagingApproval).toBeTruthy()
    expect(productionApproval).toBeTruthy()
    // The team is told; the admin is not.
    const asked = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.tenantId, tenantId), eq(notifications.type, 'approval_requested'))
      )
    const toldIds = new Set(asked.map(n => n.userId))
    expect(toldIds.has(carol.id) && toldIds.has(dan.id)).toBe(true)
    expect(toldIds.has(admin.id)).toBe(false)
    const detail = approvalDetailSchema.parse(
      (await call(carol, 'GET', `/api/approvals/${stagingApproval}`)).body
    )
    expect(detail).toMatchObject({ kind: 'grant.request', status: 'pending', canDecide: true })
    expect(detail.eligible?.map(p => p.id).sort()).toEqual([carol.id, dan.id].sort())
    // The admin is not in the team: refused. Alice may not approve her own request.
    const byAdmin = await decide(stagingApproval, admin)
    expect(byAdmin.status).toBe(403)
    expect(byAdmin.body).toMatchObject({ statusCode: 403, code: 'not_an_approver' })
    expect((await decide(stagingApproval, alice)).status).toBe(403)

    // 4. Carol approves staging: the push replaces the live plain vars with the secrets.
    expect((await decide(stagingApproval, carol)).status).toBe(200)
    const stagingPush = await pushOfApproval(stagingApproval)
    expect((await drivePush(stagingPush.id)).outcome.status).toBe('succeeded')
    expect(envOf(shopStaging)).toMatchObject({
      RELEASE_VERSION: '0.1.1',
      M365_TENANT_ID: M365_VALUES.M365_TENANT_ID,
      M365_CLIENT_ID: M365_VALUES.M365_CLIENT_ID,
      M365_CLIENT_SECRET: STAGING_SECRET,
    })
    const stagingTypes = Object.fromEntries(
      (cloud.cloudflare.activeVersion(shopStaging)?.bindings ?? []).map(b => [b.name, b.type])
    )
    expect(stagingTypes).toMatchObject({
      M365_TENANT_ID: 'secret_text',
      M365_CLIENT_ID: 'secret_text',
      M365_CLIENT_SECRET: 'secret_text',
    })
    const [stagingTarget] = await db
      .select()
      .from(grantPushTargets)
      .where(eq(grantPushTargets.pushId, stagingPush.id))
    expect(stagingTarget?.shadowedVars.sort()).toEqual(['M365_CLIENT_ID', 'M365_TENANT_ID'])
    expect(await connector(shop.staging.url)).toBe(200)
    // The push as its owners read it: the same names, never a value.
    const readPush = await ok(
      carol,
      'GET',
      `/api/shared-resources/${resource.id}/pushes/${stagingPush.id}`,
      undefined,
      200,
      grantPushSchema
    )
    expect(readPush.targets[0]).toMatchObject({ status: 'succeeded', app: { id: shop.app.id } })
    expect(readPush.targets[0]?.shadowedVars.sort()).toEqual(['M365_CLIENT_ID', 'M365_TENANT_ID'])
    // Alice (a member, not an owner of the resource) gets the same 404 as a missing push.
    expect(
      (await call(alice, 'GET', `/api/shared-resources/${resource.id}/pushes/${stagingPush.id}`))
        .status
    ).toBe(404)

    // Production needs two: carol's approval alone starts nothing.
    expect((await decide(productionApproval, carol)).status).toBe(200)
    const [stillPending] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, productionApproval))
    expect(stillPending?.status).toBe('pending')
    expect(
      await db.select().from(grantPushes).where(eq(grantPushes.approvalId, productionApproval))
    ).toHaveLength(0)
    expect((await decide(productionApproval, dan)).status).toBe(200)
    const productionPush = await pushOfApproval(productionApproval)
    expect((await drivePush(productionPush.id)).outcome.status).toBe('succeeded')
    expect(envOf(shopProduction)).toMatchObject({
      M365_TENANT_ID: M365_VALUES.M365_TENANT_ID,
      M365_CLIENT_SECRET: PRODUCTION_SECRET,
    })
    expect(await connector(shop.production.url)).toBe(200)

    // 5. The next staging deploy through deployer.mjs: the toml still carries the vars; the
    // gateway drops them (the grant wins) and keep_bindings keeps the secrets.
    const redeploy = deployJob(shop, 'staging', 'refs/tags/0.1.1', stagingToml)
    await deployToEnd(redeploy)
    const [ticket] = await db
      .select()
      .from(deployTickets)
      .where(eq(deployTickets.id, redeploy.ticketId() as string))
    expect(
      (ticket?.bindings as { shadowedVars?: string[] } | undefined)?.shadowedVars?.sort()
    ).toEqual(['M365_CLIENT_ID', 'M365_TENANT_ID'])
    expect(envOf(shopStaging)).toMatchObject({
      M365_TENANT_ID: M365_VALUES.M365_TENANT_ID,
      M365_CLIENT_ID: M365_VALUES.M365_CLIENT_ID,
      M365_CLIENT_SECRET: STAGING_SECRET,
    })
    expect(Object.values(envOf(shopStaging))).not.toContain(M365_TOML_PLACEHOLDER)
    expect(await connector(shop.staging.url)).toBe(200)
    // The upload began after the push, so activate started no repair push.
    expect(
      await db
        .select()
        .from(grantPushes)
        .where(and(eq(grantPushes.tenantId, tenantId), eq(grantPushes.reason, 'repair')))
    ).toHaveLength(0)

    // 6. crm and erp get production grants the same way: three holders.
    const crmGrant = await grantProduction(w, crm, resource.id)
    await grantProduction(w, erp, resource.id)
    const holders = [shop, crm, erp]
    for (const a of holders) {
      expect(envOf(a.production.workerName).M365_CLIENT_SECRET).toBe(PRODUCTION_SECRET)
      expect(await connector(a.production.url)).toBe(200)
    }

    // 7. Carol rotates the production secret: one field, the other two blank (kept).
    const [v1] = await db
      .select()
      .from(sharedResourceValues)
      .where(
        and(
          eq(sharedResourceValues.resourceId, resource.id),
          eq(sharedResourceValues.environment, 'production'),
          eq(sharedResourceValues.version, 1)
        )
      )
    azure.valid.add(ROTATED_SECRET) // the new secret is minted in Entra first
    // crm's first secret write fails: the push is partial.
    cloud.failNext(
      `PUT https://api.cloudflare.com/client/v4/accounts/${cloud.opts.accountId}/workers/scripts/${crm.production.workerName}/secrets`,
      500
    )
    const rotated = await ok(
      carol,
      'PUT',
      `/api/shared-resources/${resource.id}/values/production`,
      { values: { M365_TENANT_ID: '', M365_CLIENT_ID: '', M365_CLIENT_SECRET: ROTATED_SECRET } },
      202,
      putSharedResourceValuesResponseSchema
    )
    expect(rotated.version).toBe(2)
    const rotation = rotated.pushId as string
    const writesBefore = cloud.calls.filter(
      c => c.method === 'PUT' && c.path.endsWith('/secrets')
    ).length
    expect((await drivePush(rotation)).outcome.status).toBe('partial')
    const [partial] = await db.select().from(grantPushes).where(eq(grantPushes.id, rotation))
    expect(partial).toMatchObject({ reason: 'rotate', total: 3, succeeded: 2, failed: 1 })
    const [retiring] = await db
      .select()
      .from(sharedResourceValues)
      .where(eq(sharedResourceValues.id, v1?.id as string))
    expect(retiring?.status).toBe('retiring')
    expect(envOf(crm.production.workerName).M365_CLIENT_SECRET).toBe(PRODUCTION_SECRET)
    expect(envOf(shop.production.workerName).M365_CLIENT_SECRET).toBe(ROTATED_SECRET)
    expect(envOf(shop.production.workerName).M365_TENANT_ID).toBe(M365_VALUES.M365_TENANT_ID)
    const failedTold = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.type, GRANT_NOTIFICATION_TYPES.pushFailed)
        )
      )
    expect(new Set(failedTold.map(n => n.userId))).toEqual(new Set([carol.id, dan.id]))

    // Retry: the same push, only crm written again, then the old version is retired.
    const retried = await ok(
      carol,
      'POST',
      `/api/shared-resources/${resource.id}/pushes/${rotation}/retry`,
      {},
      202,
      grantPushSchema
    )
    expect(retried.id).toBe(rotation)
    const beforeRetry = cloud.calls.length
    const { outcome, instanceId } = await drivePush(rotation)
    expect(instanceId).toBe(`${rotation}-r1`)
    expect(outcome.status).toBe('succeeded')
    const retryWrites = cloud.calls
      .slice(beforeRetry)
      .filter(c => c.method === 'PUT' && c.path.endsWith('/secrets'))
    expect(new Set(retryWrites.map(c => c.path.split('/')[7]))).toEqual(
      new Set([crm.production.workerName])
    )
    expect(writesBefore).toBeGreaterThan(0)
    const [retired] = await db
      .select()
      .from(sharedResourceValues)
      .where(eq(sharedResourceValues.id, v1?.id as string))
    expect(retired?.status).toBe('retired')
    const rotatedTold = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.type, GRANT_NOTIFICATION_TYPES.rotated)
        )
      )
    expect(new Set(rotatedTold.map(n => n.userId))).toEqual(new Set([carol.id, dan.id]))
    expect(rotatedTold[0]?.body).toMatch(/Revoke the old credential at the vendor/)
    // "Azure" revokes the old secret: every holder still connects with the new one.
    azure.valid.delete(PRODUCTION_SECRET)
    for (const a of holders) {
      expect(envOf(a.production.workerName).M365_CLIENT_SECRET).toBe(ROTATED_SECRET)
      expect(await connector(a.production.url)).toBe(200)
    }
    // Staging was not touched by the production rotation.
    expect(envOf(shopStaging).M365_CLIENT_SECRET).toBe(STAGING_SECRET)

    // 8. Alice revokes crm's production grant: its Worker loses the secrets, nobody else's does.
    const revoked = await ok(
      alice,
      'DELETE',
      `/api/apps/${crm.app.id}/grants/${crmGrant}`,
      {},
      202,
      grantActionResponseSchema
    )
    expect(revoked.grant.status).toBe('revoking')
    expect((await drivePush(revoked.pushId as string)).outcome.status).toBe('succeeded')
    const crmEnv = envOf(crm.production.workerName)
    for (const item of M365_ITEMS) expect(crmEnv[item.key]).toBeUndefined()
    expect(crmEnv.RELEASE_VERSION).toBe('1.0.0')
    expect(await connector(crm.production.url)).toBe(503)
    for (const a of [shop, erp]) {
      expect(envOf(a.production.workerName).M365_CLIENT_SECRET).toBe(ROTATED_SECRET)
      expect(await connector(a.production.url)).toBe(200)
    }
    const [crmRow] = await db.select().from(appGrants).where(eq(appGrants.id, crmGrant))
    expect(crmRow).toMatchObject({ status: 'revoked', pushedVersionId: null })

    // Every grant's audit rows carry its approval id.
    const grantRows = await db.select().from(appGrants).where(eq(appGrants.tenantId, tenantId))
    const grantAudit = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          inArray(
            auditEvents.targetId,
            grantRows.map(g => g.id)
          )
        )
      )
    expect(grantAudit.length).toBeGreaterThan(grantRows.length)
    for (const row of grantAudit) {
      const grant = grantRows.find(g => g.id === row.targetId)
      expect(row.approvalId, `${row.action} on ${row.targetId}`).toBe(grant?.approvalId)
    }
    expect(new Set(grantAudit.map(r => r.action).filter(a => a.startsWith('grant.')))).toEqual(
      new Set([
        'grant.requested',
        'grant.approved',
        'grant.var_shadowed',
        'grant.pushed',
        'grant.push_failed',
        'grant.revoke_requested',
        'grant.revoked',
      ])
    )

    // 9. Sealed by the audit.seal task (scoped to this tenant) and verified.
    const cron = createExecutionContext()
    const reports = await dispatchScheduled('*/5 * * * *', env, cron, {
      '*/5 * * * *': [auditSealTask({ tenantIds: [tenantId] })],
    })
    await waitOnExecutionContext(cron)
    expect(reports).toEqual([expect.objectContaining({ task: 'audit.seal', status: 'ok' })])
    const verify = await call(admin, 'GET', '/api/audit/verify')
    expect(verify.status).toBe(200)
    expect(auditVerifySchema.parse(verify.body)).toMatchObject({ ok: true, unsealed: 0 })

    // ---- no secret anywhere
    const rows = {
      resources: await db
        .select()
        .from(sharedResources)
        .where(eq(sharedResources.tenantId, tenantId)),
      values: (
        await db
          .select()
          .from(sharedResourceValues)
          .where(eq(sharedResourceValues.tenantId, tenantId))
      ).map(({ sealed, ...rest }) => ({ ...rest, sealedLength: sealed.length })),
      grants: grantRows,
      pushes: await db.select().from(grantPushes).where(eq(grantPushes.tenantId, tenantId)),
      targets: await db
        .select()
        .from(grantPushTargets)
        .where(eq(grantPushTargets.tenantId, tenantId)),
      scans: await db.select().from(appConfigScans).where(eq(appConfigScans.tenantId, tenantId)),
      approvals: await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.tenantId, tenantId)),
      audit: await db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
      notifications: await db
        .select()
        .from(notifications)
        .where(eq(notifications.tenantId, tenantId)),
      tickets: await db.select().from(deployTickets).where(eq(deployTickets.tenantId, tenantId)),
    }
    // The sealed blob is really sealed: none of it reads as a sentinel either.
    const sealed = await db
      .select({ sealed: sharedResourceValues.sealed })
      .from(sharedResourceValues)
      .where(eq(sharedResourceValues.tenantId, tenantId))
    const haystacks: [string, string][] = [
      ['responses', bodies.join('\n')],
      ['rows', safeJson(rows)],
      ['sealed', safeJson(sealed)],
      ['step results', safeJson(stepResults)],
      ['logs', logged.join('\n')],
      ['deployer output', deployerOutput.join('\n')],
      ['realtime', safeJson(stubs(env).hub.broadcasts)],
      ['queue', safeJson(stubs(env).queue.messages)],
    ]
    // The search can find a sentinel: the vendor was sent every one (that is the point)…
    for (const sentinel of SENTINELS) expect(safeJson(cloud.calls)).toContain(sentinel)
    // …and the app's own log lines are in the haystack (pino writes JSON through stdout).
    expect(logged.some(line => line.includes('"msg"'))).toBe(true)
    expect(stepResults.length).toBeGreaterThan(0)
    for (const [where, hay] of haystacks) {
      for (const sentinel of SENTINELS) {
        expect(hay.includes(sentinel), `${where} carried a secret`).toBe(false)
      }
    }
  })
})

describe('variants', () => {
  it('reject: the team says no, the grant is rejected and nothing is pushed', async () => {
    const w = await world()
    const resource = await createM365(w)
    const asked = await ok(
      w.alice,
      'POST',
      `/api/apps/${w.shop.app.id}/grants`,
      { resourceId: resource.id, environments: ['staging'], reason: 'Mail sync' },
      202,
      requestGrantResponseSchema
    )
    const [grant] = asked.grants
    const refused = await call(w.dan, 'POST', `/api/approvals/${grant?.approvalId}/decide`, {
      decision: 'reject',
      comment: 'Use the shared mailbox connector instead',
    })
    expect(refused.status).toBe(200)
    const [row] = await db
      .select()
      .from(appGrants)
      .where(eq(appGrants.id, grant?.id as string))
    expect(row?.status).toBe('rejected')
    expect(
      await db.select().from(grantPushes).where(eq(grantPushes.resourceId, resource.id))
    ).toHaveLength(0)
    expect(await connector(w.shop.staging.url)).toBe(503)
    // The live index is free again: alice may ask once more.
    const again = await call(w.alice, 'POST', `/api/apps/${w.shop.app.id}/grants`, {
      resourceId: resource.id,
      environments: ['staging'],
      reason: 'Mail sync, second try',
    })
    expect(again.status).toBe(202)
  })

  it('a rotation between upload and activate: activate starts a repair push that restores it', async () => {
    const w = await world()
    const resource = await createM365(w)
    const { shop, alice, carol } = w
    const shopStaging = shop.staging.workerName as string
    await goLive(shopStaging, { RELEASE_VERSION: '0.1.0' })
    // shop holds staging: requested, approved by carol, pushed.
    const asked = await ok(
      alice,
      'POST',
      `/api/apps/${shop.app.id}/grants`,
      { resourceId: resource.id, environments: ['staging'], reason: 'Mail sync' },
      202,
      requestGrantResponseSchema
    )
    const approvalId = asked.grants[0]?.approvalId as string
    expect((await decide(approvalId, carol)).status).toBe(200)
    expect((await drivePush((await pushOfApproval(approvalId)).id)).outcome.status).toBe(
      'succeeded'
    )
    expect(envOf(shopStaging).M365_CLIENT_SECRET).toBe(STAGING_SECRET)
    cloud.github.pushCommit(shop.owner, shop.repo, {
      'package.json': '{\n  "name": "shop",\n  "version": "0.2.0"\n}\n',
    })

    // A deploy uploads (the version carries the secrets as of NOW)…
    const job = deployJob(
      shop,
      'staging',
      'refs/heads/main',
      withM365Vars(appToml(shop, 'staging'))
    )
    for (const command of ['start', 'upload']) {
      const step = await job.run(command)
      expect(step.code, `${command}: ${step.stderr}`).toBe(0)
    }
    // …carol rotates staging before it activates…
    const rotated = await ok(
      carol,
      'PUT',
      `/api/shared-resources/${resource.id}/values/staging`,
      { values: { M365_CLIENT_SECRET: ROTATED_SECRET } },
      202,
      putSharedResourceValuesResponseSchema
    )
    expect((await drivePush(rotated.pushId as string)).outcome.status).toBe('succeeded')
    expect(envOf(shopStaging).M365_CLIENT_SECRET).toBe(ROTATED_SECRET)
    // …and activating the older upload brings the OLD secret back — until the repair lands.
    const activated = await job.run('activate')
    expect(activated.code, activated.stderr).toBe(0)
    expect(envOf(shopStaging).M365_CLIENT_SECRET).toBe(STAGING_SECRET)
    const [repair] = await db
      .select()
      .from(grantPushes)
      .where(and(eq(grantPushes.resourceId, resource.id), eq(grantPushes.reason, 'repair')))
    expect(repair).toBeDefined()
    expect((await drivePush(repair?.id as string)).outcome.status).toBe('succeeded')
    expect(envOf(shopStaging).M365_CLIENT_SECRET).toBe(ROTATED_SECRET)
    expect((await job.run('finish')).code).toBe(0)
    azure.valid.add(ROTATED_SECRET)
    expect(await connector(shop.staging.url)).toBe(200)
  })
})
