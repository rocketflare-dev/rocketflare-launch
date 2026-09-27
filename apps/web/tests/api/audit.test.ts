/**
 * Launch audit log (spec/08): `recordAudit` writes, `GET /api/audit` reads (admin+, tenant-scoped,
 * cursor-paged, filterable), and the table is append-only BY THE DATABASE — an UPDATE or DELETE
 * raises from the trigger even on the owner connection the Worker uses, while deleting the tenant
 * still cascades its log away.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditActor, recordAudit, SYSTEM_ACTOR } from '@/api/services/launch/audit'
import type { AppContext } from '@/api/types'
import { auditEvents, tenants } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()

interface AuditBody {
  items: Array<{
    id: string
    action: string
    actorType: string
    actorEmail: string | null
    appId: string | null
    summary: { before?: Record<string, unknown>; after?: Record<string, unknown> }
  }>
  nextCursor: string | null
}

async function ownerCookie() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return { user, tenant, cookie }
}

/** The whole error chain as one string — drizzle wraps the driver's error in `cause`. */
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

describe('recordAudit + GET /api/audit', () => {
  it('lists what was recorded, newest first, with the actor and summary', async () => {
    const { user, tenant, cookie } = await ownerCookie()
    const appId = crypto.randomUUID()
    await recordAudit(db, {
      tenantId: tenant.id,
      actorType: 'user',
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'credential.set',
      targetType: 'Credential',
      targetId: 'github_app',
      summary: { after: { privateKey: 'set' } },
    })
    await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'app.imported', appId })

    const res = await request('/api/audit', { headers: cookie })
    expect(res.status).toBe(200)
    const body = await json<AuditBody>(res)
    expect(body.items.map(i => i.action)).toEqual(['app.imported', 'credential.set'])
    expect(body.items[0]).toMatchObject({ actorType: 'system', actorEmail: null, appId })
    expect(body.items[1]).toMatchObject({
      actorType: 'user',
      actorEmail: user.email,
      summary: { after: { privateKey: 'set' } },
    })
    expect(body.nextCursor).toBeNull()
  })

  it('filters by appId and by action prefix', async () => {
    const { tenant, cookie } = await ownerCookie()
    const appId = crypto.randomUUID()
    for (const action of ['oidc.signin', 'oidc.key.rotated', 'oidcx.other', 'app.imported']) {
      await recordAudit(db, {
        tenantId: tenant.id,
        ...SYSTEM_ACTOR,
        action,
        appId: action === 'app.imported' ? appId : null,
      })
    }
    const byPrefix = await json<AuditBody>(
      await request('/api/audit?action=oidc', { headers: cookie })
    )
    expect(byPrefix.items.map(i => i.action).sort()).toEqual(['oidc.key.rotated', 'oidc.signin'])
    const exact = await json<AuditBody>(
      await request('/api/audit?action=oidc.signin', { headers: cookie })
    )
    expect(exact.items.map(i => i.action)).toEqual(['oidc.signin'])
    const byApp = await json<AuditBody>(
      await request(`/api/audit?appId=${appId}`, { headers: cookie })
    )
    expect(byApp.items.map(i => i.action)).toEqual(['app.imported'])
  })

  it('pages by cursor without skipping or repeating a row', async () => {
    const { tenant, cookie } = await ownerCookie()
    for (let i = 0; i < 5; i++) {
      await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: `test.step_${i}` })
    }
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const query: string = cursor ? `&cursor=${cursor}` : ''
      const body: AuditBody = await json<AuditBody>(
        await request(`/api/audit?limit=2${query}`, { headers: cookie })
      )
      seen.push(...body.items.map(i => i.action))
      cursor = body.nextCursor
      if (!cursor) break
    }
    // Every row exactly once, across three pages of at most two.
    expect(seen).toHaveLength(5)
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4].map(i => `test.step_${i}`))
  })

  it('a garbage cursor and a malformed action are 400 envelopes', async () => {
    const { cookie } = await ownerCookie()
    const badCursor = await request('/api/audit?cursor=not-a-uuid', { headers: cookie })
    expect(badCursor.status).toBe(400)
    expect(await json(badCursor)).toMatchObject({ statusCode: 400, code: 'invalid_cursor' })
    const badAction = await request('/api/audit?action=DROP%20TABLE', { headers: cookie })
    expect(badAction.status).toBe(400)
    expect(await json(badAction)).toMatchObject({ statusCode: 400, error: expect.any(String) })
  })

  it('member → 403 envelope; unauthenticated → 401; another tenant sees none of ours', async () => {
    const { tenant, cookie } = await ownerCookie()
    await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'app.imported' })

    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, tenant.id, 'member')
    const forbidden = await request('/api/audit', {
      headers: sessionCookieHeader(await createTestSession(db, member.id, tenant.id)),
    })
    expect(forbidden.status).toBe(403)
    expect(await json(forbidden)).toMatchObject({ statusCode: 403, code: 'forbidden' })

    const anonymous = await request('/api/audit')
    expect(anonymous.status).toBe(401)
    expect(await json(anonymous)).toMatchObject({ statusCode: 401 })

    const other = await ownerCookie()
    const theirs = await json<AuditBody>(await request('/api/audit', { headers: other.cookie }))
    expect(theirs.items).toEqual([])
    // Our own row is still there for us — the empty list above is isolation, not an empty table.
    const ours = await json<AuditBody>(await request('/api/audit', { headers: cookie }))
    expect(ours.items).toHaveLength(1)
  })

  it("another tenant's cursor matches nothing rather than leaking its position", async () => {
    const a = await ownerCookie()
    const row = await recordAudit(db, { tenantId: a.tenant.id, ...SYSTEM_ACTOR, action: 'x.y' })
    const b = await ownerCookie()
    await recordAudit(db, { tenantId: b.tenant.id, ...SYSTEM_ACTOR, action: 'x.y' })
    const body = await json<AuditBody>(
      await request(`/api/audit?cursor=${row.id}`, { headers: b.cookie })
    )
    expect(body.items).toEqual([])
  })
})

describe('audit_events is append-only', () => {
  it('UPDATE and DELETE raise, even on the owner connection', async () => {
    const { tenant } = await ownerCookie()
    const row = await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'a.b' })

    const update = await caught(
      db.update(auditEvents).set({ action: 'tampered' }).where(eq(auditEvents.id, row.id))
    )
    expect(errorText(update)).toContain('append-only')
    const del = await caught(db.delete(auditEvents).where(eq(auditEvents.id, row.id)))
    expect(errorText(del)).toContain('append-only')

    const [still] = await db.select().from(auditEvents).where(eq(auditEvents.id, row.id))
    expect(still?.action).toBe('a.b')
  })

  it('deleting the tenant still cascades its log away', async () => {
    const { tenant } = await ownerCookie()
    await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'a.b' })
    await recordAudit(db, { tenantId: tenant.id, ...SYSTEM_ACTOR, action: 'a.c' })
    await db.delete(tenants).where(eq(tenants.id, tenant.id))
    const left = await db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenant.id))
    expect(left).toEqual([])
  })
})

describe('auditActor', () => {
  function fakeContext(headers: Record<string, string>, auth?: unknown): AppContext {
    const vars: Record<string, unknown> = { auth, requestId: 'req-123' }
    return {
      get: (key: string) => vars[key],
      req: { header: (name: string) => headers[name.toLowerCase()] },
    } as unknown as AppContext
  }

  it('reads the signed-in user, the client IP, the user agent and the request id', () => {
    const actor = auditActor(
      fakeContext(
        { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'x'.repeat(600) },
        { user: { id: 'u1', email: 'a@example.test' } }
      )
    )
    expect(actor).toEqual({
      actorType: 'user',
      actorUserId: 'u1',
      actorEmail: 'a@example.test',
      ip: '203.0.113.9',
      userAgent: 'x'.repeat(512),
      requestId: 'req-123',
    })
  })

  it('prefers an explicit user, and is `system` with none', () => {
    expect(auditActor(fakeContext({}), { id: 'u2', email: 'b@example.test' })).toMatchObject({
      actorType: 'user',
      actorUserId: 'u2',
    })
    expect(auditActor(fakeContext({}))).toMatchObject({ actorType: 'system', actorUserId: null })
  })
})
