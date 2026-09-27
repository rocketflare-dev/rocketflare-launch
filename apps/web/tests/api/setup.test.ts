// @vitest-isolate
// Stubs the global fetch (the vendor probes) AND owns every write to `admin_credentials` for the
// cloudflare, neon and github kinds, plus resend through the routes. That table holds ONE row per
// kind for the whole deployment, so two files writing a kind at once would race; `pnpm test` runs
// the shared `api` project to completion before this isolated one, which keeps it clear of
// `launch-credentials.test.ts` (resend, shared project), and the tests below run in order.
/**
 * `/api/admin/setup` (spec/03, spec/04): global admin only; settings are validated and audited
 * with before/after; a credential PUT seals the value, runs the probes and audits `credential.set`
 * then `credential.rotated`; a check audits `credential.checked`; a delete audits
 * `credential.removed`. No response — and no audit row — ever carries a secret, and the stored
 * row holds it only sealed.
 */
import { generateKeyPairSync } from 'node:crypto'
import type { SetupCheckResponse, SetupOverview } from '@launch/shared/launch-setup'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminCredentials, auditEvents, launchSettings } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  linkUserToTenant,
  sessionCookieHeader,
  uniqueId,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import {
  ACCOUNT_ID,
  cf,
  fakeVendorFetch,
  happyVendors,
  OTHER_ACCOUNT_ID,
  ZONE_ID,
} from '../helpers/vendor-fetch'

const db = setupTestDatabase()

const DOMAIN = `apps-${uniqueId().toLowerCase().replaceAll('_', '-')}.test`
const ORG = 'company-org'
const CF_TOKEN = `cf_${crypto.randomUUID().replaceAll('-', '')}`
const NEON_KEY = `napi_${crypto.randomUUID().replaceAll('-', '')}`
const RESEND_KEY = `re_${crypto.randomUUID().replaceAll('-', '')}`
const { privateKey: GITHUB_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
/** A distinctive line from inside the PEM body — present in no response if the key never leaks. */
const PEM_FRAGMENT = GITHUB_PEM.split('\n')[5] as string
const SECRETS = [CF_TOKEN, NEON_KEY, RESEND_KEY, PEM_FRAGMENT]

let vendors = fakeVendorFetch(happyVendors({ domain: DOMAIN, org: ORG }))
let admin: { cookie: Record<string, string>; tenantId: string; userId: string }
/** Every response body this file saw, checked for secrets at the end. */
const bodies: string[] = []

async function call(path: string, init: RequestInit = {}, body?: unknown) {
  const res = await request(
    path,
    { ...init, headers: { ...admin.cookie, ...init.headers } },
    {
      json: body,
    }
  )
  const text = await res.text()
  bodies.push(text)
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function auditRows(action: string) {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, admin.tenantId), eq(auditEvents.action, action)))
}

beforeAll(async () => {
  vi.stubGlobal('fetch', ((...args: Parameters<typeof fetch>) =>
    vendors.fetch(...args)) as typeof fetch)
  const user = await createTestGlobalAdmin(db)
  const tenant = await createTestTenant(db)
  await linkUserToTenant(db, user.id, tenant.id, 'owner')
  admin = {
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
    tenantId: tenant.id,
    userId: user.id,
  }
  // A clean slate for the kinds this file owns (see line 2).
  await db.delete(adminCredentials)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('guard', () => {
  it('401 without a session and 403 for an organisation owner who is not a global admin', async () => {
    const anon = await request('/api/admin/setup')
    expect(anon.status).toBe(401)
    expect(await json(anon)).toMatchObject({ statusCode: 401, error: expect.any(String) })

    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    for (const [path, method] of [
      ['/api/admin/setup', 'GET'],
      ['/api/admin/setup/settings', 'PUT'],
      ['/api/admin/setup/credentials/cloudflare_api_token', 'PUT'],
      ['/api/admin/setup/credentials/neon_org_api_key/check', 'POST'],
      ['/api/admin/setup/credentials/github_app', 'DELETE'],
    ] as const) {
      const res = await request(
        path,
        { method, headers: cookie },
        method === 'GET' ? {} : { json: {} }
      )
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(await json(res)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    }
  })
})

describe('settings', () => {
  it('validates, stores, audits before/after and lists them in the overview', async () => {
    const bad = await call(
      '/api/admin/setup/settings',
      { method: 'PUT' },
      { apps_domain: 'not a domain' }
    )
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ statusCode: 400, code: 'validation_failed' })

    const unknown = await call(
      '/api/admin/setup/settings',
      { method: 'PUT' },
      { secret_thing: 'x' }
    )
    expect(unknown.status).toBe(400)

    const res = await call(
      '/api/admin/setup/settings',
      { method: 'PUT' },
      {
        apps_domain: DOMAIN.toUpperCase(),
        cloudflare_account_id: ACCOUNT_ID,
        github_org: ORG,
        notifications_domain: null,
        neon_org_id: null,
        neon_region_id: null,
      }
    )
    expect(res.status).toBe(200)
    const overview = res.body as SetupOverview
    expect(overview.settings).toMatchObject({
      apps_domain: DOMAIN,
      cloudflare_account_id: ACCOUNT_ID,
      github_org: ORG,
    })
    expect(overview.effectiveNotificationsDomain).toBe(`notifications.${DOMAIN}`)

    const [row] = (await auditRows('setting.changed')).filter(r =>
      (r.targetId ?? '').includes('apps_domain')
    )
    expect(row).toMatchObject({ actorUserId: admin.userId, targetType: 'Setting' })
    expect(row?.summary.after).toMatchObject({ apps_domain: DOMAIN, github_org: ORG })
    expect(row?.summary.before).toHaveProperty('apps_domain')

    // Re-sending the same values changes nothing and records nothing.
    const before = (await auditRows('setting.changed')).length
    await call('/api/admin/setup/settings', { method: 'PUT' }, { apps_domain: DOMAIN })
    expect((await auditRows('setting.changed')).length).toBe(before)
  })

  it('audits into the one organisation when a global admin has no session tenant', async () => {
    const user = await createTestGlobalAdmin(db)
    const cookie = sessionCookieHeader(await createTestSession(db, user.id))
    const res = await request(
      '/api/admin/setup/settings',
      { method: 'PUT', headers: cookie },
      { json: { github_org: 'Other-Org' } }
    )
    expect(res.status).toBe(200)
    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorUserId, user.id), eq(auditEvents.action, 'setting.changed')))
    expect(rows).toHaveLength(1)
    // Put it back for the GitHub tests below.
    await call('/api/admin/setup/settings', { method: 'PUT' }, { github_org: ORG })
  })
})

describe('credentials', () => {
  it('refuses a payload that does not fit its kind, and an unknown kind', async () => {
    const res = await call(
      '/api/admin/setup/credentials/resend_api_key',
      { method: 'PUT' },
      { apiKey: 'not-a-resend-key' }
    )
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ statusCode: 400, code: 'validation_failed' })
    const bogus = await call('/api/admin/setup/credentials/aws_root', { method: 'PUT' }, {})
    expect(bogus.status).toBe(400)
    const [row] = await db
      .select()
      .from(adminCredentials)
      .where(eq(adminCredentials.kind, 'resend_api_key'))
    expect(row).toBeUndefined()
  })

  it('Cloudflare: sets, seals, checks, rotates, re-checks and removes — with audit rows', async () => {
    const put = await call(
      '/api/admin/setup/credentials/cloudflare_api_token',
      { method: 'PUT' },
      { apiToken: CF_TOKEN }
    )
    expect(put.status).toBe(200)
    const result = put.body as SetupCheckResponse
    // Write scope can never be proved, so the best Cloudflare gets is a warning.
    expect(result.status).toBe('warning')
    expect(result.checks.filter(c => c.status === 'failed')).toEqual([])
    expect(result.credential).toMatchObject({
      kind: 'cloudflare_api_token',
      set: true,
      setByUserId: admin.userId,
      setByEmail: expect.stringContaining('@'),
      lastCheckStatus: 'warning',
      metadata: expect.objectContaining({
        accountId: ACCOUNT_ID,
        tokenId: 'tok123',
        zoneId: ZONE_ID,
      }),
    })

    // Sealed at rest.
    const [row] = await db
      .select()
      .from(adminCredentials)
      .where(eq(adminCredentials.kind, 'cloudflare_api_token'))
    expect(row?.sealed).toBeTruthy()
    expect(JSON.stringify(row)).not.toContain(CF_TOKEN)

    const [set] = await auditRows('credential.set')
    expect(set).toMatchObject({ targetType: 'Credential', targetId: 'cloudflare_api_token' })
    expect(set?.summary.after).toMatchObject({ value: 'set', checkStatus: 'warning' })

    // Rotate into an account whose zone lives elsewhere: stored, but the zone probe fails.
    vendors = fakeVendorFetch({
      ...happyVendors({ domain: DOMAIN, org: ORG }),
      'api.cloudflare.com/client/v4/zones?name=': cf([
        { id: ZONE_ID, name: DOMAIN, status: 'active', account: { id: OTHER_ACCOUNT_ID } },
      ]),
    })
    const rotated = await call(
      '/api/admin/setup/credentials/cloudflare_api_token',
      { method: 'PUT' },
      { apiToken: `${CF_TOKEN}2` }
    )
    expect(rotated.body).toMatchObject({ status: 'failed' })
    expect((await auditRows('credential.rotated')).map(r => r.targetId)).toContain(
      'cloudflare_api_token'
    )
    const overview = (await call('/api/admin/setup')).body as SetupOverview
    expect(overview.steps.find(s => s.id === 'domain')?.status).toBe('failed')
    expect(overview.steps.find(s => s.id === 'cloudflare')?.status).toBe('failed')

    // Fixed upstream → re-check goes back to a warning, and is audited.
    vendors = fakeVendorFetch(happyVendors({ domain: DOMAIN, org: ORG }))
    const check = await call('/api/admin/setup/credentials/cloudflare_api_token/check', {
      method: 'POST',
    })
    expect(check.body).toMatchObject({ status: 'warning' })
    const [checked] = await auditRows('credential.checked')
    expect(checked?.summary.after).toMatchObject({ checkStatus: 'warning', failed: [] })
    // The fetch saw the ROTATED token, as a Bearer header, only on Cloudflare's API.
    expect(vendors.calls.every(c => c.authorization === `Bearer ${CF_TOKEN}2`)).toBe(true)

    const del = await call('/api/admin/setup/credentials/cloudflare_api_token', {
      method: 'DELETE',
    })
    expect(del).toMatchObject({ status: 200, body: { removed: true } })
    expect((await auditRows('credential.removed')).map(r => r.targetId)).toContain(
      'cloudflare_api_token'
    )
    const again = await call('/api/admin/setup/credentials/cloudflare_api_token', {
      method: 'DELETE',
    })
    expect(again.status).toBe(404)
    expect(again.body).toMatchObject({ statusCode: 404, code: 'credential_not_set' })
    const unsetCheck = await call('/api/admin/setup/credentials/cloudflare_api_token/check', {
      method: 'POST',
    })
    expect(unsetCheck.status).toBe(404)
  })

  it('Neon: discovers the org and pins the region into the settings', async () => {
    const put = await call(
      '/api/admin/setup/credentials/neon_org_api_key',
      { method: 'PUT' },
      { apiKey: NEON_KEY }
    )
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({
      status: 'warning',
      credential: { metadata: { orgId: 'org-test-12345' } },
    })
    const settings = await db.select().from(launchSettings)
    const byKey = Object.fromEntries(settings.map(s => [s.key, s.value]))
    expect(byKey).toMatchObject({ neon_org_id: 'org-test-12345', neon_region_id: 'aws-us-east-2' })
    // Pinned now, so the next check is clean.
    const check = await call('/api/admin/setup/credentials/neon_org_api_key/check', {
      method: 'POST',
    })
    expect(check.body).toMatchObject({ status: 'ok' })
  })

  it('Resend: a verified notifications domain passes; an unverified one does not', async () => {
    const put = await call(
      '/api/admin/setup/credentials/resend_api_key',
      { method: 'PUT' },
      { apiKey: RESEND_KEY }
    )
    expect(put.body).toMatchObject({ status: 'ok', credential: { metadata: { domainId: 'd1' } } })

    vendors = fakeVendorFetch({
      ...happyVendors({ domain: DOMAIN, org: ORG }),
      'api.resend.com/domains': {
        data: [{ id: 'd1', name: `notifications.${DOMAIN}`, status: 'failed' }],
      },
    })
    const check = await call('/api/admin/setup/credentials/resend_api_key/check', {
      method: 'POST',
    })
    expect(check.body).toMatchObject({ status: 'failed' })
    vendors = fakeVendorFetch(happyVendors({ domain: DOMAIN, org: ORG }))
    await call('/api/admin/setup/credentials/resend_api_key', { method: 'DELETE' })
  })

  it('GitHub App: stores the installation id, and fails a missing permission', async () => {
    const put = await call(
      '/api/admin/setup/credentials/github_app',
      { method: 'PUT' },
      { appId: 123456, privateKey: GITHUB_PEM }
    )
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({
      status: 'ok',
      credential: {
        metadata: { appId: '123456', installationId: 4242, appSlug: 'company-launch' },
      },
    })

    const { actions_variables: _, ...rest } = {
      administration: 'write',
      contents: 'write',
      workflows: 'write',
      pull_requests: 'write',
      actions: 'write',
      environments: 'write',
      actions_variables: 'write',
      deployments: 'write',
    }
    vendors = fakeVendorFetch(happyVendors({ domain: DOMAIN, org: ORG, permissions: rest }))
    const check = await call('/api/admin/setup/credentials/github_app/check', { method: 'POST' })
    const body = check.body as SetupCheckResponse
    expect(body.status).toBe('failed')
    expect(body.checks.find(c => c.id === 'permissions')?.detail).toContain('actions_variables')
    vendors = fakeVendorFetch(happyVendors({ domain: DOMAIN, org: ORG }))
  })

  it('never returns a secret, in any response or audit row', async () => {
    const overview = await call('/api/admin/setup')
    expect(overview.status).toBe(200)
    const o = overview.body as SetupOverview
    expect(o.credentials.map(c => c.kind).sort()).toEqual(
      [
        'anthropic_api_key',
        'cloudflare_api_token',
        'github_app',
        'neon_org_api_key',
        'resend_api_key',
      ].sort()
    )
    expect(o.identity.providers.length).toBeGreaterThan(0)
    for (const text of bodies) {
      for (const secret of SECRETS) expect(text).not.toContain(secret)
      expect(text).not.toContain('"sealed"')
    }
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, admin.tenantId))
    const auditText = JSON.stringify(audits)
    for (const secret of SECRETS) expect(auditText).not.toContain(secret)
  })
})
