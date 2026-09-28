/**
 * The session lifecycle routes (Launch P3, slice 3b): `POST|GET /api/apps/:id/sessions`,
 * `GET /api/sessions/:id`, `POST /api/sessions/:id/resume`, `/api/admin/sessions` (list, drain,
 * undrain), and the `sessions.expire` cron. Every refusal is checked BEFORE a row is written.
 *
 * `sessions_paused` is a global setting: only this file writes it, always restoring it in
 * `finally`, and the Workflow suite mocks its read.
 */
import {
  adminSessionListResponseSchema,
  drainResponseSchema,
  sessionDetailResponseSchema,
  sessionListResponseSchema,
} from '@launch/shared/launch-sessions'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { putSetting } from '@/api/services/launch/credentials'
import { NeonSessionDb } from '@/api/services/sessions/db/neon-session-db'
import { expireSuspendedSessions } from '@/api/services/sessions/expire'
import { SESSION_IMAGE_VERSION } from '@/api/services/sessions/rocketflare-dev'
import { loadConfig } from '@/config'
import { aiUsage, apps, auditEvents, sessions } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { json, request } from '../helpers/request'
import { createFakeSessionPorts, insertSession, seedSessionApp } from '../helpers/sessions'
import { createTestEnv, stubs } from '../mocks/bindings'

const db = setupTestDatabase()

afterEach(async () => {
  await putSetting(db, 'sessions_paused', null, null)
})

const post = (
  path: string,
  headers: Record<string, string>,
  env = createTestEnv(),
  body?: unknown
) => request(path, { method: 'POST', headers }, { env, json: body ?? {} })

async function sessionCount(appId: string, tenantId: string) {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.appId, appId)))
  return rows.length
}

/** A second person in the fixture's tenant, with a cookie. */
async function colleague(tenantId: string, role: 'member' | 'admin' = 'member') {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return { user, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
}

describe('POST /api/apps/:id/sessions', () => {
  it('creates the row, audits session.created and starts the Workflow → 202', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const env = createTestEnv()
    const res = await post(`/api/apps/${f.app.id}/sessions`, f.cookie, env, {
      title: 'Blue header',
    })
    expect(res.status).toBe(202)
    const body = sessionDetailResponseSchema.parse(await json(res))
    expect(body.session).toMatchObject({
      appId: f.app.id,
      status: 'requested',
      title: 'Blue header',
      baseRef: 'main',
      branch: `session/${body.session.shortId}`,
      viewerCanManage: true,
      imageVersion: SESSION_IMAGE_VERSION,
    })
    // Nothing secret-shaped in the answer.
    expect(JSON.stringify(body)).not.toMatch(/previewToken|preview_token|sealed/)

    expect(stubs(env).sessionWorkflow?.created).toEqual([
      { id: body.session.id, params: { sessionId: body.session.id, tenantId: f.tenant.id } },
    ])
    const [row] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, f.tenant.id), eq(sessions.id, body.session.id)))
    expect(row).toMatchObject({ instanceId: body.session.id, createdByUserId: f.user.id })
    expect(row?.policy.maxConcurrentPerApp).toBe(3)
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, f.tenant.id), eq(auditEvents.targetId, body.session.id)))
    expect(audit.map(a => a.action)).toEqual(['session.created'])
  })

  it('401 without a session; 404 for another organisation’s app', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    expect((await post(`/api/apps/${f.app.id}/sessions`, {})).status).toBe(401)
    const other = await seedSessionApp(db, createFakeCloud())
    const res = await post(`/api/apps/${f.app.id}/sessions`, other.cookie)
    expect(res.status).toBe(404)
    expect(await sessionCount(f.app.id, f.tenant.id)).toBe(0)
  })

  it('409 session_limit at maxConcurrentPerApp active sessions', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    for (const status of ['ready', 'suspended', 'booting'] as const) {
      await insertSession(db, f, { status })
    }
    await insertSession(db, f, { status: 'ended' }) // settled: does not count
    const res = await post(`/api/apps/${f.app.id}/sessions`, f.cookie)
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'session_limit' })
    expect(await sessionCount(f.app.id, f.tenant.id)).toBe(4)
  })

  it('409 session_budget_exhausted when the app’s month is spent', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    await db
      .update(apps)
      .set({ sessionMonthlyBudgetMicrocents: 1000 })
      .where(and(eq(apps.tenantId, f.tenant.id), eq(apps.id, f.app.id)))
    const spent = await insertSession(db, f, { status: 'ended' })
    await db.insert(aiUsage).values({
      tenantId: f.tenant.id,
      sessionId: spent.id,
      feature: 'session',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      costMicrocents: 5000,
    })
    const res = await post(`/api/apps/${f.app.id}/sessions`, f.cookie)
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'session_budget_exhausted' })
  })

  it('503 sessions_not_configured without SESSION_WORKFLOW, before any row', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const env = createTestEnv({ SESSION_WORKFLOW: undefined })
    const res = await post(`/api/apps/${f.app.id}/sessions`, f.cookie, env)
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ code: 'sessions_not_configured' })
    expect(await sessionCount(f.app.id, f.tenant.id)).toBe(0)
  })
})

describe('drain and undrain', () => {
  it('403 for anyone but a platform admin', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'owner' })
    expect((await post('/api/admin/sessions/drain', f.cookie)).status).toBe(403)
    expect((await post('/api/admin/sessions/undrain', f.cookie)).status).toBe(403)
  })

  it('drain pauses new sessions (409) and wakes the live ones; undrain lets them start again', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const live = await insertSession(db, f, { status: 'ready' })
    await db
      .update(sessions)
      .set({ instanceId: live.id })
      .where(and(eq(sessions.tenantId, f.tenant.id), eq(sessions.id, live.id)))
    const admin = await createTestGlobalAdmin(db)
    await linkUserToTenant(db, admin.id, f.tenant.id, 'owner')
    const adminCookie = sessionCookieHeader(await createTestSession(db, admin.id, f.tenant.id))
    const env = createTestEnv()
    stubs(env).sessionWorkflow?.setStatus(live.id, { status: 'waiting' })
    // A suspended session that still KEEPS its container (a warm idle suspend) is woken too, so
    // its Workflow destroys the container; a cold suspended one has nothing to drain.
    const warm = await insertSession(db, f, { status: 'suspended', containerKeptAt: new Date() })
    const cold = await insertSession(db, f, { status: 'suspended' })
    await db
      .update(sessions)
      .set({ instanceId: sql`${sessions.id}::text` })
      .where(and(eq(sessions.tenantId, f.tenant.id), inArray(sessions.id, [warm.id, cold.id])))
    stubs(env).sessionWorkflow?.setStatus(warm.id, { status: 'waiting' })
    stubs(env).sessionWorkflow?.setStatus(cold.id, { status: 'waiting' })

    const drained = drainResponseSchema.parse(
      await json(await post('/api/admin/sessions/drain', adminCookie, env))
    )
    expect(drained.paused).toBe(true)
    expect(drained.suspended).toBeGreaterThanOrEqual(1)
    expect(stubs(env).sessionWorkflow?.events).toContainEqual({
      instanceId: live.id,
      type: 'session_wake',
      payload: {},
    })
    const woken = stubs(env).sessionWorkflow?.events.map(e => e.instanceId) ?? []
    expect(woken).toContain(warm.id)
    expect(woken).not.toContain(cold.id)
    // Out of the app's concurrency count for the create below.
    await db
      .delete(sessions)
      .where(and(eq(sessions.tenantId, f.tenant.id), inArray(sessions.id, [warm.id, cold.id])))

    const refused = await post(`/api/apps/${f.app.id}/sessions`, f.cookie, env)
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ code: 'sessions_paused' })

    const list = adminSessionListResponseSchema.parse(
      await json(await request('/api/admin/sessions', { headers: adminCookie }, { env }))
    )
    expect(list.paused).toBe(true)
    expect(list.items.find(i => i.id === live.id)).toMatchObject({ appSlug: f.app.slug })

    const undrained = drainResponseSchema.parse(
      await json(await post('/api/admin/sessions/undrain', adminCookie, env))
    )
    expect(undrained).toEqual({ paused: false, suspended: 0 })
    expect((await post(`/api/apps/${f.app.id}/sessions`, f.cookie, env)).status).toBe(202)

    const audit = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, f.tenant.id), eq(auditEvents.targetType, 'deployment')))
    expect(audit.map(a => a.action).sort()).toEqual(['sessions.drained', 'sessions.undrained'])
  })
})

describe('GET /api/sessions/:id, GET /api/apps/:id/sessions', () => {
  it('the creator, the app’s owners and admins see a session; another member gets the same 404', async () => {
    const f = await seedSessionApp(db, createFakeCloud(), { role: 'member' })
    const row = await insertSession(db, f, { status: 'ready' })
    const mine = await request(`/api/sessions/${row.id}`, { headers: f.cookie })
    expect(mine.status).toBe(200)
    expect(sessionDetailResponseSchema.parse(await json(mine)).session.id).toBe(row.id)

    const member = await colleague(f.tenant.id, 'member')
    expect((await request(`/api/sessions/${row.id}`, { headers: member.cookie })).status).toBe(404)
    const admin = await colleague(f.tenant.id, 'admin')
    expect((await request(`/api/sessions/${row.id}`, { headers: admin.cookie })).status).toBe(200)

    const other = await seedSessionApp(db, createFakeCloud())
    expect((await request(`/api/sessions/${row.id}`, { headers: other.cookie })).status).toBe(404)
    expect((await request(`/api/sessions/${row.id}`)).status).toBe(401)

    // Lists: a member sees their own; an admin sees the app's.
    await insertSession(db, { ...f, user: admin.user }, { status: 'ready' })
    const own = sessionListResponseSchema.parse(
      await json(await request(`/api/apps/${f.app.id}/sessions`, { headers: f.cookie }))
    )
    expect(own.items.map(i => i.id)).toEqual([row.id])
    const all = sessionListResponseSchema.parse(
      await json(await request(`/api/apps/${f.app.id}/sessions`, { headers: admin.cookie }))
    )
    expect(all.items).toHaveLength(2)
    const none = sessionListResponseSchema.parse(
      await json(
        await request(`/api/apps/${f.app.id}/sessions?scope=all`, { headers: member.cookie })
      )
    )
    expect(none.items).toEqual([])
  })
})

describe('POST /api/sessions/:id/resume', () => {
  it('asks a suspended session to resume and wakes it; a ready one is 409', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'suspended', suspendedAt: new Date() })
    const env = createTestEnv()
    stubs(env).sessionWorkflow?.setStatus(row.id, { status: 'waiting' })
    await db
      .update(sessions)
      .set({ instanceId: row.id })
      .where(and(eq(sessions.tenantId, f.tenant.id), eq(sessions.id, row.id)))
    const res = await post(`/api/sessions/${row.id}/resume`, f.cookie, env)
    expect(res.status).toBe(202)
    expect(sessionDetailResponseSchema.parse(await json(res)).session.requestedAction).toBe(
      'resume'
    )
    expect(stubs(env).sessionWorkflow?.events.map(e => e.instanceId)).toEqual([row.id])

    const ready = await insertSession(db, f, { status: 'ready' })
    const refused = await post(`/api/sessions/${ready.id}/resume`, f.cookie, env)
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ code: 'session_not_ready' })
  })

  it('an instance that is gone is restarted as <id>-r1', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const row = await insertSession(db, f, { status: 'suspended', suspendedAt: new Date() })
    const env = createTestEnv()
    const res = await post(`/api/sessions/${row.id}/resume`, f.cookie, env)
    expect(res.status).toBe(202)
    expect(stubs(env).sessionWorkflow?.created).toEqual([
      { id: `${row.id}-r1`, params: { sessionId: row.id, tenantId: f.tenant.id } },
    ])
    const [after] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, f.tenant.id), eq(sessions.id, row.id)))
    expect(after?.instanceId).toBe(`${row.id}-r1`)
  })
})

describe('sessions.expire (the five-minute cron)', () => {
  it('asks an expired suspended session to end and wakes it; a fresh one is left alone', async () => {
    const f = await seedSessionApp(db, createFakeCloud())
    const old = await insertSession(db, f, {
      status: 'suspended',
      suspendedAt: new Date(Date.now() - 25 * 3_600_000),
    })
    const fresh = await insertSession(db, f, { status: 'suspended', suspendedAt: new Date() })
    const env = createTestEnv()
    const result = await expireSuspendedSessions(db, env, loadConfig(env))
    expect(result.expired).toBeGreaterThanOrEqual(1)
    const [after] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, f.tenant.id), eq(sessions.id, old.id)))
    expect(after?.requestedAction).toBe('end')
    expect(stubs(env).sessionWorkflow?.created.map(c => c.id)).toContain(`${old.id}-r1`)
    const [untouched] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, f.tenant.id), eq(sessions.id, fresh.id)))
    expect(untouched?.requestedAction).toBeNull()
  })

  it('without SESSION_WORKFLOW, cleans up inline: the branch is deleted and the session ended', async () => {
    const cloud = createFakeCloud()
    const f = await seedSessionApp(db, cloud, { prepared: true })
    const env = createTestEnv({ SESSION_WORKFLOW: undefined })
    const cfg = loadConfig(env)
    const port = new NeonSessionDb(db, cfg, {
      fetch: cloud.fetch,
      sleep: async () => {},
      apiKey: 'neon-test-key-abcdefghijklmnop',
    })
    const row = await insertSession(db, f, {
      status: 'suspended',
      suspendedAt: new Date(Date.now() - 48 * 3_600_000),
    })
    const branch = await port.createBranch(
      {
        id: f.app.id,
        tenantId: f.tenant.id,
        slug: f.app.slug,
        repoOwner: f.repo.owner,
        repoName: f.repo.repo,
        defaultBranch: 'main',
        neonProjectId: f.neonProjectId,
        sessionDb: f.app.sessionDb ?? null,
      },
      row
    )
    await db
      .update(sessions)
      .set({ db: branch.db })
      .where(and(eq(sessions.tenantId, f.tenant.id), eq(sessions.id, row.id)))
    const ports = createFakeSessionPorts({ sessionDb: port })
    await expireSuspendedSessions(db, env, cfg, { ports })
    expect(cloud.neon.branchNamed(f.neonProjectId, `session-${row.shortId}`)).toBeUndefined()
    const [after] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenantId, f.tenant.id), eq(sessions.id, row.id)))
    expect(after).toMatchObject({ status: 'ended' })
    const audit = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, f.tenant.id), eq(auditEvents.targetId, row.id)))
    expect(audit.map(a => a.action)).toEqual(['session.ended'])
  })
})
