// @vitest-isolate
// Mocks `services/grants/push` and `revoke` (slice 5c's), so this file needs its own module registry.
/**
 * Launch P5 slice 5d — an app asking for shared config (plan §1.7–§1.9): `requestGrant`, the
 * `grant.request` kind through the REAL approvals engine, `appConfigView`, `repushGrant` and the
 * `/api/apps/:id/config|grants` routes. 5c's `startPush` / `revokeGrant` are recording fakes (the
 * seam is 5a's stub signature), so what is pinned here is who decides, what a decision does to the
 * grant, and what it asks the push to do — not the push itself.
 *
 * What it pins: the RESOURCE's owner group decides and the admins do not by default; the requester
 * is excluded even when they own the resource; a production policy of N=2 needs two; staging
 * self-served under `autoApproveRole: 'member'` activates and pushes inside the request; a
 * rejection frees the live index; every refusal (403, archived, no values, already held, 503)
 * lands before any row; the config view matches declared keys to resources; 401/403/404 and tenant
 * isolation on the routes.
 */

import { type ApprovalPolicy, DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import {
  appConfigSchema,
  type GrantActionResponse,
  type RequestGrantResponse,
} from '@launch/shared/launch-grants'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decide, open } from '@/api/services/approvals/engine'
import { kindHandler } from '@/api/services/approvals/kinds'
import { eligibleApprovers } from '@/api/services/approvals/policy'
import type { ApprovalViewer } from '@/api/services/approvals/types'
import { appConfigView, repushGrant, requestGrant } from '@/api/services/grants/requests'
import type { StartPushInput } from '@/api/services/grants/types'
import { loadConfig } from '@/config'
import {
  appConfigScans,
  appGrants,
  approvalRequests,
  auditEvents,
  notifications,
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
import { M365_ITEMS, seedGrant, seedResourceValues, seedSharedResource } from '../helpers/grants'
import { forgetApps, seedApp } from '../helpers/launch-apps'
import { addTestAppOwner, createTestGroup } from '../helpers/oidc'
import { json, request } from '../helpers/request'
import { createTestEnv, type TestEnv } from '../mocks/bindings'

/** 5c's `startPush`, recorded: idempotent by `approvalId`, as its contract says. */
const pushes = vi.hoisted(() => ({
  calls: [] as unknown[],
  byApproval: new Map<string, string>(),
}))
vi.mock('@/api/services/grants/push', async importOriginal => ({
  ...(await importOriginal<object>()),
  startPush: async (_deps: unknown, input: { approvalId?: string | null }) => {
    pushes.calls.push(input)
    const known = input.approvalId ? pushes.byApproval.get(input.approvalId) : undefined
    if (known) return { pushId: known, created: false }
    const pushId = crypto.randomUUID()
    if (input.approvalId) pushes.byApproval.set(input.approvalId, pushId)
    return { pushId, created: true }
  },
}))

/** 5c's `revokeGrant`, recorded: the route's wiring is 5d's, the transition is 5c's. */
const revokes = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('@/api/services/grants/revoke', async importOriginal => ({
  ...(await importOriginal<object>()),
  revokeGrant: async (_deps: unknown, _viewer: unknown, input: unknown) => {
    revokes.calls.push(input)
    return { grant: {}, pushId: '00000000-0000-4000-8000-00000000abcd' }
  },
}))

const db = setupTestDatabase()
const tenantIds: string[] = []
let env: TestEnv

afterAll(async () => {
  await forgetApps(db, tenantIds)
})
beforeEach(() => {
  env = createTestEnv()
  pushes.calls.length = 0
  revokes.calls.length = 0
})

const pushCalls = () => pushes.calls as StartPushInput[]

type Person = { id: string; email: string }

/**
 * One organisation: `admin` (its owner), `alice` (a member who owns `app`), `carol` and `dave`
 * (members of "IT Identity", which owns the M365 resource), `erin` (a member with no part).
 * Values are set for both environments.
 */
async function world(policies: { staging?: ApprovalPolicy; production?: ApprovalPolicy } = {}) {
  const { tenant, user: admin } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const people: Person[] = []
  for (let i = 0; i < 4; i++) {
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, tenant.id, 'member')
    people.push(user)
  }
  const [alice, carol, dave, erin] = people as [Person, Person, Person, Person]
  const identity = await createTestGroup(db, tenant.id, 'IT Identity', [carol.id, dave.id])
  const { app } = await seedApp(db, tenant.id, { environments: {} })
  await addTestAppOwner(db, tenant.id, app.id, alice.id)
  const resource = await seedSharedResource(db, tenant.id, {
    ownerGroupId: identity.id,
    policies,
  })
  const cfg = loadConfig(env)
  const staging = await seedResourceValues(db, cfg, resource, 'staging')
  const production = await seedResourceValues(db, cfg, resource, 'production')
  const viewer = (person: Person, groupIds: string[] = []) =>
    viewerOf(db, tenant.id, person, groupIds)
  return {
    tenant,
    admin,
    alice,
    carol,
    dave,
    erin,
    identity,
    app,
    resource,
    versions: { staging, production },
    viewer,
    ownerViewer: (person: Person) => viewer(person, [identity.id]),
  }
}

type World = Awaited<ReturnType<typeof world>>

async function ask(
  w: World,
  who: Person = w.alice,
  environments: ('staging' | 'production')[] = ['staging', 'production']
) {
  return requestGrant(
    approvalDeps(db, env),
    await w.viewer(who),
    w.app.id,
    { resourceId: w.resource.id, environments, reason: 'The M365 connector needs it' },
    actorOf(who)
  )
}

async function decideAs(
  viewer: ApprovalViewer,
  requestId: string,
  decision: 'approve' | 'reject' = 'approve'
) {
  return decide(approvalDeps(db, env), {
    requestId,
    viewer,
    decision,
    actor: actorOf({ id: viewer.userId, email: viewer.email }),
  })
}

async function grantRow(id: string) {
  const [row] = await db.select().from(appGrants).where(eq(appGrants.id, id))
  if (!row) throw new Error(`no grant ${id}`)
  return row
}

async function approvalRow(id: string) {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id))
  if (!row) throw new Error(`no approval ${id}`)
  return row
}

async function caught(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (err) {
    return err as { statusCode?: number; code?: string }
  }
  throw new Error('expected a throw')
}

function entry(result: RequestGrantResponse, environment: 'staging' | 'production') {
  const found = result.grants.find(g => g.environment === environment)
  if (!found?.approvalId) throw new Error(`no ${environment} grant`)
  return found as typeof found & { approvalId: string }
}

describe('requesting: one grant and one grant.request per environment', () => {
  it('opens two approvals the owner group decides — not the admins, not the requester', async () => {
    const w = await world()
    const result = await ask(w)
    expect(result.grants.map(g => [g.environment, g.status])).toEqual([
      ['staging', 'requested'],
      ['production', 'requested'],
    ])
    for (const g of result.grants) {
      const grant = await grantRow(g.id)
      expect(grant).toMatchObject({
        status: 'requested',
        approvalId: g.approvalId,
        requestedByUserId: w.alice.id,
        pushedVersionId: null,
      })
      const approval = await approvalRow(g.approvalId as string)
      expect(approval).toMatchObject({
        kind: 'grant.request',
        subjectType: 'grant',
        subjectId: g.id,
        appId: w.app.id,
        status: 'pending',
        requiredApprovals: 1,
      })
      expect(approval.policy).toEqual(DEFAULT_APPROVAL_POLICIES['grant.request'])
      expect(approval.context).toMatchObject({
        kind: 'grant.request',
        resourceId: w.resource.id,
        environment: g.environment,
        appSlug: w.app.slug,
        items: M365_ITEMS.map(i => ({ key: i.key, kind: i.kind })),
      })
      expect(new Set(await eligibleApprovers(db, approval))).toEqual(
        new Set([w.carol.id, w.dave.id])
      )
    }
    // Carol is told; the admin is not.
    const told = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(
        and(eq(notifications.tenantId, w.tenant.id), eq(notifications.type, 'approval_requested'))
      )
    expect(told.filter(n => n.userId === w.carol.id)).toHaveLength(2)
    expect(told.some(n => n.userId === w.admin.id)).toBe(false)
    expect(pushCalls()).toHaveLength(0)

    const staging = entry(result, 'staging')
    // The admin and an unrelated member are refused; the requester too.
    const byAdmin = await caught(async () => decideAs(await w.viewer(w.admin), staging.approvalId))
    expect(byAdmin).toMatchObject({ statusCode: 403, code: 'not_an_approver' })
    // A member with no part in it cannot even see it: the engine's 404.
    const byErin = await caught(async () => decideAs(await w.viewer(w.erin), staging.approvalId))
    expect(byErin).toMatchObject({ statusCode: 404 })
    const byAlice = await caught(async () => decideAs(await w.viewer(w.alice), staging.approvalId))
    expect(byAlice).toMatchObject({ statusCode: 403, code: 'self_approval' })
    expect((await grantRow(staging.id)).status).toBe('requested')

    // Carol approves: the grant goes active, pending its push, and the push is started.
    const detail = await decideAs(await w.ownerViewer(w.carol), staging.approvalId)
    expect(detail.status).toBe('approved')
    const active = await grantRow(staging.id)
    expect(active).toMatchObject({ status: 'active', pushedVersionId: null, pushError: null })
    expect(pushCalls()).toEqual([
      {
        tenantId: w.tenant.id,
        resourceId: w.resource.id,
        environment: 'staging',
        reason: 'grant',
        grantId: staging.id,
        versionId: w.versions.staging.id,
        approvalId: staging.approvalId,
        startedByUserId: w.carol.id,
      },
    ])
    expect((await approvalRow(staging.approvalId)).appliedAt).not.toBeNull()
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, w.tenant.id), eq(auditEvents.targetId, staging.id)))
    const approved = audits.find(a => a.action === 'grant.approved')
    expect(approved).toMatchObject({ actorUserId: w.carol.id, approvalId: staging.approvalId })
    expect(audits.map(a => a.action)).toEqual(
      expect.arrayContaining(['grant.requested', 'approval.requested', 'approval.approved'])
    )
    // No value in any audit row.
    expect(JSON.stringify(audits)).not.toContain('sentinel-m365-secret')

    // Production still waits on its own approval.
    expect((await grantRow(entry(result, 'production').id)).status).toBe('requested')
  })

  it('applyAfter is idempotent by approval and leaves a grant that is no longer active alone', async () => {
    const w = await world()
    const staging = entry(await ask(w, w.alice, ['staging']), 'staging')
    await decideAs(await w.ownerViewer(w.carol), staging.approvalId)
    const handler = kindHandler('grant.request')
    const request = await approvalRow(staging.approvalId)
    await handler.applyAfter(request, approvalDeps(db, env))
    expect(pushCalls()).toHaveLength(2)
    expect(pushCalls()[1]?.approvalId).toBe(staging.approvalId)
    // Revoked since (5c): nothing more to push.
    await db.update(appGrants).set({ status: 'revoked' }).where(eq(appGrants.id, staging.id))
    await handler.applyAfter(request, approvalDeps(db, env))
    expect(pushCalls()).toHaveLength(2)
  })

  it('a production policy of N=2 needs both owners', async () => {
    const production: ApprovalPolicy = {
      ...DEFAULT_APPROVAL_POLICIES['grant.request'],
      minApprovals: 2,
    }
    const w = await world({ production })
    const prod = entry(await ask(w, w.alice, ['production']), 'production')
    const approval = await approvalRow(prod.approvalId)
    expect(approval.requiredApprovals).toBe(2)
    expect(approval.policy).toEqual(production)

    expect((await decideAs(await w.ownerViewer(w.carol), prod.approvalId)).status).toBe('pending')
    expect((await grantRow(prod.id)).status).toBe('requested')
    expect(pushCalls()).toHaveLength(0)
    expect((await decideAs(await w.ownerViewer(w.dave), prod.approvalId)).status).toBe('approved')
    expect((await grantRow(prod.id)).status).toBe('active')
    expect(pushCalls()).toHaveLength(1)
    expect(pushCalls()[0]).toMatchObject({
      environment: 'production',
      versionId: w.versions.production.id,
    })
  })

  it('staging self-serves under autoApproveRole member; production still asks', async () => {
    const staging: ApprovalPolicy = {
      ...DEFAULT_APPROVAL_POLICIES['grant.request'],
      autoApproveRole: 'member',
    }
    const w = await world({ staging })
    const result = await ask(w)
    const s = entry(result, 'staging')
    const p = entry(result, 'production')
    expect(s.status).toBe('active')
    expect(p.status).toBe('requested')
    expect(await approvalRow(s.approvalId)).toMatchObject({ status: 'approved' })
    expect(await approvalRow(p.approvalId)).toMatchObject({ status: 'pending' })
    expect(await grantRow(s.id)).toMatchObject({ status: 'active', approvalId: s.approvalId })
    expect(pushCalls()).toEqual([
      expect.objectContaining({ grantId: s.id, reason: 'grant', approvalId: s.approvalId }),
    ])
  })

  it('an owner of the resource who asks for their own app still needs another owner', async () => {
    const w = await world()
    await addTestAppOwner(db, w.tenant.id, w.app.id, w.carol.id)
    const staging = entry(await ask(w, w.carol, ['staging']), 'staging')
    const self = await caught(async () =>
      decideAs(await w.ownerViewer(w.carol), staging.approvalId)
    )
    expect(self).toMatchObject({ statusCode: 403, code: 'self_approval' })
    expect((await decideAs(await w.ownerViewer(w.dave), staging.approvalId)).status).toBe(
      'approved'
    )
  })

  it('a rejection closes the grant and frees the app to ask again', async () => {
    const w = await world()
    const staging = entry(await ask(w, w.alice, ['staging']), 'staging')
    await decideAs(await w.ownerViewer(w.dave), staging.approvalId, 'reject')
    expect((await grantRow(staging.id)).status).toBe('rejected')
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, w.tenant.id),
          eq(auditEvents.targetId, staging.id),
          eq(auditEvents.action, 'grant.rejected')
        )
      )
    expect(audit).toMatchObject({ actorUserId: w.dave.id, approvalId: staging.approvalId })
    expect(pushCalls()).toHaveLength(0)
    const again = entry(await ask(w, w.alice, ['staging']), 'staging')
    expect(again.id).not.toBe(staging.id)
  })

  it('an expired approval expires the grant', async () => {
    const w = await world()
    const staging = entry(await ask(w, w.alice, ['staging']), 'staging')
    const request = await approvalRow(staging.approvalId)
    await kindHandler('grant.request').onClosed?.(request, 'expired', approvalDeps(db, env))
    expect((await grantRow(staging.id)).status).toBe('expired')
  })

  it('refuses before any row: not an owner, archived, no values, already held, no binding', async () => {
    const w = await world()
    const count = async () =>
      (await db.select().from(appGrants).where(eq(appGrants.appId, w.app.id))).length

    expect(await caught(() => ask(w, w.erin))).toMatchObject({ statusCode: 403 })

    const bare = await seedSharedResource(db, w.tenant.id, { ownerGroupId: w.identity.id })
    await seedResourceValues(db, loadConfig(env), bare, 'staging')
    const noProd = await caught(async () =>
      requestGrant(
        approvalDeps(db, env),
        await w.viewer(w.alice),
        w.app.id,
        { resourceId: bare.id, environments: ['staging', 'production'], reason: 'r' },
        actorOf(w.alice)
      )
    )
    expect(noProd).toMatchObject({ statusCode: 409, code: 'values_not_set' })

    const archived = await seedSharedResource(db, w.tenant.id, {
      ownerGroupId: w.identity.id,
      archivedAt: new Date(),
    })
    const gone = await caught(async () =>
      requestGrant(
        approvalDeps(db, env),
        await w.viewer(w.alice),
        w.app.id,
        { resourceId: archived.id, environments: ['staging'], reason: 'r' },
        actorOf(w.alice)
      )
    )
    expect(gone).toMatchObject({ statusCode: 409, code: 'shared_resource_archived' })

    const past = await caught(async () =>
      requestGrant(
        approvalDeps(db, env),
        await w.viewer(w.alice),
        w.app.id,
        {
          resourceId: w.resource.id,
          environments: ['staging'],
          reason: 'r',
          expiresAt: new Date(Date.now() - 1000),
        },
        actorOf(w.alice)
      )
    )
    expect(past).toMatchObject({ statusCode: 400, code: 'grant_expiry_past' })

    env = createTestEnv({ GRANT_PUSH_WORKFLOW: undefined })
    expect(await caught(() => ask(w))).toMatchObject({
      statusCode: 503,
      code: 'grants_not_configured',
    })
    env = createTestEnv()
    expect(await count()).toBe(0)

    await ask(w, w.alice, ['production'])
    // Staging is new, production is held: all or nothing.
    expect(await caught(() => ask(w))).toMatchObject({
      statusCode: 409,
      code: 'grant_already_held',
    })
    expect(await count()).toBe(1)
  })
})

describe('the config view', () => {
  it('matches declared keys to resources, lists needs and unmatched keys, and each grant', async () => {
    const w = await world()
    await db.insert(appConfigScans).values({
      tenantId: w.tenant.id,
      appId: w.app.id,
      ref: 'main',
      sha: 'abc123',
      declared: [
        ...M365_ITEMS.map(i => ({ key: i.key, secret: i.kind === 'secret', pluginId: 'm365' })),
        { key: 'OPENAI_API_KEY', secret: true, pluginId: 'kit' },
      ],
    })
    const before = await appConfigView(db, await w.viewer(w.erin), w.app.id)
    expect(appConfigSchema.parse(before)).toBeTruthy()
    expect(before.canRequest).toBe(false)
    expect(before.needs).toEqual([w.resource.id])
    expect(before.unmatched).toEqual(['OPENAI_API_KEY'])
    expect(before.matched).toHaveLength(1)
    expect(before.matched[0]).toMatchObject({
      resource: { id: w.resource.id, archived: false },
      keys: M365_ITEMS.map(i => i.key),
      declaredBy: ['m365'],
      grants: { staging: null, production: null },
    })

    const staging = entry(await ask(w, w.alice, ['staging']), 'staging')
    const approval = await approvalRow(staging.approvalId)
    expect(approval.context).toMatchObject({ declaredBy: ['m365'] })
    const after = await appConfigView(db, await w.viewer(w.alice), w.app.id)
    expect(after.canRequest).toBe(true)
    expect(after.needs).toEqual([])
    expect(after.matched[0]?.grants.staging).toMatchObject({
      id: staging.id,
      status: 'requested',
      resource: { id: w.resource.id, slug: w.resource.slug },
    })
    expect(after.matched[0]?.grants.production).toBeNull()
    expect(after.grants.map(g => g.id)).toEqual([staging.id])
  })

  it('shows the pushed version number, never a value', async () => {
    const w = await world()
    await seedGrant(db, {
      tenantId: w.tenant.id,
      appId: w.app.id,
      resourceId: w.resource.id,
      environment: 'production',
      pushedVersionId: w.versions.production.id,
      pushedAt: new Date(),
    })
    const view = await appConfigView(db, await w.viewer(w.alice), w.app.id)
    expect(view.grants[0]).toMatchObject({ status: 'active', pushedVersion: 1 })
    expect(JSON.stringify(view)).not.toContain('sentinel-m365-secret')
  })
})

describe('re-pushing', () => {
  it('starts a repair push of the active version for an active grant; 409 otherwise', async () => {
    const w = await world()
    const grant = await seedGrant(db, {
      tenantId: w.tenant.id,
      appId: w.app.id,
      resourceId: w.resource.id,
      environment: 'staging',
    })
    const result = await repushGrant(
      approvalDeps(db, env),
      await w.ownerViewer(w.carol),
      w.app.id,
      grant.id,
      actorOf(w.carol)
    )
    expect(result.grant.id).toBe(grant.id)
    expect(pushCalls()).toEqual([
      expect.objectContaining({
        reason: 'repair',
        grantId: grant.id,
        versionId: w.versions.staging.id,
        environment: 'staging',
      }),
    ])
    expect(result.pushId).toBeTruthy()

    const erin = await caught(async () =>
      repushGrant(
        approvalDeps(db, env),
        await w.viewer(w.erin),
        w.app.id,
        grant.id,
        actorOf(w.erin)
      )
    )
    expect(erin).toMatchObject({ statusCode: 403 })

    const requested = await seedGrant(db, {
      tenantId: w.tenant.id,
      appId: w.app.id,
      resourceId: w.resource.id,
      environment: 'production',
      status: 'requested',
    })
    const notActive = await caught(async () =>
      repushGrant(
        approvalDeps(db, env),
        await w.viewer(w.alice),
        w.app.id,
        requested.id,
        actorOf(w.alice)
      )
    )
    expect(notActive).toMatchObject({ statusCode: 409, code: 'grant_not_active' })
  })
})

describe('/api/apps/:id/config and /grants', () => {
  async function cookieOf(tenantId: string, person: Person) {
    return sessionCookieHeader(await createTestSession(db, person.id, tenantId))
  }

  it('401 without a session', async () => {
    const w = await world()
    const id = w.app.id
    for (const [method, path] of [
      ['GET', `/api/apps/${id}/config`],
      ['POST', `/api/apps/${id}/grants`],
      ['DELETE', `/api/apps/${id}/grants/${crypto.randomUUID()}`],
      ['POST', `/api/apps/${id}/grants/${crypto.randomUUID()}/repush`],
    ] as const) {
      const res = await request(
        path,
        { method },
        { env, ...(method === 'GET' ? {} : { json: {} }) }
      )
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  it('reads for any member, requests for owners (202), 403 for others, 400 on a bad body', async () => {
    const w = await world()
    const erin = await cookieOf(w.tenant.id, w.erin)
    const alice = await cookieOf(w.tenant.id, w.alice)

    const read = await request(`/api/apps/${w.app.id}/config`, { headers: erin }, { env })
    expect(read.status).toBe(200)
    expect(appConfigSchema.parse(await json(read)).canRequest).toBe(false)

    const body = { resourceId: w.resource.id, environments: ['staging'], reason: 'M365' }
    const refused = await request(
      `/api/apps/${w.app.id}/grants`,
      { method: 'POST', headers: erin },
      { env, json: body }
    )
    expect(refused.status).toBe(403)

    const bad = await request(
      `/api/apps/${w.app.id}/grants`,
      { method: 'POST', headers: alice },
      { env, json: { ...body, environments: ['staging', 'staging'] } }
    )
    expect(bad.status).toBe(400)

    const asked = await request(
      `/api/apps/${w.app.id}/grants`,
      { method: 'POST', headers: alice },
      { env, json: body }
    )
    expect(asked.status).toBe(202)
    const result = await json<RequestGrantResponse>(asked)
    expect(result.grants).toEqual([
      expect.objectContaining({ environment: 'staging', status: 'requested' }),
    ])

    const again = await request(
      `/api/apps/${w.app.id}/grants`,
      { method: 'POST', headers: alice },
      { env, json: body }
    )
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ code: 'grant_already_held' })

    // 503 before any row without the binding.
    const noBinding = await request(
      `/api/apps/${w.app.id}/grants`,
      { method: 'POST', headers: alice },
      {
        env: createTestEnv({ GRANT_PUSH_WORKFLOW: undefined }),
        json: { ...body, environments: ['production'] },
      }
    )
    expect(noBinding.status).toBe(503)
    expect(await json(noBinding)).toMatchObject({ code: 'grants_not_configured' })
  })

  it('revoke and repush go through the services; a grant of another app is a 404', async () => {
    const w = await world()
    const alice = await cookieOf(w.tenant.id, w.alice)
    const grant = await seedGrant(db, {
      tenantId: w.tenant.id,
      appId: w.app.id,
      resourceId: w.resource.id,
      environment: 'staging',
    })
    const revoked = await request(
      `/api/apps/${w.app.id}/grants/${grant.id}`,
      { method: 'DELETE', headers: alice },
      { env, json: { reason: 'no longer needed' } }
    )
    expect(revoked.status).toBe(202)
    expect((await json<GrantActionResponse>(revoked)).grant.id).toBe(grant.id)
    expect(revokes.calls).toEqual([
      expect.objectContaining({ appId: w.app.id, grantId: grant.id, reason: 'no longer needed' }),
    ])
    // No body at all is fine too.
    const bare = await request(
      `/api/apps/${w.app.id}/grants/${grant.id}`,
      { method: 'DELETE', headers: alice },
      { env }
    )
    expect(bare.status).toBe(202)

    const repushed = await request(
      `/api/apps/${w.app.id}/grants/${grant.id}/repush`,
      { method: 'POST', headers: alice },
      { env }
    )
    expect(repushed.status).toBe(202)
    expect((await json<GrantActionResponse>(repushed)).pushId).toBeTruthy()

    const { app: other } = await seedApp(db, w.tenant.id, { environments: {} })
    await addTestAppOwner(db, w.tenant.id, other.id, w.alice.id)
    revokes.calls.length = 0
    const wrongApp = await request(
      `/api/apps/${other.id}/grants/${grant.id}`,
      { method: 'DELETE', headers: alice },
      { env }
    )
    expect(wrongApp.status).toBe(404)
    expect(revokes.calls).toHaveLength(0)
    const wrongRepush = await request(
      `/api/apps/${other.id}/grants/${grant.id}/repush`,
      { method: 'POST', headers: alice },
      { env }
    )
    expect(wrongRepush.status).toBe(404)
  })

  it('tenant isolation: another organisation’s app, grant and resource are 404s', async () => {
    const w = await world()
    const x = await world()
    const alice = await cookieOf(w.tenant.id, w.alice)
    const xGrant = await seedGrant(db, {
      tenantId: x.tenant.id,
      appId: x.app.id,
      resourceId: x.resource.id,
      environment: 'staging',
    })
    const paths = [
      ['GET', `/api/apps/${x.app.id}/config`, undefined],
      [
        'POST',
        `/api/apps/${x.app.id}/grants`,
        { resourceId: x.resource.id, environments: ['staging'], reason: 'r' },
      ],
      ['DELETE', `/api/apps/${x.app.id}/grants/${xGrant.id}`, undefined],
      ['POST', `/api/apps/${x.app.id}/grants/${xGrant.id}/repush`, undefined],
    ] as const
    for (const [method, path, body] of paths) {
      const res = await request(
        path,
        { method, headers: alice },
        { env, ...(method === 'GET' ? {} : { json: body ?? {} }) }
      )
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    // Their resource on my app: 404, and no row.
    const foreign = await request(
      `/api/apps/${w.app.id}/grants`,
      { method: 'POST', headers: alice },
      { env, json: { resourceId: x.resource.id, environments: ['staging'], reason: 'r' } }
    )
    expect(foreign.status).toBe(404)
    expect(await db.select().from(appGrants).where(eq(appGrants.appId, w.app.id))).toHaveLength(0)
    // Their owners are not my approvers.
    const mine = entry(await ask(w, w.alice, ['staging']), 'staging')
    const xCarol = await caught(async () =>
      decideAs(await viewerOf(db, w.tenant.id, x.carol, [x.identity.id]), mine.approvalId)
    )
    expect(xCarol).toMatchObject({ statusCode: 404 })
    expect(revokes.calls).toHaveLength(0)
  })
})

describe('the kind in the engine', () => {
  it('eligibleExtra is the resource owner group, read at decide time', async () => {
    const w = await world()
    const grant = await seedGrant(db, {
      tenantId: w.tenant.id,
      appId: w.app.id,
      resourceId: w.resource.id,
      environment: 'staging',
      status: 'requested',
    })
    const { request: row } = await open(approvalDeps(db, env), {
      tenantId: w.tenant.id,
      kind: 'grant.request',
      subject: { type: 'grant', id: grant.id },
      appId: w.app.id,
      requester: { userId: w.alice.id, email: w.alice.email, role: 'member' },
      context: {
        kind: 'grant.request',
        resourceId: w.resource.id,
        resourceName: w.resource.displayName,
        environment: 'staging',
        items: [],
        declaredBy: [],
        appSlug: w.app.slug,
        expiresAt: null,
      },
    })
    expect(new Set(await kindHandler('grant.request').eligibleExtra?.(db, row))).toEqual(
      new Set([w.carol.id, w.dave.id])
    )
  })
})
