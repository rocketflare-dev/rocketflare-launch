// @vitest-isolate
// Swaps every entry of the approvals KIND_HANDLERS registry for a recording fake.
/**
 * The approvals engine (Launch P4 slice 4b) against the real database, with fake kind handlers —
 * the real kinds are 4c's and 4d's, and the engine has to be provable without them.
 *
 * What these protect, in the order they would hurt:
 *
 * - **N of M means N different people**, and one reject vetoes (a second approval from the same
 *   person is 409 `already_decided`, never a second vote).
 * - **The author is never an approver**: the requester and the excluded set are 403
 *   `self_approval`, and are not even notified.
 * - **A decision and its database effect are one transaction**: `applyInTx` failing leaves the
 *   request pending with no decision recorded.
 * - **A vendor effect is owed until it lands**: `applyAfter` failing leaves `applied_at` NULL and
 *   `apply_error` set; the sweep's retries give up loudly (`approval.apply_failed`) after five.
 * - **Expiry and cancel close a request exactly once**, and the kind hears (`onClosed`).
 * - **Every transition is audited with `approval_id`**, and the notifications land as rows.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dispatchScheduled } from '@/api/scheduled'
import {
  APPLY_RETRY_BACKOFF_MS,
  cancel,
  count,
  decide,
  detail,
  expire,
  list,
  open,
  retryApply,
} from '@/api/services/approvals/engine'
import { eligibleApprovers } from '@/api/services/approvals/policy'
import { approvalsSweep } from '@/api/services/approvals/sweep'
import {
  approvalDecisions,
  approvalPolicies,
  approvalRequests,
  auditEvents,
  notifications,
} from '@/db/schema'
import {
  accessOpen,
  actorOf,
  approvalDeps,
  approvalsFixture,
  type FakeKinds,
  installFakeKinds,
  productionOpen,
  viewerOf,
} from '../helpers/approvals'
import { createTestUser, linkUserToTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps } from '../helpers/launch-apps'
import { createTestGroup } from '../helpers/oidc'
import {
  createExecutionContext,
  createTestEnv,
  stubs,
  waitOnExecutionContext,
} from '../mocks/bindings'

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
  return { ...f, env, deps: approvalDeps(db, env) }
}

async function caught(promise: Promise<unknown>): Promise<{ statusCode?: number; code?: string }> {
  try {
    await promise
  } catch (error) {
    return error as { statusCode?: number; code?: string }
  }
  throw new Error('expected a refusal')
}

/**
 * Where each action falls in a request's life — the tie-break for rows ONE transaction wrote:
 * they share `at` (`now()` is the transaction's start), and `id` is a random uuid, so `ORDER BY
 * at` alone returns e.g. an auto-approval's `requested` and `approved` in either order.
 */
const LIFECYCLE_RANK: Record<string, number> = {
  'approval.requested': 0,
  'approval.decided': 1,
  'approval.approved': 2,
  'approval.rejected': 2,
  'approval.apply_failed': 3,
  'approval.expired': 4,
  'approval.cancelled': 4,
}

async function auditActions(tenantId: string, approvalId: string) {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.approvalId, approvalId)))
    .orderBy(auditEvents.at)
  const rank = (action: string) => LIFECYCLE_RANK[action] ?? 99
  return rows.sort((a, b) => a.at.getTime() - b.at.getTime() || rank(a.action) - rank(b.action))
}

async function notificationsOf(tenantId: string, type: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.tenantId, tenantId), eq(notifications.type, type)))
}

async function setTenantPolicy(
  tenantId: string,
  kind: 'deploy.production' | 'app.access',
  patch: Partial<typeof approvalPolicies.$inferInsert>
) {
  await db.insert(approvalPolicies).values({
    tenantId,
    kind,
    scopeType: 'tenant',
    scopeId: null,
    approvers: { appOwners: true, admins: true, groupIds: [], userIds: [] },
    minApprovals: 1,
    ...patch,
  })
}

describe('open', () => {
  it('snapshots the policy, audits, notifies the approvers (not the requester) and is idempotent', async () => {
    const { tenant, app, admin, alice, bob, carol, deps, env } = await fixture()
    const first = await open(deps, accessOpen(tenant.id, app.id, carol))
    expect(first).toMatchObject({ created: true, autoApproved: false })
    expect(first.request).toMatchObject({
      status: 'pending',
      requiredApprovals: 1,
      requestedByUserId: carol.id,
      excludedUserIds: [carol.id],
    })
    expect(first.request.policy.approvers.appOwners).toBe(true)
    // app.access expires in 14 days by default.
    const days = ((first.request.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(13.9)
    expect(days).toBeLessThanOrEqual(14)

    const again = await open(deps, accessOpen(tenant.id, app.id, carol))
    expect(again).toMatchObject({ created: false })
    expect(again.request.id).toBe(first.request.id)

    const audit = await auditActions(tenant.id, first.request.id)
    expect(audit.map(a => a.action)).toEqual(['approval.requested'])
    expect(audit[0]).toMatchObject({ actorUserId: carol.id, appId: app.id, targetType: 'user' })

    // The app's owners and the organisation's admins (app.access's default, P1 parity).
    const asked = await notificationsOf(tenant.id, 'approval_requested')
    expect(asked.map(n => n.userId).sort()).toEqual([admin.id, alice.id, bob.id].sort())
    expect(asked[0]?.data).toEqual({ approvalId: first.request.id, kind: 'app.access' })
    expect(asked[0]?.title).toContain('Fake app.access')

    const emails = stubs(env).queue.messages.map(
      m => m.body as { type: string; payload: { to: string; link: string } }
    )
    expect(emails.map(e => e.type)).toEqual(['email.send', 'email.send', 'email.send'])
    expect(emails.map(e => e.payload.to).sort()).toEqual(
      [admin.email, alice.email, bob.email].sort()
    )
    expect(emails[0]?.payload.link).toBe(`http://localhost:3001/approvals/${first.request.id}`)

    const nudges = stubs(env).hub.broadcasts.filter(b => b.args[0] === 'broadcastToUsers')
    const entity = nudges.find(b => (b.args[2] as { type: string }).type === 'entity.changed')
    expect(entity?.args[2]).toMatchObject({
      tenantId: tenant.id,
      payload: { entity: 'approval', id: first.request.id },
    })
    expect(entity?.args[1]).toEqual(expect.arrayContaining([admin.id, alice.id, bob.id, carol.id]))
  })

  it('caps the expiry at a hard deadline (a deploy ticket expires with its run)', async () => {
    const { tenant, app, carol, deps } = await fixture()
    const deadline = new Date(Date.now() + 10 * 60_000)
    const { request } = await open(
      deps,
      productionOpen(tenant.id, app.id, carol, { expiresNoLaterThan: deadline })
    )
    expect(request.expiresAt?.getTime()).toBe(deadline.getTime())
  })

  it('auto-approves a requester at autoApproveRole: still a row, decided by system, applied', async () => {
    const { tenant, admin, carol, deps } = await fixture()
    const input = (who: { id: string; email: string }, role: 'owner' | 'member') => ({
      tenantId: tenant.id,
      kind: 'app.create' as const,
      subject: { type: 'app' as const, id: crypto.randomUUID() },
      appId: null,
      requester: { userId: who.id, email: who.email, role },
      context: {
        kind: 'app.create' as const,
        slug: `new-${crypto.randomUUID().slice(0, 8)}`,
        displayName: 'New',
        ownerGroupId: null,
      },
    })
    const auto = await open(deps, input(admin, 'owner'))
    expect(auto).toMatchObject({ created: true, autoApproved: true })
    expect(auto.request.status).toBe('approved')
    expect(auto.request.appliedAt).not.toBeNull()
    expect(fake.inTx).toContain(auto.request.id)
    expect(fake.applied).toContain(auto.request.id)
    const decisions = await db
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.requestId, auto.request.id))
    expect(decisions).toEqual([])
    const audit = await auditActions(tenant.id, auto.request.id)
    expect(audit.map(a => a.action)).toEqual(['approval.requested', 'approval.approved'])
    expect(audit[1]).toMatchObject({ actorType: 'system' })
    expect(audit[1]?.summary).toMatchObject({
      after: { decidedBy: 'system', autoApproveRole: 'admin' },
    })

    // A member below the role ASKS: pending, and the admins are told.
    const asked = await open(deps, input(carol, 'member'))
    expect(asked).toMatchObject({ autoApproved: false })
    expect(asked.request.status).toBe('pending')
    expect(await eligibleApprovers(db, asked.request)).toEqual([admin.id])
  })
})

describe('decide', () => {
  it('N=2 needs two different people; the second vote from one person is 409', async () => {
    const { tenant, app, alice, bob, carol, deps, env } = await fixture()
    await setTenantPolicy(tenant.id, 'deploy.production', { minApprovals: 2 })
    const { request } = await open(deps, productionOpen(tenant.id, app.id, carol))
    expect(request.requiredApprovals).toBe(2)
    const aliceView = await viewerOf(db, tenant.id, alice)

    const one = await decide(deps, {
      requestId: request.id,
      viewer: aliceView,
      decision: 'approve',
      comment: 'LGTM',
      actor: actorOf(alice),
    })
    expect(one).toMatchObject({
      status: 'pending',
      approvals: 1,
      canDecide: false,
      whyNot: 'already_decided',
    })
    expect(fake.inTx).not.toContain(request.id)
    const twice = await caught(
      decide(deps, {
        requestId: request.id,
        viewer: aliceView,
        decision: 'approve',
        actor: actorOf(alice),
      })
    )
    expect(twice).toMatchObject({ statusCode: 409, code: 'already_decided' })

    const two = await decide(deps, {
      requestId: request.id,
      viewer: await viewerOf(db, tenant.id, bob),
      decision: 'approve',
      actor: actorOf(bob),
    })
    expect(two).toMatchObject({ status: 'approved', approvals: 2 })
    expect(two.appliedAt).not.toBeNull()
    expect(two.decisions.map(d => [d.userId, d.decision, d.comment])).toEqual([
      [alice.id, 'approve', 'LGTM'],
      [bob.id, 'approve', null],
    ])
    expect(fake.inTx.filter(id => id === request.id)).toHaveLength(1)
    expect(fake.applied.filter(id => id === request.id)).toHaveLength(1)

    const audit = await auditActions(tenant.id, request.id)
    expect(audit.map(a => a.action)).toEqual([
      'approval.requested',
      'approval.decided',
      'approval.decided',
      'approval.approved',
    ])
    expect(audit[1]).toMatchObject({ actorUserId: alice.id })
    expect(audit[1]?.summary).toMatchObject({
      after: { decision: 'approve', approvals: 1, comment: 'LGTM' },
    })

    const told = await notificationsOf(tenant.id, 'approval_decided')
    expect(told.map(n => n.userId)).toEqual([carol.id])
    expect(told[0]?.title).toMatch(/^Approved: /)
    const decidedEmails = stubs(env)
      .queue.messages.map(m => m.body as { payload: { to: string; reason: string } })
      .filter(m => m.payload.reason === 'approval_decided')
    expect(decidedEmails.map(e => e.payload.to)).toEqual([carol.email])
  })

  it('a single reject vetoes, even with approvals already in', async () => {
    const { tenant, app, alice, bob, admin, carol, deps } = await fixture()
    await setTenantPolicy(tenant.id, 'deploy.production', { minApprovals: 2 })
    const { request } = await open(deps, productionOpen(tenant.id, app.id, carol))
    await decide(deps, {
      requestId: request.id,
      viewer: await viewerOf(db, tenant.id, alice),
      decision: 'approve',
      actor: actorOf(alice),
    })
    const vetoed = await decide(deps, {
      requestId: request.id,
      viewer: await viewerOf(db, tenant.id, bob),
      decision: 'reject',
      comment: 'Not on a Friday',
      actor: actorOf(bob),
    })
    expect(vetoed.status).toBe('rejected')
    expect(fake.closed).toContainEqual({ id: request.id, status: 'rejected' })
    expect(fake.inTx).not.toContain(request.id)
    const late = await caught(
      decide(deps, {
        requestId: request.id,
        viewer: await viewerOf(db, tenant.id, admin),
        decision: 'approve',
        actor: actorOf(admin),
      })
    )
    expect(late).toMatchObject({ statusCode: 409, code: 'not_pending' })
    expect((await auditActions(tenant.id, request.id)).map(a => a.action)).toContain(
      'approval.rejected'
    )
    const told = await notificationsOf(tenant.id, 'approval_decided')
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ userId: carol.id, body: 'Not on a Friday' })
  })

  it('refuses the requester and the excluded (self_approval), and hides the request from others', async () => {
    const { tenant, app, alice, bob, admin, carol, deps } = await fixture()
    // Alice (an owner) promotes; Bob authored a PR in it. Only the admin is left to decide.
    const { request } = await open(
      deps,
      productionOpen(tenant.id, app.id, alice, { excludedUserIds: [bob.id] })
    )
    expect(request.excludedUserIds.sort()).toEqual([alice.id, bob.id].sort())
    expect(await eligibleApprovers(db, request)).toEqual([admin.id])
    const asked = await notificationsOf(tenant.id, 'approval_requested')
    expect(asked.map(n => n.userId)).toEqual([admin.id])

    for (const who of [alice, bob]) {
      const refused = await caught(
        decide(deps, {
          requestId: request.id,
          viewer: await viewerOf(db, tenant.id, who),
          decision: 'approve',
          actor: actorOf(who),
        })
      )
      expect(refused).toMatchObject({ statusCode: 403, code: 'self_approval' })
      expect(
        await detail(deps, { requestId: request.id, viewer: await viewerOf(db, tenant.id, who) })
      ).toMatchObject({ canDecide: false, whyNot: 'self_approval' })
    }
    // Carol has no part in it: the same 404 as a missing request.
    const hidden = await caught(
      decide(deps, {
        requestId: request.id,
        viewer: await viewerOf(db, tenant.id, carol),
        decision: 'approve',
        actor: actorOf(carol),
      })
    )
    expect(hidden).toMatchObject({ statusCode: 404 })
    const ok = await decide(deps, {
      requestId: request.id,
      viewer: await viewerOf(db, tenant.id, admin),
      decision: 'approve',
      actor: actorOf(admin),
    })
    expect(ok.status).toBe('approved')
  })

  it('allowSelfApproval lets the requester decide; an admin not named by the policy may not', async () => {
    const { tenant, app, alice, admin, deps } = await fixture()
    await setTenantPolicy(tenant.id, 'app.access', {
      approvers: { appOwners: true, admins: false, groupIds: [], userIds: [] },
      allowSelfApproval: true,
    })
    const { request } = await open(deps, accessOpen(tenant.id, app.id, alice))
    const adminTry = await caught(
      decide(deps, {
        requestId: request.id,
        viewer: await viewerOf(db, tenant.id, admin),
        decision: 'approve',
        actor: actorOf(admin),
      })
    )
    expect(adminTry).toMatchObject({ statusCode: 403, code: 'not_an_approver' })
    const self = await decide(deps, {
      requestId: request.id,
      viewer: await viewerOf(db, tenant.id, alice),
      decision: 'approve',
      actor: actorOf(alice),
    })
    expect(self.status).toBe('approved')
  })

  it('group, named and kind-extra approvers are eligible, evaluated at decide time', async () => {
    const { tenant, app, admin, carol, deps } = await fixture()
    const dave = await createTestUser(db)
    await linkUserToTenant(db, dave.id, tenant.id, 'member')
    const reviewers = await createTestGroup(db, tenant.id, 'Reviewers', [])
    await setTenantPolicy(tenant.id, 'app.access', {
      approvers: { appOwners: false, admins: false, groupIds: [reviewers.id], userIds: [admin.id] },
    })
    fake.extra.set(carol.id, [dave.id])
    const { request } = await open(deps, accessOpen(tenant.id, app.id, carol))
    expect((await eligibleApprovers(db, request)).sort()).toEqual([admin.id, dave.id].sort())
    // Dave is eligible as the kind's extra approver.
    const daveView = await viewerOf(db, tenant.id, dave)
    expect(await detail(deps, { requestId: request.id, viewer: daveView })).toMatchObject({
      canDecide: true,
    })
    fake.extra.delete(carol.id)
    // Without the extra, and without joining the group, Dave cannot see it at all …
    expect(await caught(detail(deps, { requestId: request.id, viewer: daveView }))).toMatchObject({
      statusCode: 404,
    })
    // … and a group membership held NOW makes him an approver (eligibility is not snapshotted).
    const asMember = await viewerOf(db, tenant.id, dave, [reviewers.id])
    const decided = await decide(deps, {
      requestId: request.id,
      viewer: asMember,
      decision: 'approve',
      actor: actorOf(dave),
    })
    expect(decided.status).toBe('approved')
  })

  it('applyInTx failing rolls the decision back: still pending, no decision row', async () => {
    const { tenant, app, alice, carol, deps } = await fixture()
    const { request } = await open(deps, accessOpen(tenant.id, app.id, carol))
    fake.failApplyInTx.add(request.id)
    await expect(
      decide(deps, {
        requestId: request.id,
        viewer: await viewerOf(db, tenant.id, alice),
        decision: 'approve',
        actor: actorOf(alice),
      })
    ).rejects.toThrow('applyInTx refused')
    fake.failApplyInTx.delete(request.id)
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, request.id))
    expect(row?.status).toBe('pending')
    const decisions = await db
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.requestId, request.id))
    expect(decisions).toEqual([])
    expect((await auditActions(tenant.id, request.id)).map(a => a.action)).toEqual([
      'approval.requested',
    ])
  })
})

describe('applyAfter and its retries', () => {
  it('a failure is owed; retries wait out the backoff; the fifth failure gives up loudly', async () => {
    const { tenant, app, alice, carol, deps, env } = await fixture()
    const { request } = await open(deps, accessOpen(tenant.id, app.id, carol))
    fake.failApplyAfter.add(request.id)
    const approved = await decide(deps, {
      requestId: request.id,
      viewer: await viewerOf(db, tenant.id, alice),
      decision: 'approve',
      actor: actorOf(alice),
    })
    expect(approved).toMatchObject({
      status: 'approved',
      appliedAt: null,
      applyError: 'the vendor is down',
    })

    const base = Date.now()
    const at = (minutes: number) => approvalDeps(db, env, () => new Date(base + minutes * 60_000))
    const ids = { tenantId: tenant.id, requestId: request.id }
    // Inside the backoff nothing runs (a first attempt may still be in flight).
    expect(await retryApply(at(1), ids)).toBe('not_owed')
    expect(await retryApply(at(5), ids)).toBe('failed')
    expect(await retryApply(at(6), ids)).toBe('not_owed')
    expect(await retryApply(at(10), ids)).toBe('failed')
    expect(await retryApply(at(15), ids)).toBe('failed')
    expect(await retryApply(at(20), ids)).toBe('gave_up')
    expect(await retryApply(at(25), ids)).toBe('not_owed')
    expect(fake.attempts.filter(id => id === request.id)).toHaveLength(5)

    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, request.id))
    expect(row).toMatchObject({
      applyAttempts: 5,
      appliedAt: null,
      applyError: 'the vendor is down',
    })
    const failedAudit = (await auditActions(tenant.id, request.id)).filter(
      a => a.action === 'approval.apply_failed'
    )
    expect(failedAudit).toHaveLength(1)
    expect(failedAudit[0]).toMatchObject({ actorType: 'system' })
    const told = (await notificationsOf(tenant.id, 'approval_decided')).filter(n =>
      n.title.startsWith('Approved but not applied')
    )
    expect(told.map(n => n.userId).sort()).toEqual([alice.id, carol.id].sort())
    fake.failApplyAfter.delete(request.id)
  })

  it('a retry that succeeds sets applied_at and clears the error', async () => {
    const { tenant, app, bob, carol, deps, env } = await fixture()
    const { request } = await open(deps, accessOpen(tenant.id, app.id, carol))
    fake.failApplyAfter.add(request.id)
    await decide(deps, {
      requestId: request.id,
      viewer: await viewerOf(db, tenant.id, bob),
      decision: 'approve',
      actor: actorOf(bob),
    })
    fake.failApplyAfter.delete(request.id)
    const later = approvalDeps(
      db,
      env,
      () => new Date(Date.now() + APPLY_RETRY_BACKOFF_MS + 60_000)
    )
    const approvalNudges = () =>
      stubs(env).hub.broadcasts.filter(
        b =>
          b.tenantId === tenant.id &&
          b.args[0] === 'broadcastToUsers' &&
          (b.args[2] as { payload?: { id?: string } }).payload?.id === request.id
      ).length
    const beforeRetry = approvalNudges()
    expect(await retryApply(later, { tenantId: tenant.id, requestId: request.id })).toBe('applied')
    // The request's page hears that the apply landed (it polls only as a fallback while connected).
    expect(approvalNudges()).toBe(beforeRetry + 1)
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, request.id))
    expect(row).toMatchObject({ applyAttempts: 2, applyError: null })
    expect(row?.appliedAt).not.toBeNull()
    expect(await retryApply(later, { tenantId: tenant.id, requestId: request.id })).toBe('not_owed')
    expect(approvalNudges()).toBe(beforeRetry + 1)
  })
})

describe('expire and cancel', () => {
  it('expire closes a due request once: onClosed, the requester told, audited; decide is then 409', async () => {
    const { tenant, app, alice, carol, deps, env } = await fixture()
    const { request } = await open(deps, accessOpen(tenant.id, app.id, carol))
    const ids = { tenantId: tenant.id, requestId: request.id }
    expect(await expire(deps, ids)).toBeNull() // not due yet
    const later = approvalDeps(db, env, () => new Date(Date.now() + 15 * 86_400_000))
    const expired = await expire(later, ids)
    expect(expired?.status).toBe('expired')
    expect(await expire(later, ids)).toBeNull()
    expect(fake.closed).toContainEqual({ id: request.id, status: 'expired' })
    const told = await notificationsOf(tenant.id, 'approval_expired')
    expect(told.map(n => [n.userId, (n.data as { approvalId: string }).approvalId])).toEqual([
      [carol.id, request.id],
    ])
    expect((await auditActions(tenant.id, request.id)).map(a => a.action)).toEqual([
      'approval.requested',
      'approval.expired',
    ])
    const late = await caught(
      decide(deps, {
        requestId: request.id,
        viewer: await viewerOf(db, tenant.id, alice),
        decision: 'approve',
        actor: actorOf(alice),
      })
    )
    expect(late).toMatchObject({ statusCode: 409, code: 'not_pending' })
  })

  it('the */5 sweep expires what is due', async () => {
    const { tenant, app, carol, deps } = await fixture()
    const { request } = await open(
      deps,
      productionOpen(tenant.id, app.id, carol, { expiresNoLaterThan: new Date(Date.now() - 1000) })
    )
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled('*/5 * * * *', createTestEnv(), ctx, {
      '*/5 * * * *': [approvalsSweep],
    })
    await waitOnExecutionContext(ctx)
    expect(reports.map(r => [r.task, r.status])).toEqual([['approvals.sweep', 'ok']])
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, request.id))
    expect(row?.status).toBe('expired')
    expect((await auditActions(tenant.id, request.id)).map(a => a.action)).toContain(
      'approval.expired'
    )
  })

  it('the requester or an admin may cancel; an approver may not', async () => {
    const { tenant, app, admin, bob, carol, deps } = await fixture()
    const first = await open(deps, accessOpen(tenant.id, app.id, carol))
    const byBob = await caught(
      cancel(deps, {
        requestId: first.request.id,
        viewer: await viewerOf(db, tenant.id, bob),
        actor: actorOf(bob),
      })
    )
    expect(byBob).toMatchObject({ statusCode: 403 })
    const byCarol = await cancel(deps, {
      requestId: first.request.id,
      viewer: await viewerOf(db, tenant.id, carol),
      reason: 'No longer needed',
      actor: actorOf(carol),
    })
    expect(byCarol).toMatchObject({ status: 'cancelled', canCancel: false })
    expect(fake.closed).toContainEqual({ id: first.request.id, status: 'cancelled' })
    const audit = await auditActions(tenant.id, first.request.id)
    expect(audit.at(-1)).toMatchObject({ action: 'approval.cancelled', actorUserId: carol.id })

    const second = await open(deps, accessOpen(tenant.id, app.id, carol))
    expect(second.created).toBe(true)
    const byAdmin = await cancel(deps, {
      requestId: second.request.id,
      viewer: await viewerOf(db, tenant.id, admin),
      actor: actorOf(admin),
    })
    expect(byAdmin.status).toBe('cancelled')
    const again = await caught(
      cancel(deps, {
        requestId: second.request.id,
        viewer: await viewerOf(db, tenant.id, admin),
        actor: actorOf(admin),
      })
    )
    expect(again).toMatchObject({ statusCode: 409, code: 'not_pending' })
  })
})

describe('list and count', () => {
  it('mine is what waits on me; requested is what I asked; all is admins only', async () => {
    const { tenant, app, admin, alice, carol, deps } = await fixture()
    const access = await open(deps, accessOpen(tenant.id, app.id, carol))
    const deploy = await open(deps, productionOpen(tenant.id, app.id, alice))
    const aliceView = await viewerOf(db, tenant.id, alice)
    const carolView = await viewerOf(db, tenant.id, carol)
    const adminView = await viewerOf(db, tenant.id, admin)
    const ids = (items: Array<{ id: string }>) => items.map(i => i.id).sort()
    const q = (box: 'mine' | 'requested' | 'all') => ({ box, limit: 50 })

    // Alice owns the app: carol's access request waits on her; her own promote does not.
    expect(ids(await list(deps, { viewer: aliceView, query: q('mine') }))).toEqual([
      access.request.id,
    ])
    expect(await count(deps, { viewer: aliceView })).toBe(1)
    expect(ids(await list(deps, { viewer: aliceView, query: q('requested') }))).toEqual([
      deploy.request.id,
    ])
    // The admin is an approver of both (app.access is owners + admins, P1 parity).
    expect(ids(await list(deps, { viewer: adminView, query: q('mine') }))).toEqual(
      [access.request.id, deploy.request.id].sort()
    )
    expect(ids(await list(deps, { viewer: adminView, query: q('all') }))).toEqual(
      [access.request.id, deploy.request.id].sort()
    )
    // A member asking for `all` gets `mine` — nothing waits on Carol.
    expect(await list(deps, { viewer: carolView, query: q('all') })).toEqual([])
    const [row] = await list(deps, { viewer: carolView, query: q('requested') })
    expect(row).toMatchObject({
      id: access.request.id,
      app: { id: app.id, slug: app.slug },
      requester: { id: carol.id, email: carol.email },
      approvals: 0,
    })

    await decide(deps, {
      requestId: access.request.id,
      viewer: aliceView,
      decision: 'approve',
      actor: actorOf(alice),
    })
    expect(await count(deps, { viewer: aliceView })).toBe(0)
    expect(
      ids(await list(deps, { viewer: carolView, query: { ...q('requested'), status: 'approved' } }))
    ).toEqual([access.request.id])
  })
})
