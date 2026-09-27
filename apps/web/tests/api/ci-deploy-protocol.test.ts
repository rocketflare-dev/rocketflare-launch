// @vitest-isolate
// Installs a FakeCloud as the global fetch, mocks the credential store, runs deployer.mjs.
/**
 * The deployer protocol end to end: the kit's REAL `scripts/deployer.mjs` (the deploy job's side
 * of DEPLOYER.md v1, byte-identical to the kit's) run as a child process against Launch's
 * `/ci/deploy`, exactly as `deploy.yml` runs it when `DEPLOYER_URL` is set.
 *
 * A `node:http` bridge stands in for the network, as `tests/config/deployer.test.ts` does for the
 * script alone: it forwards every request to `app.request(…, env)` and also serves
 * `ACTIONS_ID_TOKEN_REQUEST_URL`, minting a GitHub Actions OIDC token for the audience the script
 * asks for (`mintActionsToken`). Every vendor call Launch makes lands in a FakeCloud. The child
 * runs asynchronously so the bridge can answer it.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '@/api/index'
import type { GitHubOidcClaims } from '@/api/services/launch/ci/github-oidc'
import { deployTickets } from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
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
import { forgetApps } from '../helpers/launch-apps'
import { request } from '../helpers/request'
import {
  createExecutionContext,
  createTestEnv,
  type TestEnv,
  waitOnExecutionContext,
} from '../mocks/bindings'

const SCRIPT = path.resolve(__dirname, '../../../../scripts/deployer.mjs')
const REQUEST_TOKEN = 'actions-request-token'

/** The platform credentials, in memory (`fillDeployCredentials`): no global table is written. */
const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal => {
  const real = await importOriginal<typeof import('@/api/services/launch/credentials')>()
  return {
    ...real,
    getCredential: async (_db: unknown, _cfg: unknown, kind: string) =>
      store.credentials.get(kind) ?? null,
    getSetting: async (_db: unknown, key: string) => store.settings.get(key) ?? null,
  }
})

const db = setupTestDatabase()
const cloud = createFakeCloud()
let restoreFetch: () => void
let server: Server
let base = ''
let env: TestEnv
/** The claims the bridge's token endpoint signs — the job currently "running". */
let claims: Partial<GitHubOidcClaims> = {}
const tenantIds: string[] = []

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
  // GitHub's token endpoint, as `ACTIONS_ID_TOKEN_REQUEST_URL` names it.
  if (url.pathname === '/actions-token') {
    if (req.headers.authorization !== `bearer ${REQUEST_TOKEN}`) return reply(res, 401, {})
    const audience = url.searchParams.get('audience') ?? ''
    return reply(res, 200, { value: await mintActionsToken(claims, { audience }) })
  }
  // Everything else is Launch.
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

beforeAll(async () => {
  restoreFetch = cloud.install()
  server = createServer((req, res) => {
    bridge(req, res).catch(error => reply(res, 500, { error: String(error) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  restoreFetch()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await forgetApps(db, tenantIds)
})

let dir = ''
let githubEnv = ''
let admin: { tenantId: string; cookie: Record<string, string> }
let seeded: DeployableApp

beforeEach(async () => {
  // Launch's APP_URL is the bridge, so `DEPLOYER_AUDIENCE` (= APP_URL) is what it verifies.
  env = createTestEnv({ APP_URL: base })
  fillDeployCredentials(store, cloud)
  const { user, tenant } = await createTestTenantWithUser(db, 'admin')
  tenantIds.push(tenant.id)
  admin = {
    tenantId: tenant.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
  seeded = await seedDeployableApp(db, cloud, tenant.id)
  dir = mkdtempSync(path.join(tmpdir(), 'launch-deployer-'))
  githubEnv = path.join(dir, 'github-env')
  writeFileSync(githubEnv, '')
  mkdirSync(path.join(dir, 'web/dist/deploy'), { recursive: true })
  mkdirSync(path.join(dir, 'web/dist/ui'), { recursive: true })
  writeFileSync(
    path.join(dir, 'web/dist/deploy/worker.js'),
    'export default { fetch() { return new Response("ok") } }'
  )
  writeFileSync(path.join(dir, 'web/dist/deploy/worker.js.map'), '{}')
  writeFileSync(path.join(dir, 'web/dist/ui/index.html'), '<!doctype html><title>shop</title>')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function writeToml(environment: 'staging' | 'production', text?: string): string {
  const file = path.join(
    dir,
    environment === 'staging' ? 'web/wrangler.staging.toml' : 'web/wrangler.toml'
  )
  writeFileSync(file, text ?? appToml(seeded, environment))
  return file
}

function exported(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(githubEnv, 'utf8').split('\n').filter(Boolean)) {
    const at = line.indexOf('=')
    out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

/** Run one `deployer.mjs` command as the job would, with a bare env. */
function run(command: string, toml: string, extra: Record<string, string> = {}) {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    DEPLOYER_URL: `${base}/ci`,
    DEPLOYER_AUDIENCE: base,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/actions-token?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    GITHUB_ENV: githubEnv,
    TOML: toml,
    RELEASE_VERSION: '2.0.0',
    WAIT_SECONDS: '20',
    DEPLOYER_POLL_SECONDS: '0.05',
    ...exported(),
    ...extra,
  }
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const options = { env: childEnv as unknown as NodeJS.ProcessEnv, cwd: dir }
    execFile(process.execPath, [SCRIPT, command], options, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function ticket(id: string) {
  const [row] = await db.select().from(deployTickets).where(eq(deployTickets.id, id))
  if (!row) throw new Error(`no ticket ${id}`)
  return row
}

/** Resolve once the app has a ticket in `status` (the job is waiting on it). */
async function waitForTicket(environmentId: string, status: 'pending') {
  for (let i = 0; i < 200; i++) {
    const [row] = await db
      .select()
      .from(deployTickets)
      .where(and(eq(deployTickets.environmentId, environmentId), eq(deployTickets.status, status)))
    if (row) return row
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the job never opened a pending ticket')
}

describe('scripts/deployer.mjs against /ci/deploy', () => {
  it('deploys staging: start → upload → activate → finish, and the credential dies after', async () => {
    claims = deployClaims(seeded, 'staging')
    const toml = writeToml('staging')

    const start = await run('start', toml)
    expect(start.code, start.stderr).toBe(0)
    const id = exported().DEPLOYER_TICKET
    expect(start.stdout).toContain(`ticket ${id}: approved`)

    const upload = await run('upload', toml)
    expect(upload.code, upload.stderr).toBe(0)
    const migratorUrl = exported().MIGRATOR_URL
    expect(migratorUrl).toMatch(/^postgres(ql)?:\/\/migrator:/)
    const password = new URL(migratorUrl).password
    expect(upload.stdout).toContain(`::add-mask::${migratorUrl}`)
    const leaks = `${upload.stdout}\n${upload.stderr}`
      .split('\n')
      .filter(line => line.includes(password) && !line.startsWith('::add-mask::'))
    expect(leaks).toEqual([])
    // The password works right now: it is the staging branch's current one.
    const branch = cloud.neon.projects.get(seeded.projectId)?.branches.get(seeded.stagingBranchId)
    expect(branch?.roles.get('migrator')?.password).toBe(password)

    const activate = await run('activate', toml)
    expect(activate.code, activate.stderr).toBe(0)
    expect(activate.stdout).toContain('activated: active')
    const finish = await run('finish', toml)
    expect(finish.code, finish.stderr).toBe(0)
    expect(finish.stdout).toContain('finished: finished')

    // Revoked: the password the job holds is no longer the role's.
    expect(branch?.roles.get('migrator')?.password).not.toBe(password)
    const row = await ticket(id ?? '')
    expect(row).toMatchObject({ status: 'finished', version: '2.0.0' })
    const live = cloud.cloudflare.activeVersion(seeded.staging.workerName ?? '')
    expect(live?.id).toBe(row.cfVersionId)
    // The outdir's source map never left the job; the asset did.
    expect(Object.keys(live?.modules ?? {})).toEqual(['worker.js'])
    expect(live?.bindings).toEqual(
      expect.arrayContaining([{ type: 'plain_text', name: 'RELEASE_VERSION', text: '2.0.0' }])
    )
  })

  it('production waits for approval on the app page, then deploys', async () => {
    claims = deployClaims(seeded, 'production')
    const toml = writeToml('production')

    const starting = run('start', toml)
    const pending = await waitForTicket(seeded.production.id, 'pending')
    const decide = await request(
      `/api/apps/${seeded.app.id}/deploys/${pending.id}/decide`,
      { method: 'POST', headers: admin.cookie },
      { env, json: { decision: 'approve' } }
    )
    expect(decide.status).toBe(200)
    const start = await starting
    expect(start.code, start.stderr).toBe(0)
    expect(start.stdout).toContain('waiting for approval (status pending)')
    expect(start.stdout).toContain(`ticket ${pending.id} approved`)

    for (const command of ['upload', 'activate', 'finish']) {
      const step = await run(command, toml)
      expect(step.code, `${command}: ${step.stderr}`).toBe(0)
    }
    expect((await ticket(pending.id)).status).toBe('finished')
    expect(cloud.cloudflare.activeVersion(seeded.production.workerName ?? '')?.id).toBe(
      (await ticket(pending.id)).cfVersionId
    )
  })

  it('a rejected production deploy fails the job at start', async () => {
    claims = deployClaims(seeded, 'production')
    const toml = writeToml('production')
    const starting = run('start', toml)
    const pending = await waitForTicket(seeded.production.id, 'pending')
    await request(
      `/api/apps/${seeded.app.id}/deploys/${pending.id}/decide`,
      { method: 'POST', headers: admin.cookie },
      { env, json: { decision: 'reject' } }
    )
    const start = await starting
    expect(start.code).toBe(1)
    expect(start.stderr).toMatch(/was rejected by the deployer/)
    const finish = await run('finish', toml)
    expect(finish.code, finish.stderr).toBe(0)
    expect(finish.stdout).toContain('finished: rejected')
  })

  it('the S1 attack through the real client: 403 at upload, no credential, no Neon call', async () => {
    claims = deployClaims(seeded, 'staging')
    const victim = await seedDeployableApp(db, cloud, admin.tenantId)
    const evilKv = victim.staging.resources.kv?.[0]?.id
    const toml = writeToml(
      'staging',
      appToml(seeded, 'staging', `\n[[kv_namespaces]]\nbinding = "VICTIM"\nid = "${evilKv}"\n`)
    )
    expect((await run('start', toml)).code).toBe(0)
    const neonBefore = cloud.callsTo('neon').length

    const upload = await run('upload', toml)
    expect(upload.code).toBe(1)
    expect(upload.stderr).toContain(`upload refused: 403 bindings not registered for this app`)
    expect(exported().MIGRATOR_URL).toBeUndefined()
    expect(cloud.callsTo('neon').length).toBe(neonBefore)

    const finish = await run('finish', toml)
    expect(finish.code, finish.stderr).toBe(0)
    expect(finish.stdout).toContain('finished: failed')
    const row = await ticket(exported().DEPLOYER_TICKET ?? '')
    expect(row.refused).toEqual([`kv_namespaces VICTIM=${evilKv}`])
    expect(cloud.callsTo('neon').length).toBe(neonBefore)
  })
})
