// @vitest-isolate
// Mocks slice 5c's startPush and spies on console and stdout (the "no secret in a log line" check).
/**
 * Launch P5 slice 5b: shared resources and their values over the real app and the real database —
 * `/api/shared-resources` and `services/grants/{resources,values,access}.ts`.
 *
 * - **values are write-only**: a sentinel secret is in no response of any route, no audit row and
 *   no log line; a var's value reaches the resource's owners and admins only;
 * - **versioning**: each `PUT` is version N+1 per environment, a blank field keeps the previous
 *   value, the previous version is `retired` (nobody holds it) or `retiring` (a rotation started);
 * - **the visibility matrix**: a member, an owner (the owner group), an admin, another tenant;
 * - the owner group's and the admins' rights, archiving (409 while held), the group-delete 409 and
 *   the way out of it, and the audit trail.
 *
 * `startPush` is slice 5c's: it is faked here (`vi.mock`), so this file asserts only the hand-off
 * — its arguments carry ids, never a value.
 */

import type {
  PutSharedResourceValuesResponse,
  SharedResource,
  SharedResourceDetail,
} from '@launch/shared/launch-grants'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { canManageResource, canSeeHolders, isResourceOwner } from '@/api/services/grants/access'
import { startPush } from '@/api/services/grants/push'
import { openValues } from '@/api/services/grants/sealed'
import { deleteGroup } from '@/api/services/groups'
import { loadConfig } from '@/config'
import { auditEvents, grantPushes, sharedResources, sharedResourceValues } from '@/db/schema'
import { approvalsFixture, viewerOf } from '../helpers/approvals'
import { createTestSession, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  M365_ITEMS,
  M365_VALUES,
  seedGrant,
  seedResourceValues,
  seedSharedResource,
} from '../helpers/grants'
import { forgetApps } from '../helpers/launch-apps'
import { createTestGroup } from '../helpers/oidc'
import { request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

vi.mock('@/api/services/grants/push', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/services/grants/push')>()),
  startPush: vi.fn(async () => ({ pushId: crypto.randomUUID(), created: true })),
}))

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())
const tenantIds: string[] = []
const SECRET = M365_VALUES.M365_CLIENT_SECRET
const ROTATED = 'sentinel-rotated-secret-never-echoed'

// Every log line the app writes, whichever way it writes it — searched for the sentinels.
const logged: string[] = []
const capture =
  (write: (...args: never[]) => unknown) =>
  (...args: unknown[]) => {
    logged.push(args.map(a => (typeof a === 'string' ? a : safeJson(a))).join(' '))
    return (write as (...a: unknown[]) => unknown)(...args)
  }
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  vi.spyOn(console, level).mockImplementation(capture(() => undefined))
}
// Swallowed rather than passed on: at `trace` the request logger would flood the run's output.
vi.spyOn(process.stdout, 'write').mockImplementation(capture(() => true) as never)

/** A test env that logs everything, so the log search below has lines to search. */
function loudEnv() {
  return createTestEnv({ LOG_LEVEL: 'trace' })
}

/** Every response body this file received — searched for the sentinels at the end. */
const bodies: string[] = []

afterAll(async () => {
  await forgetApps(db, tenantIds)
})

beforeEach(() => {
  vi.mocked(startPush).mockClear()
})

async function call(
  url: string,
  init: { method?: string; headers: Record<string, string>; json?: unknown },
  env = loudEnv()
) {
  const res = await request(
    url,
    { method: init.method ?? 'GET', headers: init.headers },
    { env, ...(init.json !== undefined ? { json: init.json } : {}) }
  )
  const text = await res.text()
  bodies.push(text)
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/**
 * One organisation: `admin` (its owner), `carol` (in "IT Identity", which owns M365), `alice` (a
 * member who owns `app` but not the resource) — plus another organisation's admin.
 */
async function seedWorld() {
  const fixture = await approvalsFixture(db)
  tenantIds.push(fixture.tenant.id)
  const itIdentity = await createTestGroup(db, fixture.tenant.id, 'IT Identity', [fixture.carol.id])
  const other = await approvalsFixture(db)
  tenantIds.push(other.tenant.id)
  const cookie = async (user: { id: string }, tenantId = fixture.tenant.id) =>
    sessionCookieHeader(await createTestSession(db, user.id, tenantId))
  return {
    ...fixture,
    itIdentity,
    other,
    as: {
      admin: await cookie(fixture.admin),
      carol: await cookie(fixture.carol),
      alice: await cookie(fixture.alice),
      outsider: await cookie(other.admin, other.tenant.id),
    },
  }
}

async function createM365(world: Awaited<ReturnType<typeof seedWorld>>, slug = uniqueSlug()) {
  const res = await call('/api/shared-resources', {
    method: 'POST',
    headers: world.as.admin,
    json: {
      slug,
      displayName: 'M365 (company tenant)',
      description: 'The company Entra app',
      ownerGroupId: world.itIdentity.id,
      items: M365_ITEMS,
    },
  })
  expect(res.status).toBe(201)
  return res.body as SharedResourceDetail
}

function uniqueSlug() {
  return `m365-${crypto.randomUUID().slice(0, 8)}`
}

async function auditOf(tenantId: string, action: string) {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action)))
}

async function versionsOf(tenantId: string, resourceId: string) {
  return db
    .select()
    .from(sharedResourceValues)
    .where(
      and(
        eq(sharedResourceValues.tenantId, tenantId),
        eq(sharedResourceValues.resourceId, resourceId)
      )
    )
    .orderBy(sharedResourceValues.environment, sharedResourceValues.version)
}

describe('creating a shared resource', () => {
  it('is an admin’s: 201 with the detail, audited; a member is 403; a taken slug 409', async () => {
    const world = await seedWorld()
    const created = await createM365(world, 'm365-company')
    expect(created).toMatchObject({
      slug: 'm365-company',
      ownerGroup: { id: world.itIdentity.id, name: 'IT Identity' },
      items: M365_ITEMS,
      policies: {},
      holders: [],
      canManage: true,
      canSetValues: true,
      createdByUserId: world.admin.id,
    })
    expect(created.environments.map(e => [e.environment, e.version, e.holderCount])).toEqual([
      ['staging', null, 0],
      ['production', null, 0],
    ])
    const [audit] = await auditOf(world.tenant.id, 'shared_resource.created')
    expect(audit).toMatchObject({ targetId: created.id, actorUserId: world.admin.id })
    expect(audit?.summary.after).toMatchObject({
      slug: 'm365-company',
      ownerGroupId: world.itIdentity.id,
    })

    const again = await call('/api/shared-resources', {
      method: 'POST',
      headers: world.as.admin,
      json: {
        slug: 'm365-company',
        displayName: 'Again',
        ownerGroupId: world.itIdentity.id,
        items: M365_ITEMS,
      },
    })
    expect(again).toMatchObject({ status: 409, body: { code: 'shared_resource_slug_taken' } })

    // Even the owner group's own member may not create one: CASL `create` is admins'.
    const byMember = await call('/api/shared-resources', {
      method: 'POST',
      headers: world.as.carol,
      json: {
        slug: uniqueSlug(),
        displayName: 'X',
        ownerGroupId: world.itIdentity.id,
        items: M365_ITEMS,
      },
    })
    expect(byMember.status).toBe(403)

    // Another organisation's group is not ours to name; duplicate keys are a 400.
    const foreignGroup = await createTestGroup(db, world.other.tenant.id, 'Theirs')
    const foreign = await call('/api/shared-resources', {
      method: 'POST',
      headers: world.as.admin,
      json: {
        slug: uniqueSlug(),
        displayName: 'X',
        ownerGroupId: foreignGroup.id,
        items: M365_ITEMS,
      },
    })
    expect(foreign.status).toBe(400)
    const dupKeys = await call('/api/shared-resources', {
      method: 'POST',
      headers: world.as.admin,
      json: {
        slug: uniqueSlug(),
        displayName: 'X',
        ownerGroupId: world.itIdentity.id,
        items: [M365_ITEMS[0], M365_ITEMS[0]],
      },
    })
    expect(dupKeys).toMatchObject({ status: 400, body: { code: 'validation_failed' } })
  })
})

describe('values', () => {
  it('each PUT is version N+1 per environment; a blank field keeps the previous value', async () => {
    const world = await seedWorld()
    const resource = await createM365(world)
    const url = `/api/shared-resources/${resource.id}/values/staging`

    const first = await call(url, {
      method: 'PUT',
      headers: world.as.carol,
      json: { values: M365_VALUES },
    })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ version: 1, pushId: null })

    // Rotate the secret only: the two vars are blank (kept) or absent (kept).
    const second = await call(url, {
      method: 'PUT',
      headers: world.as.carol,
      json: { values: { M365_TENANT_ID: '', M365_CLIENT_SECRET: ROTATED } },
    })
    expect(second.status).toBe(200)
    expect((second.body as PutSharedResourceValuesResponse).version).toBe(2)
    // Production counts on its own.
    const prod = await call(`/api/shared-resources/${resource.id}/values/production`, {
      method: 'PUT',
      headers: world.as.admin,
      json: { values: { M365_TENANT_ID: 'prod-tenant' } },
    })
    expect(prod.body).toMatchObject({ version: 1, pushId: null })

    const rows = await versionsOf(world.tenant.id, resource.id)
    expect(rows.map(r => [r.environment, r.version, r.status])).toEqual([
      ['staging', 1, 'retired'], // nobody held it: retired at once
      ['staging', 2, 'active'],
      ['production', 1, 'active'],
    ])
    expect(rows[0]?.retiredAt).toBeInstanceOf(Date)
    expect(await openValues(cfg, rows[1]?.sealed ?? '')).toEqual({
      ...M365_VALUES,
      M365_CLIENT_SECRET: ROTATED,
    })
    expect(await openValues(cfg, rows[2]?.sealed ?? '')).toEqual({ M365_TENANT_ID: 'prod-tenant' })
    for (const row of rows) {
      expect(row.sealed).not.toContain(SECRET)
      expect(row.sealed).not.toContain(ROTATED)
    }
    expect(vi.mocked(startPush)).not.toHaveBeenCalled()

    // The detail reports each environment's status: version, who, which keys.
    const detail = (await call(`/api/shared-resources/${resource.id}`, { headers: world.as.carol }))
      .body as SharedResourceDetail
    const [staging, production] = detail.environments
    expect(staging).toMatchObject({
      version: 2,
      setBy: { id: world.carol.id, email: world.carol.email },
      keysSet: ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET'],
      retiringVersions: [],
      rotationDue: [],
      holderCount: 0,
    })
    expect(production).toMatchObject({ version: 1, keysSet: ['M365_TENANT_ID'] })

    // Audited with the KEYS that changed, never a value.
    const audits = await auditOf(world.tenant.id, 'shared_resource.values.set')
    expect(audits.map(a => a.summary.after)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environment: 'staging',
          version: 1,
          values: 'set',
          keys: Object.keys(M365_VALUES),
        }),
        expect.objectContaining({
          environment: 'staging',
          version: 2,
          previousVersion: 1,
          keys: ['M365_CLIENT_SECRET'],
          kept: ['M365_TENANT_ID', 'M365_CLIENT_ID'],
        }),
      ])
    )
  })

  it('refuses an unknown key, an empty body, a non-owner, an archived resource, a bad env', async () => {
    const world = await seedWorld()
    const resource = await createM365(world)
    const url = `/api/shared-resources/${resource.id}/values/staging`
    expect(
      await call(url, {
        method: 'PUT',
        headers: world.as.carol,
        json: { values: { NOT_AN_ITEM: 'x' } },
      })
    ).toMatchObject({
      status: 400,
      body: { code: 'unknown_item_key', details: { keys: ['NOT_AN_ITEM'] } },
    })
    expect(
      await call(url, {
        method: 'PUT',
        headers: world.as.carol,
        json: { values: { M365_TENANT_ID: '' } },
      })
    ).toMatchObject({ status: 400, body: { code: 'validation_failed' } })
    expect(
      await call(url, { method: 'PUT', headers: world.as.alice, json: { values: M365_VALUES } })
    ).toMatchObject({ status: 403, body: { code: 'not_resource_owner' } })
    expect(
      (
        await call(`/api/shared-resources/${resource.id}/values/dev`, {
          method: 'PUT',
          headers: world.as.carol,
          json: { values: M365_VALUES },
        })
      ).status
    ).toBe(400)
    await db
      .update(sharedResources)
      .set({ archivedAt: new Date() })
      .where(
        and(eq(sharedResources.tenantId, world.tenant.id), eq(sharedResources.id, resource.id))
      )
    expect(
      await call(url, { method: 'PUT', headers: world.as.admin, json: { values: M365_VALUES } })
    ).toMatchObject({ status: 409, body: { code: 'shared_resource_archived' } })
    expect(await versionsOf(world.tenant.id, resource.id)).toEqual([])
  })

  it('with holders: 202, a rotate push handed to startPush, the previous version retiring', async () => {
    const world = await seedWorld()
    const resource = await createM365(world)
    const v1 = await seedResourceValues(
      db,
      cfg,
      { id: resource.id, tenantId: world.tenant.id },
      'staging'
    )
    await seedGrant(db, {
      tenantId: world.tenant.id,
      appId: world.app.id,
      resourceId: resource.id,
      environment: 'staging',
      pushedVersionId: v1.id,
    })
    const res = await call(`/api/shared-resources/${resource.id}/values/staging`, {
      method: 'PUT',
      headers: world.as.carol,
      json: { values: { M365_CLIENT_SECRET: ROTATED } },
    })
    expect(res.status).toBe(202)
    const answer = res.body as PutSharedResourceValuesResponse
    expect(answer.pushId).toEqual(expect.any(String))
    expect(vi.mocked(startPush)).toHaveBeenCalledTimes(1)
    const [deps, input] = vi.mocked(startPush).mock.calls[0] ?? []
    expect(deps?.env.GRANT_PUSH_WORKFLOW).toBeDefined()
    expect(input).toEqual({
      tenantId: world.tenant.id,
      resourceId: resource.id,
      environment: 'staging',
      reason: 'rotate',
      grantId: null,
      versionId: answer.versionId,
      startedByUserId: world.carol.id,
    })
    expect(safeJson(input)).not.toContain(ROTATED)
    const rows = await versionsOf(world.tenant.id, resource.id)
    expect(rows.map(r => [r.version, r.status])).toEqual([
      [1, 'retiring'],
      [2, 'active'],
    ])
    const [audit] = (await auditOf(world.tenant.id, 'shared_resource.values.set')).filter(
      a => a.summary.after?.version === 2
    )
    expect(audit?.summary.after).toMatchObject({ holders: 1, keys: ['M365_CLIENT_SECRET'] })

    // The detail counts the holder and shows the retiring version.
    const detail = (await call(`/api/shared-resources/${resource.id}`, { headers: world.as.admin }))
      .body as SharedResourceDetail
    expect(detail.environments[0]).toMatchObject({
      version: 2,
      retiringVersions: [1],
      holderCount: 1,
    })
  })

  it('a push already running for the environment is 409 push_in_progress, and nothing is written', async () => {
    const world = await seedWorld()
    const resource = await createM365(world)
    const v1 = await seedResourceValues(
      db,
      cfg,
      { id: resource.id, tenantId: world.tenant.id },
      'staging'
    )
    await seedGrant(db, {
      tenantId: world.tenant.id,
      appId: world.app.id,
      resourceId: resource.id,
      environment: 'staging',
    })
    await db.insert(grantPushes).values({
      tenantId: world.tenant.id,
      resourceId: resource.id,
      environment: 'staging',
      reason: 'grant',
      versionId: v1.id,
      status: 'running',
    })
    const res = await call(`/api/shared-resources/${resource.id}/values/staging`, {
      method: 'PUT',
      headers: world.as.carol,
      json: { values: { M365_CLIENT_SECRET: ROTATED } },
    })
    expect(res).toMatchObject({ status: 409, body: { code: 'push_in_progress' } })
    expect((await versionsOf(world.tenant.id, resource.id)).map(r => r.status)).toEqual(['active'])
    expect(vi.mocked(startPush)).not.toHaveBeenCalled()
  })

  it('without the GRANT_PUSH_WORKFLOW binding: 503 grants_not_configured before any row', async () => {
    const world = await seedWorld()
    const resource = await createM365(world)
    const env = loudEnv()
    delete (env as { GRANT_PUSH_WORKFLOW?: unknown }).GRANT_PUSH_WORKFLOW
    const res = await call(
      `/api/shared-resources/${resource.id}/values/staging`,
      { method: 'PUT', headers: world.as.carol, json: { values: M365_VALUES } },
      env
    )
    expect(res).toMatchObject({ status: 503, body: { code: 'grants_not_configured' } })
    expect(await versionsOf(world.tenant.id, resource.id)).toEqual([])
  })
})

describe('who sees what', () => {
  it('members see names and status; owners and admins also holders and var values; nobody a secret', async () => {
    const world = await seedWorld()
    const resource = await createM365(world)
    await call(`/api/shared-resources/${resource.id}/values/production`, {
      method: 'PUT',
      headers: world.as.carol,
      json: { values: M365_VALUES },
    })
    await seedGrant(db, {
      tenantId: world.tenant.id,
      appId: world.app.id,
      resourceId: resource.id,
      environment: 'production',
    })
    const url = `/api/shared-resources/${resource.id}`
    const vars = {
      M365_TENANT_ID: M365_VALUES.M365_TENANT_ID,
      M365_CLIENT_ID: M365_VALUES.M365_CLIENT_ID,
    }

    const member = (await call(url, { headers: world.as.alice })).body as SharedResourceDetail
    expect(member).toMatchObject({ canManage: false, canSetValues: false, activePushes: [] })
    expect(member.holders).toBeUndefined()
    expect(member.environments[1]).toMatchObject({ version: 1, holderCount: 1 })
    expect(member.environments[1]?.vars).toBeUndefined()

    const owner = (await call(url, { headers: world.as.carol })).body as SharedResourceDetail
    expect(owner).toMatchObject({ canManage: false, canSetValues: true })
    expect(owner.holders).toEqual([
      expect.objectContaining({
        app: { id: world.app.id, slug: world.app.slug, displayName: world.app.displayName },
        environment: 'production',
        status: 'active',
        pushedVersion: null,
      }),
    ])
    expect(owner.environments[1]?.vars).toEqual(vars)
    expect(owner.environments[0]?.vars).toBeUndefined() // nothing set in staging

    const admin = (await call(url, { headers: world.as.admin })).body as SharedResourceDetail
    expect(admin).toMatchObject({ canManage: true, canSetValues: true })
    expect(admin.holders).toHaveLength(1)
    expect(admin.environments[1]?.vars).toEqual(vars)

    // The list carries no values at all, not even to an admin.
    const list = (await call('/api/shared-resources', { headers: world.as.admin })).body as {
      items: SharedResource[]
    }
    const row = list.items.find(i => i.id === resource.id)
    expect(row?.environments.every(e => e.vars === undefined)).toBe(true)
    expect(row).not.toHaveProperty('holders')

    // No session: 401 with the envelope.
    const anonymous = await request(url)
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ statusCode: 401, error: expect.any(String) })

    // Another organisation: not in its list, 404 on every route.
    const theirs = (await call('/api/shared-resources', { headers: world.as.outsider })).body as {
      items: SharedResource[]
    }
    expect(theirs.items.map(i => i.id)).not.toContain(resource.id)
    for (const [method, path, body] of [
      ['GET', url, undefined],
      ['PATCH', url, { description: 'mine now' }],
      ['PUT', `${url}/values/staging`, { values: M365_VALUES }],
      ['DELETE', url, undefined],
    ] as const) {
      const res = await call(path, { method, headers: world.as.outsider, json: body })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })

  it('the access checks name the tenant first', async () => {
    const world = await seedWorld()
    const resource = { tenantId: world.tenant.id, ownerGroupId: world.itIdentity.id }
    const carol = await viewerOf(db, world.tenant.id, world.carol, [world.itIdentity.id])
    const admin = await viewerOf(db, world.tenant.id, world.admin)
    const alice = await viewerOf(db, world.tenant.id, world.alice)
    expect([
      isResourceOwner(carol, resource),
      canManageResource(carol, resource),
      canSeeHolders(carol, resource),
    ]).toEqual([true, false, true])
    expect([
      isResourceOwner(admin, resource),
      canManageResource(admin, resource),
      canSeeHolders(admin, resource),
    ]).toEqual([false, true, true])
    expect([
      isResourceOwner(alice, resource),
      canManageResource(alice, resource),
      canSeeHolders(alice, resource),
    ]).toEqual([false, false, false])
    // Another tenant's admin carrying the same group id is nobody here.
    const stranger = { ...admin, tenantId: world.other.tenant.id, groupIds: [world.itIdentity.id] }
    expect([
      isResourceOwner(stranger, resource),
      canManageResource(stranger, resource),
      canSeeHolders(stranger, resource),
    ]).toEqual([false, false, false])
  })
})

describe('editing', () => {
  it('owners edit the name, description and items; only admins the owner group and policies', async () => {
    const world = await seedWorld()
    const resource = await createM365(world)
    const url = `/api/shared-resources/${resource.id}`
    const items = [...M365_ITEMS, { key: 'M365_SCOPE', kind: 'var' as const }]
    const byOwner = await call(url, {
      method: 'PATCH',
      headers: world.as.carol,
      json: { description: 'Entra app for connectors', items },
    })
    expect(byOwner.status).toBe(200)
    expect(byOwner.body).toMatchObject({ description: 'Entra app for connectors', items })
    const [updated] = await auditOf(world.tenant.id, 'shared_resource.updated')
    expect(updated?.summary).toMatchObject({
      before: { description: 'The company Entra app' },
      after: { description: 'Entra app for connectors' },
    })
    expect(Object.keys(updated?.summary.after ?? {}).sort()).toEqual(['description', 'items'])

    const policy = {
      production: { approvers: { appOwners: false, admins: false }, minApprovals: 2 },
    }
    expect(
      await call(url, { method: 'PATCH', headers: world.as.carol, json: { policies: policy } })
    ).toMatchObject({ status: 403, body: { code: 'not_resource_admin' } })
    expect(
      await call(url, {
        method: 'PATCH',
        headers: world.as.carol,
        json: { ownerGroupId: world.itIdentity.id },
      })
    ).toMatchObject({ status: 403, body: { code: 'not_resource_admin' } })
    expect(
      await call(url, { method: 'PATCH', headers: world.as.alice, json: { description: 'x' } })
    ).toMatchObject({ status: 403, body: { code: 'not_resource_owner' } })
    expect((await call(url, { method: 'PATCH', headers: world.as.carol, json: {} })).status).toBe(
      400
    )

    const byAdmin = await call(url, {
      method: 'PATCH',
      headers: world.as.admin,
      json: { policies: policy },
    })
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200)
    expect((byAdmin.body as SharedResourceDetail).policies.production).toMatchObject({
      minApprovals: 2,
    })
  })
})

describe('archiving', () => {
  it('is refused while a live grant exists, then archives; archived is hidden and read-only', async () => {
    const world = await seedWorld()
    const resource = await createM365(world)
    const url = `/api/shared-resources/${resource.id}`
    const grant = await seedGrant(db, {
      tenantId: world.tenant.id,
      appId: world.app.id,
      resourceId: resource.id,
      environment: 'staging',
      status: 'requested',
    })
    expect((await call(url, { method: 'DELETE', headers: world.as.carol })).status).toBe(403)
    expect(await call(url, { method: 'DELETE', headers: world.as.admin })).toMatchObject({
      status: 409,
      body: { code: 'resource_has_holders', details: { holders: { staging: 1 } } },
    })

    const { appGrants } = await import('@/db/schema')
    await db
      .update(appGrants)
      .set({ status: 'rejected' })
      .where(and(eq(appGrants.tenantId, world.tenant.id), eq(appGrants.id, grant.id)))
    expect((await call(url, { method: 'DELETE', headers: world.as.admin })).status).toBe(204)
    expect((await call(url, { method: 'DELETE', headers: world.as.admin })).status).toBe(204)
    expect(await auditOf(world.tenant.id, 'shared_resource.archived')).toHaveLength(1)

    const listed = async (q: string) =>
      (
        (await call(`/api/shared-resources${q}`, { headers: world.as.alice })).body as {
          items: SharedResource[]
        }
      ).items.map(i => i.id)
    expect(await listed('')).not.toContain(resource.id)
    expect(await listed('?archived=true')).toContain(resource.id)
    const detail = (await call(url, { headers: world.as.carol })).body as SharedResourceDetail
    expect(detail).toMatchObject({ canSetValues: false, archivedAt: expect.any(String) })
    expect(
      await call(url, { method: 'PATCH', headers: world.as.admin, json: { displayName: 'Old' } })
    ).toMatchObject({ status: 409, body: { code: 'shared_resource_archived' } })
  })

  it('the owner group cannot be deleted while it owns one — an admin moves it, then it can', async () => {
    const world = await seedWorld()
    const resource = await createM365(world)
    await call(`/api/shared-resources/${resource.id}`, {
      method: 'DELETE',
      headers: world.as.admin,
    })
    // Archived still counts: the row keeps pointing at the group.
    await expect(deleteGroup(db, world.tenant.id, world.itIdentity.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'group_owns_shared_config',
    })
    const successor = await createTestGroup(db, world.tenant.id, 'Identity Platform')
    const moved = await call(`/api/shared-resources/${resource.id}`, {
      method: 'PATCH',
      headers: world.as.admin,
      json: { ownerGroupId: successor.id },
    })
    expect(moved.status).toBe(200)
    expect(moved.body).toMatchObject({
      ownerGroup: { id: successor.id, name: 'Identity Platform' },
    })
    await deleteGroup(db, world.tenant.id, world.itIdentity.id)
  })
})

describe('write-only values', () => {
  it('no response, audit row or log line of this file ever carried a secret', async () => {
    // Seeded directly too, so the sentinel exists even if this test runs alone.
    const world = await seedWorld()
    const resource = await seedSharedResource(db, world.tenant.id, {
      ownerGroupId: world.itIdentity.id,
    })
    await seedResourceValues(db, cfg, resource, 'staging')
    for (const headers of Object.values(world.as)) {
      await call(`/api/shared-resources/${resource.id}`, { headers })
      await call('/api/shared-resources?archived=true', { headers })
    }
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      expect(body).not.toContain(SECRET)
      expect(body).not.toContain(ROTATED)
    }
    for (const tenantId of tenantIds) {
      const rows = await db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId))
      for (const row of rows) {
        expect(JSON.stringify(row)).not.toContain(SECRET)
        expect(JSON.stringify(row)).not.toContain(ROTATED)
      }
    }
    expect(logged.length).toBeGreaterThan(0)
    for (const line of logged) {
      expect(line).not.toContain(SECRET)
      expect(line).not.toContain(ROTATED)
    }
  })
})
