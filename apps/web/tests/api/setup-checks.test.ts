/**
 * The setup wizard's vendor probes (`services/launch/setup.ts`), driven through an INJECTED fake
 * `fetch` — no network, no database. Happy paths for each vendor, and the failures the wizard
 * exists to catch: a zone in the wrong account, no wildcard record (created when the caller allows
 * it), a DNS-only one (left alone), a Neon region pinned without `GET /regions`, an unverified
 * notifications domain, a sending-only Resend key, a GitHub permission missing (Variables, S5), an app not
 * installed on the org, and a vendor error that must not echo the secret back.
 */
import { generateKeyPairSync } from 'node:crypto'
import {
  DEFAULT_NEON_REGION,
  launchSettingValueSchemas,
  NEON_REGIONS,
  type SetupSettings,
} from '@launch/shared/launch-setup'
import { describe, expect, it } from 'vitest'
import {
  checkAnthropic,
  checkCloudflare,
  checkGitHubApp,
  checkNeon,
  checkResend,
  identityStatus,
  missingGitHubPermissions,
  mostCommonRegion,
  scrub,
  stepStatuses,
} from '@/api/services/launch/setup'
import { loadConfig } from '@/config'
import {
  ACCOUNT_ID,
  cf,
  FULL_GITHUB_PERMISSIONS,
  fakeVendorFetch,
  happyVendors,
  jsonResponse,
  OTHER_ACCOUNT_ID,
  ZONE_ID,
} from '../helpers/vendor-fetch'
import { createTestEnv } from '../mocks/bindings'

const DOMAIN = 'company-apps.test'
const ORG = 'company'
const TOKEN = 'cf-token-abcdefghijklmnopqrstuvwxyz'
const settings: Partial<SetupSettings> = {
  apps_domain: DOMAIN,
  cloudflare_account_id: ACCOUNT_ID,
  github_org: ORG,
}
const CF = 'api.cloudflare.com/client/v4'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const githubSecret = { appId: '123456', privateKey }

const byId = (checks: { id: string; status: string }[]) =>
  Object.fromEntries(checks.map(c => [c.id, c.status]))

describe('checkCloudflare', () => {
  it('passes every probe on a correct account, and reports write scope as unverified', async () => {
    const fake = fakeVendorFetch(happyVendors({ domain: DOMAIN, org: ORG }))
    const out = await checkCloudflare({ apiToken: TOKEN }, settings, { fetch: fake.fetch })
    expect(byId(out.checks)).toEqual({
      'token.verify': 'ok',
      'account.workers': 'ok',
      'account.kv': 'ok',
      'account.queues': 'ok',
      'account.r2': 'ok',
      'zone.account': 'ok',
      'zone.wildcard': 'ok',
      'zone.routes': 'ok',
      'token.write': 'warning',
    })
    expect(out.metadata).toMatchObject({
      accountId: ACCOUNT_ID,
      tokenId: 'tok123',
      zoneId: ZONE_ID,
    })
    // The account-owned verify endpoint, and the token only ever as a Bearer header to Cloudflare.
    expect(fake.calls[0]?.url).toContain(`/accounts/${ACCOUNT_ID}/tokens/verify`)
    expect(fake.calls.every(c => c.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(fake.calls.every(c => c.url.startsWith('https://api.cloudflare.com/client/v4/'))).toBe(
      true
    )
    expect(fake.calls.find(c => c.url.includes('dns_records'))?.url).toContain(
      `name=${encodeURIComponent(`*.${DOMAIN}`)}`
    )
  })

  it('fails the zone when it lives in another account', async () => {
    const fake = fakeVendorFetch({
      ...happyVendors({ domain: DOMAIN, org: ORG }),
      [`${CF}/zones?name=`]: cf([
        { id: ZONE_ID, name: DOMAIN, status: 'active', account: { id: OTHER_ACCOUNT_ID } },
      ]),
    })
    const out = await checkCloudflare({ apiToken: TOKEN }, settings, { fetch: fake.fetch })
    const zone = out.checks.find(c => c.id === 'zone.account')
    expect(zone).toMatchObject({ status: 'failed' })
    expect(zone?.detail).toContain(OTHER_ACCOUNT_ID)
    // Nothing downstream of the zone is probed.
    expect(out.checks.some(c => c.id === 'zone.wildcard')).toBe(false)
  })

  it('fails when the zone is not visible to the token', async () => {
    const fake = fakeVendorFetch({
      ...happyVendors({ domain: DOMAIN, org: ORG }),
      [`${CF}/zones?name=`]: cf([]),
    })
    const out = await checkCloudflare({ apiToken: TOKEN }, settings, { fetch: fake.fetch })
    expect(byId(out.checks)['zone.account']).toBe('failed')
  })

  it('fails with no wildcard record and creates nothing unless the caller allows it', async () => {
    const none = fakeVendorFetch({
      ...happyVendors({ domain: DOMAIN, org: ORG }),
      [`${CF}/zones/${ZONE_ID}/dns_records`]: cf([]),
    })
    const a = await checkCloudflare({ apiToken: TOKEN }, settings, { fetch: none.fetch })
    expect(a.checks.find(c => c.id === 'zone.wildcard')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('No *.'),
    })
    expect(a.effects).toEqual([])
    expect(none.calls.every(c => c.method === 'GET')).toBe(true)
  })

  describe('the wildcard record, when the caller allows creating it', () => {
    /** A zone's DNS, stateful: GET lists `records`, POST appends (or answers `postError`). */
    function dnsZone(
      records: Record<string, unknown>[],
      postError?: { status: number; message: string }
    ) {
      const posts: Record<string, unknown>[] = []
      const fake = fakeVendorFetch({
        ...happyVendors({ domain: DOMAIN, org: ORG }),
        [`${CF}/zones/${ZONE_ID}/dns_records`]: (_url: string, init?: RequestInit) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse(cf(records))
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          posts.push(body)
          if (postError) {
            return jsonResponse(
              { success: false, errors: [{ code: 10000, message: postError.message }] },
              postError.status
            )
          }
          const record = { ...body, id: `rec${posts.length}`, name: `*.${DOMAIN}` }
          records.push(record)
          return jsonResponse(cf(record))
        },
      })
      return { ...fake, posts, records }
    }

    it('creates a proxied AAAA * → 100:: when the zone has none, once', async () => {
      const zone = dnsZone([])
      const out = await checkCloudflare({ apiToken: TOKEN }, settings, {
        fetch: zone.fetch,
        createWildcard: true,
      })
      expect(out.checks.find(c => c.id === 'zone.wildcard')).toEqual({
        id: 'zone.wildcard',
        label: 'Proxied wildcard DNS record',
        status: 'ok',
        detail: `Created proxied AAAA *.${DOMAIN} → 100::`,
      })
      expect(zone.posts).toEqual([
        expect.objectContaining({ type: 'AAAA', name: '*', content: '100::', proxied: true }),
      ])
      expect(out.effects).toEqual([
        {
          action: 'dns.wildcard.created',
          targetType: 'Zone',
          targetId: ZONE_ID,
          after: expect.objectContaining({ recordId: 'rec1', name: `*.${DOMAIN}`, proxied: true }),
        },
      ])
      expect(JSON.stringify(out.effects)).not.toContain(TOKEN)

      // Idempotent: the next run finds the record it made and creates nothing.
      const again = await checkCloudflare({ apiToken: TOKEN }, settings, {
        fetch: zone.fetch,
        createWildcard: true,
      })
      expect(again.checks.find(c => c.id === 'zone.wildcard')).toMatchObject({
        status: 'ok',
        detail: `AAAA *.${DOMAIN}`,
      })
      expect(again.effects).toEqual([])
      expect(zone.posts).toHaveLength(1)
    })

    it('leaves a DNS-only record alone and says what to do about it', async () => {
      const zone = dnsZone([
        { id: 'r', type: 'A', name: `*.${DOMAIN}`, content: '192.0.2.1', proxied: false },
      ])
      const out = await checkCloudflare({ apiToken: TOKEN }, settings, {
        fetch: zone.fetch,
        createWildcard: true,
      })
      const check = out.checks.find(c => c.id === 'zone.wildcard')
      expect(check).toMatchObject({ status: 'failed' })
      expect(check?.detail).toContain('DNS-only A record (→ 192.0.2.1)')
      expect(check?.detail).toContain('turn on its proxy')
      expect(zone.posts).toEqual([])
      expect(out.effects).toEqual([])
    })

    it('fails with the scrubbed vendor error when the token cannot create it', async () => {
      const zone = dnsZone([], {
        status: 403,
        message: `Authentication error for ${TOKEN}`,
      })
      const out = await checkCloudflare({ apiToken: TOKEN }, settings, {
        fetch: zone.fetch,
        createWildcard: true,
      })
      const check = out.checks.find(c => c.id === 'zone.wildcard')
      expect(check).toMatchObject({ status: 'failed' })
      expect(check?.detail).toContain('Cloudflare 403: 10000: Authentication error for [redacted]')
      expect(check?.detail).toContain('DNS Edit')
      expect(JSON.stringify(out)).not.toContain(TOKEN)
      expect(out.effects).toEqual([])
    })
  })

  it('stops at a rejected token, and never echoes the token from a vendor message', async () => {
    const fake = fakeVendorFetch({
      [`${CF}/accounts/${ACCOUNT_ID}/tokens/verify`]: () =>
        jsonResponse(
          { success: false, errors: [{ code: 1000, message: `Invalid API Token ${TOKEN}` }] },
          401
        ),
    })
    const out = await checkCloudflare({ apiToken: TOKEN }, settings, { fetch: fake.fetch })
    expect(out.checks).toHaveLength(1)
    expect(out.checks[0]).toMatchObject({ id: 'token.verify', status: 'failed' })
    expect(JSON.stringify(out)).not.toContain(TOKEN)
    expect(out.checks[0]?.detail).toContain('[redacted]')
  })

  it('needs the account id before it can verify anything', async () => {
    const fake = fakeVendorFetch({})
    const out = await checkCloudflare(
      { apiToken: TOKEN },
      { apps_domain: DOMAIN },
      { fetch: fake.fetch }
    )
    expect(out.checks).toEqual([expect.objectContaining({ id: 'token.verify', status: 'failed' })])
    expect(fake.calls).toHaveLength(0)
  })
})

describe('checkNeon', () => {
  const KEY = 'napi_orgkey_0123456789abcdefghij'

  const neonProjects = (...regions: string[]) => ({
    'console.neon.tech/api/v2/projects': {
      projects: regions.map((region_id, i) => ({
        id: `p${i}`,
        name: `p${i}`,
        region_id,
        org_id: 'org-test-12345',
      })),
    },
  })

  it('discovers the org and pins the region its projects are in, never calling /regions', async () => {
    const fake = fakeVendorFetch({
      ...happyVendors({ domain: DOMAIN, org: ORG }),
      ...neonProjects('aws-eu-central-1', 'aws-us-east-2', 'aws-eu-central-1'),
    })
    const out = await checkNeon({ apiKey: KEY }, {}, { fetch: fake.fetch })
    expect(byId(out.checks)).toEqual({ 'projects.list': 'ok', org: 'ok', region: 'warning' })
    expect(out.settings).toEqual({
      neon_org_id: 'org-test-12345',
      neon_region_id: 'aws-eu-central-1',
    })
    expect(out.checks.find(c => c.id === 'region')?.detail).toContain(
      "where 2 of the org's 3 projects are"
    )
    expect(fake.calls.map(c => c.url)).toEqual([
      'https://console.neon.tech/api/v2/projects?limit=100',
    ])
  })

  it("pins Neon's default for new projects when the org has none, with a warning", async () => {
    const fake = fakeVendorFetch({
      ...happyVendors({ domain: DOMAIN, org: ORG }),
      ...neonProjects(),
    })
    const out = await checkNeon(
      { apiKey: KEY },
      { neon_org_id: 'org-test-12345' },
      { fetch: fake.fetch }
    )
    expect(byId(out.checks)).toEqual({ 'projects.list': 'ok', org: 'ok', region: 'warning' })
    expect(out.settings).toEqual({ neon_region_id: DEFAULT_NEON_REGION })
    expect(out.checks.find(c => c.id === 'region')?.detail).toContain(
      'Change it before the first app'
    )
    expect(fake.calls.some(c => c.url.includes('/regions'))).toBe(false)
  })

  it('accepts a pinned region Launch knows, and only warns about one it does not', async () => {
    const fake = fakeVendorFetch(happyVendors({ domain: DOMAIN, org: ORG }))
    const good = await checkNeon(
      { apiKey: KEY },
      { neon_org_id: 'org-test-12345', neon_region_id: 'aws-eu-central-1' },
      { fetch: fake.fetch }
    )
    expect(byId(good.checks)).toEqual({ 'projects.list': 'ok', org: 'ok', region: 'ok' })
    expect(good.checks.find(c => c.id === 'region')?.detail).toContain('Frankfurt')
    expect(good.settings).toEqual({})
    expect(fake.calls[0]?.url).toContain('org_id=org-test-12345')

    const unknown = await checkNeon(
      { apiKey: KEY },
      { neon_org_id: 'org-test-12345', neon_region_id: 'aws-mars-1' },
      { fetch: fake.fetch }
    )
    expect(unknown.checks.find(c => c.id === 'region')).toMatchObject({
      status: 'warning',
      detail: expect.stringContaining('Neon will validate it when the first project is created'),
    })
    expect(unknown.settings).toEqual({})
    expect(fake.calls.some(c => c.url.includes('/regions'))).toBe(false)
  })

  it('offers only well-formed, distinct region ids, the default among them', () => {
    const ids = NEON_REGIONS.map(r => r.id)
    expect(ids).toContain(DEFAULT_NEON_REGION)
    for (const id of ids) expect(launchSettingValueSchemas.neon_region_id.parse(id)).toBe(id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reads the most common region, first seen winning a tie', () => {
    expect(mostCommonRegion([])).toBeNull()
    expect(
      mostCommonRegion([{ region_id: 'aws-us-west-2' }, { region_id: 'aws-us-east-1' }])
    ).toEqual({ regionId: 'aws-us-west-2', count: 1 })
  })

  it('fails on a rejected key without probing further', async () => {
    const fake = fakeVendorFetch({
      'console.neon.tech/api/v2/projects': () => jsonResponse({ message: 'unauthorized' }, 401),
    })
    const out = await checkNeon({ apiKey: KEY }, {}, { fetch: fake.fetch })
    expect(out.checks).toEqual([
      expect.objectContaining({
        id: 'projects.list',
        status: 'failed',
        detail: 'Neon 401: unauthorized',
      }),
    ])
  })
})

describe('checkResend', () => {
  const KEY = 're_full_access_0123456789abcdef'

  it('passes with a full-access key and a verified notifications domain', async () => {
    const fake = fakeVendorFetch(happyVendors({ domain: DOMAIN, org: ORG }))
    const out = await checkResend({ apiKey: KEY }, settings, { fetch: fake.fetch })
    expect(byId(out.checks)).toEqual({ 'key.full_access': 'ok', 'domain.verified': 'ok' })
    expect(out.metadata).toMatchObject({ domainId: 'd1', domain: `notifications.${DOMAIN}` })
  })

  it('refuses a sending-only key', async () => {
    const fake = fakeVendorFetch({
      'api.resend.com/api-keys': () =>
        jsonResponse({ name: 'restricted_api_key', message: 'This API key is restricted' }, 401),
    })
    const out = await checkResend({ apiKey: KEY }, settings, { fetch: fake.fetch })
    expect(out.checks).toEqual([
      expect.objectContaining({
        id: 'key.full_access',
        status: 'failed',
        detail: expect.stringContaining('full-access'),
      }),
    ])
  })

  it('warns while the domain is pending and fails when it is missing or failed', async () => {
    const withStatus = (status: string | null) =>
      fakeVendorFetch({
        ...happyVendors({ domain: DOMAIN, org: ORG }),
        'api.resend.com/domains': {
          data: status ? [{ id: 'd1', name: `notifications.${DOMAIN}`, status }] : [],
        },
      })
    const run = async (status: string | null) =>
      byId(
        (await checkResend({ apiKey: KEY }, settings, { fetch: withStatus(status).fetch })).checks
      )['domain.verified']
    expect(await run('pending')).toBe('warning')
    expect(await run('failed')).toBe('failed')
    expect(await run(null)).toBe('failed')
  })

  it('uses an explicit notifications domain over the derived one', async () => {
    const fake = fakeVendorFetch({
      ...happyVendors({ domain: DOMAIN, org: ORG }),
      'api.resend.com/domains': {
        data: [{ id: 'd2', name: 'mail.elsewhere.test', status: 'verified' }],
      },
    })
    const out = await checkResend(
      { apiKey: KEY },
      { ...settings, notifications_domain: 'mail.elsewhere.test' },
      { fetch: fake.fetch }
    )
    expect(byId(out.checks)['domain.verified']).toBe('ok')
  })
})

describe('checkGitHubApp', () => {
  it('finds the org installation and its permissions', async () => {
    const fake = fakeVendorFetch(happyVendors({ domain: DOMAIN, org: ORG, installationId: 777 }))
    const out = await checkGitHubApp(githubSecret, settings, { fetch: fake.fetch })
    expect(byId(out.checks)).toEqual({ app: 'ok', installation: 'ok', permissions: 'ok' })
    expect(out.metadata).toMatchObject({
      appId: '123456',
      appSlug: 'company-launch',
      installationId: 777,
    })
  })

  it('fails when a required permission is missing or read-only', async () => {
    const { actions_variables: _, ...withoutVariables } = FULL_GITHUB_PERMISSIONS
    const fake = fakeVendorFetch(
      happyVendors({
        domain: DOMAIN,
        org: ORG,
        permissions: { ...withoutVariables, deployments: 'read' },
      })
    )
    const out = await checkGitHubApp(githubSecret, settings, { fetch: fake.fetch })
    const perms = out.checks.find(c => c.id === 'permissions')
    expect(perms).toMatchObject({ status: 'failed' })
    expect(perms?.detail).toContain('actions_variables')
    expect(perms?.detail).toContain('deployments')
  })

  it('fails when the app is not installed on the org', async () => {
    const fake = fakeVendorFetch(happyVendors({ domain: DOMAIN, org: 'someone-else' }))
    const out = await checkGitHubApp(githubSecret, settings, { fetch: fake.fetch })
    expect(out.checks.find(c => c.id === 'installation')).toMatchObject({ status: 'failed' })
    expect(out.checks.some(c => c.id === 'permissions')).toBe(false)
  })

  it('fails on a key GitHub rejects', async () => {
    const fake = fakeVendorFetch({
      'api.github.com/app': () =>
        jsonResponse({ message: 'A JSON web token could not be decoded' }, 401),
    })
    const out = await checkGitHubApp(githubSecret, settings, { fetch: fake.fetch })
    expect(out.checks).toEqual([
      expect.objectContaining({
        id: 'app',
        status: 'failed',
        detail: expect.stringContaining('401'),
      }),
    ])
  })

  it('treats admin as at least write, and names every missing permission', () => {
    expect(
      missingGitHubPermissions({ ...FULL_GITHUB_PERMISSIONS, administration: 'admin' })
    ).toEqual([])
    expect(missingGitHubPermissions({})).toHaveLength(10)
  })

  it('needs READ on checks and statuses (P3: a session ships when its CI is green)', async () => {
    const { checks: _c, ...withoutChecks } = FULL_GITHUB_PERMISSIONS
    const fake = fakeVendorFetch(
      happyVendors({
        domain: DOMAIN,
        org: ORG,
        permissions: { ...withoutChecks, statuses: 'read' },
      })
    )
    const out = await checkGitHubApp(githubSecret, settings, { fetch: fake.fetch })
    const perms = out.checks.find(c => c.id === 'permissions')
    expect(perms).toMatchObject({ status: 'failed' })
    expect(perms?.detail).toContain('Missing read on: checks.')
    expect(perms?.detail).not.toContain('Missing write')
    // Read is enough for these two; write is enough for anything.
    expect(missingGitHubPermissions({ ...FULL_GITHUB_PERMISSIONS, checks: 'write' })).toEqual([])
    expect(missingGitHubPermissions({ ...FULL_GITHUB_PERMISSIONS, contents: 'read' })).toEqual([
      'contents',
    ])
  })
})

describe('checkAnthropic (P3)', () => {
  const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
  const models = (ids: string[]) =>
    fakeVendorFetch({
      'api.anthropic.com/v1/models': () =>
        jsonResponse({ data: ids.map(id => ({ id, type: 'model' })), has_more: false }),
    })

  it('accepts a key that lists the session model (matched by prefix — ids carry dates)', async () => {
    const fake = models(['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'])
    const out = await checkAnthropic({ apiKey: KEY }, settings, { fetch: fake.fetch })
    expect(byId(out.checks)).toEqual({ key: 'ok', model: 'ok' })
    expect(out.metadata).toMatchObject({ models: 2 })
    expect(JSON.stringify(out)).not.toContain(KEY)
  })

  it('warns when the key cannot see the policy model', async () => {
    const fake = models(['claude-haiku-4-5-20251001'])
    const out = await checkAnthropic({ apiKey: KEY }, settings, { fetch: fake.fetch })
    expect(byId(out.checks)).toEqual({ key: 'ok', model: 'warning' })
  })

  it('fails on a key Anthropic refuses, without echoing it', async () => {
    const fake = fakeVendorFetch({
      'api.anthropic.com/v1/models': () =>
        jsonResponse(
          {
            type: 'error',
            error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` },
          },
          401
        ),
    })
    const out = await checkAnthropic({ apiKey: KEY }, settings, { fetch: fake.fetch })
    expect(out.checks).toEqual([
      expect.objectContaining({
        id: 'key',
        status: 'failed',
        detail: expect.stringContaining('401'),
      }),
    ])
    expect(JSON.stringify(out)).not.toContain(KEY)
  })
})

describe('identity and steps', () => {
  it('reports the upstream providers read-only from the Worker config', () => {
    const cfg = loadConfig(createTestEnv())
    const identity = identityStatus(cfg)
    expect(identity.providers).toEqual(expect.arrayContaining(['google', 'microsoft']))
    expect(identity.checks.find(c => c.id === 'providers')?.status).toBe('ok')
    expect(identity.oidc).toBeNull()
    expect(JSON.stringify(identity)).not.toContain('test_google_client_secret')
  })

  it('derives each step from the settings and the stored checks', () => {
    const cfg = loadConfig(createTestEnv())
    const identity = identityStatus(cfg)
    const unset = {
      kind: 'neon_org_api_key' as const,
      set: false,
      setAt: null,
      setByUserId: null,
      setByEmail: null,
      rotatedAt: null,
      metadata: {},
      lastCheckStatus: null,
      lastCheck: null,
      lastCheckedAt: null,
    }
    const steps = stepStatuses(
      {
        apps_domain: DOMAIN,
        cloudflare_account_id: ACCOUNT_ID,
        neon_org_id: null,
        neon_region_id: null,
        notifications_domain: null,
        github_org: null,
      },
      [
        {
          ...unset,
          kind: 'cloudflare_api_token',
          set: true,
          lastCheckStatus: 'warning',
          lastCheck: [
            { id: 'zone.account', label: 'z', status: 'ok' },
            { id: 'token.write', label: 'w', status: 'warning' },
          ],
        },
        { ...unset, kind: 'resend_api_key', set: true },
        unset,
      ],
      identity
    )
    expect(Object.fromEntries(steps.map(s => [s.id, s.status]))).toEqual({
      domain: 'ok',
      cloudflare: 'warning',
      neon: 'todo',
      resend: 'unchecked',
      github: 'todo',
      identity: 'ok',
    })
  })

  it('scrub removes a secret wherever it appears', () => {
    expect(scrub('a SECRETVALUE1 b SECRETVALUE1', ['SECRETVALUE1'])).toBe(
      'a [redacted] b [redacted]'
    )
  })
})
