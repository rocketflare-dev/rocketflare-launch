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
import { createAppResponseSchema } from '@launch/shared/launch-pipeline'
import { DEFAULT_SESSION_POLICY, usdToMicrocents } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appCreateHandler } from '@/api/services/approvals/kinds/app-create'
import { sessionBudgetHandler } from '@/api/services/approvals/kinds/session-budget'
import type { PipelineSettings } from '@/api/services/launch/pipeline/context'
import { approvalRequests, apps, auditEvents, type SessionRow, sessions } from '@/db/schema'
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
