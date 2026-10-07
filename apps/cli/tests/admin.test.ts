/**
 * Issue #6: `admin sessions|drain|undrain` and `platform setup`, in-process against a fake
 * server. These routes take only an ADMIN-scoped key: a 403 exits 3 with the `login --admin`
 * hint; drain and undrain ask first (injectable `confirm`) and refuse with no terminal and no
 * `--yes`; `platform setup` prints statuses and what to act on, never a value.
 */
import { setupOverviewSchema } from '@launch/shared/launch-setup'
import { afterEach, describe, expect, it } from 'vitest'
import { runAdminDrain, runAdminSessions, runAdminUndrain } from '../src/commands/admin'
import { runPlatformSetup, setupWarnings } from '../src/commands/platform'
import { EXIT_ERROR, EXIT_FORBIDDEN, EXIT_NOT_LOGGED_IN, exitCodeFor } from '../src/errors'
import type { Route } from './helpers'
import { jsonResponse, mockFetch, testContext } from './helpers'
import { APP_ID, at, loggedInStore } from './p4-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

const SESSION_ID = 'c0000000-0000-4000-8000-000000000001'
const OTHER_TENANT = '22222222-3333-4444-8555-666666666666'

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
  return { ...t, calls, error }
}

const tenantKeyRefused = () =>
  jsonResponse(
    { error: 'This needs an admin API key', statusCode: 403, code: 'admin_key_required' },
    403
  )

const adminSession = {
  id: SESSION_ID,
  appId: APP_ID,
  kind: 'session',
  shortId: 'abcdefghijkl',
  title: 'Fix the totals',
  status: 'ready',
  createdByUserId: null,
  branch: 'launch/abcdefghijkl',
  turnCount: 3,
  costMicrocents: 0,
  prNumber: null,
  prUrl: null,
  lastActivityAt: at,
  createdAt: at,
  appSlug: 'expenses',
  tenantId: OTHER_TENANT,
  imageVersion: '1.2.0',
  containerSeconds: 600,
}

describe('admin sessions', () => {
  it('lists sessions across the deployment with the drain flag; --json prints the body', async () => {
    const body = { items: [adminSession], paused: true }
    const human = await run(c => runAdminSessions(c, { scope: 'all' }), {
      '/api/admin/sessions': () => jsonResponse(body),
    })
    expect(human.error).toBeNull()
    expect(human.calls[0]?.url.searchParams.get('scope')).toBe('all')
    const text = human.out.content()
    expect(text).toContain('DRAINED')
    expect(text).toContain('expenses')
    expect(text).toContain('abcdefghijkl')
    expect(text).toContain('10 min')

    const json = await run(
      c => runAdminSessions(c),
      {
        '/api/admin/sessions': () => jsonResponse(body),
      },
      true
    )
    expect(JSON.parse(json.out.content())).toEqual(body)
    expect(json.calls[0]?.url.searchParams.get('scope')).toBe('active')
  })

  it('an unknown --scope is refused before any request', async () => {
    const r = await run(c => runAdminSessions(c, { scope: 'mine' }), {})
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.calls).toHaveLength(0)
  })

  it('a tenant key → 403 → exit 3 with the login --admin hint', async () => {
    const r = await run(c => runAdminSessions(c), { '/api/admin/sessions': tenantKeyRefused })
    expect(exitCodeFor(r.error)).toBe(EXIT_FORBIDDEN)
    expect(r.error.hint).toBe('this needs an admin key: launch login --admin')
  })

  it('an expired admin key → 401 → exit 2, pointing at login --admin', async () => {
    const r = await run(c => runAdminSessions(c), {
      '/api/admin/sessions': () =>
        jsonResponse({ error: 'Invalid API key', statusCode: 401, code: 'unauthorized' }, 401),
    })
    expect(exitCodeFor(r.error)).toBe(EXIT_NOT_LOGGED_IN)
    expect(r.error.hint).toContain('login --admin')
  })
})

describe('admin drain / undrain', () => {
  const drainRoutes = {
    '/api/admin/sessions/drain': () => jsonResponse({ paused: true, suspended: 2 }),
    '/api/admin/sessions/undrain': () => jsonResponse({ paused: false, suspended: 0 }),
  }

  it('drain asks first and POSTs once confirmed', async () => {
    const questions: string[] = []
    const r = await run(
      c =>
        runAdminDrain(c, {
          confirm: async q => {
            questions.push(q)
            return true
          },
        }),
      drainRoutes
    )
    expect(r.error).toBeNull()
    expect(questions).toHaveLength(1)
    expect(r.calls.map(call => [call.init.method, call.url.pathname])).toEqual([
      ['POST', '/api/admin/sessions/drain'],
    ])
    expect(r.out.content()).toContain('2 live sessions asked to suspend')
  })

  it('a declined prompt sends nothing; no terminal and no --yes refuses', async () => {
    const declined = await run(c => runAdminDrain(c, { confirm: async () => false }), drainRoutes)
    expect(declined.error).toBeNull()
    expect(declined.calls).toHaveLength(0)

    // Vitest's stdin is not a TTY, so with nothing injected there is nobody to ask.
    const refused = await run(c => runAdminUndrain(c), drainRoutes)
    expect(exitCodeFor(refused.error)).toBe(EXIT_ERROR)
    expect(refused.error.hint).toContain('--yes')
    expect(refused.calls).toHaveLength(0)
  })

  it('--yes skips the prompt; --json prints the body', async () => {
    const r = await run(c => runAdminUndrain(c, { yes: true }), drainRoutes, true)
    expect(r.error).toBeNull()
    expect(JSON.parse(r.out.content())).toEqual({ paused: false, suspended: 0 })
  })

  it('a 403 exits 3 with the hint', async () => {
    const r = await run(c => runAdminDrain(c, { yes: true }), {
      '/api/admin/sessions/drain': tenantKeyRefused,
    })
    expect(exitCodeFor(r.error)).toBe(EXIT_FORBIDDEN)
    expect(r.error.hint).toBe('this needs an admin key: launch login --admin')
  })
})

const check = (id: string, status: 'ok' | 'warning' | 'failed', detail?: string) => ({
  id,
  label: id,
  status,
  ...(detail ? { detail } : {}),
})

const credential = (kind: string, set: boolean, lastCheck: unknown[] | null = null) => ({
  kind,
  set,
  setAt: set ? at : null,
  setByUserId: null,
  rotatedAt: null,
  // Non-secret facts the server may send; the command must not print them.
  metadata: set ? { fingerprint: 'fp-should-not-print' } : {},
  lastCheckStatus: lastCheck ? 'failed' : null,
  lastCheck,
  lastCheckedAt: lastCheck ? at : null,
  setByEmail: null,
})

const overview = {
  steps: [
    { id: 'domain', status: 'ok' },
    { id: 'cloudflare', status: 'failed' },
    { id: 'neon', status: 'todo' },
    { id: 'resend', status: 'unchecked' },
    { id: 'github', status: 'ok' },
    { id: 'identity', status: 'ok' },
    { id: 'public_url', status: 'warning' },
  ],
  settings: {
    apps_domain: 'apps.example.com',
    cloudflare_account_id: null,
    neon_org_id: null,
    neon_region_id: null,
    notifications_domain: null,
    github_org: 'acme',
  },
  effectiveNotificationsDomain: 'notifications.apps.example.com',
  credentials: [
    credential('cloudflare_api_token', true, [
      check('zone.account', 'failed', 'Token lacks Zone:Edit'),
    ]),
    credential('neon_org_api_key', false),
  ],
  identity: { providers: ['google'], oidc: null, oidcOnly: false, checks: [] },
  publicUrl: {
    url: 'https://launch.example.com',
    status: 'warning',
    checks: [check('reachable', 'warning', 'Answered 302 from the internet')],
    checkedAt: at,
  },
  templatePin: {
    pin: { repo: 'rocketflare-dev/rocketflare', tag: '0.16.0', commit: 'a'.repeat(40) },
    isDefault: true,
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
        credentialMode: 'platform',
        isDefault: true,
        models: [],
        platformKey: { kind: 'anthropic_api_key', source: null },
        connectedAccounts: 0,
        minImage: null,
      },
    ],
  },
  sessionSandbox: { host: 'local', isDefault: true, options: [] },
}

describe('platform setup', () => {
  it('the fixture is a valid overview', () => {
    expect(setupOverviewSchema.safeParse(overview).success).toBe(true)
  })

  it('setupWarnings names only what someone has to act on', () => {
    const warnings = setupWarnings(setupOverviewSchema.parse(overview))
    expect(warnings).toEqual([
      'Neon: not set up yet',
      'Resend (email): entered but never checked',
      'cloudflare_api_token: zone.account — failed: Token lacks Zone:Edit',
      'Public URL: reachable — warning: Answered 302 from the internet',
      "Claude Code: enabled on Launch's account, but no anthropic_api_key is set",
    ])
    const fine = setupOverviewSchema.parse({
      ...overview,
      steps: overview.steps.map(s => ({ ...s, status: 'ok' })),
      credentials: [],
      publicUrl: { ...overview.publicUrl, checks: [] },
      sessionAgents: { runtimes: [] },
    })
    expect(setupWarnings(fine)).toEqual([])
  })

  it('prints steps, credential presence and the warnings — never metadata', async () => {
    const r = await run(c => runPlatformSetup(c), {
      '/api/platform/setup': () => jsonResponse(overview),
    })
    expect(r.error).toBeNull()
    const text = r.out.content()
    expect(text).toContain('Cloudflare')
    expect(text).toContain('not started')
    expect(text).toContain('To act on (5)')
    expect(text).toContain('Token lacks Zone:Edit')
    expect(text).toContain('rocketflare-dev/rocketflare@0.16.0 (default)')
    expect(text).not.toContain('fp-should-not-print')
  })

  it('--json prints the body; a 403 exits 3 with the login --admin hint', async () => {
    const json = await run(
      c => runPlatformSetup(c),
      { '/api/platform/setup': () => jsonResponse(overview) },
      true
    )
    expect(JSON.parse(json.out.content())).toEqual(overview)

    const refused = await run(c => runPlatformSetup(c), {
      '/api/platform/setup': tenantKeyRefused,
    })
    expect(exitCodeFor(refused.error)).toBe(EXIT_FORBIDDEN)
    expect(refused.error.hint).toBe('this needs an admin key: launch login --admin')
  })
})
