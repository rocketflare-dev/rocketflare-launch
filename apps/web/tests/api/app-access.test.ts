/**
 * `/api/app-access` (spec/05): asking for access to an app, and its owners deciding — the policy
 * (`company` | `restricted`), group and person grants, and the request queue. The authorize
 * endpoint is exercised at the end to prove an approval really opens the door.
 */
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { auditEvents, oidcClientGrants } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import {
  addTestAppOwner,
  createTestApp,
  createTestGroup,
  createTestOidcClient,
  ISSUER,
  issuerEnv,
  type TestOidcClient,
} from '../helpers/oidc'
import { json, request } from '../helpers/request'

const db = setupTestDatabase()
const env = issuerEnv()

let tenantId: string
let adminCookie: string
let ownerCookie: string
let memberCookie: string
let member: { id: string; email: string }
let app: { id: string; slug: string }
let client: TestOidcClient

async function newMember(role: 'member' | 'admin' = 'member') {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, role)
  return { user, cookie: await createTestSession(db, user.id, tenantId) }
}

function call(path: string, cookie: string, init: RequestInit & { json?: unknown } = {}) {
  const { json: body, ...rest } = init
  return request(
    `/api/app-access${path}`,
    { ...rest, headers: { ...sessionCookieHeader(cookie), ...(rest.headers ?? {}) } },
    { env, json: body }
  )
}

async function audits(action: string) {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action)))
}

function authorizePath(c: TestOidcClient) {
  return `/oidc/authorize?${new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: 'openid',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
  })}`
}

beforeAll(async () => {
  const seeded = await createTestTenantWithUser(db, 'admin')
  tenantId = seeded.tenant.id
  adminCookie = await createTestSession(db, seeded.user.id, tenantId)
  const owner = await newMember()
  ownerCookie = owner.cookie
  const plain = await newMember()
  member = plain.user
  memberCookie = plain.cookie
  const row = await createTestApp(db, tenantId)
  app = row
  await addTestAppOwner(db, tenantId, row.id, owner.user.id)
  client = await createTestOidcClient(db, tenantId, { appId: row.id, accessPolicy: 'restricted' })
})

describe('requesting access', () => {
  it('shows where the person stands, lets them ask once, and audits the request', async () => {
    const ctx = await call(`/request-context?clientId=${client.clientId}`, memberCookie)
    expect(ctx.status).toBe(200)
    expect(await json(ctx)).toMatchObject({
      app: { id: app.id, slug: app.slug },
      standing: 'none',
    })

    const first = await call('/requests', memberCookie, {
      method: 'POST',
      json: { clientId: client.clientId, message: 'For the quarterly close' },
    })
    expect(first.status).toBe(201)
    const created = await json<{ standing: string; request: { id: string; message: string } }>(
      first
    )
    expect(created.standing).toBe('pending')
    expect(created.request.message).toBe('For the quarterly close')

    // Asking again while one is open is the same request, not a second.
    const again = await call('/requests', memberCookie, {
      method: 'POST',
      json: { clientId: client.clientId },
    })
    expect(again.status).toBe(200)
    expect((await json<{ request: { id: string } }>(again)).request.id).toBe(created.request.id)

    const after = await json<{ standing: string }>(
      await call(`/request-context?clientId=${client.clientId}`, memberCookie)
    )
    expect(after.standing).toBe('pending')
    const rows = await audits('app.access.requested')
    expect(rows.filter(r => r.targetId === created.request.id)).toHaveLength(1)
    expect(rows[0]?.appId).toBe(app.id)
  })

  it('someone the policy already admits is told so and nothing is queued', async () => {
    const open = await createTestOidcClient(db, tenantId)
    const res = await call('/requests', memberCookie, {
      method: 'POST',
      json: { clientId: open.clientId },
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ standing: 'allowed', request: null })
  })

  it("another organisation's app is a 404, never a request", async () => {
    const other = await createTestTenantWithUser(db, 'owner')
    const foreign = await createTestOidcClient(db, other.tenant.id)
    const ctx = await call(`/request-context?clientId=${foreign.clientId}`, memberCookie)
    expect(ctx.status).toBe(404)
    const res = await call('/requests', memberCookie, {
      method: 'POST',
      json: { clientId: foreign.clientId },
    })
    expect(res.status).toBe(404)
  })

  it('401 without a session; 400 for a malformed body', async () => {
    const anon = await request(`/api/app-access/request-context?clientId=x`, {}, { env })
    expect(anon.status).toBe(401)
    const bad = await call('/requests', memberCookie, { method: 'POST', json: { message: 1 } })
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ statusCode: 400, code: 'validation_failed' })
  })
})

describe('the owner side', () => {
  it('owners and admins manage access; other members get the same 404 as a missing app', async () => {
    expect((await call(`/${app.id}/policy`, ownerCookie)).status).toBe(200)
    expect((await call(`/${app.slug}/policy`, adminCookie)).status).toBe(200)
    const denied = await call(`/${app.id}/policy`, memberCookie)
    expect(denied.status).toBe(404)
    expect((await call('/no-such-app/policy', adminCookie)).status).toBe(404)
  })

  it('an owner group member manages access too', async () => {
    const teammate = await newMember()
    const group = await createTestGroup(db, tenantId, 'App crew', [teammate.user.id])
    const groupApp = await createTestApp(db, tenantId, { ownerGroupId: group.id })
    await createTestOidcClient(db, tenantId, { appId: groupApp.id })
    expect((await call(`/${groupApp.id}/policy`, teammate.cookie)).status).toBe(200)
  })

  it('changes the policy and records before and after', async () => {
    const res = await call(`/${app.id}/policy`, ownerCookie, {
      method: 'PUT',
      json: { accessPolicy: 'company' },
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ accessPolicy: 'company', clientId: client.clientId })
    const rows = await audits('app.access.policy_changed')
    expect(
      rows.some(
        r =>
          r.summary.before?.accessPolicy === 'restricted' &&
          r.summary.after?.accessPolicy === 'company'
      )
    ).toBe(true)
    await call(`/${app.id}/policy`, ownerCookie, {
      method: 'PUT',
      json: { accessPolicy: 'restricted' },
    })
  })

  it('an app without an OIDC client says so', async () => {
    const bare = await createTestApp(db, tenantId)
    const policy = await json(await call(`/${bare.id}/policy`, adminCookie))
    expect(policy).toMatchObject({ hasClient: false, clientId: null, accessPolicy: null })
    const put = await call(`/${bare.id}/policy`, adminCookie, {
      method: 'PUT',
      json: { accessPolicy: 'restricted' },
    })
    expect(put.status).toBe(409)
    expect(await json(put)).toMatchObject({ code: 'oidc_client_missing' })
  })

  it('grants a group, a person by email and a person by id; removes one; refuses strangers', async () => {
    const group = await createTestGroup(db, tenantId, 'Finance')
    const byGroup = await call(`/${app.id}/grants`, ownerCookie, {
      method: 'POST',
      json: { groupId: group.id },
    })
    expect(byGroup.status).toBe(201)
    const person = await newMember()
    await call(`/${app.id}/grants`, ownerCookie, {
      method: 'POST',
      json: { email: person.user.email.toUpperCase() },
    })
    const list = await json<{
      items: { id: string; kind: string; name: string; email: string | null }[]
    }>(await call(`/${app.id}/grants`, ownerCookie))
    expect(list.items.find(g => g.kind === 'group')?.name).toBe('Finance')
    const personGrant = list.items.find(g => g.kind === 'user')
    expect(personGrant?.email).toBe(person.user.email)

    // Granting twice is one grant.
    await call(`/${app.id}/grants`, ownerCookie, {
      method: 'POST',
      json: { userId: person.user.id },
    })
    const again = await json<{ items: unknown[] }>(await call(`/${app.id}/grants`, ownerCookie))
    expect(again.items).toHaveLength(2)

    const removed = await call(`/${app.id}/grants/${personGrant?.id}`, ownerCookie, {
      method: 'DELETE',
    })
    expect(removed.status).toBe(204)

    const other = await createTestTenantWithUser(db, 'owner')
    const foreignGroup = await createTestGroup(db, other.tenant.id, 'Theirs')
    expect(
      (
        await call(`/${app.id}/grants`, ownerCookie, {
          method: 'POST',
          json: { groupId: foreignGroup.id },
        })
      ).status
    ).toBe(404)
    expect(
      (
        await call(`/${app.id}/grants`, ownerCookie, {
          method: 'POST',
          json: { userId: other.user.id },
        })
      ).status
    ).toBe(404)
    const changes = await audits('app.access.policy_changed')
    expect(changes.some(r => r.summary.after?.grantAdded === 'group')).toBe(true)
    expect(changes.some(r => r.summary.before?.grantRemoved === 'user')).toBe(true)
  })

  it('approving a request grants the person, who can then sign in; a second decision is 409', async () => {
    // Before: the restricted app sends the member to request access.
    const before = await request(
      authorizePath(client),
      { headers: sessionCookieHeader(memberCookie) },
      { env }
    )
    expect(new URL(before.headers.get('location') ?? '', ISSUER).pathname).toBe('/request-access')

    const queue = await json<{ items: { id: string; userId: string; userEmail: string }[] }>(
      await call(`/${app.id}/requests?status=pending`, ownerCookie)
    )
    const pending = queue.items.find(r => r.userId === member.id)
    expect(pending?.userEmail).toBe(member.email)

    const decided = await call(`/${app.id}/requests/${pending?.id}/decide`, ownerCookie, {
      method: 'POST',
      json: { decision: 'approve' },
    })
    expect(decided.status).toBe(200)
    expect(await json(decided)).toMatchObject({ status: 'approved', decidedAt: expect.any(String) })
    const grants = await db
      .select()
      .from(oidcClientGrants)
      .where(and(eq(oidcClientGrants.tenantId, tenantId), eq(oidcClientGrants.userId, member.id)))
    expect(grants).toHaveLength(1)

    const twice = await call(`/${app.id}/requests/${pending?.id}/decide`, adminCookie, {
      method: 'POST',
      json: { decision: 'reject' },
    })
    expect(twice.status).toBe(409)
    expect(await json(twice)).toMatchObject({ code: 'request_not_pending' })
    expect((await audits('app.access.decided')).some(r => r.targetId === pending?.id)).toBe(true)

    // After: the same browser gets a code.
    const after = await request(
      authorizePath(client),
      { headers: sessionCookieHeader(memberCookie) },
      { env }
    )
    expect(new URL(after.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy()
    const standing = await json<{ standing: string }>(
      await call(`/request-context?clientId=${client.clientId}`, memberCookie)
    )
    expect(standing.standing).toBe('allowed')
  })

  it('a rejected person sees it, and may ask again', async () => {
    const asker = await newMember()
    await call('/requests', asker.cookie, { method: 'POST', json: { clientId: client.clientId } })
    const queue = await json<{ items: { id: string; userId: string }[] }>(
      await call(`/${app.id}/requests`, ownerCookie)
    )
    const mine = queue.items.find(r => r.userId === asker.user.id)
    await call(`/${app.id}/requests/${mine?.id}/decide`, ownerCookie, {
      method: 'POST',
      json: { decision: 'reject' },
    })
    const ctx = await json<{ standing: string }>(
      await call(`/request-context?clientId=${client.clientId}`, asker.cookie)
    )
    expect(ctx.standing).toBe('rejected')
    const again = await call('/requests', asker.cookie, {
      method: 'POST',
      json: { clientId: client.clientId },
    })
    expect(again.status).toBe(201)
  })

  it("an unknown or another app's request id is a 404", async () => {
    const res = await call(`/${app.id}/requests/${crypto.randomUUID()}/decide`, ownerCookie, {
      method: 'POST',
      json: { decision: 'approve' },
    })
    expect(res.status).toBe(404)
  })

  it("another organisation's owner cannot reach this app at all", async () => {
    const other = await createTestTenantWithUser(db, 'owner')
    const cookie = await createTestSession(db, other.user.id, other.tenant.id)
    expect((await call(`/${app.id}/policy`, cookie)).status).toBe(404)
    expect((await call(`/${app.id}/requests`, cookie)).status).toBe(404)
  })
})
