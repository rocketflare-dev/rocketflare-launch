// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the credential store and 5c's `startPush`.
/**
 * Launch P5 slice 5d — the deploy gateway and grants (plan §1.5, §1.6), over `/ci/deploy` with a
 * stateful FakeCloud behind every vendor call.
 *
 * What it pins:
 *
 * - **upload**: a toml `[vars]` entry a live grant of the app and environment supplies is DROPPED
 *   from the version upload and recorded as `shadowedVars` on the ticket and in `deploy.uploaded`
 *   — without the drop, FakeCloud's 10053 "Binding name already in use" (a var shadowing a kept
 *   secret) fails the upload, and the granted secret is what the running Worker reads. A grant in
 *   the OTHER environment, of another app, or no longer live shadows nothing;
 * - **activate**: a grant pushed after the upload began (a rotation landing between upload and
 *   activate) gets a `repair` push, because the version carries the secrets as of its upload and
 *   activating resurrects the old one; a grant pushed before the upload does not. A repair that
 *   cannot start leaves the deploy live and says so on the grant.
 *
 * 5c's `startPush` is a recorder here (the seam is 5a's stub signature).
 */

import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartPushInput } from '@/api/services/grants/types'
import { CloudflareClient } from '@/api/services/launch/cloudflare'
import { loadConfig } from '@/config'
import { appGrants, auditEvents, deployTickets } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  appToml,
  type DeployableApp,
  deployClaims,
  fillDeployCredentials,
  namesFor,
  seedDeployableApp,
  uploadBody,
} from '../helpers/deploy-gateway'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import { mintActionsToken } from '../helpers/github-oidc'
import { M365_VALUES, seedGrant, seedResourceValues, seedSharedResource } from '../helpers/grants'
import { forgetApps } from '../helpers/launch-apps'
import { createTestGroup } from '../helpers/oidc'
import { request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

/** The platform credentials, in memory (`fillDeployCredentials`): no global table is written. */
const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

/** 5c's `startPush`, recorded; `fail` makes the next call throw (a rotation's push running). */
const pushes = vi.hoisted(() => ({ calls: [] as unknown[], fail: null as Error | null }))
vi.mock('@/api/services/grants/push', async importOriginal => ({
  ...(await importOriginal<object>()),
  startPush: async (_deps: unknown, input: unknown) => {
    if (pushes.fail) {
      const err = pushes.fail
      pushes.fail = null
      throw err
    }
    pushes.calls.push(input)
    return { pushId: crypto.randomUUID(), created: true }
  },
}))

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
beforeEach(() => {
  env = createTestEnv()
  fillDeployCredentials(store, cloud)
  pushes.calls.length = 0
  pushes.fail = null
})

const pushCalls = () => pushes.calls as StartPushInput[]
const cf = () => new CloudflareClient('cf-test', { fetch: cloud.fetch })

/** A job of `seeded`'s repo calling `/ci/deploy…` as one run. */
function job(seeded: DeployableApp, environment: 'staging' | 'production') {
  const runId = String(8_000_000 + Math.floor(Math.random() * 1_000_000))
  const claims = deployClaims(seeded, environment, { runId })
  return async (method: string, path: string, body?: unknown) => {
    const token = await mintActionsToken(claims)
    return request(
      `/ci/deploy${path}`,
      { method, headers: { Authorization: `Bearer ${token}` } },
      { env, ...(body === undefined ? {} : { json: body }) }
    )
  }
}

/** The app's staging toml with the M365 connector's two vars in `[vars]` (a plugin install). */
function tomlWithM365(seeded: DeployableApp, env: 'staging' | 'production' = 'staging') {
  return appToml(seeded, env).replace(
    '[vars]\n',
    '[vars]\nM365_TENANT_ID = "from-the-toml"\nM365_CLIENT_ID = "from-the-toml"\n'
  )
}

/**
 * One app deployable through the FakeCloud, an M365 resource with values in both environments,
 * and (unless `grant: null`) a live staging grant whose secrets are already on the Worker — what
 * 5c's first push leaves.
 */
async function world(opts: { grant?: 'active' | 'revoked' | null; pushedAt?: Date } = {}) {
  const { tenant, user } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const seeded = await seedDeployableApp(db, cloud, tenant.id)
  const group = await createTestGroup(db, tenant.id, 'IT Identity', [user.id])
  const resource = await seedSharedResource(db, tenant.id, { ownerGroupId: group.id })
  const cfg = loadConfig(env)
  const versions = {
    staging: await seedResourceValues(db, cfg, resource, 'staging'),
    production: await seedResourceValues(db, cfg, resource, 'production'),
  }
  const worker = namesFor(seeded.app.slug, 'staging').worker
  let grant = null
  if (opts.grant !== null) {
    grant = await seedGrant(db, {
      tenantId: tenant.id,
      appId: seeded.app.id,
      resourceId: resource.id,
      environment: 'staging',
      status: opts.grant ?? 'active',
      pushedVersionId: versions.staging.id,
      pushedAt: opts.pushedAt ?? new Date(Date.now() - 60_000),
    })
    for (const [name, value] of Object.entries(M365_VALUES)) {
      await cf().putWorkerSecret(cloud.opts.accountId, worker, name, value)
    }
  }
  return { tenant, seeded, resource, versions, grant, worker }
}

/** start → upload through the gateway; returns the ticket id and the upload response. */
async function startAndUpload(
  call: ReturnType<typeof job>,
  toml: string,
  version = '1.0.0'
): Promise<{ id: string; upload: Response }> {
  const started = await call('POST', '/start', { protocol: 1 })
  expect(started.status).toBe(200)
  const { id } = (await started.json()) as { id: string }
  const upload = await call('POST', `/${id}/upload`, uploadBody(toml, version))
  return { id, upload }
}

async function ticketRow(id: string) {
  const [row] = await db.select().from(deployTickets).where(eq(deployTickets.id, id))
  if (!row) throw new Error(`no ticket ${id}`)
  return row
}

async function auditOf(tenantId: string, ticketId: string, action: string) {
  const [row] = await db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.targetId, ticketId),
        eq(auditEvents.action, action)
      )
    )
  return row
}

describe('upload drops the vars a live grant supplies (plan §1.5)', () => {
  it('records shadowedVars, uploads without them, and the Worker reads the granted secret', async () => {
    const { tenant, seeded, worker } = await world()
    const call = job(seeded, 'staging')
    const { id, upload } = await startAndUpload(call, tomlWithM365(seeded))
    expect(upload.status).toBe(200)

    const ticket = await ticketRow(id)
    expect(ticket.bindings).toMatchObject({
      shadowedVars: ['M365_TENANT_ID', 'M365_CLIENT_ID'],
      uploadedAt: expect.any(String),
    })
    const names = (ticket.bindings as { bindings: { name: string }[] }).bindings.map(b => b.name)
    expect(names).toContain('APP_ENV')
    expect(names).not.toContain('M365_TENANT_ID')
    const audit = await auditOf(tenant.id, id, 'deploy.uploaded')
    expect(audit?.summary).toMatchObject({
      after: { shadowedVars: ['M365_TENANT_ID', 'M365_CLIENT_ID'] },
    })

    // The version carries no plain var of those names; it keeps the secrets.
    const script = cloud.cloudflare.scripts.get(worker)
    const version = script?.versions.find(v => v.id === ticket.cfVersionId)
    const plain = version?.bindings.filter(b => b.type === 'plain_text').map(b => b.name)
    expect(plain).toEqual(expect.arrayContaining(['APP_ENV', 'RELEASE_VERSION']))
    expect(plain).not.toContain('M365_TENANT_ID')

    expect((await call('POST', `/${id}/activate`)).status).toBe(200)
    expect(cloud.cloudflare.envOf(worker)).toMatchObject({
      APP_ENV: 'staging',
      M365_TENANT_ID: M365_VALUES.M365_TENANT_ID,
      M365_CLIENT_ID: M365_VALUES.M365_CLIENT_ID,
      M365_CLIENT_SECRET: M365_VALUES.M365_CLIENT_SECRET,
    })
    // Nothing was pushed after the upload: no repair.
    expect(pushCalls()).toHaveLength(0)
  })

  it('without a live grant the var is kept — and meets the kept secret as 10053', async () => {
    const { seeded } = await world({ grant: 'revoked' })
    const { id, upload } = await startAndUpload(job(seeded, 'staging'), tomlWithM365(seeded))
    // The secrets the revoked grant left (5c removes them; here they linger) clash with the vars:
    // exactly what the drop prevents.
    expect(upload.status).toBe(502)
    expect(await upload.json()).toMatchObject({ code: 'deploy_upload_failed' })
    expect(JSON.stringify(await ticketRow(id))).toContain('already in use')
  })

  it('a grant in the other environment, or of another app, shadows nothing', async () => {
    const { tenant, seeded, resource, versions } = await world({ grant: null })
    await seedGrant(db, {
      tenantId: tenant.id,
      appId: seeded.app.id,
      resourceId: resource.id,
      environment: 'production',
      pushedVersionId: versions.production.id,
    })
    const other = await seedDeployableApp(db, cloud, tenant.id)
    await seedGrant(db, {
      tenantId: tenant.id,
      appId: other.app.id,
      resourceId: resource.id,
      environment: 'staging',
      pushedVersionId: versions.staging.id,
    })
    const { id, upload } = await startAndUpload(job(seeded, 'staging'), tomlWithM365(seeded))
    expect(upload.status).toBe(200)
    expect((await ticketRow(id)).bindings).toMatchObject({ shadowedVars: [] })
    const audit = await auditOf(tenant.id, id, 'deploy.uploaded')
    const after = (audit?.summary as { after?: Record<string, unknown> } | undefined)?.after
    expect(after).toBeDefined()
    expect(after?.shadowedVars).toBeUndefined()
  })

  it('a requested grant already shadows, so its first push never meets a plain var', async () => {
    const { tenant, seeded, resource } = await world({ grant: null })
    await seedGrant(db, {
      tenantId: tenant.id,
      appId: seeded.app.id,
      resourceId: resource.id,
      environment: 'staging',
      status: 'requested',
    })
    const { id, upload } = await startAndUpload(job(seeded, 'staging'), tomlWithM365(seeded))
    expect(upload.status).toBe(200)
    expect((await ticketRow(id)).bindings).toMatchObject({
      shadowedVars: ['M365_TENANT_ID', 'M365_CLIENT_ID'],
    })
  })
})

describe('activate re-pushes a grant pushed after the upload (plan §1.6)', () => {
  it('a rotation between upload and activate is resurrected by activating — and repaired', async () => {
    const { tenant, seeded, grant, versions, worker } = await world()
    if (!grant) throw new Error('no grant')
    // Deploy 1.0.0: live, holding the original secret.
    const first = job(seeded, 'staging')
    const one = await startAndUpload(first, tomlWithM365(seeded), '1.0.0')
    expect(one.upload.status).toBe(200)
    expect((await first('POST', `/${one.id}/activate`)).status).toBe(200)
    await first('POST', `/${one.id}/finish`)

    // Deploy 1.1.0 uploads (copying the secrets as they are now) …
    const second = job(seeded, 'staging')
    const two = await startAndUpload(second, tomlWithM365(seeded), '1.1.0')
    expect(two.upload.status).toBe(200)
    // … then a rotation lands: 5c's push writes the new secret and records the push.
    await cf().putWorkerSecret(cloud.opts.accountId, worker, 'M365_CLIENT_SECRET', 'rotated-v2')
    expect(cloud.cloudflare.envOf(worker)?.M365_CLIENT_SECRET).toBe('rotated-v2')
    await db
      .update(appGrants)
      .set({ pushedAt: new Date(Date.now() + 1000) })
      .where(eq(appGrants.id, grant.id))

    const activated = await second('POST', `/${two.id}/activate`)
    expect(activated.status).toBe(200)
    // Activating brought the old secret back (keep_bindings copied it at upload) …
    expect(cloud.cloudflare.envOf(worker)?.M365_CLIENT_SECRET).toBe(M365_VALUES.M365_CLIENT_SECRET)
    // … so the gateway started a repair push of the active version for that grant.
    expect(pushCalls()).toEqual([
      {
        tenantId: tenant.id,
        resourceId: grant.resourceId,
        environment: 'staging',
        reason: 'repair',
        grantId: grant.id,
        versionId: versions.staging.id,
      },
    ])
    const audit = await auditOf(tenant.id, two.id, 'deploy.activated')
    expect(audit?.summary).toMatchObject({
      after: { grantRepairs: [{ grantId: grant.id, pushId: expect.any(String) }] },
    })
  })

  it('a push that cannot start leaves the deploy live and the grant saying so', async () => {
    const { seeded, grant } = await world()
    if (!grant) throw new Error('no grant')
    const call = job(seeded, 'staging')
    const { id } = await startAndUpload(call, tomlWithM365(seeded))
    await db
      .update(appGrants)
      .set({ pushedAt: new Date(Date.now() + 1000) })
      .where(eq(appGrants.id, grant.id))
    pushes.fail = Object.assign(new Error('A push is already running'), { statusCode: 409 })
    const activated = await call('POST', `/${id}/activate`)
    expect(activated.status).toBe(200)
    expect(await activated.json()).toMatchObject({ status: 'active' })
    const [row] = await db.select().from(appGrants).where(eq(appGrants.id, grant.id))
    expect(row?.pushError).toMatch(/re-push this grant .*already running/)
  })
})
