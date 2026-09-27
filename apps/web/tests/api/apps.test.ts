/**
 * `/api/apps` (spec/06): the catalogue and the detail page's reads are every member's and
 * tenant-scoped (another organisation's app is a 404, never a leak); edits and the OIDC client are
 * admin-level. The client secret leaves the server exactly once — in the create or rotate response
 * — and only its hash and a four-character hint are stored.
 */
import {
  appDetailSchema,
  appListResponseSchema,
  appOidcClientResponseSchema,
  appOidcClientSecretResponseSchema,
  appOperationListResponseSchema,
} from '@launch/shared/launch-apps'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { hashToken } from '@/api/utils/core/hash'
import { appOperations, auditEvents, groups, groupTypes, oidcClients } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, seedApp, uniqueSlug } from '../helpers/launch-apps'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()

const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

type Role = 'owner' | 'admin' | 'member'

async function session(role: Role, tenantId?: string) {
  if (tenantId) {
    const user = await createTestUser(db)
    await linkUserToTenant(db, user.id, tenantId, role)
    return { tenantId, cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)) }
  }
  const { user, tenant } = await createTestTenantWithUser(db, role)
  tenantIds.push(tenant.id)
  return {
    tenantId: tenant.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

async function auditActions(tenantId: string) {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId))
  return rows.map(r => r.action).sort()
}

describe('GET /api/apps and GET /api/apps/:slug', () => {
  it('lists this organisation’s apps with team and environments; members may read', async () => {
    const admin = await session('admin')
    const [type] = await db
      .insert(groupTypes)
      .values({ tenantId: admin.tenantId, name: 'Teams' })
      .returning()
    const [team] = await db
      .insert(groups)
      .values({ tenantId: admin.tenantId, groupTypeId: type?.id ?? '', name: 'Finance' })
      .returning()
    const { app } = await seedApp(db, admin.tenantId, {
      displayName: 'Expenses',
      ownerGroupId: team?.id,
    })
    await seedApp(db, admin.tenantId, { displayName: 'Atlas' })
    const member = await session('member', admin.tenantId)

    const res = await request('/api/apps', { headers: member.cookie })
    expect(res.status).toBe(200)
    const body = appListResponseSchema.parse(await res.json())
    expect(body.items.map(a => a.displayName)).toEqual(['Atlas', 'Expenses'])
    const expenses = body.items[1]
    expect(expenses).toMatchObject({
      id: app.id,
      ownerGroup: { id: team?.id, name: 'Finance' },
      templateVersion: '0.15.0',
    })
    expect(expenses?.environments.map(e => [e.name, e.healthStatus])).toEqual([
      ['staging', 'unknown'],
      ['production', 'unknown'],
    ])

    const detail = await request(`/api/apps/${app.slug}`, { headers: member.cookie })
    expect(detail.status).toBe(200)
    const parsed = appDetailSchema.parse(await detail.json())
    expect(parsed.environments[1]).toMatchObject({
      name: 'production',
      url: `https://${app.slug}.apps.test`,
      workerName: app.slug,
      resources: {},
    })
  })

  it('is tenant-isolated: another organisation sees neither the row nor the slug', async () => {
    const a = await session('owner')
    const b = await session('owner')
    const { app } = await seedApp(db, a.tenantId)
    const list = appListResponseSchema.parse(
      await (await request('/api/apps', { headers: b.cookie })).json()
    )
    expect(list.items.some(i => i.id === app.id)).toBe(false)
    const res = await request(`/api/apps/${app.slug}`, { headers: b.cookie })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: 'App not found',
      statusCode: 404,
      code: 'app_not_found',
    })
    for (const path of ['operations', 'health', 'oidc-client']) {
      expect((await request(`/api/apps/${app.id}/${path}`, { headers: b.cookie })).status).toBe(404)
    }
  })

  it('is 401 without a session', async () => {
    expect((await request('/api/apps')).status).toBe(401)
    expect((await request('/api/apps/anything')).status).toBe(401)
  })
})

describe('PATCH /api/apps/:id', () => {
  it('edits name, description and team for an admin, audited; 403 for a member', async () => {
    const admin = await session('admin')
    const { app } = await seedApp(db, admin.tenantId)
    const member = await session('member', admin.tenantId)

    const denied = await request(
      `/api/apps/${app.id}`,
      { method: 'PATCH', headers: member.cookie },
      { json: { displayName: 'Nope' } }
    )
    expect(denied.status).toBe(403)

    const res = await request(
      `/api/apps/${app.id}`,
      { method: 'PATCH', headers: admin.cookie },
      { json: { displayName: 'Renamed', description: 'Claims and receipts' } }
    )
    expect(res.status).toBe(200)
    expect(appDetailSchema.parse(await res.json())).toMatchObject({
      displayName: 'Renamed',
      description: 'Claims and receipts',
    })
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, admin.tenantId), eq(auditEvents.action, 'app.updated')))
    expect(audit?.summary).toMatchObject({
      before: { displayName: app.displayName },
      after: { displayName: 'Renamed' },
    })

    const foreignGroup = await request(
      `/api/apps/${app.id}`,
      { method: 'PATCH', headers: admin.cookie },
      { json: { ownerGroupId: crypto.randomUUID() } }
    )
    expect(foreignGroup.status).toBe(400)
    expect(await foreignGroup.json()).toMatchObject({ code: 'unknown_group' })

    expect(
      (
        await request(
          `/api/apps/${app.id}`,
          { method: 'PATCH', headers: admin.cookie },
          { json: {} }
        )
      ).status
    ).toBe(400)
  })
})

describe('GET /api/apps/:id/operations', () => {
  it('returns the log newest first', async () => {
    const owner = await session('owner')
    const { app } = await seedApp(db, owner.tenantId)
    const runId = crypto.randomUUID()
    await db.insert(appOperations).values({
      tenantId: owner.tenantId,
      appId: app.id,
      runId,
      kind: 'import',
      step: 'read_repo',
      status: 'succeeded',
      attempt: 1,
      externalIds: { repo: 'acme/x' },
    })
    const body = appOperationListResponseSchema.parse(
      await (await request(`/api/apps/${app.id}/operations`, { headers: owner.cookie })).json()
    )
    expect(body.items).toEqual([
      expect.objectContaining({ runId, step: 'read_repo', externalIds: { repo: 'acme/x' } }),
    ])
  })
})

describe('the OIDC client', () => {
  it('registers once, returning the secret ONCE with the snippet; the store has only its hash', async () => {
    const admin = await session('admin')
    const slug = uniqueSlug('sso')
    const { app } = await seedApp(db, admin.tenantId, { slug })

    const created = await request(`/api/apps/${app.id}/oidc-client`, {
      method: 'POST',
      headers: admin.cookie,
    })
    expect(created.status).toBe(201)
    const body = appOidcClientSecretResponseSchema.parse(await created.json())
    expect(body.clientId).toMatch(/^lc_/)
    expect(body.issuer).toBe('http://localhost:3001')
    expect(body.clientSecret.length).toBeGreaterThanOrEqual(40)
    expect(body.client.secretHint).toBe(body.clientSecret.slice(-4))
    expect(body.client.redirectUris).toEqual([
      `https://${slug}-staging.apps.test/auth/oidc/callback`,
      `https://${slug}.apps.test/auth/oidc/callback`,
    ])
    expect(body.client.postLogoutRedirectUris).toEqual([
      `https://${slug}-staging.apps.test/login?signedOut=1`,
      `https://${slug}.apps.test/login?signedOut=1`,
    ])
    expect(body.snippet).toContain(`OIDC_ISSUER = "http://localhost:3001"`)
    expect(body.snippet).toContain(`OIDC_CLIENT_ID = "${body.clientId}"`)
    expect(body.snippet).toContain('AUTH_OIDC_ONLY = "true"')
    expect(body.snippet).toContain('wrangler secret put OIDC_CLIENT_SECRET')
    expect(body.snippet).not.toContain(body.clientSecret)

    const [row] = await db
      .select()
      .from(oidcClients)
      .where(and(eq(oidcClients.tenantId, admin.tenantId), eq(oidcClients.appId, app.id)))
    expect(row?.secretHash).toBe(await hashToken(body.clientSecret))
    expect(JSON.stringify(row)).not.toContain(body.clientSecret)

    // Afterwards the secret is gone: the read carries the hint and nothing else.
    const read = await request(`/api/apps/${app.id}/oidc-client`, { headers: admin.cookie })
    const text = await read.text()
    expect(text).not.toContain(body.clientSecret)
    expect(text).not.toContain(row?.secretHash ?? '<no hash>')
    expect(appOidcClientResponseSchema.parse(JSON.parse(text)).client).toMatchObject({
      clientId: body.clientId,
      secretHint: body.client.secretHint,
    })

    const again = await request(`/api/apps/${app.id}/oidc-client`, {
      method: 'POST',
      headers: admin.cookie,
    })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ statusCode: 409, code: 'oidc_client_exists' })

    // The audit rows never carry the secret.
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, admin.tenantId))
    expect(JSON.stringify(audits)).not.toContain(body.clientSecret)
    expect(await auditActions(admin.tenantId)).toContain('oidc_client.created')
  })

  it('rotates the secret — a new one, shown once, the old hash replaced — and audits it', async () => {
    const admin = await session('admin')
    const { app } = await seedApp(db, admin.tenantId)
    const first = appOidcClientSecretResponseSchema.parse(
      await (
        await request(`/api/apps/${app.id}/oidc-client`, { method: 'POST', headers: admin.cookie })
      ).json()
    )
    const res = await request(`/api/apps/${app.id}/oidc-client/rotate-secret`, {
      method: 'POST',
      headers: admin.cookie,
    })
    expect(res.status).toBe(200)
    const rotated = appOidcClientSecretResponseSchema.parse(await res.json())
    expect(rotated.clientId).toBe(first.clientId)
    expect(rotated.clientSecret).not.toBe(first.clientSecret)
    expect(rotated.client.secretRotatedAt).toBeInstanceOf(Date)
    const [row] = await db
      .select()
      .from(oidcClients)
      .where(and(eq(oidcClients.tenantId, admin.tenantId), eq(oidcClients.appId, app.id)))
    expect(row?.secretHash).toBe(await hashToken(rotated.clientSecret))
    expect(await auditActions(admin.tenantId)).toEqual(
      expect.arrayContaining(['oidc_client.created', 'oidc_client.secret_rotated'])
    )
  })

  it('replaces the redirect URIs, refusing a non-https one', async () => {
    const admin = await session('admin')
    const { app } = await seedApp(db, admin.tenantId)
    await request(`/api/apps/${app.id}/oidc-client`, { method: 'POST', headers: admin.cookie })

    const bad = await request(
      `/api/apps/${app.id}/oidc-client/redirect-uris`,
      { method: 'PATCH', headers: admin.cookie },
      { json: { redirectUris: ['http://evil.example.com/cb'] } }
    )
    expect(bad.status).toBe(400)

    const uris = [
      'https://expenses.example.com/auth/oidc/callback',
      'http://localhost:3001/auth/oidc/callback',
    ]
    const res = await request(
      `/api/apps/${app.id}/oidc-client/redirect-uris`,
      { method: 'PATCH', headers: admin.cookie },
      { json: { redirectUris: uris } }
    )
    expect(res.status).toBe(200)
    const body = appOidcClientResponseSchema.parse(await res.json())
    expect(body.client?.redirectUris).toEqual(uris)
    expect(await auditActions(admin.tenantId)).toContain('oidc_client.redirect_uris_updated')
  })

  it('is admin-only, and needs an environment URL to redirect to', async () => {
    const admin = await session('admin')
    const member = await session('member', admin.tenantId)
    const { app } = await seedApp(db, admin.tenantId)
    for (const [method, path] of [
      ['POST', 'oidc-client'],
      ['POST', 'oidc-client/rotate-secret'],
    ] as const) {
      const res = await request(`/api/apps/${app.id}/${path}`, { method, headers: member.cookie })
      expect(res.status).toBe(403)
    }
    // Members may still see that a client exists.
    expect(
      (await request(`/api/apps/${app.id}/oidc-client`, { headers: member.cookie })).status
    ).toBe(200)

    const { app: bare } = await seedApp(db, admin.tenantId, { environments: {} })
    const res = await request(`/api/apps/${bare.id}/oidc-client`, {
      method: 'POST',
      headers: admin.cookie,
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'no_environment_url' })

    const rotate = await request(`/api/apps/${bare.id}/oidc-client/rotate-secret`, {
      method: 'POST',
      headers: admin.cookie,
    })
    expect(rotate.status).toBe(404)
    expect(await json(rotate)).toMatchObject({ code: 'oidc_client_not_found' })
  })
})
