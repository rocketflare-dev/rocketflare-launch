/**
 * `GRANT_PUSH` end to end under Node (Launch P5 slice 5c, plan §1.10–§1.13): the Workflow class
 * with a fake `step`, the real database, and the stateful FakeCloud behind a `WorkerSecretsBacking`
 * (its client gets `cloud.fetch`, so nothing reaches Cloudflare and no global fetch is replaced).
 *
 * - a rotation reaches every holder (`envOf` shows the new secret), retires the old version and
 *   tells the owners to revoke it at the vendor; twelve holders take two `push#N` steps;
 * - one app failing → `partial`, the old version stays `retiring`; Retry (`<pushId>-r1`) finishes
 *   it with no second `PUT` for the apps that already had it;
 * - a second push of the environment is 409 `push_in_progress`;
 * - the first push onto a Worker whose live version still binds the var as `plain_text` (Cloudflare's
 *   10053) replaces it with a copy of that version — the var gone, the secret in, the other
 *   bindings and secrets kept — and audits `grant.var_shadowed`;
 * - revoke removes the secrets; the sweep reminds, expires and flags a rotation;
 * - tenant isolation on the reads, and no secret in any step result, row, audit summary or
 *   notification.
 */
import { GRANT_NOTIFICATION_TYPES, type GrantPushParams } from '@launch/shared/launch-grants'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { open } from '@/api/services/approvals/engine'
import { LocalGrantBacking, WorkerSecretsBacking } from '@/api/services/grants/backing'
import { getPush, listPushes, retryPush, startPush } from '@/api/services/grants/push'
import { revokeGrant } from '@/api/services/grants/revoke'
import { rotationDueKeys, sweepGrants } from '@/api/services/grants/sweep'
import type { GrantBacking, GrantViewer } from '@/api/services/grants/types'
import { CloudflareClient } from '@/api/services/launch/cloudflare'
import { GrantPushWorkflow } from '@/api/workflows/grant-push'
import { loadConfig } from '@/config'
import {
  appGrants,
  auditEvents,
  grantPushes,
  grantPushTargets,
  notifications,
  type SharedResourceRow,
  type SharedResourceValueRow,
  sharedResourceValues,
} from '@/db/schema'
import { accessOpen, actorOf, approvalDeps, approvalsFixture, viewerOf } from '../helpers/approvals'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud, type FakeCloud } from '../helpers/fake-cloud'
import {
  grantDeps,
  M365_VALUES,
  seedGrant,
  seedResourceValues,
  seedSharedResource,
} from '../helpers/grants'
import { forgetApps, seedApp } from '../helpers/launch-apps'
import { addTestAppOwner, createTestGroup } from '../helpers/oidc'
import { json, request } from '../helpers/request'
import { createExecutionContext, createTestEnv, stubs, type TestEnv } from '../mocks/bindings'
import { createFakeWorkflowStep } from '../mocks/cloudflare-workers'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())
const tenantIds: string[] = []
const DAY_MS = 24 * 60 * 60 * 1000
const SECRET = M365_VALUES.M365_CLIENT_SECRET
const NEW_SECRET = 'sentinel-rotated-secret-never-echo'

afterAll(async () => {
  await forgetApps(db, tenantIds)
})

let cloud: FakeCloud
let env: TestEnv
beforeEach(() => {
  cloud = createFakeCloud()
  env = createTestEnv()
})

const client = () => new CloudflareClient('cf-token-xxxxxxxxxxxxxxxxxxxx', { fetch: cloud.fetch })
const cloudBacking = () =>
  new WorkerSecretsBacking({ client: client(), accountId: cloud.opts.accountId })

/**
 * A script with one DEPLOYED version, as the deploy gateway leaves it: a release var, a KV binding,
 * any extra vars, and optionally a secret the pipeline put (`DATABASE_URL`).
 */
async function liveScript(
  name: string,
  opts: { vars?: Record<string, string>; secret?: boolean } = {}
): Promise<void> {
  const cf = client()
  const account = cloud.opts.accountId
  await cf.putWorkerScript(account, name, { main_module: 'index.js' }, [
    { name: 'index.js', content: 'export default {}' },
  ])
  if (opts.secret) await cf.putWorkerSecret(account, name, 'DATABASE_URL', 'postgres://app')
  const version = await cf.createVersion(
    account,
    name,
    {
      main_module: 'worker.js',
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      bindings: [
        { type: 'plain_text', name: 'RELEASE_VERSION', text: '1.0.0' },
        { type: 'kv_namespace', name: 'RATE_LIMIT_KV', namespace_id: 'kv-1' },
        ...Object.entries(opts.vars ?? {}).map(([n, text]) => ({
          type: 'plain_text',
          name: n,
          text,
        })),
      ],
      keep_bindings: ['secret_text'],
    },
    [{ name: 'worker.js', content: new TextEncoder().encode('export default { fetch() {} }') }]
  )
  await cf.createDeployment(account, name, version.id, 'first deploy')
}

/** An organisation: alice and bob own `app`, carol is in "IT Identity" (owns M365), `n` holders. */
async function seedWorld(holders = 3) {
  const fixture = await approvalsFixture(db)
  tenantIds.push(fixture.tenant.id)
  const itIdentity = await createTestGroup(db, fixture.tenant.id, 'IT Identity', [fixture.carol.id])
  const resource = await seedSharedResource(db, fixture.tenant.id, { ownerGroupId: itIdentity.id })
  const v1 = await seedResourceValues(db, cfg, resource, 'staging')
  const apps = []
  for (let i = 0; i < holders; i++) {
    const { app, environments } = await seedApp(db, fixture.tenant.id)
    const script = environments.find(e => e.name === 'staging')?.workerName as string
    await liveScript(script)
    await addTestAppOwner(db, fixture.tenant.id, app.id, fixture.alice.id)
    apps.push({ app, script })
  }
  return { ...fixture, itIdentity, resource, v1, apps }
}

async function grantAll(
  world: Awaited<ReturnType<typeof seedWorld>>,
  pushedVersionId: string | null = null
) {
  const grants = []
  for (const { app } of world.apps) {
    grants.push(
      await seedGrant(db, {
        tenantId: world.tenant.id,
        appId: app.id,
        resourceId: world.resource.id,
        environment: 'staging',
        pushedVersionId,
      })
    )
  }
  return grants
}

/** What 5b's `setValues` leaves for a rotation: the old version `retiring`, the new one active. */
async function rotate(
  resource: SharedResourceRow,
  previous: SharedResourceValueRow,
  secret = NEW_SECRET
) {
  await db
    .update(sharedResourceValues)
    .set({ status: 'retiring' })
    .where(
      and(
        eq(sharedResourceValues.tenantId, resource.tenantId),
        eq(sharedResourceValues.id, previous.id)
      )
    )
  return seedResourceValues(
    db,
    cfg,
    resource,
    'staging',
    { ...M365_VALUES, M365_CLIENT_SECRET: secret },
    { version: previous.version + 1 }
  )
}

/** Every value a step returned, so "no secret in a step result" can be checked. */
const stepResults: unknown[] = []

/** Run the instance `startPush` / `retryPush` created last, through the real class. */
async function drive(backing: GrantBacking = cloudBacking(), instanceIndex = -1) {
  const created = stubs(env).grantPushWorkflow?.created ?? []
  const instance = created.at(instanceIndex)
  if (!instance) throw new Error('no GRANT_PUSH instance was created')
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
  workflow.overrides = { backing }
  const outcome = await workflow.run(
    {
      payload: instance.params as GrantPushParams,
      timestamp: new Date(),
      instanceId: instance.id,
      workflowName: 'launch-grant-push',
    },
    recording as unknown as Parameters<GrantPushWorkflow['run']>[1]
  )
  return { outcome, names: fake.names, instanceId: instance.id }
}

async function pushRow(tenantId: string, pushId: string) {
  const [row] = await db
    .select()
    .from(grantPushes)
    .where(and(eq(grantPushes.tenantId, tenantId), eq(grantPushes.id, pushId)))
  return row
}

async function versionRow(tenantId: string, id: string) {
  const [row] = await db
    .select()
    .from(sharedResourceValues)
    .where(and(eq(sharedResourceValues.tenantId, tenantId), eq(sharedResourceValues.id, id)))
  return row
}

async function auditOf(tenantId: string, action: string) {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action)))
}

async function notificationsOf(tenantId: string, type: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.tenantId, tenantId), eq(notifications.type, type)))
}

describe('a rotation', () => {
  it('reaches every holder, retires the old version and tells the owners to revoke it', async () => {
    const world = await seedWorld(3)
    await grantAll(world, world.v1.id)
    const v2 = await rotate(world.resource, world.v1)
    const deps = grantDeps(db, env)
    const { pushId, created } = await startPush(deps, {
      tenantId: world.tenant.id,
      resourceId: world.resource.id,
      environment: 'staging',
      reason: 'rotate',
      versionId: v2.id,
      startedByUserId: world.carol.id,
    })
    expect(created).toBe(true)
    expect(stubs(env).grantPushWorkflow?.created.at(-1)).toEqual({
      id: pushId,
      params: { tenantId: world.tenant.id, pushId },
    })

    const { outcome, names } = await drive()
    expect(outcome).toEqual({ pushId, status: 'succeeded' })
    expect(names).toEqual(['plan', 'push#0', 'finish'])
    for (const { script } of world.apps) {
      expect(cloud.cloudflare.envOf(script)).toMatchObject({
        RELEASE_VERSION: '1.0.0',
        M365_TENANT_ID: M365_VALUES.M365_TENANT_ID,
        M365_CLIENT_SECRET: NEW_SECRET,
      })
    }
    expect(await pushRow(world.tenant.id, pushId)).toMatchObject({
      status: 'succeeded',
      total: 3,
      succeeded: 3,
      failed: 0,
      instanceId: pushId,
    })
    expect((await versionRow(world.tenant.id, world.v1.id))?.status).toBe('retired')
    expect((await versionRow(world.tenant.id, v2.id))?.status).toBe('active')
    const grants = await db
      .select()
      .from(appGrants)
      .where(
        and(eq(appGrants.tenantId, world.tenant.id), eq(appGrants.resourceId, world.resource.id))
      )
    expect(grants.map(g => g.pushedVersionId)).toEqual([v2.id, v2.id, v2.id])
    expect(await auditOf(world.tenant.id, 'grant.pushed')).toHaveLength(3)
    expect(await auditOf(world.tenant.id, 'shared_resource.values.retired')).toHaveLength(1)
    const [finished] = await auditOf(world.tenant.id, 'grant.push.finished')
    expect(finished?.summary.after).toMatchObject({ status: 'succeeded', total: 3, succeeded: 3 })
    const told = await notificationsOf(world.tenant.id, GRANT_NOTIFICATION_TYPES.rotated)
    expect(told.map(n => n.userId)).toEqual([world.carol.id])
    expect(told[0]?.body).toMatch(/Revoke the old credential at the vendor/)

    // The owners read it back with every target; the version NUMBER rides along.
    const carol = await viewerOf(db, world.tenant.id, world.carol, [world.itIdentity.id])
    const detail = await getPush(db, carol, world.resource.id, pushId)
    expect(detail).toMatchObject({ reason: 'rotate', version: 2, status: 'succeeded' })
    expect(detail.targets.map(t => t.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(detail.targets[0]?.names).toEqual([
      'M365_TENANT_ID',
      'M365_CLIENT_ID',
      'M365_CLIENT_SECRET',
    ])
    expect((await listPushes(db, carol, world.resource.id, { limit: 20 })).items[0]?.id).toBe(
      pushId
    )
  })

  it('twelve holders take two push#N steps (ten targets a step)', async () => {
    const world = await seedWorld(0)
    for (let i = 0; i < 12; i++) {
      const { app } = await seedApp(db, world.tenant.id)
      await seedGrant(db, {
        tenantId: world.tenant.id,
        appId: app.id,
        resourceId: world.resource.id,
        environment: 'staging',
      })
    }
    const v2 = await rotate(world.resource, world.v1)
    await startPush(grantDeps(db, env), {
      tenantId: world.tenant.id,
      resourceId: world.resource.id,
      environment: 'staging',
      reason: 'rotate',
      versionId: v2.id,
    })
    const local = new LocalGrantBacking()
    const { outcome, names } = await drive(local)
    expect(outcome.status).toBe('succeeded')
    expect(names).toEqual(['plan', 'push#0', 'push#1', 'finish'])
    expect(local.writes).toHaveLength(12)
    expect(JSON.stringify(local.writes)).not.toContain(NEW_SECRET)
  })

  it('one app failing is partial, keeps the old version retiring; Retry finishes with no second PUT', async () => {
    const world = await seedWorld(3)
    await grantAll(world, world.v1.id)
    const v2 = await rotate(world.resource, world.v1)
    const deps = grantDeps(db, env)
    const { pushId } = await startPush(deps, {
      tenantId: world.tenant.id,
      resourceId: world.resource.id,
      environment: 'staging',
      reason: 'rotate',
      versionId: v2.id,
      startedByUserId: world.carol.id,
    })
    const broken = world.apps[1]?.script as string
    // Cloudflare's error echoes the value it refused — the target must store it scrubbed.
    cloud.failNext(`/workers/scripts/${broken}/secrets`, 500, {
      success: false,
      errors: [{ code: 10013, message: `could not store ${M365_VALUES.M365_TENANT_ID}` }],
    })
    const first = await drive()
    expect(first.outcome.status).toBe('partial')
    expect(await pushRow(world.tenant.id, pushId)).toMatchObject({
      status: 'partial',
      total: 3,
      succeeded: 2,
      failed: 1,
    })
    expect((await versionRow(world.tenant.id, world.v1.id))?.status).toBe('retiring')
    const carol = await viewerOf(db, world.tenant.id, world.carol, [world.itIdentity.id])
    const detail = await getPush(db, carol, world.resource.id, pushId)
    const failed = detail.targets.find(t => t.status === 'failed')
    expect(failed?.app.id).toBe(world.apps[1]?.app.id)
    expect(failed?.error).toContain('[redacted]')
    expect(failed?.error).not.toContain(M365_VALUES.M365_TENANT_ID)
    const [grantRow] = await db
      .select()
      .from(appGrants)
      .where(
        and(
          eq(appGrants.tenantId, world.tenant.id),
          eq(appGrants.appId, world.apps[1]?.app.id as string)
        )
      )
    expect(grantRow?.pushError).toContain('[redacted]')
    expect(await auditOf(world.tenant.id, 'grant.push_failed')).toHaveLength(1)
    const failedNotes = await notificationsOf(world.tenant.id, GRANT_NOTIFICATION_TYPES.pushFailed)
    expect(failedNotes.map(n => n.userId)).toEqual([world.carol.id])
    expect(failedNotes[0]?.data).toEqual({ resourceId: world.resource.id, pushId })

    const putsBefore = Object.fromEntries(
      world.apps.map(({ script }) => [
        script,
        cloud.cloudflare.scripts.get(script)?.secretPuts.length,
      ])
    )
    const retried = await retryPush(deps, carol, world.resource.id, pushId, actorOf(world.carol))
    expect(retried.status).toBe('queued')
    const second = await drive()
    expect(second.instanceId).toBe(`${pushId}-r1`)
    expect(second.outcome.status).toBe('succeeded')
    for (const [i, { script }] of world.apps.entries()) {
      const puts = cloud.cloudflare.scripts.get(script)?.secretPuts.length ?? 0
      // Only the app that failed was written again.
      expect(puts - (putsBefore[script] ?? 0), script).toBe(i === 1 ? 3 : 0)
      expect(cloud.cloudflare.envOf(script)?.M365_CLIENT_SECRET).toBe(NEW_SECRET)
    }
    expect(await pushRow(world.tenant.id, pushId)).toMatchObject({
      status: 'succeeded',
      succeeded: 3,
      failed: 0,
      instanceId: `${pushId}-r1`,
    })
    expect((await versionRow(world.tenant.id, world.v1.id))?.status).toBe('retired')
    expect(await auditOf(world.tenant.id, 'grant.push.retried')).toHaveLength(1)
    // A push that succeeded has nothing to retry.
    await expect(
      retryPush(deps, carol, world.resource.id, pushId, actorOf(world.carol))
    ).rejects.toMatchObject({ statusCode: 409, code: 'push_not_retryable' })
  })

  it('a second push of the environment while one runs is 409 push_in_progress', async () => {
    const world = await seedWorld(1)
    await grantAll(world, world.v1.id)
    const v2 = await rotate(world.resource, world.v1)
    const deps = grantDeps(db, env)
    const input = {
      tenantId: world.tenant.id,
      resourceId: world.resource.id,
      environment: 'staging' as const,
      reason: 'rotate' as const,
      versionId: v2.id,
    }
    const { pushId } = await startPush(deps, input)
    await expect(startPush(deps, input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'push_in_progress',
    })
    // Production is its own slot.
    const prod = await seedResourceValues(db, cfg, world.resource, 'production')
    await expect(
      startPush(deps, { ...input, environment: 'production', versionId: prod.id })
    ).resolves.toMatchObject({ created: true })
    const carol = await viewerOf(db, world.tenant.id, world.carol, [world.itIdentity.id])
    await expect(
      retryPush(deps, carol, world.resource.id, pushId, actorOf(world.carol))
    ).rejects.toMatchObject({ statusCode: 409, code: 'push_in_progress' })
    // Without the binding nothing is written.
    const { GRANT_PUSH_WORKFLOW: _, ...without } = env
    await expect(
      startPush(grantDeps(db, without as TestEnv), { ...input, environment: 'production' })
    ).rejects.toMatchObject({ statusCode: 503, code: 'grants_not_configured' })
  })

  it('an approval that already started its push gets that push back (a retried applyAfter)', async () => {
    const world = await seedWorld(1)
    const [grant] = await grantAll(world)
    const deps = grantDeps(db, env)
    // Any approval row will do for the unique index; the grant.request kind is 5d's.
    const { request: approval } = await open(
      approvalDeps(db, env),
      accessOpen(world.tenant.id, world.app.id, world.carol)
    )
    const input = {
      tenantId: world.tenant.id,
      resourceId: world.resource.id,
      environment: 'staging' as const,
      reason: 'grant' as const,
      grantId: grant?.id,
      versionId: world.v1.id,
      approvalId: approval.id,
    }
    const first = await startPush(deps, input)
    expect(first.created).toBe(true)
    // Even with the first push still running, the same approval finds it rather than a 409.
    expect(await startPush(deps, input)).toEqual({ pushId: first.pushId, created: false })
    expect(stubs(env).grantPushWorkflow?.created).toHaveLength(1)
    const [started] = await auditOf(world.tenant.id, 'grant.push.started')
    expect(started?.approvalId).toBe(approval.id)
  })
})

describe('the first push onto a Worker that still binds the var as plain_text', () => {
  it('copies the live version without the vars and with the secrets, and audits grant.var_shadowed', async () => {
    const fixture = await approvalsFixture(db)
    tenantIds.push(fixture.tenant.id)
    const group = await createTestGroup(db, fixture.tenant.id, 'IT Identity', [fixture.carol.id])
    const resource = await seedSharedResource(db, fixture.tenant.id, { ownerGroupId: group.id })
    const v1 = await seedResourceValues(db, cfg, resource, 'staging')
    const { app, environments } = await seedApp(db, fixture.tenant.id)
    const script = environments.find(e => e.name === 'staging')?.workerName as string
    // The plugin install wrote both ids into the toml; the pipeline put DATABASE_URL.
    await liveScript(script, {
      vars: { M365_TENANT_ID: 'toml-tenant', M365_CLIENT_ID: 'toml-client' },
      secret: true,
    })
    expect(cloud.cloudflare.secretNameClash).toBe(true)
    const grant = await seedGrant(db, {
      tenantId: fixture.tenant.id,
      appId: app.id,
      resourceId: resource.id,
      environment: 'staging',
    })
    const { pushId } = await startPush(grantDeps(db, env), {
      tenantId: fixture.tenant.id,
      resourceId: resource.id,
      environment: 'staging',
      reason: 'grant',
      grantId: grant.id,
      versionId: v1.id,
    })
    const { outcome } = await drive()
    expect(outcome.status).toBe('succeeded')

    // The app now sees the granted values, and kept everything else.
    expect(cloud.cloudflare.envOf(script)).toEqual({
      RELEASE_VERSION: '1.0.0',
      DATABASE_URL: 'postgres://app',
      ...M365_VALUES,
    })
    const live = cloud.cloudflare.activeVersion(script)
    const byName = Object.fromEntries((live?.bindings ?? []).map(b => [b.name, b.type]))
    expect(byName).toEqual({
      RELEASE_VERSION: 'plain_text',
      RATE_LIMIT_KV: 'kv_namespace',
      M365_TENANT_ID: 'secret_text',
      M365_CLIENT_ID: 'secret_text',
      M365_CLIENT_SECRET: 'secret_text',
      DATABASE_URL: 'secret_text',
    })
    expect(live?.metadata).toMatchObject({
      main_module: 'worker.js',
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      keep_bindings: ['secret_text'],
    })
    expect(live?.modules['worker.js']).toBe('export default { fetch() {} }')
    // The first secret PUT was refused; the copy carried all three, no PUT after it.
    expect(
      cloud.calls.filter(c => c.method === 'PUT' && c.path.endsWith('/secrets')).map(c => c.status)
    ).toEqual([200, 400])
    const [shadowed] = await auditOf(fixture.tenant.id, 'grant.var_shadowed')
    expect(shadowed?.summary.after).toEqual({
      pushId,
      script,
      environment: 'staging',
      shadowedVars: ['M365_TENANT_ID', 'M365_CLIENT_ID'],
      via: 'new_version',
    })
    expect(shadowed?.targetId).toBe(grant.id)
    const [pushed] = await auditOf(fixture.tenant.id, 'grant.pushed')
    expect(pushed?.summary.after).toMatchObject({
      shadowedVars: ['M365_TENANT_ID', 'M365_CLIENT_ID'],
    })
    // …and the target row keeps the names too (0026), which the push view returns.
    const [target] = await db
      .select()
      .from(grantPushTargets)
      .where(eq(grantPushTargets.pushId, pushId))
    expect(target?.shadowedVars).toEqual(['M365_TENANT_ID', 'M365_CLIENT_ID'])
    // Read back, the copy names its secrets and never shows them.
    const readBack = await client().getVersion(cloud.opts.accountId, script, live?.id as string)
    expect(JSON.stringify(readBack)).toContain('M365_CLIENT_SECRET')
    expect(JSON.stringify(readBack)).not.toContain(SECRET)

    // A later rotation is plain secret PUTs: the var no longer clashes.
    const v2 = await rotate(resource, v1)
    await startPush(grantDeps(db, env), {
      tenantId: fixture.tenant.id,
      resourceId: resource.id,
      environment: 'staging',
      reason: 'rotate',
      versionId: v2.id,
    })
    expect((await drive()).outcome.status).toBe('succeeded')
    expect(cloud.cloudflare.envOf(script)?.M365_CLIENT_SECRET).toBe(NEW_SECRET)
    expect(await auditOf(fixture.tenant.id, 'grant.var_shadowed')).toHaveLength(1)
  })

  it('a clash with no such var on the live version fails the target (nothing else is touched)', async () => {
    const world = await seedWorld(1)
    const [grant] = await grantAll(world)
    const script = world.apps[0]?.script as string
    const versionsBefore = cloud.cloudflare.scripts.get(script)?.versions.length
    cloud.failNext(`/workers/scripts/${script}/secrets`, 400, {
      success: false,
      errors: [{ code: 10053, message: 'Binding name already in use' }],
    })
    await startPush(grantDeps(db, env), {
      tenantId: world.tenant.id,
      resourceId: world.resource.id,
      environment: 'staging',
      reason: 'grant',
      grantId: grant?.id,
      versionId: world.v1.id,
    })
    expect((await drive()).outcome.status).toBe('failed')
    expect(cloud.cloudflare.scripts.get(script)?.versions.length).toBe(versionsBefore)
  })
})

describe('revoking', () => {
  it('removes the secrets from the Worker and ends the grant revoked', async () => {
    const world = await seedWorld(1)
    const [grant] = await grantAll(world)
    await startPush(grantDeps(db, env), {
      tenantId: world.tenant.id,
      resourceId: world.resource.id,
      environment: 'staging',
      reason: 'grant',
      grantId: grant?.id,
      versionId: world.v1.id,
    })
    await drive()
    const script = world.apps[0]?.script as string
    expect(cloud.cloudflare.envOf(script)?.M365_CLIENT_SECRET).toBe(SECRET)

    const deps = grantDeps(db, env)
    // A member with no part in the app or the resource may not.
    const dave = await createTestUser(db)
    await linkUserToTenant(db, dave.id, world.tenant.id, 'member')
    const outsider: GrantViewer = await viewerOf(db, world.tenant.id, dave)
    await expect(
      revokeGrant(deps, outsider, {
        appId: world.apps[0]?.app.id as string,
        grantId: grant?.id as string,
        actor: actorOf(dave),
      })
    ).rejects.toMatchObject({ statusCode: 403 })
    // The app's owner may.
    const aliceView = await viewerOf(db, world.tenant.id, world.alice)
    const { grant: revoking, pushId } = await revokeGrant(deps, aliceView, {
      appId: world.apps[0]?.app.id as string,
      grantId: grant?.id as string,
      reason: 'no longer needed',
      actor: actorOf(world.alice),
    })
    expect(revoking.status).toBe('revoking')
    expect(pushId).toBeTruthy()
    const { outcome } = await drive()
    expect(outcome.status).toBe('succeeded')
    const env2 = cloud.cloudflare.envOf(script) ?? {}
    for (const key of M365_ITEMS_KEYS) expect(env2[key]).toBeUndefined()
    expect(cloud.cloudflare.scripts.get(script)?.secretDeletes).toEqual(M365_ITEMS_KEYS)
    const [row] = await db
      .select()
      .from(appGrants)
      .where(and(eq(appGrants.tenantId, world.tenant.id), eq(appGrants.id, grant?.id as string)))
    expect(row).toMatchObject({
      status: 'revoked',
      revokedByUserId: world.alice.id,
      pushedVersionId: null,
    })
    expect(row?.revokedAt).toBeInstanceOf(Date)
    expect(await auditOf(world.tenant.id, 'grant.revoke_requested')).toHaveLength(1)
    expect(await auditOf(world.tenant.id, 'grant.revoked')).toHaveLength(1)
    // Revoking again is 409.
    await expect(
      revokeGrant(deps, aliceView, {
        appId: world.apps[0]?.app.id as string,
        grantId: grant?.id as string,
        actor: actorOf(world.alice),
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'grant_not_active' })
  })
})

const M365_ITEMS_KEYS = ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET']

describe('the sweep', () => {
  it('reminds once 7 days out, expires with an expire push, and flags a secret due for rotation', async () => {
    const world = await seedWorld(2)
    const now = new Date()
    const [soon, due] = await Promise.all(
      world.apps.map(({ app }, i) =>
        seedGrant(db, {
          tenantId: world.tenant.id,
          appId: app.id,
          resourceId: world.resource.id,
          environment: 'staging',
          expiresAt: new Date(now.getTime() + (i === 0 ? 3 * DAY_MS : -60_000)),
        })
      )
    )
    // A version set 200 days ago with a 180-day secret.
    await db
      .update(sharedResourceValues)
      .set({ setAt: new Date(now.getTime() - 200 * DAY_MS) })
      .where(
        and(
          eq(sharedResourceValues.tenantId, world.tenant.id),
          eq(sharedResourceValues.id, world.v1.id)
        )
      )

    const deps = grantDeps(db, env, () => now)
    const report = await sweepGrants(deps)
    expect(report.reminded).toBeGreaterThanOrEqual(1)
    expect(report.expired).toBeGreaterThanOrEqual(1)
    expect(report.rotationDue).toBeGreaterThanOrEqual(1)

    const reminders = await notificationsOf(world.tenant.id, GRANT_NOTIFICATION_TYPES.expiring)
    expect(reminders.map(n => n.userId)).toEqual([world.alice.id])
    expect(reminders[0]?.data).toMatchObject({ grantId: soon?.id, appId: world.apps[0]?.app.id })
    const [dueRow] = await db
      .select()
      .from(appGrants)
      .where(and(eq(appGrants.tenantId, world.tenant.id), eq(appGrants.id, due?.id as string)))
    expect(dueRow?.status).toBe('revoking')
    const [expirePush] = await db
      .select()
      .from(grantPushes)
      .where(
        and(eq(grantPushes.tenantId, world.tenant.id), eq(grantPushes.grantId, due?.id as string))
      )
    expect(expirePush).toMatchObject({ reason: 'expire', status: 'queued', versionId: null })
    const rotation = await notificationsOf(world.tenant.id, GRANT_NOTIFICATION_TYPES.rotationDue)
    expect(rotation.map(n => n.userId)).toEqual([world.carol.id])
    expect(rotation[0]?.data).toMatchObject({
      resourceId: world.resource.id,
      environment: 'staging',
      keys: ['M365_CLIENT_SECRET'],
      versionId: world.v1.id,
    })

    // The expire push removes the names and ends the grant `expired`.
    const { outcome } = await drive()
    expect(outcome.status).toBe('succeeded')
    const [expired] = await db
      .select()
      .from(appGrants)
      .where(and(eq(appGrants.tenantId, world.tenant.id), eq(appGrants.id, due?.id as string)))
    expect(expired?.status).toBe('expired')
    expect(await auditOf(world.tenant.id, 'grant.expired')).toHaveLength(1)

    // A second sweep sends nothing again.
    await sweepGrants(deps)
    expect(await notificationsOf(world.tenant.id, GRANT_NOTIFICATION_TYPES.expiring)).toHaveLength(
      1
    )
    expect(
      await notificationsOf(world.tenant.id, GRANT_NOTIFICATION_TYPES.rotationDue)
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(grantPushes)
        .where(and(eq(grantPushes.tenantId, world.tenant.id), eq(grantPushes.reason, 'expire')))
    ).toHaveLength(1)
  })

  it('rotationDueKeys: only secrets, only past their days', () => {
    const now = new Date()
    const resource = { items: M365_ITEMS_WITH_DAYS }
    expect(
      rotationDueKeys(resource, { setAt: new Date(now.getTime() - 10 * DAY_MS) }, now)
    ).toEqual([])
    expect(
      rotationDueKeys(resource, { setAt: new Date(now.getTime() - 181 * DAY_MS) }, now)
    ).toEqual(['M365_CLIENT_SECRET'])
  })
})

const M365_ITEMS_WITH_DAYS = [
  { key: 'M365_TENANT_ID', kind: 'var' as const, rotationDays: 1 },
  { key: 'M365_CLIENT_SECRET', kind: 'secret' as const, rotationDays: 180 },
]

describe('isolation and secrecy', () => {
  it('another organisation, and a member who is not an owner, get 404; the routes agree', async () => {
    const world = await seedWorld(1)
    await grantAll(world, world.v1.id)
    const v2 = await rotate(world.resource, world.v1)
    const { pushId } = await startPush(grantDeps(db, env), {
      tenantId: world.tenant.id,
      resourceId: world.resource.id,
      environment: 'staging',
      reason: 'rotate',
      versionId: v2.id,
    })
    await drive()
    const other = await createTestTenantWithUser(db, 'owner')
    tenantIds.push(other.tenant.id)
    const foreignAdmin = await viewerOf(db, other.tenant.id, other.user)
    await expect(getPush(db, foreignAdmin, world.resource.id, pushId)).rejects.toMatchObject({
      statusCode: 404,
    })
    await expect(
      listPushes(db, foreignAdmin, world.resource.id, { limit: 20 })
    ).rejects.toMatchObject({ statusCode: 404 })
    const bob = await viewerOf(db, world.tenant.id, world.bob)
    await expect(getPush(db, bob, world.resource.id, pushId)).rejects.toMatchObject({
      statusCode: 404,
    })
    const admin = await viewerOf(db, world.tenant.id, world.admin)
    expect((await getPush(db, admin, world.resource.id, pushId)).status).toBe('succeeded')

    const asCarol = sessionCookieHeader(
      await createTestSession(db, world.carol.id, world.tenant.id)
    )
    const list = await request(`/api/shared-resources/${world.resource.id}/pushes`, {
      headers: asCarol,
    })
    expect(list.status).toBe(200)
    expect((await json<{ items: { id: string }[] }>(list)).items.map(i => i.id)).toEqual([pushId])
    const one = await request(`/api/shared-resources/${world.resource.id}/pushes/${pushId}`, {
      headers: asCarol,
    })
    expect(one.status).toBe(200)
    const asBob = sessionCookieHeader(await createTestSession(db, world.bob.id, world.tenant.id))
    expect(
      (await request(`/api/shared-resources/${world.resource.id}/pushes`, { headers: asBob }))
        .status
    ).toBe(404)
    const retry = await request(
      `/api/shared-resources/${world.resource.id}/pushes/${pushId}/retry`,
      { method: 'POST', headers: asCarol }
    )
    expect(retry.status).toBe(409)
    expect(await json(retry)).toMatchObject({ statusCode: 409, code: 'push_not_retryable' })
    expect((await request(`/api/shared-resources/${world.resource.id}/pushes`)).status).toBe(401)
    expect(
      (
        await request(`/api/shared-resources/${world.resource.id}/pushes/not-a-uuid`, {
          headers: asCarol,
        })
      ).status
    ).toBe(404)
  })

  it('no secret in any step result, push row, target row, audit summary or notification', async () => {
    const world = await seedWorld(2)
    await grantAll(world, world.v1.id)
    const v2 = await rotate(world.resource, world.v1)
    stepResults.length = 0
    cloud.failNext(`/workers/scripts/${world.apps[0]?.script}/secrets`, 500, {
      success: false,
      errors: [{ code: 1, message: `rejected ${NEW_SECRET}` }],
    })
    const deps = grantDeps(db, env)
    const { pushId } = await startPush(deps, {
      tenantId: world.tenant.id,
      resourceId: world.resource.id,
      environment: 'staging',
      reason: 'rotate',
      versionId: v2.id,
    })
    await drive()
    const carol = await viewerOf(db, world.tenant.id, world.carol, [world.itIdentity.id])
    await retryPush(deps, carol, world.resource.id, pushId, actorOf(world.carol))
    await drive()
    const everything = JSON.stringify({
      steps: stepResults,
      pushes: await db.select().from(grantPushes).where(eq(grantPushes.tenantId, world.tenant.id)),
      targets: await db
        .select()
        .from(grantPushTargets)
        .where(eq(grantPushTargets.tenantId, world.tenant.id)),
      audit: await db.select().from(auditEvents).where(eq(auditEvents.tenantId, world.tenant.id)),
      notes: await db
        .select()
        .from(notifications)
        .where(eq(notifications.tenantId, world.tenant.id)),
      grants: await db
        .select()
        .from(appGrants)
        .where(
          inArray(
            appGrants.appId,
            world.apps.map(a => a.app.id)
          )
        ),
      view: await getPush(db, carol, world.resource.id, pushId),
    })
    expect(stepResults.length).toBeGreaterThan(0)
    for (const value of [
      SECRET,
      NEW_SECRET,
      M365_VALUES.M365_TENANT_ID,
      M365_VALUES.M365_CLIENT_ID,
    ]) {
      expect(everything).not.toContain(value)
    }
    expect(everything).toContain('[redacted]')
  })
})
