// @vitest-isolate
// Mocks the credentials module: `admin_credentials` and `launch_settings` hold one row per kind
// and key for the whole deployment and `setup.test.ts` owns the real tables (tests/helpers/
// credential-store.ts says why). The store below SEALS through the real `encryptToken`, so what
// it holds is exactly what the column would.
/**
 * `pnpm provision setup` (`scripts/provision/setup-db.ts`): the Setup page's settings and
 * credentials written by script — every value sealed with the INSTANCE's key (it unseals with that
 * key and with no other), a rerun with the same values changes nothing, a changed value is a
 * rotation, `force` (after `secrets --rotate`) re-seals everything, and each change leaves the
 * same audit row the routes write — actor `system`, user agent `launch-provision`, never a value.
 */
import type { CredentialKind } from '@launch/shared/launch-setup'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { decryptToken, encryptToken } from '@/api/auth/oauth-encryption'
import { loadConfig } from '@/config'
import { auditEvents } from '@/db/schema'
import { writeInstanceSetup } from '../../scripts/provision/setup-db'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv } from '../mocks/bindings'

interface Row {
  sealed: string
  metadata: Record<string, unknown>
  rotatedAt: Date | null
}
const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
  sealed: new Map<string, Row>(),
}))

vi.mock('@/api/services/launch/credentials', async importOriginal => {
  const real = await importOriginal<typeof import('@/api/services/launch/credentials')>()
  const mocked = (await import('../helpers/credential-store')).mockCredentialsModule(real, store)
  return {
    ...mocked,
    // The real seal, into memory: `sealed` is what the admin_credentials column would hold.
    putCredential: (async (db, cfg, kind, secret, metadata, userId) => {
      const result = await mocked.putCredential(db, cfg, kind, secret, metadata, userId)
      const sealed = await encryptToken(cfg, JSON.stringify(secret))
      store.sealed.set(kind, {
        sealed: sealed as string,
        metadata,
        rotatedAt: result.rotated ? new Date() : null,
      })
      return result
    }) as typeof real.putCredential,
  }
})

const db = setupTestDatabase()
const INSTANCE_KEY = 'ab'.repeat(32)
const OTHER_KEY = 'cd'.repeat(32)
const cfgFor = (key: string) =>
  loadConfig({
    ...createTestEnv(),
    APP_ENV: 'production',
    APP_URL: 'https://launch.example.test',
    OAUTH_ENCRYPTION_KEY: key,
  } as never)
const cfg = cfgFor(INSTANCE_KEY)

const CF_TOKEN = `cf_${'x'.repeat(37)}`
const NEON_KEY = `napi_${'n'.repeat(40)}`
const RESEND_KEY = `re_${'r'.repeat(30)}`
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----'

const input = (overrides: { apiToken?: string; force?: boolean } = {}) => ({
  settings: {
    apps_domain: 'example.test',
    cloudflare_account_id: '0123456789abcdef0123456789abcdef',
    neon_region_id: 'aws-eu-central-1',
    notifications_domain: 'notifications.example.test',
    github_org: 'example-org',
  },
  credentials: {
    cloudflare_api_token: { apiToken: overrides.apiToken ?? CF_TOKEN },
    neon_org_api_key: { apiKey: NEON_KEY },
    resend_api_key: { apiKey: RESEND_KEY },
    github_app: { appId: '12345', privateKey: PEM },
  },
  tenantName: 'Launch',
  ownerEmail: 'owner@example.test',
  force: overrides.force,
  checks: false as const,
})

/** Every `launch-provision` audit row, so a test can take the ones it added (by id, not clock). */
async function provisionRows(tenantId?: string) {
  return db
    .select()
    .from(auditEvents)
    .where(
      tenantId
        ? and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.userAgent, 'launch-provision'))
        : eq(auditEvents.userAgent, 'launch-provision')
    )
}
async function seen(): Promise<Set<string>> {
  return new Set((await provisionRows()).map(r => r.id))
}
const added = async (tenantId: string, before: Set<string>) =>
  (await provisionRows(tenantId)).filter(r => !before.has(r.id))

describe('provision setup', () => {
  it('seals every credential with the instance key, sets the settings, and audits both', async () => {
    const before = await seen()
    const result = await writeInstanceSetup(db, cfg, input())
    expect(result.credentials).toEqual({
      cloudflare_api_token: 'set',
      neon_org_api_key: 'set',
      resend_api_key: 'set',
      github_app: 'set',
    })
    expect(result.settingsChanged.sort()).toEqual(
      [
        'apps_domain',
        'cloudflare_account_id',
        'github_org',
        'neon_region_id',
        'notifications_domain',
      ].sort()
    )
    expect(store.settings.get('apps_domain')).toBe('example.test')

    // Sealed at rest: no plaintext in what is stored; it opens with the instance key only.
    for (const [kind, plain] of [
      ['cloudflare_api_token', CF_TOKEN],
      ['neon_org_api_key', NEON_KEY],
      ['resend_api_key', RESEND_KEY],
      ['github_app', 'MIIfake'],
    ] as const) {
      const row = store.sealed.get(kind) as Row
      expect(row.sealed).not.toContain(plain)
      expect(await decryptToken(cfg, row.sealed)).toContain(plain)
      expect(await decryptToken(cfgFor(OTHER_KEY), row.sealed).catch(() => null)).toBeNull()
      expect(row.metadata).toMatchObject({ source: 'provision' })
      expect(typeof row.metadata.fingerprint).toBe('string')
    }
    expect(store.sealed.get('github_app')?.metadata.appId).toBe('12345')

    const audit = await added(result.tenantId, before)
    const byAction = (action: string) => audit.filter(r => r.action === action)
    expect(
      byAction('credential.set')
        .map(r => r.targetId as CredentialKind)
        .sort()
    ).toEqual(['cloudflare_api_token', 'github_app', 'neon_org_api_key', 'resend_api_key'].sort())
    expect(byAction('setting.changed')).toHaveLength(1)
    for (const row of audit) {
      expect(row.actorType).toBe('system')
      expect(row.actorUserId).toBeNull()
      const text = JSON.stringify(row)
      for (const secret of [CF_TOKEN, NEON_KEY, RESEND_KEY, 'MIIfake'])
        expect(text).not.toContain(secret)
    }
  })

  it('a rerun with the same values writes nothing; a changed token is a rotation', async () => {
    const before = await seen()
    const again = await writeInstanceSetup(db, cfg, input())
    expect(Object.values(again.credentials)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
    ])
    expect(again.settingsChanged).toEqual([])
    expect(await added(again.tenantId, before)).toEqual([])

    const rotatedToken = `cf_${'y'.repeat(37)}`
    const rotated = await writeInstanceSetup(db, cfg, input({ apiToken: rotatedToken }))
    expect(rotated.credentials.cloudflare_api_token).toBe('rotated')
    expect(rotated.credentials.neon_org_api_key).toBe('unchanged')
    const row = store.sealed.get('cloudflare_api_token') as Row
    expect(row.rotatedAt).not.toBeNull()
    expect(await decryptToken(cfg, row.sealed)).toContain(rotatedToken)
    const audit = await added(rotated.tenantId, before)
    expect(audit.map(r => [r.action, r.targetId])).toEqual([
      ['credential.rotated', 'cloudflare_api_token'],
    ])
    expect(audit[0]?.summary).toMatchObject({ after: { value: 'rotated' } })
  })

  it('force re-seals every credential (after the OAuth key was rotated)', async () => {
    const rotatedCfg = cfgFor(OTHER_KEY)
    const forced = await writeInstanceSetup(
      db,
      rotatedCfg,
      input({ apiToken: `cf_${'y'.repeat(37)}`, force: true })
    )
    expect(new Set(Object.values(forced.credentials))).toEqual(new Set(['rotated']))
    const row = store.sealed.get('neon_org_api_key') as Row
    expect(await decryptToken(rotatedCfg, row.sealed)).toContain(NEON_KEY)
  })

  it('refuses a malformed value before writing anything, without echoing it', async () => {
    const before = store.sealed.get('resend_api_key')
    const bad = input()
    bad.credentials.resend_api_key = { apiKey: 'not-a-resend-key-value' }
    await expect(writeInstanceSetup(db, cfg, bad)).rejects.toThrow(
      /resend_api_key: .*\(the value is not shown\)/
    )
    await expect(writeInstanceSetup(db, cfg, bad)).rejects.not.toThrow(/not-a-resend-key-value/)
    expect(store.sealed.get('resend_api_key')).toBe(before)
  })
  it('runs each credential check like the Setup page does, and audits it', async () => {
    const before = await seen()
    // Every vendor answers 401: the checks run (through the fake), fail, and are recorded.
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: 'no' }] }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
    ) as unknown as typeof globalThis.fetch
    const { github_app: _app, ...credentials } = input().credentials
    const result = await writeInstanceSetup(db, cfg, {
      ...input(),
      credentials,
      checks: { fetch },
    })
    expect(fetch).toHaveBeenCalled()
    expect(Object.keys(result.checks).sort()).toEqual([
      'cloudflare_api_token',
      'neon_org_api_key',
      'resend_api_key',
    ])
    for (const check of Object.values(result.checks))
      expect(check?.failed.length).toBeGreaterThan(0)
    const checked = (await added(result.tenantId, before)).filter(
      r => r.action === 'credential.checked'
    )
    expect(checked.map(r => r.targetId).sort()).toEqual(Object.keys(result.checks).sort())
  })
})
