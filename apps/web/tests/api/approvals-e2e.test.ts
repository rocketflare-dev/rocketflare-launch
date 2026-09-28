// @vitest-isolate
// Installs a FakeCloud as the global fetch, mocks the credential store, runs deployer.mjs.
/**
 * The P4 exit test (`docs/plans/p4-approvals.md` §4): a production deploy waits in the Launch
 * inbox and is released by the approval, and the audit log shows the whole chain from PR to
 * production. Every step goes through the real surfaces — the `/api` routes as alice and bob, the
 * kit's REAL `scripts/deployer.mjs` as the GitHub job (a child process, over a `node:http` bridge
 * to `app.request`, exactly as `ci-deploy-protocol.test.ts` runs it), the real approvals engine,
 * the `sessions.checks` merge follower and the audit sealer — with every vendor in a FakeCloud.
 *
 * Setup: alice and bob own the app; alice's shipped session has PR #1.
 *
 * 1. FakeCloud merges #1; the `sessions.checks` follower records `pr.merged`.
 * 2. Alice releases (`patch`) → tag `0.1.1` in the FakeCloud, `prs = [#1]`.
 * 3. A staging run on `refs/tags/0.1.1`: start → upload → activate → finish → `staging_active`.
 * 4. Alice promotes: pending; bob has a notification and an `email.send` job; alice's own decide
 *    is 403 `self_approval`.
 * 5. Bob approves in the inbox: a published GitHub Release, and a pre-approval bound to the tag.
 * 6. The production run on the tag claims it at `start` → upload → activate → finish →
 *    `production_active`.
 * 7. The `audit.seal` task seals the log, `GET /api/audit/verify` is ok, and every link of the
 *    chain is in the export with its `seq` and `hash`.
 *
 * Asserted on the way: the request waits in bob's inbox (`box=mine`, the badge) and in alice's
 * `requested`, never her `mine`; the detail names who it waits on (`eligible`: bob and the owner,
 * not alice); `/chain` is every link in time order — `session.shipped` → `pr.merged` →
 * `release.created` → staging `deploy.*` → `release.staging_active` → `approval.*` → production
 * `deploy.*` → `release.production` — with the approval rows carrying its id.
 *
 * Variants: two approvals required (N=2), expiry (the sweep), and a job-originated run (a Release
 * published by hand while the job waits) approved from the app page.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  approvalCountSchema,
  approvalDetailSchema,
  approvalListResponseSchema,
} from '@launch/shared/launch-approvals'
import { auditExportRowSchema, auditVerifySchema } from '@launch/shared/launch-audit'
import {
  promoteReleaseResponseSchema,
  releaseChainSchema,
  releaseSchema,
} from '@launch/shared/launch-releases'
import { and, eq, isNotNull } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '@/api/index'
import { dispatchScheduled } from '@/api/scheduled'
import { sweepApprovals } from '@/api/services/approvals/sweep'
import { auditSealTask } from '@/api/services/launch/audit-chain'
import type { GitHubOidcClaims } from '@/api/services/launch/ci/github-oidc'
import { followMergedPullRequests, githubPullReader } from '@/api/services/sessions/checks-cron'
import { loadConfig } from '@/config'
import {
  appReleases,
  approvalPolicies,
  approvalRequests,
  auditEvents,
  deployTickets,
  notifications,
} from '@/db/schema'
import { approvalDeps } from '../helpers/approvals'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { appToml, deployClaims, fillDeployCredentials } from '../helpers/deploy-gateway'
import { createFakeCloud } from '../helpers/fake-cloud'
import { mintActionsToken } from '../helpers/github-oidc'
import { forgetApps } from '../helpers/launch-apps'
import { addTestAppOwner } from '../helpers/oidc'
import {
  type ReleasableApp,
  seedReleasableApp,
  serveAppHosts,
  shipSessionPr,
} from '../helpers/releases'
import { request } from '../helpers/request'
import {
  createExecutionContext,
  createTestEnv,
  stubs,
  type TestEnv,
  waitOnExecutionContext,
} from '../mocks/bindings'

const SCRIPT = path.resolve(__dirname, '../../../../scripts/deployer.mjs')
const REQUEST_TOKEN = 'actions-request-token'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

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

interface Person {
  id: string
  email: string
  cookie: Record<string, string>
}

let dir = ''
beforeEach(() => {
  env = createTestEnv({ APP_URL: base })
  fillDeployCredentials(store, cloud)
  dir = mkdtempSync(path.join(tmpdir(), 'launch-p4-e2e-'))
  mkdirSync(path.join(dir, 'web/dist/deploy'), { recursive: true })
  mkdirSync(path.join(dir, 'web/dist/ui'), { recursive: true })
  writeFileSync(
    path.join(dir, 'web/dist/deploy/worker.js'),
    'export default { fetch() { return new Response("ok") } }'
  )
  writeFileSync(path.join(dir, 'web/dist/ui/index.html'), '<!doctype html><title>shop</title>')
  return () => rmSync(dir, { recursive: true, force: true })
})

async function person(tenantId: string, role: 'owner' | 'admin' | 'member'): Promise<Person> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenantId))
  return { id: user.id, email: user.email, cookie }
}

/** The organisation: its owner, alice and bob (members who own the app), alice's shipped PR #1. */
async function fixture() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const admin: Person = {
    id: user.id,
    email: user.email,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
  const alice = await person(tenant.id, 'member')
  const bob = await person(tenant.id, 'member')
  const seeded = await seedReleasableApp(db, cloud, tenant.id)
  await addTestAppOwner(db, tenant.id, seeded.app.id, alice.id)
  await addTestAppOwner(db, tenant.id, seeded.app.id, bob.id)
  serveAppHosts(cloud, seeded)
  const shipped = await shipSessionPr(db, cloud, seeded, {
    tenantId: tenant.id,
    userId: alice.id,
    title: 'Add the orders page',
  })
  return { tenantId: tenant.id, admin, alice, bob, seeded, shipped }
}

/** One `deploy.yml` job: the real deployer script, one command per call, sharing GITHUB_ENV. */
function deployJob(seeded: ReleasableApp, environment: 'staging' | 'production', ref: string) {
  const githubEnv = path.join(dir, `github-env-${Math.random().toString(36).slice(2)}`)
  writeFileSync(githubEnv, '')
  const tomlFile = path.join(
    dir,
    environment === 'staging' ? 'web/wrangler.staging.toml' : 'web/wrangler.toml'
  )
  writeFileSync(tomlFile, appToml(seeded, environment))
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
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      })
    })
  }
  return { run, ticketId: () => exported().DEPLOYER_TICKET }
}

/** start → upload → activate → finish, each exiting 0. */
async function runToTheEnd(job: ReturnType<typeof deployJob>, from = 'start') {
  const steps = ['start', 'upload', 'activate', 'finish']
  for (const command of steps.slice(steps.indexOf(from))) {
    const step = await job.run(command)
    expect(step.code, `${command}: ${step.stderr}`).toBe(0)
  }
}

function decideRoute(approvalId: string, who: Person, decision: 'approve' | 'reject' = 'approve') {
  return request(
    `/api/approvals/${approvalId}/decide`,
    { method: 'POST', headers: who.cookie },
    { env, json: { decision } }
  )
}

async function releaseRow(id: string) {
  const [row] = await db.select().from(appReleases).where(eq(appReleases.id, id))
  if (!row) throw new Error(`no release ${id}`)
  return row
}

/** Steps 1–3: merged, released, live on staging. */
async function onStaging(f: Awaited<ReturnType<typeof fixture>>) {
  const { tenantId, alice, seeded, shipped } = f
  cloud.github.merge(seeded.owner, seeded.repo, shipped.number)
  const merges = await followMergedPullRequests(db, githubPullReader(loadConfig(env)), {
    tenantIds: [tenantId],
  })
  expect(merges.merged).toBe(1)

  const res = await request(
    `/api/apps/${seeded.app.id}/releases`,
    { method: 'POST', headers: alice.cookie },
    { env, json: { bump: 'patch' } }
  )
  expect(res.status, await res.clone().text()).toBe(201)
  const cut = releaseSchema.parse(await res.json())
  expect(cut).toMatchObject({ tag: '0.1.1', version: '0.1.1' })
  expect(cut.prs.map(p => [p.number, p.sessionId])).toEqual([[shipped.number, shipped.session.id]])
  expect(cloud.github.repo(seeded.owner, seeded.repo)?.refs.get('tags/0.1.1')).toBe(cut.sha)

  await runToTheEnd(deployJob(seeded, 'staging', 'refs/tags/0.1.1'))
  expect(await releaseRow(cut.id)).toMatchObject({ status: 'staging_active' })
  return cut
}

async function promote(seeded: ReleasableApp, releaseId: string, who: Person) {
  const res = await request(
    `/api/apps/${seeded.app.id}/releases/${releaseId}/promote`,
    { method: 'POST', headers: who.cookie },
    { env, json: {} }
  )
  expect(res.status, await res.clone().text()).toBe(202)
  return promoteReleaseResponseSchema.parse(await res.json())
}

/** `needles` appear in `hay` in this order (other rows may sit between them). */
function inOrder(hay: string[], needles: string[]): boolean {
  let at = 0
  for (const item of hay) if (item === needles[at]) at++
  return at === needles.length
}

describe('P4 exit: a production deploy waits in the inbox and the approval releases it', () => {
  it('PR → merge → tag → staging → approval → production, sealed and verified', async () => {
    const f = await fixture()
    const { tenantId, admin, alice, bob, seeded } = f
    const cut = await onStaging(f)

    // 4. Alice promotes; the request waits on bob, who is told in the app and by email.
    const queueBefore = stubs(env).queue.messages.length
    const { approvalId } = await promote(seeded, cut.id, alice)
    const pending = approvalDetailSchema.parse(
      await (await request(`/api/approvals/${approvalId}`, { headers: bob.cookie }, { env })).json()
    )
    expect(pending).toMatchObject({ status: 'pending', kind: 'deploy.production', canDecide: true })
    // It waits in bob's inbox and on his badge — and in alice's "requested", never her "mine".
    const box = async (who: Person, which: 'mine' | 'requested') =>
      approvalListResponseSchema
        .parse(
          await (
            await request(`/api/approvals?box=${which}`, { headers: who.cookie }, { env })
          ).json()
        )
        .items.map(i => i.id)
    const badge = async (who: Person) =>
      approvalCountSchema.parse(
        await (await request('/api/approvals/count', { headers: who.cookie }, { env })).json()
      ).count
    expect(await box(bob, 'mine')).toContain(approvalId)
    expect(await badge(bob)).toBe(1)
    expect(await box(alice, 'requested')).toContain(approvalId)
    expect(await box(alice, 'mine')).not.toContain(approvalId)
    // Named: who it waits on — bob and the organisation's owner, never alice (the author).
    expect(pending.eligible?.map(p => p.id).sort()).toEqual([admin.id, bob.id].sort())
    const told = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), eq(notifications.userId, bob.id)))
    expect(told.map(n => n.type)).toContain('approval_requested')
    const emails = stubs(env)
      .queue.messages.slice(queueBefore)
      .map(m => m.body as { type: string; payload: unknown })
      .filter(m => m.type === 'email.send')
    expect(JSON.stringify(emails)).toContain(bob.email)
    const self = await decideRoute(approvalId, alice)
    expect(self.status).toBe(403)
    expect(await self.json()).toMatchObject({ statusCode: 403, code: 'self_approval' })

    // 5. Bob approves: the GitHub Release is published and the pre-approval bound to the tag.
    const approved = await decideRoute(approvalId, bob)
    expect(approved.status, await approved.clone().text()).toBe(200)
    expect(await box(bob, 'mine')).not.toContain(approvalId)
    expect(await badge(bob)).toBe(0)
    expect(cloud.github.releaseFor(seeded.owner, seeded.repo, '0.1.1')).toMatchObject({
      via: 'api',
    })
    const [intent] = await db
      .select()
      .from(deployTickets)
      .where(eq(deployTickets.approvalId, approvalId))
    expect(intent).toMatchObject({ ref: 'refs/tags/0.1.1', status: 'approved', runId: null })

    // 6. The production run on the tag claims it at start, then ships.
    const prod = deployJob(seeded, 'production', 'refs/tags/0.1.1')
    const start = await prod.run('start')
    expect(start.code, start.stderr).toBe(0)
    expect(prod.ticketId()).toBe(intent?.id)
    expect(start.stdout).not.toContain('waiting for approval')
    await runToTheEnd(prod, 'upload')
    expect(await releaseRow(cut.id)).toMatchObject({ status: 'production_active' })
    const liveVersion = cloud.cloudflare.activeVersion(seeded.production.workerName as string)
    expect(liveVersion?.bindings).toEqual(
      expect.arrayContaining([{ type: 'plain_text', name: 'RELEASE_VERSION', text: '0.1.1' }])
    )

    // The chain, in order, linked by ids.
    const chain = releaseChainSchema.parse(
      await (
        await request(
          `/api/apps/${seeded.app.id}/releases/${cut.id}/chain`,
          { headers: bob.cookie },
          { env }
        )
      ).json()
    )
    const actions = chain.events.map(e => e.action)
    expect(
      inOrder(actions, [
        'session.shipped',
        'pr.merged',
        'release.created',
        'deploy.started',
        'deploy.activated',
        'release.staging_active',
        'approval.requested',
        'approval.decided',
        'approval.approved',
        'deploy.started',
        'deploy.activated',
        'release.production',
      ]),
      actions.join(' → ')
    ).toBe(true)
    for (const e of chain.events.filter(e => e.action.startsWith('approval.'))) {
      expect(e.approvalId).toBe(approvalId)
    }
    // In time order; staging's deploy before the approval, production's after it.
    const times = chain.events.map(e => e.at.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    const deployEnvs = chain.events
      .filter(e => e.action === 'deploy.activated')
      .map(e => e.summary.after?.environment)
    expect(deployEnvs).toEqual(['staging', 'production'])
    const decidedAt = actions.indexOf('approval.approved')
    const productionStart = chain.events.findIndex(
      e => e.action === 'deploy.started' && e.summary.after?.environment === 'production'
    )
    expect(productionStart).toBeGreaterThan(decidedAt)
    expect(chain.events.find(e => e.action === 'pr.merged')?.summary.after).toMatchObject({
      number: f.shipped.number,
    })
    // No migrator URL anywhere: not in the chain, not in any audit row.
    const everything = await db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId))
    expect(JSON.stringify([chain, everything])).not.toMatch(/postgres(ql)?:\/\//)

    // 7. Sealed by the audit.seal cron task (scoped to this tenant) and verified.
    const cron = createExecutionContext()
    const reports = await dispatchScheduled('*/5 * * * *', env, cron, {
      '*/5 * * * *': [auditSealTask({ tenantIds: [tenantId] })],
    })
    await waitOnExecutionContext(cron)
    expect(reports).toEqual([expect.objectContaining({ task: 'audit.seal', status: 'ok' })])
    const verify = await request('/api/audit/verify', { headers: admin.cookie }, { env })
    expect(verify.status, await verify.clone().text()).toBe(200)
    expect(auditVerifySchema.parse(await verify.json())).toMatchObject({ ok: true, unsealed: 0 })
    // Every link of the chain is in the export with its seq and hash.
    const exported = await request('/api/audit/export', { headers: admin.cookie }, { env })
    const rows = (await exported.text())
      .split('\n')
      .filter(Boolean)
      .map(line => auditExportRowSchema.parse(JSON.parse(line)))
    const sealedIds = new Set(rows.filter(r => r.seq !== null && r.hash).map(r => r.id))
    expect(chain.events.every(e => sealedIds.has(e.id))).toBe(true)
  })
})

describe('variants', () => {
  it('N=2: one approval is not enough, the second releases it', async () => {
    const f = await fixture()
    const { tenantId, admin, alice, bob, seeded } = f
    await db.insert(approvalPolicies).values({
      tenantId,
      kind: 'deploy.production',
      scopeType: 'app',
      scopeId: seeded.app.id,
      approvers: { appOwners: true, admins: true, groupIds: [], userIds: [] },
      minApprovals: 2,
      allowSelfApproval: false,
      expiresAfterMinutes: 60,
      autoApproveRole: null,
    })
    const cut = await onStaging(f)
    const { approvalId } = await promote(seeded, cut.id, alice)
    expect((await decideRoute(approvalId, bob)).status).toBe(200)
    expect(await releaseRow(cut.id)).toMatchObject({ status: 'awaiting_approval' })
    expect(cloud.github.releaseFor(seeded.owner, seeded.repo, '0.1.1')).toBeUndefined()
    // Bob cannot count twice.
    expect((await decideRoute(approvalId, bob)).status).toBe(409)
    expect((await decideRoute(approvalId, admin)).status).toBe(200)
    expect(await releaseRow(cut.id)).toMatchObject({ status: 'promoting' })
    expect(cloud.github.releaseFor(seeded.owner, seeded.repo, '0.1.1')).toBeDefined()
  })

  it('expiry: nobody approves in time, the sweep expires it and the release is rejected', async () => {
    const f = await fixture()
    const { tenantId, alice, seeded } = f
    const cut = await onStaging(f)
    const { approvalId } = await promote(seeded, cut.id, alice)
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId))
    // The default window is a day; the sweep runs "a day later".
    const deadline = row?.expiresAt
    if (!deadline) throw new Error('the request has no expiry')
    const later = () => new Date(deadline.getTime() + 60_000)
    await sweepApprovals(approvalDeps(db, env, later))
    const [expired] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, approvalId)))
    expect(expired?.status).toBe('expired')
    expect(await releaseRow(cut.id)).toMatchObject({
      status: 'rejected',
      error: 'The production deploy was expired',
    })
    expect(cloud.github.releaseFor(seeded.owner, seeded.repo, '0.1.1')).toBeUndefined()
  })

  it('a Release published by hand: the job waits in the inbox and an approval releases it', async () => {
    const f = await fixture()
    const { tenantId, bob, seeded } = f
    const cut = await onStaging(f)
    cloud.github.publish(seeded.owner, seeded.repo, '0.1.1')

    const prod = deployJob(seeded, 'production', 'refs/tags/0.1.1')
    const starting = prod.run('start')
    let waiting: typeof deployTickets.$inferSelect | undefined
    for (let i = 0; i < 400 && !waiting; i++) {
      ;[waiting] = await db
        .select()
        .from(deployTickets)
        .where(
          and(
            eq(deployTickets.tenantId, tenantId),
            eq(deployTickets.environmentId, seeded.production.id),
            eq(deployTickets.status, 'pending'),
            isNotNull(deployTickets.approvalId)
          )
        )
      if (!waiting) await new Promise(r => setTimeout(r, 25))
    }
    if (!waiting?.approvalId) throw new Error('the production job never waited on an approval')
    expect(waiting.releaseId).toBe(cut.id)
    // Bob approves it from his inbox while the job polls.
    expect((await decideRoute(waiting.approvalId, bob)).status).toBe(200)
    const start = await starting
    expect(start.code, start.stderr).toBe(0)
    expect(start.stdout).toContain('waiting for approval (status pending)')
    await runToTheEnd(prod, 'upload')
    expect(await releaseRow(cut.id)).toMatchObject({ status: 'production_active' })
  })
})
