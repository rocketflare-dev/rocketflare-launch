/**
 * Launch P4 slice 4a's wiring against the real database and the real app: the append-only rule
 * on `approval_decisions` and `audit_chain` (the same trigger as `audit_events`, which still says
 * what it said), the pending-subject index that makes `open` idempotent, the stub mounts answering
 * as the auth surface says (`/api/approvals` → `{ items: [] }`), the two cron tasks registered and
 * harmless, the cross-tenant scans the crons build on, and the engine's stubs failing BY NAME.
 * Issue #5's S1 (`docs/plans/i5-ship-to-staging.md`): the new columns, `session.merge` registered
 * with one open request per session, and every S1 stub failing by name with its slice.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { sessionLandingSchema } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { dispatchScheduled } from '@/api/scheduled'
import { kindHandler } from '@/api/services/approvals/kinds'
import { approvalsSweep, dueForApplyRetry, dueForExpiry } from '@/api/services/approvals/sweep'
import { recordAudit, SYSTEM_ACTOR } from '@/api/services/launch/audit'
import {
  auditSealTask,
  hasUnsealedEvents,
  tenantsWithUnsealedEvents,
} from '@/api/services/launch/audit-chain'
import { toSessionDetail } from '@/api/services/sessions/chat'
import {
  type ApprovalRequestRow,
  appReleases,
  approvalDecisions,
  approvalRequests,
  apps,
  auditChain,
  auditEvents,
  deployTickets,
  type NewApprovalRequestRow,
  sessions,
  tenants,
} from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, seedApp } from '../helpers/launch-apps'
import { json, request } from '../helpers/request'
import { insertSession } from '../helpers/sessions'
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

describe('issue #5 foundations (S1): session.merge and the new columns', () => {
  it('the new columns default to null and round-trip their jsonb shapes', async () => {
    const { tenant, user, app } = await seedTenant()
    expect(app).toMatchObject({
      shipSettings: null,
      releaseClaimHolder: null,
      releaseClaimedAt: null,
    })
    const row = await insertSession(db, { tenant, user, app })
    expect(row).toMatchObject({ landing: null, shipSummary: null })

    const landing = sessionLandingSchema.parse({
      mode: 'staging',
      stage: 'ci',
      prNumber: 4,
      gateSha: 'abc1234',
      startedAt: '2026-10-01T10:00:00.000Z',
      stageAt: '2026-10-01T10:00:00.000Z',
      reviewMode: 'app_owners',
    })
    const shipSummary = {
      title: 'Change the heading',
      body: 'The heading says hello.',
      source: 'fallback' as const,
      diffStat: ' 1 file changed',
      prNumber: 4,
      gateSha: 'abc1234',
      at: '2026-10-01T10:00:00.000Z',
    }
    await db.update(sessions).set({ landing, shipSummary }).where(eq(sessions.id, row.id))
    const [after] = await db.select().from(sessions).where(eq(sessions.id, row.id))
    expect(after?.landing).toEqual(landing)
    expect(after?.shipSummary).toEqual(shipSummary)
    // The session's answer carries both; a fresh one carries nulls.
    expect(toSessionDetail(after as typeof row, true)).toMatchObject({ landing, shipSummary })
    expect(toSessionDetail(row, true)).toMatchObject({ landing: null, shipSummary: null })

    const claimedAt = new Date()
    await db
      .update(apps)
      .set({
        shipSettings: { sessionShip: 'pr', review: { mode: 'none', groupIds: [] } },
        releaseClaimHolder: `session:${row.id}`,
        releaseClaimedAt: claimedAt,
      })
      .where(eq(apps.id, app.id))
    const [appAfter] = await db.select().from(apps).where(eq(apps.id, app.id))
    expect(appAfter).toMatchObject({
      shipSettings: { sessionShip: 'pr' },
      releaseClaimHolder: `session:${row.id}`,
      releaseClaimedAt: claimedAt,
    })
  })

  it('one open session.merge per session; the kind is registered', async () => {
    const { tenant, user, app } = await seedTenant()
    const session = await insertSession(db, { tenant, user, app })
    const values: NewApprovalRequestRow = {
      tenantId: tenant.id,
      kind: 'session.merge',
      appId: app.id,
      subjectType: 'session',
      subjectId: session.id,
      requestedByUserId: user.id,
      context: {
        kind: 'session.merge',
        sessionId: session.id,
        shortId: session.shortId,
        title: null,
        appSlug: app.slug,
        prNumber: 4,
        prUrl: 'https://github.com/acme/shop/pull/4',
        prTitle: 'Change the heading',
        summary: 'The heading says hello.',
        diffStat: ' 1 file changed',
        headSha: 'abc1234',
        sessionPath: `/sessions/${session.id}`,
      },
      policy: DEFAULT_APPROVAL_POLICIES['session.merge'],
      excludedUserIds: [user.id],
    }
    const [first] = await db.insert(approvalRequests).values(values).returning()
    expect(first?.status).toBe('pending')
    expect(
      await db.insert(approvalRequests).values(values).onConflictDoNothing().returning()
    ).toEqual([])

    const handler = kindHandler('session.merge')
    expect(await handler.defaultPolicy(db, tenant.id)).toEqual(
      DEFAULT_APPROVAL_POLICIES['session.merge']
    )
    expect(handler.describe(first as ApprovalRequestRow)).toBe(
      `Merge “Change the heading” (#4) from session ${session.shortId}`
    )
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

  it('the releases router 4d fills is mounted under /api/apps (an app with none lists none)', async () => {
    const { tenant, user, app } = await seedTenant()
    const headers = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const res = await request(`/api/apps/${app.id}/releases`, { headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [] })
  })
})

describe('the P4 crons', () => {
  it('both tasks run from the */5 dispatch', async () => {
    const ctx = createExecutionContext()
    const { tenant } = await seedTenant()
    // The seal is scoped to this test's tenant (`auditSealTask`): the registered one seals every
    // tenant, which in the shared database would seal other files' "still unsealed" events.
    const reports = await dispatchScheduled('*/5 * * * *', createTestEnv(), ctx, {
      '*/5 * * * *': [approvalsSweep, auditSealTask({ tenantIds: [tenant.id] })],
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
    // Inside a transaction that is rolled back: the event is visible to this check and to no other
    // connection, so a seal running in another file cannot seal it first (the check is global).
    class Rollback extends Error {}
    let seen: boolean | undefined
    await db
      .transaction(async tx => {
        const scoped = tx as unknown as typeof db
        await recordAudit(scoped, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'a.b' })
        seen = await hasUnsealedEvents(scoped)
        expect(await tenantsWithUnsealedEvents(scoped, [tenant.id])).toEqual([tenant.id])
        throw new Rollback()
      })
      .catch(err => {
        if (!(err instanceof Rollback)) throw err
      })
    expect(seen).toBe(true)
  })
})
