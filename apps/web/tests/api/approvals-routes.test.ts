// @vitest-isolate
// Swaps every entry of the approvals KIND_HANDLERS registry for a recording fake.
/**
 * `/api/approvals` through the real app (Launch P4 slice 4b): the auth surface (401, the 403 and
 * 409 codes the UI and the CLI branch on), tenant isolation and visibility (another tenant's
 * request, and a request the caller has no part in, are the same 404 as a missing one), the boxes,
 * the badge, cancel — and two approvers racing through separate requests (separate database
 * clients, so the row lock is what decides): one 200, one 409, one effect.
 */
import {
  type ApprovalDetail,
  type ApprovalListResponse,
  approvalDetailSchema,
  approvalListResponseSchema,
} from '@launch/shared/launch-approvals'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { open } from '@/api/services/approvals/engine'
import { approvalDecisions, approvalRequests } from '@/db/schema'
import {
  accessOpen,
  approvalDeps,
  approvalsFixture,
  type FakeKinds,
  installFakeKinds,
  productionOpen,
} from '../helpers/approvals'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps } from '../helpers/launch-apps'
import { json, request } from '../helpers/request'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()
const tenantIds: string[] = []
let fake: FakeKinds

beforeAll(() => {
  fake = installFakeKinds()
})

afterAll(async () => {
  fake.restore()
  await forgetApps(db, tenantIds)
})

async function fixture() {
  const f = await approvalsFixture(db)
  tenantIds.push(f.tenant.id)
  const env = createTestEnv()
  const headersOf = async (user: { id: string }) =>
    sessionCookieHeader(await createTestSession(db, user.id, f.tenant.id))
  return {
    ...f,
    env,
    deps: approvalDeps(db, env),
    headers: {
      admin: await headersOf(f.admin),
      alice: await headersOf(f.alice),
      bob: await headersOf(f.bob),
      carol: await headersOf(f.carol),
    },
  }
}

function post(path: string, headers: Record<string, string>, body: unknown = {}) {
  return request(path, { method: 'POST', headers }, { json: body })
}

describe('/api/approvals', () => {
  it('401 without a session', async () => {
    const id = crypto.randomUUID()
    expect((await request('/api/approvals')).status).toBe(401)
    expect((await request('/api/approvals/count')).status).toBe(401)
    expect((await request(`/api/approvals/${id}`)).status).toBe(401)
    expect(
      (
        await request(
          `/api/approvals/${id}/decide`,
          { method: 'POST' },
          { json: { decision: 'approve' } }
        )
      ).status
    ).toBe(401)
  })

  it('lists by box, counts the badge, and shows a request with who may decide', async () => {
    const { tenant, app, carol, deps, headers } = await fixture()
    const { request: row } = await open(deps, accessOpen(tenant.id, app.id, carol))

    const mine = approvalListResponseSchema.parse(
      await json<ApprovalListResponse>(await request('/api/approvals', { headers: headers.alice }))
    )
    expect(mine.items.map(i => i.id)).toEqual([row.id])
    expect(await json(await request('/api/approvals/count', { headers: headers.alice }))).toEqual({
      count: 1,
    })
    const requested = await json<ApprovalListResponse>(
      await request('/api/approvals?box=requested', { headers: headers.carol })
    )
    expect(requested.items.map(i => i.id)).toEqual([row.id])
    expect(
      (
        await json<ApprovalListResponse>(
          await request('/api/approvals?box=all', { headers: headers.carol })
        )
      ).items
    ).toEqual([])

    const asAlice = approvalDetailSchema.parse(
      await json(await request(`/api/approvals/${row.id}`, { headers: headers.alice }))
    )
    expect(asAlice).toMatchObject({
      canDecide: true,
      whyNot: null,
      canCancel: false,
      decisions: [],
    })
    const asCarol = await json<ApprovalDetail>(
      await request(`/api/approvals/${row.id}`, { headers: headers.carol })
    )
    expect(asCarol).toMatchObject({
      canDecide: false,
      whyNot: 'self_approval',
      canCancel: true,
      requester: { id: carol.id },
    })
    expect(asCarol.context).toMatchObject({ kind: 'app.access', userId: carol.id })
    expect((await request('/api/approvals/not-a-uuid', { headers: headers.alice })).status).toBe(
      404
    )
  })

  it('decide answers the codes: 403 self_approval / not_an_approver, 409 already_decided / not_pending', async () => {
    const { tenant, app, alice, deps, headers } = await fixture()
    // Alice asks for production; the code default is one approval from owners + admins, not self.
    const { request: row } = await open(deps, productionOpen(tenant.id, app.id, alice))
    const path = `/api/approvals/${row.id}/decide`
    const self = await post(path, headers.alice, { decision: 'approve' })
    expect(self.status).toBe(403)
    expect(await json(self)).toMatchObject({ code: 'self_approval' })
    // Carol has no part in it: 404, not 403 (it does not confirm the request exists).
    expect((await post(path, headers.carol, { decision: 'approve' })).status).toBe(404)
    expect((await post(path, headers.bob, { decision: 'maybe' })).status).toBe(400)

    const approved = await post(path, headers.bob, { decision: 'approve', comment: 'Ship it' })
    expect(approved.status).toBe(200)
    expect(approvalDetailSchema.parse(await json(approved))).toMatchObject({
      status: 'approved',
      approvals: 1,
    })
    const again = await post(path, headers.bob, { decision: 'approve' })
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ code: 'not_pending' })
    const late = await post(path, headers.admin, { decision: 'reject' })
    expect(await json(late)).toMatchObject({ statusCode: 409, code: 'not_pending' })

    // An admin the policy does not name (app.access is owners only) is not an approver.
    const access = await open(
      deps,
      accessOpen(tenant.id, app.id, (await fixtureCarol(tenant.id)).user)
    )
    const notApprover = await post(`/api/approvals/${access.request.id}/decide`, headers.admin, {
      decision: 'approve',
    })
    expect(notApprover.status).toBe(403)
    expect(await json(notApprover)).toMatchObject({ code: 'not_an_approver' })

    // N=2: the first approval leaves it pending, the same person again is already_decided.
    const n2 = await open(deps, {
      ...productionOpen(tenant.id, app.id, alice),
    })
    await db
      .update(approvalRequests)
      .set({ requiredApprovals: 2 })
      .where(eq(approvalRequests.id, n2.request.id))
    const first = await post(`/api/approvals/${n2.request.id}/decide`, headers.bob, {
      decision: 'approve',
    })
    expect(await json(first)).toMatchObject({ status: 'pending', approvals: 1 })
    const dup = await post(`/api/approvals/${n2.request.id}/decide`, headers.bob, {
      decision: 'approve',
    })
    expect(dup.status).toBe(409)
    expect(await json(dup)).toMatchObject({ code: 'already_decided' })
  })

  it('two approvers racing: one 200, one 409, one decision recorded, one effect', async () => {
    const { tenant, app, carol, deps, headers } = await fixture()
    const { request: row } = await open(deps, accessOpen(tenant.id, app.id, carol))
    const path = `/api/approvals/${row.id}/decide`
    const results = await Promise.all([
      post(path, headers.alice, { decision: 'approve' }),
      post(path, headers.bob, { decision: 'approve' }),
    ])
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    const loser = results.find(r => r.status === 409)
    expect(await json(loser as Response)).toMatchObject({ code: 'not_pending' })
    const decisions = await db
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.requestId, row.id))
    expect(decisions).toHaveLength(1)
    expect(fake.inTx.filter(id => id === row.id)).toHaveLength(1)
    expect(fake.applied.filter(id => id === row.id)).toHaveLength(1)
  })

  it('cancel: the requester may, an approver may not', async () => {
    const { tenant, app, carol, deps, headers, env } = await fixture()
    const { request: row } = await open(deps, accessOpen(tenant.id, app.id, carol))
    const byBob = await post(`/api/approvals/${row.id}/cancel`, headers.bob)
    expect(byBob.status).toBe(403)
    const res = await request(
      `/api/approvals/${row.id}/cancel`,
      { method: 'POST', headers: headers.carol },
      { json: { reason: 'Changed my mind' }, env }
    )
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ status: 'cancelled', canCancel: false })
    const nudge = stubs(env).hub.broadcasts.find(
      b => (b.args[2] as { type?: string } | undefined)?.type === 'entity.changed'
    )
    expect(nudge?.args[2]).toMatchObject({ payload: { entity: 'approval', id: row.id } })
  })

  it('tenant isolation: another organisation sees nothing and gets the same 404', async () => {
    const { tenant, app, carol, deps } = await fixture()
    const { request: row } = await open(deps, accessOpen(tenant.id, app.id, carol))
    const other = await createTestTenantWithUser(db, 'owner')
    tenantIds.push(other.tenant.id)
    const headers = sessionCookieHeader(await createTestSession(db, other.user.id, other.tenant.id))
    expect((await request(`/api/approvals/${row.id}`, { headers })).status).toBe(404)
    expect(
      (await post(`/api/approvals/${row.id}/decide`, headers, { decision: 'approve' })).status
    ).toBe(404)
    expect((await post(`/api/approvals/${row.id}/cancel`, headers)).status).toBe(404)
    const all = await json<ApprovalListResponse>(
      await request('/api/approvals?box=all', { headers })
    )
    expect(all.items).toEqual([])
    expect(await json(await request('/api/approvals/count', { headers }))).toEqual({ count: 0 })
  })
})

/** Another member of `tenantId` to ask for access. */
async function fixtureCarol(tenantId: string) {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, 'member')
  return { user }
}
