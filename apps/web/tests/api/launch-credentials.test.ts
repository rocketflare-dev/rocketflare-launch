/**
 * The sealed credential store (spec/03, `services/launch/credentials.ts`): a stored credential is
 * sealed at rest (the column never holds the value), it unseals for the server, a second put is a
 * rotation, and `credentialStatus` — what a route may return — never carries a value.
 *
 * `admin_credentials` has one row per KIND for the whole deployment, so this file owns one kind
 * (`resend_api_key`) and leaves the others to the setup suite.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  credentialStatus,
  getCredential,
  getSetting,
  putCredential,
  putSetting,
  recordCheck,
  removeCredential,
} from '@/api/services/launch/credentials'
import { loadConfig } from '@/config'
import { adminCredentials } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())

describe('sealed credential store', () => {
  it('seals at rest, unseals for the server, rotates, checks and never reports a value', async () => {
    const first = `re_${crypto.randomUUID().replaceAll('-', '')}`
    const second = `re_${crypto.randomUUID().replaceAll('-', '')}`

    const set = await putCredential(
      db,
      cfg,
      'resend_api_key',
      { apiKey: first },
      { keyId: 'k1' },
      null
    )
    expect(set.rotated).toBe(false)

    // At rest: sealed, and the plaintext appears nowhere in the row.
    const [row] = await db
      .select()
      .from(adminCredentials)
      .where(eq(adminCredentials.kind, 'resend_api_key'))
    expect(row?.sealed).toBeTruthy()
    expect(JSON.stringify(row)).not.toContain(first)

    // Unsealed for the server.
    const stored = await getCredential(db, cfg, 'resend_api_key')
    expect(stored).toMatchObject({
      kind: 'resend_api_key',
      secret: { apiKey: first },
      metadata: { keyId: 'k1' },
    })

    // A check is recorded, and the worst probe wins.
    const status = await recordCheck(
      db,
      'resend_api_key',
      [
        { id: 'keys', label: 'Full-access key', status: 'ok' },
        {
          id: 'domain',
          label: 'Notifications domain verified',
          status: 'warning',
          detail: 'pending',
        },
      ],
      { domain: 'notifications.example.test' }
    )
    expect(status).toBe('warning')

    // Status: set, checked, metadata merged — and no value anywhere in it.
    const listed = await credentialStatus(db)
    expect(listed.map(s => s.kind).sort()).toEqual(
      [
        'anthropic_api_key',
        'cloudflare_api_token',
        'github_app',
        'neon_org_api_key',
        'openai_api_key',
        'resend_api_key',
      ].sort()
    )
    const resend = listed.find(s => s.kind === 'resend_api_key')
    expect(resend).toMatchObject({
      set: true,
      lastCheckStatus: 'warning',
      metadata: { keyId: 'k1', domain: 'notifications.example.test' },
    })
    expect(JSON.stringify(listed)).not.toContain(first)
    expect(JSON.stringify(listed)).not.toContain('sealed')

    // A second put is a rotation, and clears the check that described the old value.
    const rotated = await putCredential(db, cfg, 'resend_api_key', { apiKey: second }, {}, null)
    expect(rotated.rotated).toBe(true)
    expect((await getCredential(db, cfg, 'resend_api_key'))?.secret).toEqual({ apiKey: second })
    const after = (await credentialStatus(db)).find(s => s.kind === 'resend_api_key')
    expect(after).toMatchObject({ set: true, lastCheckStatus: null, rotatedAt: expect.any(Date) })

    // Removed → unset, and a fresh put is a set again rather than a rotation.
    expect(await removeCredential(db, 'resend_api_key')).toBe(true)
    expect(await getCredential(db, cfg, 'resend_api_key')).toBeNull()
    expect((await credentialStatus(db)).find(s => s.kind === 'resend_api_key')?.set).toBe(false)
    expect(await recordCheck(db, 'resend_api_key', [])).toBeNull()
  })

  it('refuses a payload that does not match its kind', async () => {
    await expect(
      putCredential(db, cfg, 'resend_api_key', { apiKey: 'not-a-resend-key' }, {}, null)
    ).rejects.toThrow()
  })

  it('refuses to store anything without OAUTH_ENCRYPTION_KEY (503)', async () => {
    const bare = { ...cfg, OAUTH_ENCRYPTION_KEY: undefined }
    await expect(
      putCredential(db, bare, 'resend_api_key', { apiKey: 're_abc' }, {}, null)
    ).rejects.toMatchObject({ statusCode: 503, code: 'oauth_encryption_key_missing' })
  })

  it('stores, replaces and removes a platform setting', async () => {
    const domain = `apps-${crypto.randomUUID().slice(0, 8)}.example.test`
    await putSetting(db, 'apps_domain', domain, null)
    expect(await getSetting<string>(db, 'apps_domain')).toBe(domain)
    await putSetting(db, 'apps_domain', `x.${domain}`, null)
    expect(await getSetting<string>(db, 'apps_domain')).toBe(`x.${domain}`)
    await putSetting(db, 'apps_domain', null, null)
    expect(await getSetting(db, 'apps_domain')).toBeNull()
  })
})
