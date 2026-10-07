/**
 * Issue #6: `admin tenants|users|flags` and `platform settings|credentials|public-url|kit|agents|
 * sandbox|oidc|access-requests`, in-process against a fake server. Every route takes only an
 * ADMIN-scoped key (a 403 exits 3 with the `login --admin` hint); bodies are validated with the
 * shared schema before any request; destructive commands ask first and refuse without a terminal
 * or `--yes`; a credential comes from the hidden prompt / stdin and is never printed.
 */
import { setupOverviewSchema } from '@launch/shared/launch-setup'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runAdminFlagsClear,
  runAdminFlagsOverride,
  runAdminFlagsSet,
} from '../src/commands/admin-flags'
import {
  runAdminTenantsList,
  runAdminTenantsShow,
  runAdminTenantsSuspend,
  runAdminUsersBlock,
  runAdminUsersGrantAdmin,
} from '../src/commands/admin-orgs'
import {
  runPlatformAccessRequestApprove,
  runPlatformAccessRequestReject,
  runPlatformOidcRotate,
} from '../src/commands/platform-identity'
import {
  runPlatformAgentsSet,
  runPlatformCredentialCheck,
  runPlatformCredentialRemove,
  runPlatformCredentialSet,
  runPlatformKitCheck,
  runPlatformKitPin,
  runPlatformSettingsSet,
} from '../src/commands/platform-setup'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import type { Route } from './helpers'
import { jsonResponse, mockFetch, TENANT_ID, testContext } from './helpers'
import { at, loggedInStore } from './p4-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

const T2 = '22222222-3333-4444-8555-666666666666'
const U1 = '33333333-4444-4555-8666-777777777777'
const REQ = '44444444-5555-4666-8777-888888888888'

async function run(
  fn: (ctx: Awaited<ReturnType<typeof testContext>>['ctx']) => Promise<void>,
  routes: Record<string, Route>,
  json = false
) {
  const { fetch, calls } = mockFetch(routes)
  const t = await testContext({ store: await loggedInStore(cleanups), fetch, json })
  const error: any = await fn(t.ctx).then(
    () => null,
    (e: unknown) => e
  )
  const bodies = calls.map(c => (c.init.body ? JSON.parse(String(c.init.body)) : undefined))
  return { ...t, calls, bodies, error }
}

const tenantKeyRefused = () =>
  jsonResponse(
    { error: 'This needs an admin API key', statusCode: 403, code: 'admin_key_required' },
    403
  )
const yes = { yes: true }
const pagination = { page: 1, pageSize: 25, total: 1, totalPages: 1 }

const tenantItem = {
  id: T2,
  name: 'Acme',
  slug: 'acme',
  status: 'active',
  memberCount: 3,
  seedDataCreated: false,
  lastAccessedAt: at,
  createdAt: at,
}
const userItem = {
  id: U1,
  email: 'pat@acme.test',
  name: 'Pat',
  avatarUrl: null,
  isGlobalAdmin: false,
  emailVerifiedAt: at,
  lastLoginAt: at,
  blockedAt: null,
  tenantCount: 1,
  createdAt: at,
}

describe('admin tenants', () => {
  it('list sends the filters; --json prints the body', async () => {
    const body = { items: [tenantItem], pagination }
    const r = await run(
      c => runAdminTenantsList(c, { q: 'ac', status: 'active' }),
      { '/api/admin/tenants': () => jsonResponse(body) },
      true
    )
    expect(r.error).toBeNull()
    expect(r.calls[0]?.url.searchParams.get('q')).toBe('ac')
    expect(r.calls[0]?.url.searchParams.get('status')).toBe('active')
    expect(JSON.parse(r.out.content())).toEqual(body)
  })

  it('an invalid --status is refused before any request', async () => {
    const r = await run(c => runAdminTenantsList(c, { status: 'gone' }), {})
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.calls).toHaveLength(0)
  })

  it('show resolves a slug through the list', async () => {
    const r = await run(c => runAdminTenantsShow(c, 'acme'), {
      '/api/admin/tenants': () => jsonResponse({ items: [tenantItem], pagination }),
      [`/api/admin/tenants/${T2}`]: () =>
        jsonResponse({ ...tenantItem, members: [], supportAccess: false }),
    })
    expect(r.error).toBeNull()
    expect(r.calls.map(c => c.url.pathname)).toEqual([
      '/api/admin/tenants',
      `/api/admin/tenants/${T2}`,
    ])
    expect(r.out.content()).toContain('No members')
  })

  it('suspend asks first, refuses without a terminal, and POSTs { suspended: true }', async () => {
    const routes = {
      [`/api/admin/tenants/${T2}/suspend`]: () => jsonResponse({ id: T2, status: 'suspended' }),
    }
    const refused = await run(c => runAdminTenantsSuspend(c, T2), routes)
    expect(exitCodeFor(refused.error)).toBe(EXIT_ERROR)
    expect(refused.calls).toHaveLength(0)

    const questions: string[] = []
    const ok = await run(
      c =>
        runAdminTenantsSuspend(c, T2, {
          confirm: async q => {
            questions.push(q)
            return true
          },
        }),
      routes
    )
    expect(ok.error).toBeNull()
    expect(questions[0]).toContain("Every member's API access stops")
    expect(ok.bodies[0]).toEqual({ suspended: true })
  })

  it('a tenant key → 403 → exit 3 with the login --admin hint', async () => {
    const r = await run(c => runAdminTenantsList(c), { '/api/admin/tenants': tenantKeyRefused })
    expect(exitCodeFor(r.error)).toBe(EXIT_FORBIDDEN)
    expect(r.error.hint).toBe('this needs an admin key: launch login --admin')
  })
})

describe('admin users', () => {
  it('block resolves an email, asks, then POSTs { blocked: true }', async () => {
    const r = await run(
      c => runAdminUsersBlock(c, 'pat@acme.test', { confirm: async () => true }),
      {
        '/api/admin/users': () => jsonResponse({ items: [userItem], pagination }),
        [`/api/admin/users/${U1}/block`]: () => jsonResponse({ id: U1, blockedAt: at }),
      }
    )
    expect(r.error).toBeNull()
    expect(r.calls[1]?.url.pathname).toBe(`/api/admin/users/${U1}/block`)
    expect(r.bodies[1]).toEqual({ blocked: true })
  })

  it('grant-admin states the consequence; declining sends nothing', async () => {
    const questions: string[] = []
    const r = await run(
      c =>
        runAdminUsersGrantAdmin(c, U1, {
          confirm: async q => {
            questions.push(q)
            return false
          },
        }),
      {}
    )
    expect(r.error).toBeNull()
    expect(questions[0]).toContain('access to every organisation')
    expect(r.calls).toHaveLength(0)
  })

  it('grant-admin --yes POSTs { isGlobalAdmin: true }', async () => {
    const r = await run(c => runAdminUsersGrantAdmin(c, U1, yes), {
      [`/api/admin/users/${U1}/global-admin`]: () => jsonResponse({ id: U1, isGlobalAdmin: true }),
    })
    expect(r.error).toBeNull()
    expect(r.bodies[0]).toEqual({ isGlobalAdmin: true })
  })

  it('a 404 user exits 1', async () => {
    const r = await run(c => runAdminUsersBlock(c, U1, yes), {})
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
  })
})

const flag = {
  key: 'kit-ai',
  label: 'Chat',
  description: 'Chat',
  state: 'rollout',
  rolloutPercent: 20,
  rolloutUnit: 'user',
  environmentGated: false,
  availableInEnvironment: true,
  overrideCount: 0,
  updatedAt: at,
}

describe('admin flags', () => {
  it('set PATCHes the flags as a validated body', async () => {
    const r = await run(
      c => runAdminFlagsSet(c, 'kit-ai', { state: 'rollout', percent: '20', unit: 'user' }),
      {
        '/api/admin/feature-flags/kit-ai': () => jsonResponse(flag),
      }
    )
    expect(r.error).toBeNull()
    expect(r.calls[0]?.init.method).toBe('PATCH')
    expect(r.bodies[0]).toEqual({ state: 'rollout', rolloutPercent: 20, rolloutUnit: 'user' })
    expect(r.out.content()).toContain('rollout 20% of people')
  })

  it('an empty or invalid change is refused before any request', async () => {
    const empty = await run(c => runAdminFlagsSet(c, 'kit-ai', {}), {})
    expect(exitCodeFor(empty.error)).toBe(EXIT_ERROR)
    const bad = await run(c => runAdminFlagsSet(c, 'kit-ai', { percent: '150' }), {})
    expect(bad.error.message).toContain('rolloutPercent')
    expect(bad.calls).toHaveLength(0)
  })

  it('override PUTs { enabled }; clear DELETEs; single mode 404 exits 1', async () => {
    const path = `/api/admin/feature-flags/chat/overrides/${T2}`
    const on = await run(c => runAdminFlagsOverride(c, 'chat', T2, { on: true }), {
      [path]: () => new Response(null, { status: 204 }),
    })
    expect(on.error).toBeNull()
    expect([on.calls[0]?.init.method, on.bodies[0]]).toEqual(['PUT', { enabled: true }])

    const cleared = await run(c => runAdminFlagsClear(c, 'chat', T2), {
      [path]: () => new Response(null, { status: 204 }),
    })
    expect(cleared.calls[0]?.init.method).toBe('DELETE')

    const single = await run(c => runAdminFlagsClear(c, 'chat', T2), {
      [path]: () =>
        jsonResponse({ error: 'Single', statusCode: 404, code: 'tenancy_mode_single' }, 404),
    })
    expect(exitCodeFor(single.error)).toBe(EXIT_ERROR)
  })

  it('override needs exactly one of --on/--off', async () => {
    const r = await run(c => runAdminFlagsOverride(c, 'chat', T2, {}), {})
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.calls).toHaveLength(0)
  })
})

const overview = setupOverviewSchema.parse({
  steps: [],
  settings: {
    apps_domain: 'apps.example.com',
    cloudflare_account_id: null,
    neon_org_id: null,
    neon_region_id: null,
    notifications_domain: null,
    github_org: 'acme',
  },
  effectiveNotificationsDomain: null,
  credentials: [],
  identity: { providers: [], oidc: null, oidcOnly: false, checks: [] },
  publicUrl: { url: 'https://launch.example.com', status: null, checks: [], checkedAt: null },
  templatePin: {
    pin: { repo: 'rocketflare-dev/rocketflare', tag: '0.16.0', commit: 'a'.repeat(40) },
    isDefault: false,
    default: { repo: 'rocketflare-dev/rocketflare', tag: '0.16.0', commit: 'a'.repeat(40) },
    latestCheck: null,
  },
  sessionAgents: {
    runtimes: [
      {
        runtime: 'claude_code',
        label: 'Claude Code',
        accountLabel: 'Claude subscription',
        enabled: true,
        model: null,
        credentialMode: 'user_or_platform',
        isDefault: true,
        models: [],
        platformKey: { kind: 'anthropic_api_key', source: null },
        connectedAccounts: 0,
        minImage: null,
      },
    ],
  },
  sessionSandbox: { host: 'local', isDefault: true, options: [] },
})
const overviewJson = JSON.parse(JSON.stringify(overview))

const SECRET = 're_live_should_never_print_0123456789'
const checkResponse = (status: 'ok' | 'failed') => ({
  credential: {
    kind: 'resend_api_key',
    set: true,
    setAt: at,
    setByUserId: null,
    rotatedAt: null,
    metadata: {},
    lastCheckStatus: status,
    lastCheck: [],
    lastCheckedAt: at,
    setByEmail: null,
  },
  status,
  checks: [{ id: 'domain', label: 'Sending domain', status, detail: 'Domain not verified' }],
})

describe('platform settings and credentials', () => {
  it('settings set maps flags and --clear into a validated PUT', async () => {
    const r = await run(
      c => runPlatformSettingsSet(c, { githubOrg: 'acme', clear: 'neon_org_id' }),
      {
        '/api/platform/setup/settings': () => jsonResponse(overviewJson),
      }
    )
    expect(r.error).toBeNull()
    expect(r.bodies[0]).toEqual({ github_org: 'acme', neon_org_id: null })

    const bad = await run(c => runPlatformSettingsSet(c, { appsDomain: 'not a domain' }), {})
    expect(exitCodeFor(bad.error)).toBe(EXIT_ERROR)
    expect(bad.calls).toHaveLength(0)
  })

  it('credentials set reads the secret from the hidden prompt and never prints it', async () => {
    const r = await run(
      c =>
        runPlatformCredentialSet(c, 'resend_api_key', {
          isTTY: true,
          promptHidden: async () => SECRET,
        }),
      { '/api/platform/setup/credentials/resend_api_key': () => jsonResponse(checkResponse('ok')) }
    )
    expect(r.error).toBeNull()
    expect(r.calls[0]?.init.method).toBe('PUT')
    expect(r.bodies[0]).toEqual({ apiKey: SECRET })
    expect(r.out.content()).not.toContain(SECRET)
    expect(r.out.content()).toContain('Sending domain')
  })

  it('a value of the wrong shape is refused before sending, without echoing it', async () => {
    const r = await run(
      c =>
        runPlatformCredentialSet(c, 'resend_api_key', {
          isTTY: false,
          readStdin: async () => 'sk-not-a-resend-key\n',
        }),
      {}
    )
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.error.message).not.toContain('sk-not-a-resend-key')
    expect(r.calls).toHaveLength(0)
  })

  it('an inline --data credential is refused: secrets never go on argv', async () => {
    const r = await run(
      c => runPlatformCredentialSet(c, 'github_app', { data: '{"appId":"1"}' }),
      {}
    )
    expect(r.error.message).toContain('never goes on the command line')
    expect(r.calls).toHaveLength(0)
  })

  it('a failed check prints the probes and exits 1', async () => {
    const r = await run(c => runPlatformCredentialCheck(c, 'resend_api_key'), {
      '/api/platform/setup/credentials/resend_api_key/check': () =>
        jsonResponse(checkResponse('failed')),
    })
    expect(r.out.content()).toContain('Domain not verified')
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
  })

  it('remove asks first; a 404 (not set) exits 1; a 403 exits 3', async () => {
    const path = '/api/platform/setup/credentials/neon_org_api_key'
    const refused = await run(c => runPlatformCredentialRemove(c, 'neon_org_api_key'), {})
    expect(exitCodeFor(refused.error)).toBe(EXIT_ERROR)
    expect(refused.calls).toHaveLength(0)

    const missing = await run(c => runPlatformCredentialRemove(c, 'neon_org_api_key', yes), {
      [path]: () =>
        jsonResponse({ error: 'No credential', statusCode: 404, code: 'credential_not_set' }, 404),
    })
    expect(exitCodeFor(missing.error)).toBe(EXIT_ERROR)

    const forbidden = await run(c => runPlatformCredentialRemove(c, 'neon_org_api_key', yes), {
      [path]: tenantKeyRefused,
    })
    expect(exitCodeFor(forbidden.error)).toBe(EXIT_FORBIDDEN)
    expect(forbidden.error.hint).toBe('this needs an admin key: launch login --admin')
  })
})

describe('platform kit, agents', () => {
  it('kit pin sends the discriminated body; two choices are refused', async () => {
    const r = await run(c => runPlatformKitPin(c, { tag: '0.16.0' }), {
      '/api/platform/setup/template-pin': () => jsonResponse(overviewJson),
    })
    expect(r.error).toBeNull()
    expect(r.bodies[0]).toEqual({ kind: 'tag', tag: '0.16.0' })
    expect(r.out.content()).toContain('rocketflare-dev/rocketflare@0.16.0')

    const both = await run(c => runPlatformKitPin(c, { tag: 'x', latest: true }), {})
    expect(exitCodeFor(both.error)).toBe(EXIT_ERROR)
    expect(both.calls).toHaveLength(0)
  })

  it('kit check: 409 not following → exit 1 with the server sentence', async () => {
    const r = await run(c => runPlatformKitCheck(c), {
      '/api/platform/setup/template-pin/check': () =>
        jsonResponse(
          {
            error: 'The kit pin does not follow the latest release',
            statusCode: 409,
            code: 'template_pin_not_following',
          },
          409
        ),
    })
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.error.message).toContain('does not follow')
  })

  it('agents set keeps the rest of the runtime entry from the overview', async () => {
    const r = await run(c => runPlatformAgentsSet(c, { runtime: 'claude_code', disable: true }), {
      '/api/platform/setup': () => jsonResponse(overviewJson),
      '/api/platform/setup/session-agents': () => jsonResponse(overviewJson),
    })
    expect(r.error).toBeNull()
    expect(r.bodies[1]).toEqual({
      runtimes: {
        claude_code: { enabled: false, model: null, credentialMode: 'user_or_platform' },
      },
    })
  })
})

describe('platform oidc and access requests', () => {
  it('rotate asks first and refuses without a terminal', async () => {
    const r = await run(c => runPlatformOidcRotate(c), {})
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.calls).toHaveLength(0)
  })

  const request = {
    id: REQ,
    email: 'new@acme.test',
    userId: null,
    requestedTenantId: null,
    message: null,
    status: 'approved',
    decidedByUserId: null,
    decidedAt: at,
    createdAt: at,
  }
  const decidePath = `/api/platform/access-requests/${REQ}/decide`

  it("approve joins the profile's organisation as a member by default", async () => {
    const r = await run(c => runPlatformAccessRequestApprove(c, REQ), {
      [decidePath]: () => jsonResponse(request),
    })
    expect(r.error).toBeNull()
    expect(r.bodies[0]).toEqual({
      decision: 'approve',
      approve: { mode: 'join', tenantId: TENANT_ID, role: 'member' },
    })
  })

  it('reject sends the reason; an invalid role is refused first', async () => {
    const r = await run(c => runPlatformAccessRequestReject(c, REQ, { reason: 'Unknown' }), {
      [decidePath]: () => jsonResponse({ ...request, status: 'rejected' }),
    })
    expect(r.bodies[0]).toEqual({ decision: 'reject', reason: 'Unknown' })

    const bad = await run(c => runPlatformAccessRequestApprove(c, REQ, { role: 'king' }), {})
    expect(exitCodeFor(bad.error)).toBe(EXIT_ERROR)
    expect(bad.calls).toHaveLength(0)
  })
})
