// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform credential store.
/**
 * `/ci/deploy` (Launch P2) — the external deployer protocol v1 (the kit's DEPLOYER.md) over HTTP,
 * with a stateful FakeCloud behind every vendor call, and the app page's deploy routes
 * (`/api/apps/:id/deploys…`) that decide production.
 *
 * What it pins: every status and status code in DEPLOYER.md; the 401/403 claim checks; a ticket is
 * bound to its run attempt and environment; the order check → version → credential (a refused
 * build — the S1/S5 cross-app attack — makes ZERO Neon calls); `finish` is idempotent and wakes the
 * launch run once; production waits for an owner or claims a pre-approval exactly once; the
 * migrator URI appears in the upload response and nowhere else.
 */

import {
  deployTicketListResponseSchema,
  deployTicketSchema,
  productionDeployResponseSchema,
} from '@launch/shared/launch-pipeline'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decide as decideApproval, retryApply } from '@/api/services/approvals/engine'
import {
  appEnvironments,
  appOwners,
  approvalRequests,
  auditEvents,
  deployTickets,
} from '@/db/schema'
import { actorOf, approvalDeps, viewerOf } from '../helpers/approvals'
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
  uploadBody,
} from '../helpers/deploy-gateway'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { mintActionsToken } from '../helpers/github-oidc'
import { forgetApps } from '../helpers/launch-apps'
import { request } from '../helpers/request'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

/** The platform credentials, in memory (`fillDeployCredentials`): no global table is written. */
const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
// The test Launch is at http://localhost:3001, which the public-URL gate refuses by design; the
// gate has its own suite (`public-url.test.ts`), so here it is waved through.
vi.mock('@/api/services/launch/public-url', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/services/launch/public-url')>()),
  requirePublicUrl: async () => undefined,
}))

vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()
const cloud: FakeCloud = createFakeCloud()
let restore: () => void
let env: TestEnv
const tenantIds: string[] = []

beforeAll(() => {
  restore = cloud.install()
})
afterAll(async () => {
  restore()
  await forgetApps(db, tenantIds)
})
beforeEach(async () => {
  env = createTestEnv()
  fillDeployCredentials(store, cloud)
})

async function tenant(role: 'owner' | 'admin' | 'member' = 'admin') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  tenantIds.push(tenant.id)
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return { tenantId: tenant.id, userId: user.id, email: user.email, cookie }
}

async function personIn(tenantId: string, role: 'owner' | 'admin' | 'member') {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return {
    userId: user.id,
    email: user.email,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)),
  }
}

/** Decide an approval as `person`, straight through the engine (the inbox's route is 4b's). */
async function decideAs(
  person: { userId: string; email: string },
  tenantId: string,
  requestId: string,
  decision: 'approve' | 'reject' = 'approve'
) {
  const viewer = await viewerOf(db, tenantId, { id: person.userId, email: person.email })
  return decideApproval(approvalDeps(db, env), {
    requestId,
    viewer,
    decision,
    actor: actorOf({ id: person.userId, email: person.email }),
  })
}

/** A job of `seeded`'s repo calling `/ci/deploy…` as one run. */
function job(seeded: DeployableApp, environment: 'staging' | 'production', runId?: string) {
  const run = runId ?? String(7_000_000 + Math.floor(Math.random() * 1_000_000))
  const claims = deployClaims(seeded, environment, { runId: run })
  const call = async (method: string, path: string, body?: unknown, over = {}) => {
    const token = await mintActionsToken({ ...claims, ...over })
    return request(
      `/ci/deploy${path}`,
      { method, headers: { Authorization: `Bearer ${token}` } },
      { env, ...(body === undefined ? {} : { json: body }) }
    )
  }
  return { runId: run, claims, call }
}

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function ticketRow(id: string) {
  const [row] = await db.select().from(deployTickets).where(eq(deployTickets.id, id))
  if (!row) throw new Error(`no ticket ${id}`)
  return row
}

async function auditRows(tenantId: string) {
  return db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId))
}

const neonCalls = () => cloud.callsTo('neon').length

describe('authentication (DEPLOYER.md: 401 for a bad token, 403 for one not accepted)', () => {
  it('401 without a token, with a forged one, and for another audience', async () => {
    const t = await tenant()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId)
    const claims = deployClaims(seeded, 'staging')
    const start = (headers: Record<string, string>) =>
      request('/ci/deploy/start', { method: 'POST', headers }, { env, json: { protocol: 1 } })

    const none = await start({})
    expect(none.status).toBe(401)
    expect(await body(none)).toMatchObject({ statusCode: 401, code: 'github_oidc_missing' })
    const forged = await mintActionsToken(claims, { forged: true })
    expect((await start({ Authorization: `Bearer ${forged}` })).status).toBe(401)
    const other = await mintActionsToken(claims, { audience: 'https://someone-else.example' })
    expect((await start({ Authorization: `Bearer ${other}` })).status).toBe(401)
    // Checked before the body: a bad body without a token is still a 401.
    expect(
      (await request('/ci/deploy/start', { method: 'POST' }, { env, json: { nope: 1 } })).status
    ).toBe(401)
  })

  it('403 for an unknown repo, another workflow, another branch, or no environment', async () => {
    const t = await tenant()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId)
    const { call } = job(seeded, 'staging')
    const cases: Array<[string, Record<string, unknown>]> = [
      ['unknown repository id', { repository_id: '999999999' }],
      ['renamed repository', { repository: 'acme/not-this' }],
      [
        'another workflow',
        { job_workflow_ref: `${seeded.repository}/.github/workflows/ci.yml@refs/heads/main` },
      ],
      ['a feature branch', { ref: 'refs/heads/feature' }],
      ['no environment', { environment: undefined }],
      ['an unknown environment', { environment: 'preview' }],
    ]
    for (const [label, over] of cases) {
      const res = await call('POST', '/start', { protocol: 1 }, over)
      expect(res.status, label).toBe(403)
      expect(await body(res), label).toMatchObject({ code: 'ci_caller_refused' })
    }
    // A tag is a deployable ref.
    const tag = await call('POST', '/start', { protocol: 1 }, { ref: 'refs/tags/1.0.0' })
    expect(tag.status).toBe(200)
  })
})

describe('start', () => {
  it('400 { error, supported: [1] } for another protocol version', async () => {
    const t = await tenant()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId)
    const res = await job(seeded, 'staging').call('POST', '/start', { protocol: 2 })
    expect(res.status).toBe(400)
    const json = await body(res)
    expect(json).toMatchObject({ supported: [1], statusCode: 400 })
    expect(json.error).toMatch(/protocol 2/)
  })

  it('staging is approved by policy; a retried start returns the same ticket', async () => {
    const t = await tenant()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId)
    const { call, runId } = job(seeded, 'staging')
    const first = await call('POST', '/start', { protocol: 1 })
    expect(first.status).toBe(200)
    const opened = await body<{ id: string; status: string }>(first)
    expect(opened).toMatchObject({ status: 'approved', environment: 'staging' })
    const again = await body<{ id: string }>(await call('POST', '/start', { protocol: 1 }))
    expect(again.id).toBe(opened.id)

    const row = await ticketRow(opened.id)
    expect(row).toMatchObject({
      tenantId: t.tenantId,
      appId: seeded.app.id,
      environmentId: seeded.staging.id,
      purpose: 'deploy',
      decisionSource: 'auto',
      runId,
      runAttempt: 1,
      repositoryId: seeded.repositoryId,
      repository: seeded.repository,
      jobWorkflowRef: `${seeded.repository}/.github/workflows/deploy.yml@refs/heads/main`,
    })
    const started = (await auditRows(t.tenantId)).filter(a => a.action === 'deploy.started')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      actorType: 'app',
      targetId: opened.id,
      appId: seeded.app.id,
    })
  })

  it('a re-run attempt opens its own ticket', async () => {
    const t = await tenant()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId)
    const { call } = job(seeded, 'staging')
    const a = await body<{ id: string }>(await call('POST', '/start', { protocol: 1 }))
    const b = await body<{ id: string }>(
      await call('POST', '/start', { protocol: 1 }, { run_attempt: '2' })
    )
    expect(b.id).not.toBe(a.id)
    // …and attempt 2 cannot drive attempt 1's ticket.
    expect((await call('GET', `/${a.id}`, undefined, { run_attempt: '2' })).status).toBe(403)
  })
})

describe('a ticket belongs to its run', () => {
  it('another run is 403, another app’s ticket or a junk id is 404', async () => {
    const t = await tenant()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId)
    const other = await seedDeployableApp(db, cloud, t.tenantId)
    const mine = job(seeded, 'staging')
    const { id } = await body<{ id: string }>(await mine.call('POST', '/start', { protocol: 1 }))

    expect((await mine.call('GET', `/${id}`)).status).toBe(200)
    const thief = job(seeded, 'staging')
    for (const path of [`/${id}`, `/${id}/activate`, `/${id}/finish`]) {
      const res = await thief.call(path === `/${id}` ? 'GET' : 'POST', path)
      expect(res.status, path).toBe(403)
      expect(await body(res)).toMatchObject({ code: 'deploy_ticket_other_run' })
    }
    // Same run id, other environment.
    expect(
      (await mine.call('GET', `/${id}`, undefined, { environment: 'production' })).status
    ).toBe(403)
    const stranger = job(other, 'staging', mine.runId)
    expect((await stranger.call('GET', `/${id}`)).status).toBe(404)
    expect((await mine.call('GET', '/not-a-uuid')).status).toBe(404)
  })
})

describe('upload → activate → finish (staging)', () => {
  it('walks every status, keeps secrets, and never stores or logs the migrator URL', async () => {
    const t = await tenant()
    const launchRunId = crypto.randomUUID()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId, {
      status: 'provisioning',
      launchRunId,
    })
    stubs(env).launchWorkflow?.setStatus(launchRunId, { status: 'waiting' })
    const { call } = job(seeded, 'staging')
    const { id } = await body<{ id: string }>(await call('POST', '/start', { protocol: 1 }))
    expect((await ticketRow(id)).launchRunId).toBe(launchRunId)

    // Activate before upload: 409.
    const early = await call('POST', `/${id}/activate`)
    expect(early.status).toBe(409)
    expect(await body(early)).toMatchObject({ code: 'deploy_ticket_state' })

    const resetsBefore = cloud.neon.resetCount(seeded.projectId, 'migrator')
    const upload = await call(
      'POST',
      `/${id}/upload`,
      uploadBody(appToml(seeded, 'staging'), '1.4.0')
    )
    expect(upload.status).toBe(200)
    const uploaded = await body<{
      id: string
      status: string
      versionId: string
      migratorUrl: string
    }>(upload)
    expect(uploaded).toMatchObject({ id, status: 'uploaded' })
    const migrator = new URL(uploaded.migratorUrl)
    expect(migrator.protocol).toBe('postgresql:')
    expect(migrator.username).toBe('migrator')
    expect(migrator.pathname).toBe('/app')
    expect(migrator.hostname).not.toContain('-pooler')
    // The reset ran on the STAGING branch, not main.
    const project = cloud.neon.projects.get(seeded.projectId)
    expect(project?.branches.get(seeded.stagingBranchId)?.roles.get('migrator')?.resets).toBe(1)
    expect(project?.branches.get(seeded.mainBranchId)?.roles.get('migrator')?.resets).toBe(0)
    expect(cloud.neon.resetCount(seeded.projectId, 'migrator')).toBe(resetsBefore + 1)
    expect(migrator.password).toBe(
      project?.branches.get(seeded.stagingBranchId)?.roles.get('migrator')?.password
    )

    // An UNDEPLOYED version: checked bindings, RELEASE_VERSION, secrets kept, assets bound.
    const script = cloud.cloudflare.scripts.get(seeded.staging.workerName ?? '')
    const version = script?.versions.find(v => v.id === uploaded.versionId)
    expect(script?.activeVersionId).toBeNull()
    expect(version?.metadata).toMatchObject({
      main_module: 'worker.js',
      compatibility_date: '2026-06-01',
      compatibility_flags: ['nodejs_compat'],
      keep_bindings: ['secret_text'],
    })
    expect((version?.metadata.assets as { jwt: string } | undefined)?.jwt).toMatch(/^completion-/)
    expect(version?.bindings).toEqual(
      expect.arrayContaining([
        { type: 'plain_text', name: 'RELEASE_VERSION', text: '1.4.0' },
        { type: 'plain_text', name: 'APP_ENV', text: 'staging' },
        {
          type: 'kv_namespace',
          name: 'RATE_LIMIT_KV',
          namespace_id: seeded.staging.resources.kv?.[0]?.id,
        },
        { type: 'secret_text', name: 'DATABASE_URL' },
        { type: 'assets', name: 'ASSETS' },
      ])
    )
    expect(Object.keys(version?.modules ?? {})).toEqual(['worker.js'])
    expect(cloud.cloudflare.assetBlobs.size).toBeGreaterThan(0)

    // A second upload: 409.
    expect(
      (await call('POST', `/${id}/upload`, uploadBody(appToml(seeded, 'staging')))).status
    ).toBe(409)
    expect((await body(await call('GET', `/${id}`))).status).toBe('uploaded')

    // Activate: live at 100%, crons and workflows set, migrator revoked.
    const activate = await call('POST', `/${id}/activate`)
    expect(activate.status).toBe(200)
    expect(await body(activate)).toMatchObject({ id, status: 'active' })
    expect(cloud.cloudflare.activeVersion(seeded.staging.workerName ?? '')?.id).toBe(
      uploaded.versionId
    )
    expect(script?.schedules).toEqual(['0 4 * * *'])
    expect(cloud.cloudflare.workflows.get(`${seeded.app.slug}-agent-run-staging`)).toMatchObject({
      script_name: seeded.staging.workerName,
      class_name: 'AgentRunWorkflow',
    })
    expect(cloud.neon.resetCount(seeded.projectId, 'migrator')).toBe(resetsBefore + 2)
    expect(project?.branches.get(seeded.stagingBranchId)?.roles.get('migrator')?.password).not.toBe(
      migrator.password
    )
    expect((await call('POST', `/${id}/activate`)).status).toBe(409)

    // Finish: once, however many times it is called; the launch run is woken once.
    const finish = await call('POST', `/${id}/finish`)
    expect(finish.status).toBe(200)
    expect(await body(finish)).toMatchObject({ id, status: 'finished' })
    const again = await call('POST', `/${id}/finish`)
    expect(again.status).toBe(200)
    expect(await body(again)).toMatchObject({ id, status: 'finished' })
    expect(cloud.neon.resetCount(seeded.projectId, 'migrator')).toBe(resetsBefore + 2)
    expect(stubs(env).launchWorkflow?.events).toEqual([
      { instanceId: launchRunId, type: 'deploy_finished', payload: { ticketId: id } },
    ])

    const row = await ticketRow(id)
    expect(row).toMatchObject({
      status: 'finished',
      version: '1.4.0',
      cfVersionId: uploaded.versionId,
    })
    expect(row.credentialsIssuedAt).toBeInstanceOf(Date)
    expect(row.credentialsRevokedAt).toBeInstanceOf(Date)
    expect(row.finishedAt).toBeInstanceOf(Date)
    // `activate` — and only activate — records that the version went live.
    expect(row.activatedAt).toBeInstanceOf(Date)
    expect(row.error).toBeNull()

    const audits = await auditRows(t.tenantId)
    expect(audits.map(a => a.action)).toEqual(
      expect.arrayContaining([
        'deploy.started',
        'deploy.uploaded',
        'deploy.activated',
        'deploy.finished',
      ])
    )
    // The credential is nowhere but the response it was returned in.
    const secretish = [uploaded.migratorUrl, migrator.password]
    const stored = JSON.stringify({ row, audits })
    for (const s of secretish) expect(stored).not.toContain(s)

    const [envRow] = await db
      .select()
      .from(appEnvironments)
      .where(eq(appEnvironments.id, seeded.staging.id))
    expect(envRow).toMatchObject({ lastDeployVersion: '1.4.0', lastDeployBy: 'github:octocat' })
  })

  it('finish before activate revokes the credential and never deploys the version', async () => {
    const t = await tenant()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId)
    const { call } = job(seeded, 'staging')
    const { id } = await body<{ id: string }>(await call('POST', '/start', { protocol: 1 }))
    const resets = cloud.neon.resetCount(seeded.projectId, 'migrator')
    expect(
      (await call('POST', `/${id}/upload`, uploadBody(appToml(seeded, 'staging')))).status
    ).toBe(200)
    const finish = await call('POST', `/${id}/finish`)
    // The job's log says why: closed, not deployed.
    expect(await body(finish)).toMatchObject({
      status: 'finished',
      error: 'finished before activate',
    })
    expect(cloud.neon.resetCount(seeded.projectId, 'migrator')).toBe(resets + 2)
    expect(cloud.cloudflare.activeVersion(seeded.staging.workerName ?? '')).toBeNull()
    expect((await call('POST', `/${id}/activate`)).status).toBe(409)
    const row = await ticketRow(id)
    expect(row).toMatchObject({ status: 'finished', activatedAt: null })
    expect(row.cfVersionId).toBeTruthy()
    expect(row.credentialsRevokedAt).toBeInstanceOf(Date)
    const finished = (await auditRows(t.tenantId)).find(a => a.action === 'deploy.finished')
    expect(finished?.summary.after).toMatchObject({
      activated: false,
      error: 'finished before activate',
    })
    // No launch run was waiting: no event.
    expect(stubs(env).launchWorkflow?.events).toEqual([])
  })

  it('a failed activation fails the ticket, revokes, and leaves the old version serving', async () => {
    const t = await tenant()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId)
    const { call } = job(seeded, 'staging')
    const { id } = await body<{ id: string }>(await call('POST', '/start', { protocol: 1 }))
    await call('POST', `/${id}/upload`, uploadBody(appToml(seeded, 'staging')))
    cloud.failNext('/deployments', 500)
    const res = await call('POST', `/${id}/activate`)
    expect(res.status).toBe(502)
    expect(await body(res)).toMatchObject({ code: 'deploy_activate_failed' })
    const row = await ticketRow(id)
    expect(row.status).toBe('failed')
    expect(row.credentialsRevokedAt).toBeInstanceOf(Date)
    expect(await body(await call('POST', `/${id}/finish`))).toMatchObject({ status: 'failed' })
  })
})

describe('the S1/S5 attack: a build binding another app’s resources', () => {
  it('is refused 403 with every binding named, the ticket fails, and Neon is never called', async () => {
    const t = await tenant()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId)
    const victim = await seedDeployableApp(db, cloud, (await tenant()).tenantId)
    const v = victim.staging.resources
    const evil = appToml(
      seeded,
      'staging',
      `
[[kv_namespaces]]
binding = "VICTIM_KV"
id = "${v.kv?.[0]?.id}"

[[r2_buckets]]
binding = "VICTIM_FILES"
bucket_name = "${v.r2?.[0]?.bucketName}"

[[queues.producers]]
binding = "VICTIM_JOBS"
queue = "${v.queues?.[0]?.queue}"

[[workflows]]
name = "${v.workflows?.[0]?.name}"
binding = "VICTIM_RUN"
class_name = "AgentRunWorkflow"
`
    )
    const { call } = job(seeded, 'staging')
    const { id } = await body<{ id: string }>(await call('POST', '/start', { protocol: 1 }))
    const neonBefore = neonCalls()
    const cfBefore = cloud.callsTo('cloudflare').length

    const res = await call('POST', `/${id}/upload`, uploadBody(evil))
    expect(res.status).toBe(403)
    const json = await body<{ error: string; refused: string[] }>(res)
    expect(json.error).toBe('bindings not registered for this app')
    expect(json.refused).toEqual([
      `kv_namespaces VICTIM_KV=${v.kv?.[0]?.id}`,
      `queues VICTIM_JOBS=${v.queues?.[0]?.queue}`,
      `r2_buckets VICTIM_FILES=${v.r2?.[0]?.bucketName}`,
      `workflows VICTIM_RUN=${v.workflows?.[0]?.name}`,
    ])
    // No credential, no migration, no upload — nothing left Launch.
    expect(neonCalls()).toBe(neonBefore)
    expect(cloud.callsTo('cloudflare').length).toBe(cfBefore)

    const row = await ticketRow(id)
    expect(row).toMatchObject({ status: 'failed', refused: json.refused })
    expect(row.credentialsIssuedAt).toBeNull()
    expect((await auditRows(t.tenantId)).some(a => a.action === 'deploy.refused')).toBe(true)
    // A refused build cannot be retried on the same ticket, and finish still answers.
    expect(
      (await call('POST', `/${id}/upload`, uploadBody(appToml(seeded, 'staging')))).status
    ).toBe(409)
    expect(await body(await call('POST', `/${id}/finish`))).toMatchObject({ status: 'failed' })
    expect(neonCalls()).toBe(neonBefore)
  })

  it('refuses a build named for another Worker, and spike S5’s evil toml', async () => {
    const t = await tenant()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId)
    const { call } = job(seeded, 'staging')
    const { id } = await body<{ id: string }>(await call('POST', '/start', { protocol: 1 }))
    const neonBefore = neonCalls()
    const renamed = appToml(seeded, 'staging').replace(
      `name = "${seeded.staging.workerName}"`,
      `name = "${seeded.production.workerName}"`
    )
    const res = await call('POST', `/${id}/upload`, uploadBody(renamed))
    expect(res.status).toBe(403)
    expect((await body<{ refused: string[] }>(res)).refused).toEqual([
      `name ${seeded.production.workerName}`,
    ])
    expect(neonCalls()).toBe(neonBefore)
  })
})

describe('production', () => {
  async function productionApp() {
    const admin = await tenant('admin')
    const seeded = await seedDeployableApp(db, cloud, admin.tenantId)
    return { admin, seeded }
  }

  it('pending → an owner approves on the app page → upload', async () => {
    const { admin, seeded } = await productionApp()
    const owner = await personIn(admin.tenantId, 'member')
    await db
      .insert(appOwners)
      .values({ tenantId: admin.tenantId, appId: seeded.app.id, userId: owner.userId })
    const bystander = await personIn(admin.tenantId, 'member')
    const { call } = job(seeded, 'production')

    const start = await body<{ id: string; status: string; expiresAt: string }>(
      await call('POST', '/start', { protocol: 1 })
    )
    expect(start.status).toBe('pending')
    expect(Date.parse(start.expiresAt)).toBeGreaterThan(Date.now())
    expect((await body(await call('GET', `/${start.id}`))).status).toBe('pending')
    // Nothing may be uploaded while pending.
    expect(
      (await call('POST', `/${start.id}/upload`, uploadBody(appToml(seeded, 'production')))).status
    ).toBe(409)

    const decide = (cookie: Record<string, string>, decision: 'approve' | 'reject') =>
      request(
        `/api/apps/${seeded.app.id}/deploys/${start.id}/decide`,
        { method: 'POST', headers: cookie },
        { env, json: { decision } }
      )
    // A member with no part in the approval: the engine's answer, the same 404 as a missing one.
    expect((await decide(bystander.cookie, 'approve')).status).toBe(404)
    const approved = await decide(owner.cookie, 'approve')
    expect(approved.status).toBe(200)
    const decided = deployTicketSchema.parse(await approved.json())
    expect(decided).toMatchObject({
      id: start.id,
      status: 'approved',
      decisionSource: 'approval',
      decidedByUserId: owner.userId,
    })
    // P4: the ticket carries the `deploy.production` approval the run opened.
    expect(decided.approvalId).toEqual(expect.any(String))
    // A second decider is too late: the approval is no longer pending (409, shared envelope).
    const late = await decide(admin.cookie, 'reject')
    expect(late.status).toBe(409)
    expect(await body(late)).toMatchObject({ statusCode: 409, code: 'not_pending' })

    expect((await body(await call('GET', `/${start.id}`))).status).toBe('approved')
    const upload = await call(
      'POST',
      `/${start.id}/upload`,
      uploadBody(appToml(seeded, 'production'))
    )
    expect(upload.status).toBe(200)
    // Production migrates on `main`.
    const project = cloud.neon.projects.get(seeded.projectId)
    expect(project?.branches.get(seeded.mainBranchId)?.roles.get('migrator')?.resets).toBe(1)
    expect(project?.branches.get(seeded.stagingBranchId)?.roles.get('migrator')?.resets).toBe(0)
    expect(await body(await call('POST', `/${start.id}/activate`))).toMatchObject({
      status: 'active',
    })

    const actions = (await auditRows(admin.tenantId)).map(a => a.action)
    expect(actions).toEqual(
      expect.arrayContaining(['deploy.started', 'deploy.production.approved', 'deploy.activated'])
    )
  })

  it('a rejection ends the wait; an expired pending ticket reads as rejected', async () => {
    const { admin, seeded } = await productionApp()
    const a = job(seeded, 'production')
    const first = await body<{ id: string }>(await a.call('POST', '/start', { protocol: 1 }))
    const rejected = await request(
      `/api/apps/${seeded.app.id}/deploys/${first.id}/decide`,
      { method: 'POST', headers: admin.cookie },
      { env, json: { decision: 'reject', reason: 'not today' } }
    )
    expect(await body(rejected)).toMatchObject({ status: 'rejected', error: 'not today' })
    expect((await body(await a.call('GET', `/${first.id}`))).status).toBe('rejected')
    expect(await body(await a.call('POST', `/${first.id}/finish`))).toMatchObject({
      status: 'rejected',
    })

    const b = job(seeded, 'production')
    const second = await body<{ id: string }>(await b.call('POST', '/start', { protocol: 1 }))
    await db
      .update(deployTickets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deployTickets.id, second.id))
    const late = await request(
      `/api/apps/${seeded.app.id}/deploys/${second.id}/decide`,
      { method: 'POST', headers: admin.cookie },
      { env, json: { decision: 'approve' } }
    )
    expect(late.status).toBe(409)
    expect(await body(late)).toMatchObject({ code: 'deploy_run_gone' })
    expect((await body(await b.call('GET', `/${second.id}`))).status).toBe('rejected')
  })

  it('"Deploy to production" asks a second person, then dispatches deploy.yml, claimed exactly once', async () => {
    const { admin, seeded } = await productionApp()
    const other = await personIn(admin.tenantId, 'admin')
    const dispatched: Array<{ workflow: string; inputs: Record<string, string>; ref: string }> = []
    cloud.github.onDispatch = run => {
      dispatched.push({ workflow: run.workflow, inputs: run.inputs, ref: run.ref })
    }
    try {
      const res = await request(
        `/api/apps/${seeded.app.id}/deploys/production`,
        { method: 'POST', headers: admin.cookie },
        { env }
      )
      expect(res.status).toBe(202)
      const asked = productionDeployResponseSchema.parse(await res.json())
      // P4: nothing is pre-approved and nothing dispatched until somebody else approves.
      expect(asked.ticket).toBeNull()
      expect(dispatched).toEqual([])
      const approvalId = asked.approvalId as string
      // Asking twice joins the open request.
      const again = await request(
        `/api/apps/${seeded.app.id}/deploys/production`,
        { method: 'POST', headers: admin.cookie },
        { env }
      )
      expect(productionDeployResponseSchema.parse(await again.json()).approvalId).toBe(approvalId)

      // The clicker may not approve their own deploy.
      await expect(decideAs(admin, admin.tenantId, approvalId)).rejects.toMatchObject({
        statusCode: 403,
        code: 'self_approval',
      })
      await decideAs(other, admin.tenantId, approvalId)
      expect(dispatched).toEqual([
        { workflow: 'deploy.yml', inputs: { environment: 'production' }, ref: 'main' },
      ])
      const [intent] = await db
        .select()
        .from(deployTickets)
        .where(eq(deployTickets.approvalId, approvalId))
      if (!intent) throw new Error('expected the pre-approval')
      expect(intent).toMatchObject({
        status: 'approved',
        decisionSource: 'approval',
        decidedByUserId: other.userId,
        ref: 'refs/heads/main',
        runId: null,
      })
      // One pre-approval at a time.
      const twice = await request(
        `/api/apps/${seeded.app.id}/deploys/production`,
        { method: 'POST', headers: admin.cookie },
        { env }
      )
      expect(twice.status).toBe(409)
      expect(await body(twice)).toMatchObject({ code: 'production_deploy_pending' })

      // A run on another ref cannot spend it…
      const tagged = job(seeded, 'production')
      const onTag = await body<{ id: string; status: string }>(
        await tagged.call('POST', '/start', { protocol: 1 }, { ref: 'refs/tags/9.9.9' })
      )
      expect(onTag.id).not.toBe(intent.id)
      expect(onTag.status).toBe('pending')
      // …the dispatched run (on main) claims it…
      const run = job(seeded, 'production')
      const claimed = await body<{ id: string; status: string }>(
        await run.call('POST', '/start', { protocol: 1 })
      )
      expect(claimed).toEqual(expect.objectContaining({ id: intent.id, status: 'approved' }))
      expect(await ticketRow(intent.id)).toMatchObject({ runId: run.runId })
      // …a retried start of that run gets it back, and another run does not.
      expect((await body(await run.call('POST', '/start', { protocol: 1 }))).id).toBe(intent.id)
      const second = await body<{ id: string; status: string }>(
        await job(seeded, 'production').call('POST', '/start', { protocol: 1 })
      )
      expect(second.id).not.toBe(intent.id)
      expect(second.status).toBe('pending')
      expect(
        (await run.call('POST', `/${intent.id}/upload`, uploadBody(appToml(seeded, 'production'))))
          .status
      ).toBe(200)
    } finally {
      cloud.github.onDispatch = null
    }
  })

  it('a failed dispatch is owed and retried; a member may not deploy', async () => {
    const { admin, seeded } = await productionApp()
    const other = await personIn(admin.tenantId, 'admin')
    const member = await personIn(admin.tenantId, 'member')
    expect(
      (
        await request(
          `/api/apps/${seeded.app.id}/deploys/production`,
          { method: 'POST', headers: member.cookie },
          { env }
        )
      ).status
    ).toBe(403)
    const res = await request(
      `/api/apps/${seeded.app.id}/deploys/production`,
      { method: 'POST', headers: admin.cookie },
      { env }
    )
    const { approvalId } = productionDeployResponseSchema.parse(await res.json())
    cloud.failNext('/dispatches', 500)
    await decideAs(other, admin.tenantId, approvalId as string)
    const [owed] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId as string))
    expect(owed).toMatchObject({ status: 'approved', appliedAt: null })
    expect(owed?.applyError).toMatch(/GitHub|500/)
    // The sweep's retry (after its backoff) dispatches: the pre-approval is still live and
    // unclaimed. A second retry is a no-op — the dispatch is recorded.
    const later = approvalDeps(db, env, () => new Date(Date.now() + 5 * 60_000))
    const dispatchesBefore = cloud.github.runs.length
    const retry = { tenantId: admin.tenantId, requestId: approvalId as string }
    expect(await retryApply(later, retry)).toBe('applied')
    expect(cloud.github.runs.length).toBe(dispatchesBefore + 1)
    expect(await retryApply(later, retry)).toBe('not_owed')
    expect(cloud.github.runs.length).toBe(dispatchesBefore + 1)
  })
})

describe('GET /api/apps/:id/deploys', () => {
  it('lists the app’s tickets for members, newest first, and is tenant-isolated', async () => {
    const admin = await tenant('admin')
    const seeded = await seedDeployableApp(db, cloud, admin.tenantId)
    const a = job(seeded, 'staging')
    await a.call('POST', '/start', { protocol: 1 })
    const b = job(seeded, 'production')
    await b.call('POST', '/start', { protocol: 1 })
    const member = await personIn(admin.tenantId, 'member')

    const res = await request(
      `/api/apps/${seeded.app.id}/deploys`,
      { headers: member.cookie },
      { env }
    )
    expect(res.status).toBe(200)
    const list = deployTicketListResponseSchema.parse(await res.json())
    expect(list.items.map(i => [i.environment, i.status])).toEqual([
      ['production', 'pending'],
      ['staging', 'approved'],
    ])
    expect(JSON.stringify(list)).not.toMatch(/postgres(ql)?:\/\//)

    const outsider = await tenant('owner')
    const foreign = await request(
      `/api/apps/${seeded.app.id}/deploys`,
      { headers: outsider.cookie },
      { env }
    )
    expect(foreign.status).toBe(404)
    expect(await body(foreign)).toMatchObject({ statusCode: 404, code: 'app_not_found' })
    const ticketId = list.items[0]?.id
    expect(
      (
        await request(
          `/api/apps/${seeded.app.id}/deploys/${ticketId}/decide`,
          { method: 'POST', headers: outsider.cookie },
          { env, json: { decision: 'approve' } }
        )
      ).status
    ).toBe(404)
    expect((await request(`/api/apps/${seeded.app.id}/deploys`, {}, { env })).status).toBe(401)
  })
})

describe('configuration', () => {
  it('upload answers 503 when Launch has no Cloudflare credential, before touching Neon', async () => {
    const t = await tenant()
    const seeded = await seedDeployableApp(db, cloud, t.tenantId)
    const { call } = job(seeded, 'staging')
    const { id } = await body<{ id: string }>(await call('POST', '/start', { protocol: 1 }))
    store.credentials.delete('cloudflare_api_token')
    const neonBefore = neonCalls()
    const res = await call('POST', `/${id}/upload`, uploadBody(appToml(seeded, 'staging')))
    expect(res.status).toBe(503)
    expect(await body(res)).toMatchObject({ code: 'ci_deployer_not_configured' })
    expect(neonCalls()).toBe(neonBefore)
    expect((await ticketRow(id)).status).toBe('approved')
  })
})
