/**
 * The chat routes of `/api/sessions` (`routes/session-chat.ts`, Launch P3 slice 3c) through the
 * real Hono app: a turn is a row write plus a wake (202; 409 while one is pending or running, when
 * blocked, when the session is over; 503 without the Workflow binding, before any write), cancel,
 * the event log, and the budget extension (from P4 a `session.budget` approval: one click for an
 * owner or admin who is not the creator, audited; a blocked session comes back to `ready`).
 * Another tenant's session — or one the caller may not see — is the same 404.
 */
import {
  SESSION_WAKE_EVENT,
  sessionDetailResponseSchema,
  sessionEventsResponseSchema,
  usdToMicrocents,
} from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  approvalRequests,
  auditEvents,
  type SessionRow,
  sessionEvents,
  sessions,
} from '@/db/schema'
import { decideAs, testApprovalDeps } from '../helpers/approvals-kinds'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { json, request } from '../helpers/request'
import { insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

async function reload(row: SessionRow): Promise<SessionRow> {
  const [latest] = await db.select().from(sessions).where(eq(sessions.id, row.id))
  if (!latest) throw new Error('gone')
  return latest
}

/** An env whose Workflow knows the session's instance, so a wake is delivered. */
async function envWithInstance(row: SessionRow): Promise<TestEnv> {
  const env = createTestEnv()
  await workflowOf(env).create({ id: row.instanceId ?? row.id })
  return env
}

function workflowOf(env: TestEnv) {
  const workflow = stubs(env).sessionWorkflow
  if (!workflow) throw new Error('no SESSION_WORKFLOW stub')
  return workflow
}

const post = (path: string, cookie: Record<string, string>, env: TestEnv, body?: unknown) =>
  request(path, { method: 'POST', headers: cookie }, { env, json: body ?? {} })

describe('POST /api/sessions/:id/turns', () => {
  it('stores the message, wakes the Workflow and answers 202; a second one is 409 turn_in_progress', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const row = await insertSession(db, f, { status: 'ready', instanceId: null })
    const env = await envWithInstance(row)

    const res = await post(`/api/sessions/${row.id}/turns`, f.cookie, env, { message: ' Hi ' })
    expect(res.status).toBe(202)
    const body = sessionDetailResponseSchema.parse(await json(res))
    expect(body.session).toMatchObject({ id: row.id, pendingMessage: true, status: 'ready' })
    expect(JSON.stringify(body)).not.toContain(row.previewToken)
    expect((await reload(row)).pendingMessage).toBe('Hi')
    expect(workflowOf(env).events).toEqual([
      { instanceId: row.id, type: SESSION_WAKE_EVENT, payload: {} },
    ])

    const again = await post(`/api/sessions/${row.id}/turns`, f.cookie, env, { message: 'more' })
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ code: 'turn_in_progress' })
    expect((await reload(row)).pendingMessage).toBe('Hi')
  })

  it('409s: working → turn_in_progress, blocked → session_budget_exhausted, over → session_not_active', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const cases = [
      ['working', 'turn_in_progress'],
      ['blocked', 'session_budget_exhausted'],
      ['shipping', 'session_not_active'],
      ['ended', 'session_not_active'],
    ] as const
    for (const [status, code] of cases) {
      const row = await insertSession(db, f, { status })
      const res = await post(`/api/sessions/${row.id}/turns`, f.cookie, createTestEnv(), {
        message: 'x',
      })
      expect(res.status, status).toBe(409)
      expect(await json(res)).toMatchObject({ code })
    }
  })

  it('a message to a suspended session also asks for a resume; a lost wake still stores it', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'suspended' })
    // No instance in the fake Workflow: the wake fails, the request stands.
    const res = await post(`/api/sessions/${row.id}/turns`, f.cookie, createTestEnv(), {
      message: 'carry on',
    })
    expect(res.status).toBe(202)
    expect(await reload(row)).toMatchObject({
      pendingMessage: 'carry on',
      requestedAction: 'resume',
    })
  })

  it('503 sessions_not_configured without the Workflow binding, before any write; 400 for an empty message', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    const res = await post(
      `/api/sessions/${row.id}/turns`,
      f.cookie,
      createTestEnv({ SESSION_WORKFLOW: undefined }),
      { message: 'x' }
    )
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ code: 'sessions_not_configured' })
    expect((await reload(row)).pendingMessage).toBeNull()
    const empty = await post(`/api/sessions/${row.id}/turns`, f.cookie, createTestEnv(), {
      message: '   ',
    })
    expect(empty.status).toBe(400)
  })

  it('another tenant, or a member who is not the creator, gets 404 session_not_found', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const row = await insertSession(db, f, { status: 'ready' })
    const other = await createTestTenantWithUser(db, 'owner')
    const otherCookie = sessionCookieHeader(
      await createTestSession(db, other.user.id, other.tenant.id)
    )
    const colleague = await createTestUser(db)
    await linkUserToTenant(db, colleague.id, f.tenant.id, 'member')
    const colleagueCookie = sessionCookieHeader(
      await createTestSession(db, colleague.id, f.tenant.id)
    )
    for (const cookie of [otherCookie, colleagueCookie]) {
      for (const path of ['turns', 'cancel', 'budget']) {
        const res = await post(`/api/sessions/${row.id}/${path}`, cookie, createTestEnv(), {
          message: 'x',
          extraUsd: 5,
        })
        expect(res.status, path).toBe(404)
        expect(await json(res)).toMatchObject({ code: 'session_not_found' })
      }
      const events = await request(`/api/sessions/${row.id}/events`, { headers: cookie })
      expect(events.status).toBe(404)
    }
    expect((await reload(row)).pendingMessage).toBeNull()
  })
})

describe('POST /api/sessions/:id/cancel', () => {
  it('a working turn gets cancel_requested_at; a waiting message is withdrawn; nothing → 409', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const working = await insertSession(db, f, { status: 'working' })
    const res = await post(`/api/sessions/${working.id}/cancel`, f.cookie, createTestEnv())
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ cancelRequested: true })
    expect((await reload(working)).cancelRequestedAt).not.toBeNull()

    const waiting = await insertSession(db, f, { status: 'ready', pendingMessage: 'x' })
    expect(
      (await post(`/api/sessions/${waiting.id}/cancel`, f.cookie, createTestEnv())).status
    ).toBe(200)
    expect((await reload(waiting)).pendingMessage).toBeNull()

    const idle = await insertSession(db, f, { status: 'ready' })
    const none = await post(`/api/sessions/${idle.id}/cancel`, f.cookie, createTestEnv())
    expect(none.status).toBe(409)
    expect(await json(none)).toMatchObject({ code: 'no_turn_in_progress' })
  })
})

describe('GET /api/sessions/:id/events', () => {
  it('pages by afterSeq with nextSeq as the cursor', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'ready' })
    await db.insert(sessionEvents).values(
      [1, 2, 3].map(seq => ({
        sessionId: row.id,
        tenantId: row.tenantId,
        seq,
        turn: 1,
        type: 'text' as const,
        data: { text: `t${seq}` },
      }))
    )
    const all = sessionEventsResponseSchema.parse(
      await json(await request(`/api/sessions/${row.id}/events`, { headers: f.cookie }))
    )
    expect(all.items.map(e => e.seq)).toEqual([1, 2, 3])
    expect(all.nextSeq).toBe(3)
    const rest = sessionEventsResponseSchema.parse(
      await json(await request(`/api/sessions/${row.id}/events?afterSeq=2`, { headers: f.cookie }))
    )
    expect(rest.items.map(e => e.data)).toEqual([{ text: 't3' }])
    const empty = sessionEventsResponseSchema.parse(
      await json(await request(`/api/sessions/${row.id}/events?afterSeq=3`, { headers: f.cookie }))
    )
    expect(empty).toEqual({ items: [], nextSeq: 3 })
  })
})

// P4 (plan §4c): the budget is raised only by an approved `session.budget` request. The requester
// is always the session's creator; an eligible approver other than the creator approves in the same
// call (P3's one click), and anyone else — the creator included — waits for one.
describe('POST /api/sessions/:id/budget', () => {
  /** A member of `f`'s organisation who created a blocked session there, and their cookie. */
  async function memberSession(f: Awaited<ReturnType<typeof seedSessionApp>>) {
    const creator = await createTestUser(db)
    await linkUserToTenant(db, creator.id, f.tenant.id, 'member')
    const row = await insertSession(db, f, {
      createdByUserId: creator.id,
      status: 'blocked',
      pendingMessage: 'the message that hit the cap',
      costMicrocents: usdToMicrocents(10),
    })
    const cookie = sessionCookieHeader(await createTestSession(db, creator.id, f.tenant.id))
    return { creator, row, cookie }
  }

  async function budgetAudits(tenantId: string, sessionId: string) {
    return db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.targetId, sessionId),
          eq(auditEvents.action, 'session.budget.extended')
        )
      )
  }

  it("an owner extends a member's session in one click: 200, audited, ready again and woken", async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const { creator, row } = await memberSession(f)
    const env = await envWithInstance(row)
    const res = await post(`/api/sessions/${row.id}/budget`, f.cookie, env, {
      extraUsd: 5,
      reason: 'Nearly there',
    })
    expect(res.status).toBe(200)
    const body = await json<{ approvalId: string }>(res.clone())
    const { session } = sessionDetailResponseSchema.parse(body)
    expect(session.status).toBe('ready')
    expect(session.budget).toEqual({
      spentMicrocents: usdToMicrocents(10),
      capMicrocents: usdToMicrocents(15),
      extraMicrocents: usdToMicrocents(5),
    })
    expect(workflowOf(env).events.map(e => e.type)).toEqual([SESSION_WAKE_EVENT])

    // The request is the creator's; the owner approved it.
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, body.approvalId))
    expect(approval).toMatchObject({
      kind: 'session.budget',
      status: 'approved',
      subjectType: 'session',
      subjectId: row.id,
      requestedByUserId: creator.id,
      reason: 'Nearly there',
      context: { kind: 'session.budget', sessionId: row.id, extraUsd: 5, spentUsd: 10 },
    })
    expect(approval?.appliedAt).not.toBeNull()
    const audits = await budgetAudits(f.tenant.id, row.id)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      actorUserId: f.user.id,
      appId: f.app.id,
      approvalId: body.approvalId,
    })
  })

  it('the creator asks and waits (202); asking again joins the same request', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const { row, cookie } = await memberSession(f)
    const env = await envWithInstance(row)
    const res = await post(`/api/sessions/${row.id}/budget`, cookie, env, { extraUsd: 5 })
    expect(res.status).toBe(202)
    const first = await json<{ approvalId: string; session: { status: string } }>(res)
    expect(first.session.status).toBe('blocked')
    const again = await json<{ approvalId: string }>(
      await post(`/api/sessions/${row.id}/budget`, cookie, env, { extraUsd: 5 })
    )
    expect(again.approvalId).toBe(first.approvalId)
    expect((await reload(row)).budgetExtraMicrocents).toBe(0)
    expect(await budgetAudits(f.tenant.id, row.id)).toEqual([])
    expect(workflowOf(env).events).toEqual([])
  })

  it('an owner extending their OWN session waits for another owner or admin', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, {
      status: 'blocked',
      pendingMessage: 'mine',
      costMicrocents: usdToMicrocents(10),
    })
    const env = await envWithInstance(row)
    const res = await post(`/api/sessions/${row.id}/budget`, f.cookie, env, { extraUsd: 5 })
    expect(res.status).toBe(202)
    const { approvalId } = await json<{ approvalId: string }>(res)
    expect((await reload(row)).status).toBe('blocked')

    // Another admin of the organisation approves it in the inbox.
    const admin = await createTestUser(db)
    await linkUserToTenant(db, admin.id, f.tenant.id, 'admin')
    await decideAs(testApprovalDeps(db, env), f.tenant.id, admin.id, approvalId, 'approve')
    const after = await reload(row)
    expect(after.status).toBe('ready')
    expect(after.budgetExtraMicrocents).toBe(usdToMicrocents(5))
    expect(workflowOf(env).events.map(e => e.type)).toEqual([SESSION_WAKE_EVENT])
  })

  it('a 400 for a bad amount; another tenant cannot reach the session', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const { row } = await memberSession(f)
    const bad = await post(`/api/sessions/${row.id}/budget`, f.cookie, createTestEnv(), {
      extraUsd: -1,
    })
    expect(bad.status).toBe(400)
    const other = await seedSessionApp(db, createFakeCloud())
    const foreign = await post(`/api/sessions/${row.id}/budget`, other.cookie, createTestEnv(), {
      extraUsd: 5,
    })
    expect(foreign.status).toBe(404)
    expect((await reload(row)).budgetExtraMicrocents).toBe(0)
  })
})
