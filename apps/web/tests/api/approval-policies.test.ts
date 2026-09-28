/**
 * Approval policies (Launch P4 slice 4b, plan §1.5): resolution app → the app's owner group →
 * tenant → code default, snapshotted at open so an edit never moves a request in flight; and
 * `/api/approval-policies` — admins only at every scope (an app owner loosening their own gate
 * defeats it), a scope in another organisation is a 404, every change audited.
 *
 * No kind handler runs here beyond the registered ones' `defaultPolicy`, so this file needs no
 * fakes and stays in the shared `api` project.
 */
import {
  type ApprovalPolicyListResponse,
  type ApprovalPolicyRow,
  approvalPolicyListResponseSchema,
  DEFAULT_APPROVAL_POLICIES,
} from '@launch/shared/launch-approvals'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { open } from '@/api/services/approvals/engine'
import { resolvePolicy } from '@/api/services/approvals/policy'
import { approvalRequests, apps, auditEvents } from '@/db/schema'
import { accessOpen, approvalDeps, approvalsFixture } from '../helpers/approvals'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, seedApp } from '../helpers/launch-apps'
import { createTestGroup } from '../helpers/oidc'
import { json, request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const tenantIds: string[] = []

afterAll(async () => {
  await forgetApps(db, tenantIds)
})

async function fixture() {
  const f = await approvalsFixture(db)
  tenantIds.push(f.tenant.id)
  return {
    ...f,
    adminHeaders: sessionCookieHeader(await createTestSession(db, f.admin.id, f.tenant.id)),
    aliceHeaders: sessionCookieHeader(await createTestSession(db, f.alice.id, f.tenant.id)),
  }
}

const approvers = (patch: Partial<ApprovalPolicyRow['approvers']> = {}) => ({
  appOwners: false,
  admins: true,
  groupIds: [],
  userIds: [],
  ...patch,
})

function put(headers: Record<string, string>, body: unknown) {
  return request('/api/approval-policies', { method: 'PUT', headers }, { json: body })
}

describe('resolvePolicy', () => {
  it('app → the owner group → tenant → the code default', async () => {
    const { tenant, app, adminHeaders } = await fixture()
    const group = await createTestGroup(db, tenant.id, 'Platform')
    await db.update(apps).set({ ownerGroupId: group.id }).where(eq(apps.id, app.id))
    const kind = 'deploy.production'
    expect(await resolvePolicy(db, tenant.id, kind, app.id)).toEqual(
      DEFAULT_APPROVAL_POLICIES[kind]
    )

    await put(adminHeaders, { kind, scopeType: 'tenant', approvers: approvers(), minApprovals: 2 })
    expect((await resolvePolicy(db, tenant.id, kind, app.id)).minApprovals).toBe(2)
    await put(adminHeaders, {
      kind,
      scopeType: 'group',
      scopeId: group.id,
      approvers: approvers(),
      minApprovals: 3,
    })
    expect((await resolvePolicy(db, tenant.id, kind, app.id)).minApprovals).toBe(3)
    const appRes = await put(adminHeaders, {
      kind,
      scopeType: 'app',
      scopeId: app.id,
      approvers: approvers({ appOwners: true }),
      minApprovals: 4,
      expiresAfterMinutes: 60,
    })
    expect(appRes.status).toBe(200)
    const resolved = await resolvePolicy(db, tenant.id, kind, app.id)
    expect(resolved).toMatchObject({ minApprovals: 4, expiresAfterMinutes: 60 })
    expect(resolved.approvers.appOwners).toBe(true)

    // Another app of the same organisation (no owner group) falls through to the tenant row, and
    // a request with no app at all resolves the tenant row too.
    const { app: other } = await seedApp(db, tenant.id, { environments: {} })
    expect((await resolvePolicy(db, tenant.id, kind, other.id)).minApprovals).toBe(2)
    expect((await resolvePolicy(db, tenant.id, kind, null)).minApprovals).toBe(2)
    // Another kind is untouched.
    expect(await resolvePolicy(db, tenant.id, 'app.access', app.id)).toEqual(
      DEFAULT_APPROVAL_POLICIES['app.access']
    )
  })
})

describe('the snapshot', () => {
  it('a policy edited after open does not move the request in flight', async () => {
    const { tenant, app, carol, adminHeaders } = await fixture()
    const { request: row } = await open(
      approvalDeps(db, createTestEnv()),
      accessOpen(tenant.id, app.id, carol)
    )
    await put(adminHeaders, {
      kind: 'app.access',
      scopeType: 'app',
      scopeId: app.id,
      approvers: approvers(),
      minApprovals: 3,
    })
    const [after] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, row.id))
    expect(after).toMatchObject({ requiredApprovals: 1 })
    expect(after?.policy).toEqual(DEFAULT_APPROVAL_POLICIES['app.access'])
  })
})

describe('/api/approval-policies', () => {
  it('admins only: a member (even an app owner) is 403 on read and write; 401 without a session', async () => {
    const { app, aliceHeaders } = await fixture()
    expect((await request('/api/approval-policies')).status).toBe(401)
    expect((await request('/api/approval-policies', { headers: aliceHeaders })).status).toBe(403)
    const res = await put(aliceHeaders, {
      kind: 'deploy.production',
      scopeType: 'app',
      scopeId: app.id,
      approvers: approvers({ appOwners: true }),
      allowSelfApproval: true,
    })
    expect(res.status).toBe(403)
  })

  it('lists rows with the code defaults, upserts, audits, and deletes', async () => {
    const { tenant, admin, adminHeaders } = await fixture()
    const body = {
      kind: 'app.access',
      scopeType: 'tenant',
      approvers: approvers({ appOwners: true }),
      minApprovals: 1,
    }
    const created = await put(adminHeaders, body)
    expect(created.status).toBe(200)
    const row = await json<ApprovalPolicyRow>(created)
    expect(row).toMatchObject({ kind: 'app.access', scopeId: null, updatedByUserId: admin.id })
    const updated = await json<ApprovalPolicyRow>(
      await put(adminHeaders, { ...body, minApprovals: 2 })
    )
    expect(updated).toMatchObject({ id: row.id, minApprovals: 2 })

    const listed = approvalPolicyListResponseSchema.parse(
      await json<ApprovalPolicyListResponse>(
        await request('/api/approval-policies?kind=app.access', { headers: adminHeaders })
      )
    )
    expect(listed.items.map(i => [i.id, i.minApprovals])).toEqual([[row.id, 2]])
    expect(Object.keys(listed.defaults).sort()).toEqual(
      Object.keys(DEFAULT_APPROVAL_POLICIES).sort()
    )

    const del = await request(`/api/approval-policies/${row.id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    })
    expect(del.status).toBe(204)
    expect(
      (
        await request(`/api/approval-policies/${row.id}`, {
          method: 'DELETE',
          headers: adminHeaders,
        })
      ).status
    ).toBe(404)

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenant.id), eq(auditEvents.targetId, row.id)))
      .orderBy(auditEvents.at)
    expect(audit.map(a => a.action)).toEqual([
      'approval.policy.set',
      'approval.policy.set',
      'approval.policy.removed',
    ])
    expect(audit[1]?.summary).toMatchObject({
      before: { minApprovals: 1 },
      after: { minApprovals: 2 },
    })
  })

  it('a scope in another organisation is a 404; a tenant scope with a scopeId is a 400', async () => {
    const { adminHeaders } = await fixture()
    const other = await createTestTenantWithUser(db, 'owner')
    tenantIds.push(other.tenant.id)
    const { app: foreignApp } = await seedApp(db, other.tenant.id, { environments: {} })
    const foreignGroup = await createTestGroup(db, other.tenant.id, 'Theirs')
    for (const [scopeType, scopeId] of [
      ['app', foreignApp.id],
      ['group', foreignGroup.id],
    ] as const) {
      const res = await put(adminHeaders, {
        kind: 'deploy.production',
        scopeType,
        scopeId,
        approvers: approvers(),
      })
      expect(res.status, scopeType).toBe(404)
    }
    const bad = await put(adminHeaders, {
      kind: 'deploy.production',
      scopeType: 'tenant',
      scopeId: foreignApp.id,
      approvers: approvers(),
    })
    expect(bad.status).toBe(400)
    // And their policy rows are not ours to delete.
    const theirHeaders = sessionCookieHeader(
      await createTestSession(db, other.user.id, other.tenant.id)
    )
    const theirs = await json<ApprovalPolicyRow>(
      await put(theirHeaders, { kind: 'app.create', scopeType: 'tenant', approvers: approvers() })
    )
    expect(
      (
        await request(`/api/approval-policies/${theirs.id}`, {
          method: 'DELETE',
          headers: adminHeaders,
        })
      ).status
    ).toBe(404)
    const ours = await json<ApprovalPolicyListResponse>(
      await request('/api/approval-policies', { headers: adminHeaders })
    )
    expect(ours.items.map(i => i.id)).not.toContain(theirs.id)
  })
})
