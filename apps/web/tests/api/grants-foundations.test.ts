/**
 * Launch P5 slice 5a's wiring against the real database and the real app: the partial unique
 * indexes the grant model stands on (one live grant, one active version, one running push, one push
 * per approval), the owner group that cannot vanish from under a resource while a tenant's cascade
 * still takes everything, sealed values that round-trip and never hold the plaintext, the stub
 * mounts answering as the auth surface says (`/api/shared-resources` → `{ items: [] }`), the grants
 * sweep registered and harmless with its cross-tenant scans, the engine's policy-at-open (§1.9),
 * the `grant.request` kind registered, the 503 before any row, and the stubs failing BY NAME.
 */

import { WorkflowEntrypoint } from 'cloudflare:workers'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { encrypt } from '@/api/auth/oauth-encryption'
import { dispatchScheduled } from '@/api/scheduled'
import { open } from '@/api/services/approvals/engine'
import { kindHandler } from '@/api/services/approvals/kinds'
import { startPush } from '@/api/services/grants/push'
import { loadResource } from '@/api/services/grants/resources'
import { revokeGrant } from '@/api/services/grants/revoke'
import { openValues, sealValues } from '@/api/services/grants/sealed'
import {
  dueForExpiry,
  dueForExpiryReminder,
  grantsSweep,
  rotationCandidates,
} from '@/api/services/grants/sweep'
import { NotWiredError, requireGrantPushWorkflow } from '@/api/services/grants/types'
import { activeVersion } from '@/api/services/grants/values'
import { deleteGroup, deleteGroupType } from '@/api/services/groups'
import { GrantPushWorkflow } from '@/api/workflows/grant-push'
import { loadConfig } from '@/config'
import {
  appConfigScans,
  appGrants,
  approvalRequests,
  grantPushes,
  grantPushTargets,
  groups,
  sharedResources,
  sharedResourceValues,
  tenants,
} from '@/db/schema'
import { accessOpen, actorOf, approvalDeps, approvalsFixture } from '../helpers/approvals'
import { createTestSession, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  M365_ITEMS,
  M365_VALUES,
  seedGrant,
  seedResourceValues,
  seedSharedResource,
} from '../helpers/grants'
import { forgetApps, seedApp } from '../helpers/launch-apps'
import { createTestGroup } from '../helpers/oidc'
import { json, request } from '../helpers/request'
import { WEB_ROOT } from '../helpers/source-files'
import {
  createExecutionContext,
  createTestEnv,
  stubs,
  waitOnExecutionContext,
} from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())
const tenantIds: string[] = []

afterAll(async () => {
  await forgetApps(db, tenantIds)
})

function errorText(error: unknown): string {
  const parts: string[] = []
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    parts.push(String((e as Error).message ?? e))
  }
  return parts.join(' | ')
}

async function caught(promise: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    return error
  }
  throw new Error('expected the statement to fail')
}

/** An organisation with an app, an "IT Identity" group owning M365, and staging values. */
async function seedWorld() {
  const fixture = await approvalsFixture(db)
  tenantIds.push(fixture.tenant.id)
  const itIdentity = await createTestGroup(db, fixture.tenant.id, 'IT Identity', [fixture.carol.id])
  const resource = await seedSharedResource(db, fixture.tenant.id, {
    ownerGroupId: itIdentity.id,
  })
  const staging = await seedResourceValues(db, cfg, resource, 'staging')
  return { ...fixture, itIdentity, resource, staging }
}

describe('shared_resources and their values', () => {
  it('a slug is unique per organisation, and one version is ACTIVE per environment', async () => {
    const { tenant, itIdentity, resource, staging } = await seedWorld()
    expect(
      errorText(
        await caught(
          seedSharedResource(db, tenant.id, { ownerGroupId: itIdentity.id, slug: resource.slug })
        )
      )
    ).toMatch(/shared_resources_tenant_slug_key|duplicate key/)

    // A second ACTIVE version conflicts; the rotation shape (old → retiring, new active) does not.
    expect(
      errorText(await caught(seedResourceValues(db, cfg, resource, 'staging', {}, { version: 2 })))
    ).toMatch(/shared_resource_values_active_idx|duplicate key/)
    await db
      .update(sharedResourceValues)
      .set({ status: 'retiring' })
      .where(
        and(eq(sharedResourceValues.tenantId, tenant.id), eq(sharedResourceValues.id, staging.id))
      )
    const next = await seedResourceValues(db, cfg, resource, 'staging', {}, { version: 2 })
    expect(next.status).toBe('active')
    // A version number is used once per environment; production counts on its own.
    expect(
      errorText(
        await caught(
          seedResourceValues(db, cfg, resource, 'staging', {}, { version: 2, status: 'retired' })
        )
      )
    ).toMatch(/shared_resource_values_version_key|duplicate key/)
    expect((await seedResourceValues(db, cfg, resource, 'production')).version).toBe(1)
    expect((await activeVersion(db, tenant.id, resource.id, 'staging'))?.id).toBe(next.id)
    expect(await activeVersion(db, crypto.randomUUID(), resource.id, 'staging')).toBeNull()
    expect((await loadResource(db, tenant.id, resource.id)).items).toEqual(M365_ITEMS)
    await expect(loadResource(db, crypto.randomUUID(), resource.id)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('values are sealed: the blob round-trips and never holds the plaintext', async () => {
    const { staging } = await seedWorld()
    expect(staging.sealed).not.toContain(M365_VALUES.M365_CLIENT_SECRET)
    expect(await openValues(cfg, staging.sealed)).toEqual(M365_VALUES)
    const again = await sealValues(cfg, M365_VALUES)
    expect(again).not.toBe(staging.sealed) // a fresh IV every time
    await expect(openValues(cfg, await sealValues(cfg, {}))).resolves.toEqual({})
    const notAnObject = await caught(
      openValues(cfg, await encrypt('[1]', cfg.OAUTH_ENCRYPTION_KEY ?? ''))
    )
    expect(errorText(notAnObject)).toMatch(/not an object/)
  })

  it('the owner group cannot be deleted while it owns a resource — 409, and the FK agrees', async () => {
    const { tenant, itIdentity } = await seedWorld()
    const refusal = await caught(deleteGroup(db, tenant.id, itIdentity.id))
    expect(refusal).toMatchObject({ statusCode: 409, code: 'group_owns_shared_config' })
    const byType = await caught(deleteGroupType(db, tenant.id, itIdentity.groupTypeId))
    expect(byType).toMatchObject({ statusCode: 409, code: 'group_owns_shared_config' })
    const raw = await caught(
      db.delete(groups).where(and(eq(groups.tenantId, tenant.id), eq(groups.id, itIdentity.id)))
    )
    expect(errorText(raw)).toMatch(/shared_resources_owner_group_id_groups_id_fk|foreign key/)
    // A group owning nothing still deletes.
    const spare = await createTestGroup(db, tenant.id, 'Spare')
    await deleteGroup(db, tenant.id, spare.id)
  })
})

describe('grants, pushes and scans', () => {
  it('one LIVE grant per app × resource × environment; history does not block a new one', async () => {
    const { tenant, app, resource } = await seedWorld()
    const base = { tenantId: tenant.id, appId: app.id, resourceId: resource.id }
    const first = await seedGrant(db, { ...base, environment: 'staging', status: 'requested' })
    for (const status of ['requested', 'active', 'revoking'] as const) {
      expect(
        errorText(await caught(seedGrant(db, { ...base, environment: 'staging', status })))
      ).toMatch(/app_grants_live_idx|duplicate key/)
    }
    // Production is its own grant; a rejected staging one frees the slot.
    await seedGrant(db, { ...base, environment: 'production', status: 'requested' })
    await db
      .update(appGrants)
      .set({ status: 'rejected' })
      .where(and(eq(appGrants.tenantId, tenant.id), eq(appGrants.id, first.id)))
    expect((await seedGrant(db, { ...base, environment: 'staging' })).status).toBe('active')
  })

  it('one RUNNING push per resource environment, one push per approval, one target per grant', async () => {
    const { tenant, app, alice, resource, staging } = await seedWorld()
    const grant = await seedGrant(db, {
      tenantId: tenant.id,
      appId: app.id,
      resourceId: resource.id,
      environment: 'staging',
    })
    const push = {
      tenantId: tenant.id,
      resourceId: resource.id,
      environment: 'staging' as const,
      reason: 'rotate' as const,
      versionId: staging.id,
    }
    const [running] = await db.insert(grantPushes).values(push).returning()
    expect(running).toMatchObject({ status: 'queued', total: 0, succeeded: 0, failed: 0 })
    expect(errorText(await caught(db.insert(grantPushes).values(push)))).toMatch(
      /grant_pushes_active_idx|duplicate key/
    )
    // Production runs beside it; once staging's settles, another may start.
    await db.insert(grantPushes).values({ ...push, environment: 'production' })
    await db
      .update(grantPushes)
      .set({ status: 'partial' })
      .where(and(eq(grantPushes.tenantId, tenant.id), eq(grantPushes.id, running?.id ?? '')))

    const [approval] = await db
      .insert(approvalRequests)
      .values({
        tenantId: tenant.id,
        kind: 'grant.request',
        appId: app.id,
        subjectType: 'grant',
        subjectId: grant.id,
        requestedByUserId: alice.id,
        context: {
          kind: 'grant.request',
          resourceId: resource.id,
          resourceName: resource.displayName,
          environment: 'staging',
          items: M365_ITEMS.map(({ key, kind }) => ({ key, kind })),
          declaredBy: ['m365-connector'],
          appSlug: app.slug,
          expiresAt: null,
        },
        policy: DEFAULT_APPROVAL_POLICIES['grant.request'],
      })
      .returning()
    const withApproval = {
      ...push,
      reason: 'grant' as const,
      grantId: grant.id,
      approvalId: approval?.id,
    }
    const [granted] = await db.insert(grantPushes).values(withApproval).returning()
    await db
      .update(grantPushes)
      .set({ status: 'succeeded' })
      .where(and(eq(grantPushes.tenantId, tenant.id), eq(grantPushes.id, granted?.id ?? '')))
    expect(errorText(await caught(db.insert(grantPushes).values(withApproval)))).toMatch(
      /grant_pushes_approval_idx|duplicate key/
    )

    const target = {
      tenantId: tenant.id,
      pushId: granted?.id ?? '',
      grantId: grant.id,
      appId: app.id,
    }
    const [row] = await db.insert(grantPushTargets).values(target).returning()
    expect(row).toMatchObject({ status: 'pending', attempts: 0, names: [], error: null })
    expect(
      await db.insert(grantPushTargets).values(target).onConflictDoNothing().returning()
    ).toEqual([])
  })

  it('an app has one scan row; deleting the app takes its grants, targets and scan', async () => {
    const { tenant, resource, staging } = await seedWorld()
    const { app } = await seedApp(db, tenant.id, { environments: {} })
    const scan = {
      tenantId: tenant.id,
      appId: app.id,
      ref: 'refs/tags/0.2.0',
      declared: [{ key: 'M365_CLIENT_SECRET', secret: true, pluginId: 'm365-connector' }],
      needs: [resource.id],
    }
    await db.insert(appConfigScans).values(scan)
    expect(errorText(await caught(db.insert(appConfigScans).values(scan)))).toMatch(
      /app_config_scans_pkey|duplicate key/
    )
    const grant = await seedGrant(db, {
      tenantId: tenant.id,
      appId: app.id,
      resourceId: resource.id,
      environment: 'staging',
      pushedVersionId: staging.id,
    })
    const [push] = await db
      .insert(grantPushes)
      .values({
        tenantId: tenant.id,
        resourceId: resource.id,
        environment: 'staging',
        reason: 'grant',
        grantId: grant.id,
        versionId: staging.id,
        status: 'succeeded',
      })
      .returning()
    await db
      .insert(grantPushTargets)
      .values({ tenantId: tenant.id, pushId: push?.id ?? '', grantId: grant.id, appId: app.id })
    await forgetApps(db, [tenant.id])
    for (const table of [appGrants, grantPushTargets, appConfigScans]) {
      expect(await db.select().from(table).where(eq(table.tenantId, tenant.id))).toEqual([])
    }
    // The resource and its values stay: an app going never removes shared config.
    expect(await loadResource(db, tenant.id, resource.id)).toMatchObject({ id: resource.id })
  })

  it('a grant pins its resource (archive, never delete) but a tenant cascade takes everything', async () => {
    const { tenant, app, resource, staging } = await seedWorld()
    await seedGrant(db, {
      tenantId: tenant.id,
      appId: app.id,
      resourceId: resource.id,
      environment: 'staging',
      pushedVersionId: staging.id,
    })
    expect(
      errorText(
        await caught(
          db
            .delete(sharedResources)
            .where(
              and(eq(sharedResources.tenantId, tenant.id), eq(sharedResources.id, resource.id))
            )
        )
      )
    ).toMatch(/app_grants_resource_id_shared_resources_id_fk|foreign key/)
    await db.delete(tenants).where(eq(tenants.id, tenant.id))
    for (const table of [sharedResources, sharedResourceValues, appGrants, groups]) {
      expect(await db.select().from(table).where(eq(table.tenantId, tenant.id))).toEqual([])
    }
  })
})

describe('the P5 mounts', () => {
  it('/api/shared-resources answers the list to any member; 400 on a bad query; 401 without a session', async () => {
    const { tenant, carol, resource } = await seedWorld()
    const headers = sessionCookieHeader(await createTestSession(db, carol.id, tenant.id))
    const list = await request('/api/shared-resources', { headers })
    expect(list.status).toBe(200)
    // Slice 5b fills the list (tests/api/shared-resources.test.ts covers it).
    expect((await json<{ items: { id: string }[] }>(list)).items.map(i => i.id)).toEqual([
      resource.id,
    ])
    expect((await request('/api/shared-resources?archived=maybe', { headers })).status).toBe(400)
    expect((await request('/api/shared-resources')).status).toBe(401)
  })

  it('the routes 5b–5e fill are mounted but register nothing yet (a JSON 404)', async () => {
    const { tenant, admin, app, resource } = await seedWorld()
    const headers = sessionCookieHeader(await createTestSession(db, admin.id, tenant.id))
    for (const [method, url] of [['GET', `/api/shared-resources/${resource.id}/pushes`]] as const) {
      const res = await request(url, { method, headers })
      expect(res.status, `${method} ${url}`).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
    }
  })
})

describe('GRANT_PUSH_WORKFLOW', () => {
  it('is bound in tests, a WorkflowEntrypoint exported from worker.ts, and 503 when missing', () => {
    const env = createTestEnv()
    expect(stubs(env).grantPushWorkflow?.created).toEqual([])
    expect(requireGrantPushWorkflow(env)).toBe(env.GRANT_PUSH_WORKFLOW)
    expect(new GrantPushWorkflow({} as never, env)).toBeInstanceOf(WorkflowEntrypoint)
    expect(readFileSync(path.join(WEB_ROOT, 'src/worker.ts'), 'utf8')).toMatch(
      /export \{ GrantPushWorkflow \} from '\.\/api\/workflows\/grant-push'/
    )
    const { GRANT_PUSH_WORKFLOW: _, ...without } = env
    expect(() => requireGrantPushWorkflow(without as Partial<typeof env>)).toThrow(
      expect.objectContaining({ statusCode: 503, code: 'grants_not_configured' })
    )
  })
})

describe('the grants cron', () => {
  it('is registered and harmless until 5c fills it', async () => {
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled('*/5 * * * *', createTestEnv(), ctx, {
      '*/5 * * * *': [grantsSweep],
    })
    await waitOnExecutionContext(ctx)
    expect(reports.map(r => [r.task, r.status])).toEqual([['grants.sweep', 'ok']])
  })

  it('its scans find due expiries, due reminders and rotation candidates across tenants', async () => {
    const { tenant, app, resource, staging } = await seedWorld()
    const now = new Date()
    const day = 24 * 60 * 60 * 1000
    const base = { tenantId: tenant.id, appId: app.id, resourceId: resource.id }
    const expired = await seedGrant(db, {
      ...base,
      environment: 'staging',
      expiresAt: new Date(now.getTime() - 60_000),
    })
    const soon = await seedGrant(db, {
      ...base,
      environment: 'production',
      expiresAt: new Date(now.getTime() + 3 * day),
    })
    const { app: other } = await seedApp(db, tenant.id, { environments: {} })
    const later = await seedGrant(db, {
      ...base,
      appId: other.id,
      environment: 'staging',
      expiresAt: new Date(now.getTime() + 30 * day),
    })
    const due = (await dueForExpiry(db, now, 10_000)).map(g => g.id)
    expect(due).toContain(expired.id)
    expect(due).not.toContain(soon.id)
    const remind = (await dueForExpiryReminder(db, now, 10_000)).map(g => g.id)
    expect(remind).toContain(soon.id)
    expect(remind).not.toContain(later.id)
    expect(remind).not.toContain(expired.id)
    const candidates = await rotationCandidates(db, 10_000)
    expect(candidates.map(c => c.value.id)).toContain(staging.id)
    expect(candidates.find(c => c.value.id === staging.id)?.resource.id).toBe(resource.id)
  })
})

describe('the engine and the grant.request kind', () => {
  it('snapshots a policy handed in at open in place of the resolved one (§1.9)', async () => {
    const { tenant, app, alice, carol } = await seedWorld()
    const env = createTestEnv()
    const policy = {
      approvers: { appOwners: false, admins: false, groupIds: [], userIds: [carol.id] },
      minApprovals: 2,
      allowSelfApproval: false,
      expiresAfterMinutes: 60,
      autoApproveRole: null,
    }
    const { request: row, created } = await open(
      approvalDeps(db, env),
      accessOpen(tenant.id, app.id, alice, { policy })
    )
    expect(created).toBe(true)
    expect(row.policy).toEqual(policy)
    expect(row.requiredApprovals).toBe(2)
    expect(row.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000)
    expect(row.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60_000)
  })

  it('is registered with the §1.8 default (the owner group decides via eligibleExtra) and a title', async () => {
    const { tenant } = await seedWorld()
    const handler = kindHandler('grant.request')
    expect(handler.kind).toBe('grant.request')
    expect(await handler.defaultPolicy(db, tenant.id)).toEqual(
      DEFAULT_APPROVAL_POLICIES['grant.request']
    )
    expect(DEFAULT_APPROVAL_POLICIES['grant.request'].approvers).toEqual({
      appOwners: false,
      admins: false,
      groupIds: [],
      userIds: [],
    })
    expect(
      handler.describe({
        subjectId: 'x',
        context: {
          kind: 'grant.request',
          resourceId: crypto.randomUUID(),
          resourceName: 'M365',
          environment: 'production',
          items: [],
          declaredBy: [],
          appSlug: 'shop',
          expiresAt: null,
        },
      } as never)
    ).toBe('M365 for shop (production)')
  })
})

describe('the stubs before their slices', () => {
  it('fail by name, pointing at the slice that builds them', async () => {
    const env = createTestEnv()
    const deps = approvalDeps(db, env)
    const viewer = {} as never
    const actor = actorOf({ id: crypto.randomUUID(), email: 'a@example.com' })
    const cases: [() => unknown, RegExp][] = [
      [() => startPush(deps, {} as never), /push\.startPush .*5c/],
      [() => revokeGrant(deps, viewer, {} as never), /revokeGrant .*5c/],
      [() => new GrantPushWorkflow({} as never, env).run({} as never, {} as never), /run .*5c/],
    ]
    for (const [call, message] of cases) {
      const error = await caught(call)
      expect(error, String(message)).toBeInstanceOf(NotWiredError)
      expect(String((error as Error).message)).toMatch(message)
    }
  })
})
