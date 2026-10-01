// @vitest-isolate
// Mocks the pipeline's settings/Setup reads and its naming port (as app-pipeline-routes does), so this file needs its own module registry.
/**
 * The three stand-in kinds on the approvals engine (Launch P4, plan §4c), end to end on the REAL
 * engine and database: `app.create` (a member asks → an admin approves → the launch Workflow starts;
 * a rejection or expiry archives the app), `session.budget` (the creator waits for an owner; the
 * approval raises the cap and wakes the session) and the handlers' own contracts — the default
 * policies, the inbox titles, and that each effect is idempotent where the sweep may retry it.
 * `app.access` is exercised end to end in `app-access.test.ts`.
 */

import type { ApprovalPolicy } from '@launch/shared/launch-approvals'
import { createAppResponseSchema } from '@launch/shared/launch-pipeline'
import {
  DEFAULT_SESSION_POLICY,
  type SessionLanding,
  usdToMicrocents,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { open } from '@/api/services/approvals/engine'
import { appCreateHandler } from '@/api/services/approvals/kinds/app-create'
import { sessionBudgetHandler } from '@/api/services/approvals/kinds/session-budget'
import { sessionMergeHandler } from '@/api/services/approvals/kinds/session-merge'
import type { PipelineSettings } from '@/api/services/launch/pipeline/context'
import { appendSessionEvents } from '@/api/services/sessions/event-log'
import {
  appOwners,
  approvalRequests,
  apps,
  auditEvents,
  type SessionRow,
  sessionEvents,
  sessions,
} from '@/db/schema'
import { decideAs, expireNow, testApprovalDeps } from '../helpers/approvals-kinds'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { forgetApps, uniqueSlug } from '../helpers/launch-apps'
import { createTestGroup } from '../helpers/oidc'
import { json, request } from '../helpers/request'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const state: { settings: PipelineSettings } = {
  settings: {
    appsDomain: 'clewro.com',
    notificationsDomain: 'notifications.clewro.com',
    templatePin: { repo: 'rocketflare-dev/rocketflare', tag: '0.15.0', commit: 'a'.repeat(40) },
    appCreateRole: 'admin',
    githubOrg: 'acme',
  },
}

// The test Launch is at http://localhost:3001, which the public-URL gate refuses by design; the
// gate has its own suite (`public-url.test.ts`), so here it is waved through.
vi.mock('@/api/services/launch/public-url', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/services/launch/public-url')>()),
  requirePublicUrl: async () => undefined,
}))

vi.mock('@/api/services/launch/pipeline/context', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/launch/pipeline/context')>()
  return {
    ...actual,
    loadPipelineSettings: vi.fn(async () => state.settings),
    missingSetup: vi.fn(async () => []),
  }
})

vi.mock('@/api/services/launch/pipeline/ports', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/launch/pipeline/ports')>()
  return {
    ...actual,
    defaultPorts: () => ({
      names: (slug: string, env: 'staging' | 'production', domain: string) => {
        const host = `${slug}${env === 'staging' ? '-staging' : ''}.${domain}`
        return { workerName: host.split('.')[0], host, url: `https://${host}` }
      },
    }),
  }
})

const db = setupTestDatabase()
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

beforeEach(() => {
  state.settings = { ...state.settings, appCreateRole: 'admin' }
})

/** An organisation with an owner (who approves) and a member (who asks), both signed in. */
async function organisation() {
  const { tenant, user: owner } = await createTestTenantWithUser(db, 'owner')
  tenantIds.push(tenant.id)
  const member = await createTestUser(db)
  await linkUserToTenant(db, member.id, tenant.id, 'member')
  const headers = (userId: string) => async () => ({
    ...sessionCookieHeader(await createTestSession(db, userId, tenant.id)),
    'X-Requested-With': 'fetch',
  })
  return {
    tenant,
    owner,
    member,
    ownerHeaders: headers(owner.id),
    memberHeaders: headers(member.id),
  }
}

async function ask(headers: Record<string, string>, env: TestEnv, slug = uniqueSlug()) {
  const res = await request(
    '/api/apps',
    { method: 'POST', headers },
    { env, json: { slug, displayName: 'Ledger', options: { deployStaging: false } } }
  )
  expect(res.status, await res.clone().text()).toBe(202)
  return createAppResponseSchema.parse(await json(res))
}

async function appRow(id: string) {
  const [row] = await db.select().from(apps).where(eq(apps.id, id))
  if (!row) throw new Error('no app')
  return row
}

async function requestRow(id: string) {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id))
  if (!row) throw new Error('no request')
  return row
}

describe('app.create', () => {
  it('a member creates an app → pending → an admin approves → the Workflow starts, once', async () => {
    const org = await organisation()
    const env = createTestEnv()
    const created = await ask(await org.memberHeaders(), env)
    expect(created.approvalId).toEqual(expect.any(String))
    const approvalId = created.approvalId ?? ''
    expect(stubs(env).launchWorkflow?.created).toEqual([])
    expect((await appRow(created.app.id)).status).toBe('requested')
    const pending = await requestRow(approvalId)
    expect(pending).toMatchObject({ status: 'pending', requestedByUserId: org.member.id })
    expect(pending.policy).toMatchObject({ approvers: { admins: true }, autoApproveRole: 'admin' })
    expect(appCreateHandler.describe(pending)).toBe(`Create app Ledger (${created.app.slug})`)

    // The asker cannot approve their own app.
    const deps = testApprovalDeps(db, env)
    await expect(
      decideAs(deps, org.tenant.id, org.member.id, approvalId, 'approve')
    ).rejects.toMatchObject({ statusCode: 403, code: 'self_approval' })

    await decideAs(deps, org.tenant.id, org.owner.id, approvalId, 'approve')
    expect(stubs(env).launchWorkflow?.created).toEqual([
      {
        id: created.runId,
        params: {
          tenantId: org.tenant.id,
          appId: created.app.id,
          runId: created.runId,
          userId: org.member.id,
          options: { deployStaging: false },
        },
      },
    ])
    const approved = await requestRow(approvalId)
    expect(approved.status).toBe('approved')
    expect(approved.appliedAt).not.toBeNull()

    // applyAfter again (a sweep retry): the run exists, nothing is started twice.
    await appCreateHandler.applyAfter(approved, deps)
    expect(stubs(env).launchWorkflow?.created).toHaveLength(1)
    // Once the run has moved the app on, a retry is a no-op before it touches the binding.
    await db.update(apps).set({ status: 'provisioning' }).where(eq(apps.id, created.app.id))
    await appCreateHandler.applyAfter(approved, testApprovalDeps(db, createTestEnv()))
  })

  it('a rejection archives the requested app, audited app.create.rejected in the rejecter’s name', async () => {
    const org = await organisation()
    const env = createTestEnv()
    const created = await ask(await org.memberHeaders(), env)
    const approvalId = created.approvalId ?? ''
    await decideAs(testApprovalDeps(db, env), org.tenant.id, org.owner.id, approvalId, 'reject')
    expect((await appRow(created.app.id)).status).toBe('archived')
    expect(stubs(env).launchWorkflow?.created).toEqual([])
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, org.tenant.id), eq(auditEvents.action, 'app.create.rejected'))
      )
    expect(audit).toMatchObject({
      actorUserId: org.owner.id,
      targetId: created.app.id,
      approvalId,
      summary: { after: { status: 'archived', approval: 'rejected' } },
    })
  })

  it('an expired request archives the app too, as the system', async () => {
    const org = await organisation()
    const env = createTestEnv()
    const created = await ask(await org.memberHeaders(), env)
    const approvalId = created.approvalId ?? ''
    await expireNow(testApprovalDeps(db, env), org.tenant.id, approvalId)
    expect((await requestRow(approvalId)).status).toBe('expired')
    expect((await appRow(created.app.id)).status).toBe('archived')
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, org.tenant.id), eq(auditEvents.action, 'app.create.rejected'))
      )
    expect(audit).toMatchObject({ actorType: 'system', approvalId })
  })

  it('the default policy follows launch_settings.app_create_role', async () => {
    expect((await appCreateHandler.defaultPolicy(db, 'unused')).autoApproveRole).toBe('admin')
    state.settings = { ...state.settings, appCreateRole: 'member' }
    expect((await appCreateHandler.defaultPolicy(db, 'unused')).autoApproveRole).toBe('member')

    // …so with `member`, a member's app is auto-approved and launched in the same request.
    const org = await organisation()
    const env = createTestEnv()
    const created = await ask(await org.memberHeaders(), env)
    expect(created.approvalId).toBeNull()
    expect(stubs(env).launchWorkflow?.created.map(c => c.id)).toEqual([created.runId])
  })

  it('a launch that cannot start marks the app failed (Retry), and the approval records why', async () => {
    const org = await organisation()
    const env = createTestEnv()
    const created = await ask(await org.memberHeaders(), env)
    const approvalId = created.approvalId ?? ''
    const launcher = stubs(env).launchWorkflow
    if (!launcher) throw new Error('no launch workflow stub')
    vi.spyOn(launcher, 'create').mockRejectedValueOnce(new Error('workflows are down'))
    await decideAs(testApprovalDeps(db, env), org.tenant.id, org.owner.id, approvalId, 'approve')
    expect((await appRow(created.app.id)).status).toBe('failed')
    const row = await requestRow(approvalId)
    expect(row.appliedAt).toBeNull()
    expect(row.applyError).toContain('workflows are down')
  })
})

describe('session.budget', () => {
  async function blockedSession() {
    const f = await seedSessionApp(db, createFakeCloud())
    tenantIds.push(f.tenant.id)
    const row = await insertSession(db, f, {
      status: 'blocked',
      pendingMessage: 'the message that hit the cap',
      costMicrocents: usdToMicrocents(10),
      title: 'Fix the ledger',
    })
    const env = createTestEnv()
    await stubs(env).sessionWorkflow?.create({ id: row.instanceId ?? row.id })
    return { f, row, env }
  }

  async function reload(row: SessionRow) {
    const [latest] = await db.select().from(sessions).where(eq(sessions.id, row.id))
    if (!latest) throw new Error('gone')
    return latest
  }

  it('the creator extending their own session waits for an owner; the approval extends and wakes it', async () => {
    const { f, row, env } = await blockedSession()
    const res = await request(
      `/api/sessions/${row.id}/budget`,
      { method: 'POST', headers: f.cookie },
      { env, json: { extraUsd: 5, reason: 'One more test run' } }
    )
    expect(res.status).toBe(202)
    const { approvalId } = await json<{ approvalId: string }>(res)
    const pending = await requestRow(approvalId)
    expect(pending).toMatchObject({ status: 'pending', requestedByUserId: f.user.id })
    expect(sessionBudgetHandler.describe(pending)).toBe('$5 more budget for session Fix the ledger')
    expect(pending.policy.expiresAfterMinutes).toBe(
      DEFAULT_SESSION_POLICY.suspendedExpiryHours * 60
    )

    const deps = testApprovalDeps(db, env)
    await expect(
      decideAs(deps, f.tenant.id, f.user.id, approvalId, 'approve')
    ).rejects.toMatchObject({ statusCode: 403, code: 'self_approval' })

    const colleague = await createTestUser(db)
    await linkUserToTenant(db, colleague.id, f.tenant.id, 'admin')
    await decideAs(deps, f.tenant.id, colleague.id, approvalId, 'approve')
    const after = await reload(row)
    expect(after).toMatchObject({ status: 'ready', budgetExtraMicrocents: usdToMicrocents(5) })
    expect(stubs(env).sessionWorkflow?.events).toHaveLength(1)

    // applyAfter again (a sweep retry) never extends a second time — that is applyInTx's, once.
    const approved = await requestRow(approvalId)
    await sessionBudgetHandler.applyAfter(approved, deps)
    expect((await reload(row)).budgetExtraMicrocents).toBe(usdToMicrocents(5))
  })

  it('a rejection leaves the session blocked and its cap where it was', async () => {
    const { f, row, env } = await blockedSession()
    const res = await request(
      `/api/sessions/${row.id}/budget`,
      { method: 'POST', headers: f.cookie },
      { env, json: { extraUsd: 50 } }
    )
    const { approvalId } = await json<{ approvalId: string }>(res)
    const colleague = await createTestUser(db)
    await linkUserToTenant(db, colleague.id, f.tenant.id, 'owner')
    await decideAs(testApprovalDeps(db, env), f.tenant.id, colleague.id, approvalId, 'reject')
    expect(await reload(row)).toMatchObject({ status: 'blocked', budgetExtraMicrocents: 0 })
    expect(stubs(env).sessionWorkflow?.events).toEqual([])
  })

  it('applyAfter leaves a session alone that is not waiting on a message', async () => {
    const { f, row, env } = await blockedSession()
    await db
      .update(sessions)
      .set({ status: 'ready', pendingMessage: null })
      .where(eq(sessions.id, row.id))
    const res = await request(
      `/api/sessions/${row.id}/budget`,
      { method: 'POST', headers: f.cookie },
      { env, json: { extraUsd: 1 } }
    )
    const { approvalId } = await json<{ approvalId: string }>(res)
    await sessionBudgetHandler.applyAfter(await requestRow(approvalId), testApprovalDeps(db, env))
    expect(stubs(env).sessionWorkflow?.events).toEqual([])
  })
})

describe('session.merge (issue #5)', () => {
  const GATE_SHA = 'c'.repeat(40)
  const policyOf = (approvers: Partial<ApprovalPolicy['approvers']>): ApprovalPolicy => ({
    approvers: { appOwners: false, admins: false, groupIds: [], userIds: [], ...approvers },
    minApprovals: 1,
    allowSelfApproval: false,
    expiresAfterMinutes: 48 * 60,
    autoApproveRole: null,
  })

  /** A `shipping` session whose landing waits in `approval`, its request open (app owners). */
  async function waitingMerge() {
    const f = await seedSessionApp(db, createFakeCloud())
    tenantIds.push(f.tenant.id)
    const now = new Date().toISOString()
    const landing: SessionLanding = {
      mode: 'staging',
      stage: 'approval',
      prNumber: 3,
      gateSha: GATE_SHA,
      startedAt: now,
      stageAt: now,
      reviewMode: 'app_owners',
      approvalId: null,
      mergeSha: null,
      mergedAt: null,
      releaseId: null,
      version: null,
      tag: null,
      stagingUrl: null,
      containerReleased: false,
      stalledReason: null,
      error: null,
    }
    const row = await insertSession(db, f, {
      status: 'shipping',
      title: 'Greet people',
      prNumber: 3,
      prUrl: 'https://github.com/acme/shop/pull/3',
      landing,
    })
    // An app owner who wrote in the session (and so may not approve its merge).
    const writer = await createTestUser(db)
    await linkUserToTenant(db, writer.id, f.tenant.id, 'member')
    await db.insert(appOwners).values({ tenantId: f.tenant.id, appId: f.app.id, userId: writer.id })
    await appendSessionEvents(db, row, [
      { type: 'user.message', turn: 1, data: { text: 'Make it bold', userId: writer.id } },
    ])
    const env = createTestEnv()
    const deps = testApprovalDeps(db, env)
    const { request: opened } = await open(deps, {
      tenantId: f.tenant.id,
      kind: 'session.merge',
      subject: { type: 'session', id: row.id },
      appId: f.app.id,
      requester: { userId: f.user.id, email: f.user.email, role: 'owner' },
      context: {
        kind: 'session.merge',
        sessionId: row.id,
        shortId: row.shortId,
        title: row.title,
        appSlug: f.app.slug,
        prNumber: 3,
        prUrl: 'https://github.com/acme/shop/pull/3',
        prTitle: 'Greet people on the home page',
        summary: 'Adds a bold greeting.',
        diffStat: ' src/home.tsx | 2 +-',
        headSha: GATE_SHA,
        sessionPath: `/apps/${f.app.slug}/sessions/${row.id}`,
      },
      excludedUserIds: [f.user.id, writer.id],
      policy: policyOf({ appOwners: true }),
    })
    await db
      .update(sessions)
      .set({ landing: { ...landing, approvalId: opened.id } })
      .where(eq(sessions.id, row.id))
    return { f, row, env, deps, writer, approvalId: opened.id }
  }

  async function reload(row: SessionRow) {
    const [latest] = await db.select().from(sessions).where(eq(sessions.id, row.id))
    if (!latest) throw new Error('gone')
    return latest
  }

  /** Another member who owns the app: an eligible approver. */
  async function owner(f: { tenant: { id: string }; app: { id: string } }) {
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, f.tenant.id, 'member')
    await db.insert(appOwners).values({ tenantId: f.tenant.id, appId: f.app.id, userId: user.id })
    return user
  }

  it('approve → the landing moves approval → merging in the decision, ship.review says who, the session is woken', async () => {
    const { f, row, env, deps, approvalId } = await waitingMerge()
    expect(sessionMergeHandler.describe(await requestRow(approvalId))).toBe(
      'Merge “Greet people on the home page” (#3) from session Greet people'
    )
    const bob = await owner(f)
    await decideAs(deps, f.tenant.id, bob.id, approvalId, 'approve')
    expect((await reload(row)).landing).toMatchObject({ stage: 'merging', approvalId })
    const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, row.id))
    expect(events.find(e => e.type === 'ship.review')?.data).toMatchObject({
      status: 'approved',
      approvalId,
      by: expect.any(String),
    })
    // `applyAfter` woke the session (its instance is gone here, so a fresh one was started).
    expect(stubs(env).sessionWorkflow?.created.map(c => c.id)).toEqual([`${row.id}-r1`])
    // A retried applyAfter (the sweep) only wakes it again; nothing moves twice.
    await sessionMergeHandler.applyAfter(await requestRow(approvalId), deps)
    expect((await reload(row)).landing?.stage).toBe('merging')
  })

  it('reject → the landing stays in approval for land.review to reopen; the session is woken', async () => {
    const { f, row, env, deps, approvalId } = await waitingMerge()
    const bob = await owner(f)
    await decideAs(deps, f.tenant.id, bob.id, approvalId, 'reject')
    expect((await requestRow(approvalId)).status).toBe('rejected')
    expect((await reload(row)).landing).toMatchObject({ stage: 'approval', approvalId })
    expect(stubs(env).sessionWorkflow?.created).toHaveLength(1)
  })

  it('expiry → the session is woken (land.review reads it and reopens review_expired)', async () => {
    const { f, row, env, deps, approvalId } = await waitingMerge()
    const expired = await expireNow(deps, f.tenant.id, approvalId)
    expect(expired?.status).toBe('expired')
    expect((await reload(row)).landing?.stage).toBe('approval')
    expect(stubs(env).sessionWorkflow?.created).toHaveLength(1)
  })

  it('the creator and everyone who wrote in the session are refused: 403 self_approval', async () => {
    const { f, env, deps, writer, approvalId } = await waitingMerge()
    for (const userId of [f.user.id, writer.id]) {
      await expect(
        decideAs(deps, f.tenant.id, userId, approvalId, 'approve')
      ).rejects.toMatchObject({ statusCode: 403, code: 'self_approval' })
    }
    // The creator (the requester) still READS the request — the ship panel names who it waits on.
    const res = await request(`/api/approvals/${approvalId}`, { headers: f.cookie }, { env })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ id: approvalId, canDecide: false })
  })

  it('a group approver may read the session while the request is pending — never ship, end or send a turn', async () => {
    const { f, row, env, deps, approvalId } = await waitingMerge()
    // Carol is no owner, creator or admin of the app: only the request's group names her.
    const carol = await createTestUser(db)
    await linkUserToTenant(db, carol.id, f.tenant.id, 'member')
    const group = await createTestGroup(db, f.tenant.id, 'Reviewers', [carol.id])
    await db
      .update(approvalRequests)
      .set({ policy: policyOf({ groupIds: [group.id] }) })
      .where(eq(approvalRequests.id, approvalId))
    const headers = {
      ...sessionCookieHeader(await createTestSession(db, carol.id, f.tenant.id)),
      'X-Requested-With': 'fetch',
    }
    const detail = await request(`/api/sessions/${row.id}`, { headers }, { env })
    expect(detail.status).toBe(200)
    expect(await json(detail)).toMatchObject({ session: { id: row.id, viewerCanManage: false } })
    expect((await request(`/api/sessions/${row.id}/events`, { headers }, { env })).status).toBe(200)
    expect((await request(`/api/sessions/${row.id}/pr`, { headers }, { env })).status).toBe(200)
    for (const [path, body] of [
      ['ship', undefined],
      ['end', undefined],
      ['turns', { message: 'merge it' }],
      ['resume', undefined],
    ] as const) {
      const res = await request(
        `/api/sessions/${row.id}/${path}`,
        { method: 'POST', headers },
        { env, ...(body ? { json: body } : {}) }
      )
      expect(res.status, path).toBe(404)
      expect(await json(res)).toMatchObject({ statusCode: 404, code: 'session_not_found' })
    }
    // She decides it; once it is not pending she cannot read the session any more.
    await decideAs(deps, f.tenant.id, carol.id, approvalId, 'approve')
    expect((await request(`/api/sessions/${row.id}`, { headers }, { env })).status).toBe(404)
    // Another organisation's member never sees it; nobody signed out does.
    const other = await createTestTenantWithUser(db, 'owner')
    tenantIds.push(other.tenant.id)
    const outsider = sessionCookieHeader(
      await createTestSession(db, other.user.id, other.tenant.id)
    )
    expect((await request(`/api/sessions/${row.id}`, { headers: outsider }, { env })).status).toBe(
      404
    )
    expect((await request(`/api/sessions/${row.id}`, {}, { env })).status).toBe(401)
  })
})
