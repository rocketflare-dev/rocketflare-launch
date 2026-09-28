/**
 * Launch P4 slice 4a's wiring against the real database and the real app: the append-only rule
 * on `approval_decisions` and `audit_chain` (the same trigger as `audit_events`, which still says
 * what it said), the pending-subject index that makes `open` idempotent, the stub mounts answering
 * as the auth surface says (`/api/approvals` → `{ items: [] }`), the two cron tasks registered and
 * harmless, the cross-tenant scans the crons build on, and the engine's stubs failing BY NAME.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { dispatchScheduled } from '@/api/scheduled'
import { approvalsSweep, dueForApplyRetry, dueForExpiry } from '@/api/services/approvals/sweep'
import { recordAudit, SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { auditSeal, hasUnsealedEvents } from '@/api/services/launch/audit-chain'
import {
  appReleases,
  approvalDecisions,
  approvalRequests,
  auditChain,
  auditEvents,
  deployTickets,
  type NewApprovalRequestRow,
  tenants,
} from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, seedApp } from '../helpers/launch-apps'
import { json, request } from '../helpers/request'
import { createExecutionContext, createTestEnv, waitOnExecutionContext } from '../mocks/bindings'

const db = setupTestDatabase()
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

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the statement to fail')
}

async function seedTenant(role: 'owner' | 'member' = 'owner') {
  const seeded = await createTestTenantWithUser(db, role)
  tenantIds.push(seeded.tenant.id)
  const { app } = await seedApp(db, seeded.tenant.id, { environments: {} })
  return { ...seeded, app }
}

function accessRequest(
  tenantId: string,
  appId: string,
  userId: string,
  overrides: Partial<NewApprovalRequestRow> = {}
): NewApprovalRequestRow {
  return {
    tenantId,
    kind: 'app.access',
    appId,
    subjectType: 'user',
    subjectId: userId,
    requestedByUserId: userId,
    context: { kind: 'app.access', userId, message: null },
    policy: DEFAULT_APPROVAL_POLICIES['app.access'],
    excludedUserIds: [userId],
    ...overrides,
  }
}

describe('approval_requests', () => {
  it('one OPEN request per subject: a second open is a no-op, a decided one never blocks', async () => {
    const { tenant, user, app } = await seedTenant()
    const [first] = await db
      .insert(approvalRequests)
      .values(accessRequest(tenant.id, app.id, user.id))
      .returning()
    const again = await db
      .insert(approvalRequests)
      .values(accessRequest(tenant.id, app.id, user.id))
      .onConflictDoNothing()
      .returning()
    expect(first?.status).toBe('pending')
    expect(again).toEqual([])

    // The same person may ask for ANOTHER app at the same time (the app is part of the key).
    const { app: other } = await seedApp(db, tenant.id, { environments: {} })
    const elsewhere = await db
      .insert(approvalRequests)
      .values(accessRequest(tenant.id, other.id, user.id))
      .returning()
    expect(elsewhere).toHaveLength(1)

    // Once decided, asking again opens a new one.
    await db
      .update(approvalRequests)
      .set({ status: 'rejected', decidedAt: new Date() })
      .where(eq(approvalRequests.id, first?.id ?? ''))
    const reopened = await db
      .insert(approvalRequests)
      .values(accessRequest(tenant.id, app.id, user.id))
      .returning()
    expect(reopened).toHaveLength(1)
  })

  it('deleting the app deletes its requests and their decisions (the cascade is allowed)', async () => {
    const { tenant, user, app } = await seedTenant()
    const [row] = await db
      .insert(approvalRequests)
      .values(accessRequest(tenant.id, app.id, user.id))
      .returning()
    await db.insert(approvalDecisions).values({
      tenantId: tenant.id,
      requestId: row?.id ?? '',
      userId: user.id,
      userEmail: user.email,
      decision: 'approve',
    })
    await forgetApps(db, [tenant.id])
    const left = await db
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.tenantId, tenant.id))
    expect(left).toEqual([])
  })
})

describe('append-only tables', () => {
  it('approval_decisions refuses UPDATE and DELETE, and a second decision by one person', async () => {
    const { tenant, user, app } = await seedTenant()
    const [request] = await db
      .insert(approvalRequests)
      .values(accessRequest(tenant.id, app.id, user.id))
      .returning()
    const values = {
      tenantId: tenant.id,
      requestId: request?.id ?? '',
      userId: user.id,
      userEmail: user.email,
      decision: 'approve' as const,
    }
    const [decision] = await db.insert(approvalDecisions).values(values).returning()
    const id = decision?.id ?? ''

    const update = await caught(
      db
        .update(approvalDecisions)
        .set({ decision: 'reject' })
        .where(and(eq(approvalDecisions.tenantId, tenant.id), eq(approvalDecisions.id, id)))
    )
    expect(errorText(update)).toContain('approval_decisions is append-only: UPDATE')
    const del = await caught(
      db
        .delete(approvalDecisions)
        .where(and(eq(approvalDecisions.tenantId, tenant.id), eq(approvalDecisions.id, id)))
    )
    expect(errorText(del)).toContain('approval_decisions is append-only: DELETE')
    expect(errorText(await caught(db.insert(approvalDecisions).values(values)))).toMatch(
      /approval_decisions_request_user_key|duplicate key/
    )
  })

  it('audit_chain refuses UPDATE and DELETE; audit_events says what it always said', async () => {
    const { tenant } = await seedTenant()
    const event = await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'a.b' })
    await db.insert(auditChain).values({
      tenantId: tenant.id,
      seq: 1,
      auditEventId: event.id,
      prevHash: '',
      hash: 'f'.repeat(64),
    })
    const update = await caught(
      db
        .update(auditChain)
        .set({ hash: '0'.repeat(64) })
        .where(eq(auditChain.tenantId, tenant.id))
    )
    expect(errorText(update)).toContain('audit_chain is append-only: UPDATE')
    const del = await caught(db.delete(auditChain).where(eq(auditChain.tenantId, tenant.id)))
    expect(errorText(del)).toContain('audit_chain is append-only: DELETE')
    const events = await caught(
      db.update(auditEvents).set({ action: 'x.y' }).where(eq(auditEvents.id, event.id))
    )
    expect(errorText(events)).toContain('audit_events is append-only: UPDATE is not allowed')

    // Two seals cannot fork the chain: the second row at the same seq conflicts.
    const other = await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'a.c' })
    expect(
      errorText(
        await caught(
          db.insert(auditChain).values({
            tenantId: tenant.id,
            seq: 1,
            auditEventId: other.id,
            prevHash: '',
            hash: 'e'.repeat(64),
          })
        )
      )
    ).toMatch(/audit_chain_pkey|duplicate key/)
  })

  it('deleting the tenant still cascades through every append-only table', async () => {
    const { tenant, user, app } = await seedTenant()
    const [request] = await db
      .insert(approvalRequests)
      .values(accessRequest(tenant.id, app.id, user.id))
      .returning()
    await db.insert(approvalDecisions).values({
      tenantId: tenant.id,
      requestId: request?.id ?? '',
      userId: user.id,
      userEmail: user.email,
      decision: 'reject',
    })
    const event = await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'a.b' })
    await db.insert(auditChain).values({
      tenantId: tenant.id,
      seq: 1,
      auditEventId: event.id,
      prevHash: '',
      hash: 'a'.repeat(64),
    })
    await db.delete(tenants).where(eq(tenants.id, tenant.id))
    for (const table of [approvalDecisions, auditChain, approvalRequests]) {
      expect(await db.select().from(table).where(eq(table.tenantId, tenant.id))).toEqual([])
    }
  })
})

describe('releases and tickets', () => {
  it('a tag is one release per app, and a ticket links to its release and approval', async () => {
    const { tenant, user, app } = await seedTenant()
    const release = {
      tenantId: tenant.id,
      appId: app.id,
      version: '0.1.1',
      tag: '0.1.1',
      sha: 'c'.repeat(40),
    }
    const [row] = await db.insert(appReleases).values(release).returning()
    expect(row).toMatchObject({ status: 'tagged', prs: [], previousTag: null })
    expect(errorText(await caught(db.insert(appReleases).values(release)))).toMatch(
      /app_releases_app_tag_key|duplicate key/
    )
    const { environments } = await seedApp(db, tenant.id)
    const [approval] = await db
      .insert(approvalRequests)
      .values(accessRequest(tenant.id, app.id, user.id))
      .returning()
    const [ticket] = await db
      .insert(deployTickets)
      .values({
        tenantId: tenant.id,
        appId: app.id,
        environmentId: environments[0]?.id ?? '',
        purpose: 'deploy',
        decisionSource: 'approval',
        releaseId: row?.id,
        approvalId: approval?.id,
      })
      .returning()
    expect(ticket).toMatchObject({ releaseId: row?.id, approvalId: approval?.id })
  })
})

describe('the P4 mounts', () => {
  it('/api/approvals answers an empty inbox and a zero badge to any member; 401 without a session', async () => {
    const { tenant, user } = await seedTenant('member')
    const cookie = await createTestSession(db, user.id, tenant.id)
    const headers = sessionCookieHeader(cookie)
    const list = await request('/api/approvals', { headers })
    expect(list.status).toBe(200)
    expect(await json(list)).toEqual({ items: [] })
    const count = await request('/api/approvals/count', { headers })
    expect(await json(count)).toEqual({ count: 0 })
    expect((await request('/api/approvals?box=nope', { headers })).status).toBe(400)
    expect((await request('/api/approvals')).status).toBe(401)
    expect((await request('/api/approval-policies')).status).toBe(401)
  })

  it('the routes 4d fills are mounted but register nothing yet (a JSON 404)', async () => {
    const { tenant, user, app } = await seedTenant()
    const headers = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    for (const path of [`/api/apps/${app.id}/releases`]) {
      const res = await request(path, { headers })
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
    }
  })
})

describe('the P4 crons', () => {
  it('both tasks are registered and harmless until their slices fill them', async () => {
    const ctx = createExecutionContext()
    const reports = await dispatchScheduled('*/5 * * * *', createTestEnv(), ctx, {
      '*/5 * * * *': [approvalsSweep, auditSeal],
    })
    await waitOnExecutionContext(ctx)
    expect(reports.map(r => [r.task, r.status])).toEqual([
      ['approvals.sweep', 'ok'],
      ['audit.seal', 'ok'],
    ])
  })

  it('the sweep scans find due expiries and owed effects across tenants', async () => {
    const { tenant, user, app } = await seedTenant()
    const past = new Date(Date.now() - 60_000)
    const [due] = await db
      .insert(approvalRequests)
      .values(accessRequest(tenant.id, app.id, user.id, { expiresAt: past }))
      .returning()
    const [owed] = await db
      .insert(approvalRequests)
      .values(
        accessRequest(tenant.id, app.id, user.id, {
          subjectId: crypto.randomUUID(),
          status: 'approved',
          decidedAt: past,
          applyAttempts: 2,
        })
      )
      .returning()
    const [spent] = await db
      .insert(approvalRequests)
      .values(
        accessRequest(tenant.id, app.id, user.id, {
          subjectId: crypto.randomUUID(),
          status: 'approved',
          decidedAt: past,
          applyAttempts: 5,
        })
      )
      .returning()
    const expiring = (await dueForExpiry(db, new Date(), 10_000)).map(r => r.id)
    expect(expiring).toContain(due?.id)
    const retrying = (await dueForApplyRetry(db, 10_000)).map(r => r.id)
    expect(retrying).toContain(owed?.id)
    expect(retrying).not.toContain(spent?.id)
  })

  it('the seal sees an unsealed event in any tenant', async () => {
    const { tenant } = await seedTenant()
    await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'a.b' })
    expect(await hasUnsealedEvents(db)).toBe(true)
  })
})
