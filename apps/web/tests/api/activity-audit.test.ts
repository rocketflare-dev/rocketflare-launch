/**
 * Audit is the one log: every kit activity event (`recordActivity`) is also appended to Launch's
 * hash-chained `audit_events` — action = the activity type, the actor copied with their email,
 * the subject as the target, the metadata as `summary.after` with secret-looking keys reduced to
 * `set`, in the activity's tenant only — and the chain still seals and verifies over it.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { activitySummary, recordActivity } from '@/api/services/activity'
import { sealTenant } from '@/api/services/launch/audit-chain'
import { activityEvents, auditEvents } from '@/db/schema'
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
    tenantId: string
    action: string
    actorType: string
    actorUserId: string | null
    actorEmail: string | null
    targetType: string | null
    targetId: string | null
    summary: { before?: Record<string, unknown>; after?: Record<string, unknown> }
  }>
}

async function owner() {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  return { user, tenant, cookie }
}

describe('kit activity → audit', () => {
  it('inviting a member records member.invited in the audit log, with the actor and tenant', async () => {
    const { user, tenant, cookie } = await owner()
    const email = `aud_${Date.now()}@example.test`
    const res = await request(
      '/api/invitations',
      { method: 'POST', headers: cookie },
      { json: { email, role: 'member' } }
    )
    expect(res.status).toBe(201)

    const body = await json<AuditBody>(
      await request('/api/audit?action=member', { headers: cookie })
    )
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      tenantId: tenant.id,
      action: 'member.invited',
      actorType: 'user',
      actorUserId: user.id,
      actorEmail: user.email,
      targetType: 'Invitation',
      summary: { after: { email, role: 'member' } },
    })
    // The kit's own log keeps its row too.
    const activity = await db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.tenantId, tenant.id), eq(activityEvents.type, 'member.invited')))
    expect(activity).toHaveLength(1)
  })

  it('changing a role records member.role_changed, and the chain seals and verifies over it', async () => {
    const { user, tenant, cookie } = await owner()
    const member = await createTestUser(db)
    await linkUserToTenant(db, member.id, tenant.id, 'member')
    const res = await request(
      `/api/members/${member.id}`,
      { method: 'PATCH', headers: cookie },
      { json: { role: 'admin' } }
    )
    expect(res.status).toBe(200)
    await request('/api/keys', { method: 'POST', headers: cookie }, { json: { name: 'ci' } })

    const body = await json<AuditBody>(await request('/api/audit', { headers: cookie }))
    expect(body.items.map(i => i.action)).toEqual(['api_key.created', 'member.role_changed'])
    expect(body.items[1]).toMatchObject({
      actorEmail: user.email,
      targetType: 'TenantMember',
      targetId: member.id,
      summary: { after: { from: 'member', to: 'admin' } },
    })
    // The API key's value is never in its summary — only its name and scopes.
    expect(JSON.stringify(body.items[0]?.summary)).not.toMatch(/lk_|sk_/)

    await sealTenant(db, tenant.id)
    const verify = await json<{ ok: boolean; checked: number; unsealed: number }>(
      await request('/api/audit/verify', { headers: cookie })
    )
    expect(verify).toMatchObject({ ok: true, checked: 2, unsealed: 0 })
  })

  it('stays in the activity tenant — another tenant sees none of it', async () => {
    const a = await owner()
    await request('/api/keys', { method: 'POST', headers: a.cookie }, { json: { name: 'k' } })
    const b = await owner()
    const theirs = await json<AuditBody>(await request('/api/audit', { headers: b.cookie }))
    expect(theirs.items).toHaveLength(0)
  })

  it('a system activity (no user) is a system actor', async () => {
    const { tenant } = await owner()
    await recordActivity(db, { tenantId: tenant.id, userId: null, type: 'tenant.reactivated' })
    const [row] = await db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenant.id))
    expect(row).toMatchObject({
      action: 'tenant.reactivated',
      actorType: 'system',
      actorUserId: null,
      actorEmail: null,
      summary: {},
    })
  })
})

describe('activitySummary', () => {
  it('puts the metadata under `after`, drops undefined, and reduces secret-looking keys to `set`', () => {
    expect(
      activitySummary({
        name: 'ci',
        model: undefined,
        apiKey: 'sk-live-123',
        nested: { clientSecret: 'shh', token: 'x', label: 'ok' },
        list: [{ password: 'p' }],
      })
    ).toEqual({
      after: {
        name: 'ci',
        apiKey: 'set',
        nested: { clientSecret: 'set', token: 'set', label: 'ok' },
        list: [{ password: 'set' }],
      },
    })
  })

  it('is empty for no metadata', () => {
    expect(activitySummary(undefined)).toEqual({})
    expect(activitySummary({})).toEqual({})
  })
})
