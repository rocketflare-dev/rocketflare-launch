/**
 * Issue #5 (`docs/plans/i5-ship-to-staging.md` §1.10–§1.11, decision §0.3): an app's ship settings
 * and the review rule a landing snapshots.
 *
 * - `PUT /api/apps/:id/ship-settings` — the app's owners and admins (`mayDeployApp`), validated by
 *   the shared schema, answered with the app detail, audited `app.ship_settings.updated` with
 *   before / after. A plain member is 403, another organisation's app 404.
 * - An admin `approval_policies` row for `session.merge` — app, owner group or tenant scope —
 *   wins: the detail says `shipReviewSetBy: 'policy'`, a change to the review is 409
 *   `ship_review_set_by_policy`, and the ship mode alone may still change.
 * - `reviewPolicyFor`: `none` → nothing to open; `app_owners` / `groups` → N=1, no self-approval,
 *   48 h, no auto-approve; a policy row → its own policy, `setBy: 'policy'`.
 */
import { type ApprovalPolicy, SESSION_MERGE_EXPIRY_HOURS } from '@launch/shared/launch-approvals'
import { appDetailSchema, DEFAULT_APP_SHIP_SETTINGS } from '@launch/shared/launch-apps'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { putPolicy } from '@/api/services/approvals/policy'
import { reviewPolicyFor } from '@/api/services/launch/ship-settings'
import { type AppRow, apps, auditEvents, groupMembers } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, seedApp } from '../helpers/launch-apps'
import { addTestAppOwner, createTestGroup } from '../helpers/oidc'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

type Headers = Record<string, string>

async function member(tenantId: string, role: 'admin' | 'member' = 'member') {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return {
    user,
    headers: sessionCookieHeader(await createTestSession(db, user.id, tenantId)),
  }
}

/** An organisation (owner = admin), alice who owns the app, carol a plain member, a team. */
async function fixture() {
  const { tenant, user: admin } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const alice = await member(tenant.id)
  const carol = await member(tenant.id)
  const ownerGroup = await createTestGroup(db, tenant.id, 'Shop team')
  const reviewers = await createTestGroup(db, tenant.id, 'Reviewers', [carol.user.id])
  const { app } = await seedApp(db, tenant.id, { environments: {}, ownerGroupId: ownerGroup.id })
  await addTestAppOwner(db, tenant.id, app.id, alice.user.id)
  return {
    tenantId: tenant.id,
    admin: {
      user: admin,
      headers: sessionCookieHeader(await createTestSession(db, admin.id, tenant.id)),
    },
    alice,
    carol,
    ownerGroup,
    reviewers,
    app,
  }
}

function put(appId: string, headers: Headers, body: unknown) {
  return request(`/api/apps/${appId}/ship-settings`, { method: 'PUT', headers }, { json: body })
}

async function detail(slug: string, headers: Headers) {
  const res = await request(`/api/apps/${slug}`, { headers })
  expect(res.status).toBe(200)
  return appDetailSchema.parse(await res.json())
}

async function appRow(tenantId: string, appId: string): Promise<AppRow> {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)))
  if (!row) throw new Error('no app')
  return row
}

const policy = (patch: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  approvers: { appOwners: false, admins: true, groupIds: [], userIds: [] },
  minApprovals: 2,
  allowSelfApproval: false,
  expiresAfterMinutes: 60,
  autoApproveRole: null,
  ...patch,
})

describe('PUT /api/apps/:id/ship-settings', () => {
  it('defaults every app to staging with no review, set by the app', async () => {
    const { app, alice } = await fixture()
    const body = await detail(app.slug, alice.headers)
    expect(body.shipSettings).toEqual(DEFAULT_APP_SHIP_SETTINGS)
    expect(body.shipReviewSetBy).toBe('app')
  })

  it('lets an owner set it: answered with the detail, stored, audited before / after', async () => {
    const { tenantId, app, alice, reviewers } = await fixture()
    const res = await put(app.id, alice.headers, {
      sessionShip: 'pr',
      review: { mode: 'groups', groupIds: [reviewers.id, reviewers.id] },
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = appDetailSchema.parse(await res.json())
    // Duplicates folded; the detail is the stored value.
    const expected = { sessionShip: 'pr', review: { mode: 'groups', groupIds: [reviewers.id] } }
    expect(body.shipSettings).toEqual(expected)
    expect((await appRow(tenantId, app.id)).shipSettings).toEqual(expected)

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.appId, app.id),
          eq(auditEvents.action, 'app.ship_settings.updated')
        )
      )
    expect(audit).toMatchObject({
      actorUserId: alice.user.id,
      targetType: 'App',
      targetId: app.id,
      summary: { before: DEFAULT_APP_SHIP_SETTINGS, after: expected },
    })
  })

  it('clears the teams when the mode is not `groups`', async () => {
    const { app, admin, reviewers } = await fixture()
    const res = await put(app.id, admin.headers, {
      sessionShip: 'staging',
      review: { mode: 'app_owners', groupIds: [reviewers.id] },
    })
    expect(res.status).toBe(200)
    const body = appDetailSchema.parse(await res.json())
    expect(body.shipSettings.review).toEqual({ mode: 'app_owners', groupIds: [] })
  })

  it('lets a member of the owner group and an admin set it; a plain member is 403', async () => {
    const { tenantId, app, admin, carol, ownerGroup } = await fixture()
    const settings = { sessionShip: 'staging', review: { mode: 'app_owners', groupIds: [] } }
    expect((await put(app.id, admin.headers, settings)).status).toBe(200)

    const refused = await put(app.id, carol.headers, settings)
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ statusCode: 403, code: 'forbidden' })

    const viaGroup = await member(tenantId)
    await createTestGroup(db, tenantId, 'unrelated', [viaGroup.user.id])
    expect((await put(app.id, viaGroup.headers, settings)).status).toBe(403)
    await db
      .insert(groupMembers)
      .values({ tenantId, groupId: ownerGroup.id, userId: viaGroup.user.id })
    // A fresh session: the auth context carries the caller's groups.
    const fresh = sessionCookieHeader(await createTestSession(db, viaGroup.user.id, tenantId))
    expect((await put(app.id, fresh, settings)).status).toBe(200)
  })

  it('401 without a session; 404 for another organisation’s app, even for its admin', async () => {
    const { app } = await fixture()
    const settings = { sessionShip: 'pr', review: { mode: 'none', groupIds: [] } }
    expect((await put(app.id, {}, settings)).status).toBe(401)

    const other = await fixture()
    const res = await put(app.id, other.admin.headers, settings)
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ statusCode: 404, code: 'app_not_found' })
    expect((await appRow(app.tenantId, app.id)).shipSettings).toBeNull()
  })

  it('validates the body: `groups` names a team, and only this organisation’s', async () => {
    const { app, admin } = await fixture()
    const empty = await put(app.id, admin.headers, {
      sessionShip: 'staging',
      review: { mode: 'groups', groupIds: [] },
    })
    expect(empty.status).toBe(400)
    expect(await json(empty)).toMatchObject({ statusCode: 400, code: 'validation_failed' })

    const bad = await put(app.id, admin.headers, { sessionShip: 'production', review: {} })
    expect(bad.status).toBe(400)

    const other = await fixture()
    const foreign = await put(app.id, admin.headers, {
      sessionShip: 'staging',
      review: { mode: 'groups', groupIds: [other.reviewers.id] },
    })
    expect(foreign.status).toBe(400)
    expect(await json(foreign)).toMatchObject({ code: 'unknown_group' })
  })
})

describe('an admin `session.merge` policy wins over the app setting', () => {
  it('app scope: read-only review (409), the ship mode still changes', async () => {
    const { tenantId, app, admin, alice } = await fixture()
    await putPolicy(
      db,
      tenantId,
      { kind: 'session.merge', scopeType: 'app', scopeId: app.id, ...policy() },
      admin.user.id
    )
    expect((await detail(app.slug, alice.headers)).shipReviewSetBy).toBe('policy')

    const refused = await put(app.id, alice.headers, {
      sessionShip: 'staging',
      review: { mode: 'app_owners', groupIds: [] },
    })
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({
      statusCode: 409,
      code: 'ship_review_set_by_policy',
    })
    // An admin is refused too: the policy page is where the rule changes.
    const asAdmin = await put(app.id, admin.headers, {
      sessionShip: 'staging',
      review: { mode: 'app_owners', groupIds: [] },
    })
    expect(asAdmin.status).toBe(409)
    // The review sent back as it stands (`none`, the default) with a new ship mode is fine.
    const changed = await put(app.id, alice.headers, {
      sessionShip: 'pr',
      review: { mode: 'none', groupIds: [] },
    })
    expect(changed.status).toBe(200)
    expect(appDetailSchema.parse(await changed.json()).shipSettings.sessionShip).toBe('pr')
  })

  it('owner-group and tenant scope govern too; another organisation’s row does not', async () => {
    const { tenantId, app, admin, alice, ownerGroup } = await fixture()
    const other = await fixture()
    await putPolicy(
      db,
      other.tenantId,
      { kind: 'session.merge', scopeType: 'tenant', scopeId: null, ...policy() },
      other.admin.user.id
    )
    expect((await detail(app.slug, alice.headers)).shipReviewSetBy).toBe('app')
    // A row for another kind decides nothing here.
    await putPolicy(
      db,
      tenantId,
      { kind: 'deploy.production', scopeType: 'tenant', scopeId: null, ...policy() },
      admin.user.id
    )
    expect((await detail(app.slug, alice.headers)).shipReviewSetBy).toBe('app')

    await putPolicy(
      db,
      tenantId,
      { kind: 'session.merge', scopeType: 'group', scopeId: ownerGroup.id, ...policy() },
      admin.user.id
    )
    expect((await detail(app.slug, alice.headers)).shipReviewSetBy).toBe('policy')

    const second = await seedApp(db, tenantId, { environments: {} })
    expect((await detail(second.app.slug, admin.headers)).shipReviewSetBy).toBe('app')
    await putPolicy(
      db,
      tenantId,
      { kind: 'session.merge', scopeType: 'tenant', scopeId: null, ...policy() },
      admin.user.id
    )
    expect((await detail(second.app.slug, admin.headers)).shipReviewSetBy).toBe('policy')
  })
})

describe('reviewPolicyFor', () => {
  const merge = (approvers: Partial<ApprovalPolicy['approvers']>): ApprovalPolicy => ({
    approvers: { appOwners: false, admins: false, groupIds: [], userIds: [], ...approvers },
    minApprovals: 1,
    allowSelfApproval: false,
    expiresAfterMinutes: SESSION_MERGE_EXPIRY_HOURS * 60,
    autoApproveRole: null,
  })

  it('none → nothing to open (the default, a null column included)', async () => {
    const { tenantId, app } = await fixture()
    expect(await reviewPolicyFor(db, tenantId, app)).toEqual({
      required: false,
      setBy: 'app',
      mode: 'none',
      policy: null,
    })
  })

  it('app_owners and groups → one approval, never self, 48 h, never automatic', async () => {
    const { tenantId, app, admin, reviewers } = await fixture()
    await put(app.id, admin.headers, {
      sessionShip: 'staging',
      review: { mode: 'app_owners', groupIds: [] },
    })
    expect(await reviewPolicyFor(db, tenantId, await appRow(tenantId, app.id))).toEqual({
      required: true,
      setBy: 'app',
      mode: 'app_owners',
      policy: merge({ appOwners: true }),
    })
    await put(app.id, admin.headers, {
      sessionShip: 'staging',
      review: { mode: 'groups', groupIds: [reviewers.id] },
    })
    expect(await reviewPolicyFor(db, tenantId, await appRow(tenantId, app.id))).toEqual({
      required: true,
      setBy: 'app',
      mode: 'groups',
      policy: merge({ groupIds: [reviewers.id] }),
    })
  })

  it('groups whose teams were all deleted fall back to the app’s owners', async () => {
    const { tenantId, app } = await fixture()
    const gone = crypto.randomUUID()
    const row = {
      ...app,
      shipSettings: {
        sessionShip: 'staging' as const,
        review: { mode: 'groups' as const, groupIds: [gone] },
      },
    }
    expect((await reviewPolicyFor(db, tenantId, row)).policy).toEqual(merge({ appOwners: true }))
  })

  it('a policy row → required, set by the policy, with the row’s own policy', async () => {
    const { tenantId, app, admin } = await fixture()
    const rowPolicy = policy({ minApprovals: 2, expiresAfterMinutes: 120 })
    await putPolicy(
      db,
      tenantId,
      { kind: 'session.merge', scopeType: 'app', scopeId: app.id, ...rowPolicy },
      admin.user.id
    )
    expect(await reviewPolicyFor(db, tenantId, app)).toEqual({
      required: true,
      setBy: 'policy',
      mode: 'policy',
      policy: rowPolicy,
    })
  })
})
