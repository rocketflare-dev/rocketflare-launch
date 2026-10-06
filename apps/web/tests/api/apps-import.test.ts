/**
 * Importing an existing Rocketflare app (`services/launch/import.ts`, spec/06). GitHub is a
 * recording fake handed in as `opts.fetch`, and the files it serves are THIS repo's own
 * `apps/web/wrangler{,.staging}.toml` and `launch.plugins.json` — real kit output.
 *
 * The GitHub App credential is handed in as `opts.github` rather than stored: `admin_credentials`
 * holds one row per kind for the whole database, and the setup suite owns that row. The route is
 * exercised for its auth and validation, which never reach GitHub.
 */
import { generateKeyPairSync } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { SYSTEM_ACTOR } from '@/api/services/launch/audit'
import { type ImportGitHub, importApp } from '@/api/services/launch/import'
import { parseManifest, parseWranglerToml } from '@/api/services/launch/rocketflare-manifest'
import { ApiError } from '@/api/utils/core/errors'
import { loadConfig } from '@/config'
import { appEnvironments, appOperations, apps, auditEvents, groups, groupTypes } from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, repoFixture, uniqueSlug } from '../helpers/launch-apps'
import { request } from '../helpers/request'
import { createTestEnv } from '../mocks/bindings'

const db = setupTestDatabase()
const cfg = loadConfig(createTestEnv())

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const PRODUCTION_TOML = repoFixture('apps/web/wrangler.toml')
const STAGING_TOML = repoFixture('apps/web/wrangler.staging.toml')
const LAUNCH_PLUGINS_JSON = repoFixture('launch.plugins.json')

interface Call {
  method: string
  url: string
  headers: Headers
  body: string | null
}

/** A GitHub that serves `files` (path → text; absent = 404) for any repo. */
function fakeGitHub(
  files: Record<string, string>,
  installations = [{ id: 77, login: 'acme' }],
  opts: { variables?: 'refuse' } = {}
) {
  const calls: Call[] = []
  const variables = new Map<string, string>()
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      method: init?.method ?? 'GET',
      url: url.toString(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    })
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    if (url.pathname === '/app/installations') {
      return json(
        installations.map(i => ({ id: i.id, account: { login: i.login }, permissions: {} }))
      )
    }
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return json({ token: 'ghs_fake_installation_token', expires_at: '2099-01-01T00:00:00Z' }, 201)
    }
    const contents = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/)
    if (contents?.[1]) {
      const text = files[decodeURIComponent(contents[1])]
      return text === undefined
        ? json({ message: 'Not Found' }, 404)
        : new Response(text, { status: 200 })
    }
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return json({ default_branch: 'main' })
    // Issue #21: the repo's Actions variables — none until written; `variables: 'refuse'` is an
    // installation without `actions_variables: write`.
    const variable = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/variables(?:\/(.+))?$/)
    if (variable) {
      const method = init?.method ?? 'GET'
      if (opts.variables === 'refuse' && method !== 'GET') {
        return json({ message: 'Resource not accessible by integration' }, 403)
      }
      const name = variable[1] ? decodeURIComponent(variable[1]) : null
      if (method === 'GET') {
        const value = name ? variables.get(name) : undefined
        return value === undefined ? json({ message: 'Not Found' }, 404) : json({ name, value })
      }
      if (method === 'PATCH') {
        if (!name || !variables.has(name)) return json({ message: 'Not Found' }, 404)
        variables.set(name, JSON.parse(String(init?.body)).value)
        return new Response(null, { status: 204 })
      }
      const sent = JSON.parse(String(init?.body)) as { name: string; value: string }
      variables.set(sent.name, sent.value)
      return new Response(null, { status: 201 })
    }
    return json({ message: `unexpected ${url.pathname}` }, 500)
  }) as typeof fetch
  return { calls, fetch: fetchImpl, variables }
}

function rocketflareJson(slug: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    app: { slug, display: 'Expense Tracker', domain: 'apps.example.com' },
    kit: { version: '0.15.0', commit: 'abc123' },
    defaultPlugins: [],
    ...extra,
  })
}

function repoFiles(manifest: Record<string, string>) {
  return {
    ...manifest,
    'apps/web/wrangler.toml': PRODUCTION_TOML,
    'apps/web/wrangler.staging.toml': STAGING_TOML,
  }
}

const github = (overrides: Partial<ImportGitHub> = {}): ImportGitHub => ({
  auth: { appId: '12345', privateKey },
  installationId: null,
  org: null,
  ...overrides,
})

/** Every tenant this file imported into — their apps name real hosts, so they go afterwards. */
const tenantIds: string[] = []
afterAll(() => forgetApps(db, tenantIds))

async function adminActor() {
  const { user, tenant } = await createTestTenantWithUser(db, 'admin')
  tenantIds.push(tenant.id)
  return {
    tenant,
    user,
    actor: {
      ...SYSTEM_ACTOR,
      actorType: 'user' as const,
      actorUserId: user.id,
      actorEmail: user.email,
    },
  }
}

/** The error a rejected promise carries, for its status and code. */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ApiError) return err
    throw err
  }
  throw new Error('expected the import to fail')
}

async function appsIn(tenantId: string) {
  return db.select().from(apps).where(eq(apps.tenantId, tenantId))
}

describe('the Rocketflare manifest and tomls', () => {
  it("reads this repo's own tomls: name, APP_URL, binding ids, and placeholders left out", () => {
    const production = parseWranglerToml(PRODUCTION_TOML, 'apps/web/wrangler.toml')
    expect(production).toMatchObject({
      workerName: 'launch',
      url: 'https://launch.clewro.com',
      appEnv: 'production',
      placeholders: ['<KV_RATE_LIMIT_ID>'],
    })
    expect(production.resources).toEqual({
      queues: [{ binding: 'JOBS_QUEUE', queue: 'launch-jobs' }],
      r2: [
        { binding: 'FILES', bucketName: 'launch-files' },
        { binding: 'BACKUP_BUCKET', bucketName: 'launch-files' },
      ],
      durableObjects: [
        { binding: 'NOTIFICATIONS_HUB', className: 'NotificationsHub' },
        { binding: 'SESSION_SANDBOX', className: 'SessionSandbox' },
      ],
      workflows: [
        { binding: 'AGENT_RUN_WORKFLOW', name: 'launch-agent-run', className: 'AgentRunWorkflow' },
        {
          binding: 'APP_LAUNCH_WORKFLOW',
          name: 'launch-app-create',
          className: 'AppLaunchWorkflow',
        },
        {
          binding: 'APP_TEARDOWN_WORKFLOW',
          name: 'launch-app-teardown',
          className: 'AppTeardownWorkflow',
        },
        { binding: 'SESSION_WORKFLOW', name: 'launch-session', className: 'SessionWorkflow' },
        {
          binding: 'GRANT_PUSH_WORKFLOW',
          name: 'launch-grant-push',
          className: 'GrantPushWorkflow',
        },
        {
          binding: 'AGENT_LOGIN_WORKFLOW',
          name: 'launch-agent-login',
          className: 'AgentLoginWorkflow',
        },
      ],
    })
    const staging = parseWranglerToml(STAGING_TOML, 'apps/web/wrangler.staging.toml')
    expect(staging).toMatchObject({
      workerName: 'launch-staging',
      url: 'https://launch-staging.clewro.com',
      placeholders: ['<KV_RATE_LIMIT_STAGING_ID>'],
    })
    expect(staging.resources.queues).toEqual([
      { binding: 'JOBS_QUEUE', queue: 'launch-jobs-staging' },
    ])
  })

  it('records a real KV id, and refuses text that is not TOML', () => {
    const withId = PRODUCTION_TOML.replace('<KV_RATE_LIMIT_ID>', '0123456789abcdef')
    expect(parseWranglerToml(withId, 'x').resources.kv).toEqual([
      { binding: 'RATE_LIMIT_KV', id: '0123456789abcdef' },
    ])
    expect(() => parseWranglerToml('name = [', 'apps/web/wrangler.toml')).toThrow(/not valid TOML/)
  })

  it('accepts both manifest shapes', () => {
    expect(parseManifest(rocketflareJson('expenses'))).toEqual({
      slug: 'expenses',
      displayName: 'Expense Tracker',
      domain: 'apps.example.com',
      kitVersion: '0.15.0',
      kitCommit: 'abc123',
    })
    expect(parseManifest(LAUNCH_PLUGINS_JSON, 'launch.plugins.json')).toMatchObject({
      slug: 'launch',
      displayName: 'Launch',
      kitVersion: '0.15.0',
    })
    expect(() => parseManifest('[]')).toThrow(/not a Rocketflare manifest/)
    expect(() => parseManifest('{nope')).toThrow(/not valid JSON/)
  })
})

describe('importApp', () => {
  it('writes the app, both environments, the operations and the audit row in one go', async () => {
    const { tenant, user, actor } = await adminActor()
    const slug = uniqueSlug('expenses')
    const gh = fakeGitHub(repoFiles({ '.rocketflare.json': rocketflareJson(slug) }))

    const { app, runId } = await importApp(
      db,
      cfg,
      tenant.id,
      { repo: 'acme/expense-tracker' },
      actor,
      { fetch: gh.fetch, github: github() }
    )

    expect(app).toMatchObject({
      tenantId: tenant.id,
      slug,
      displayName: 'Expense Tracker',
      source: 'imported',
      status: 'live',
      template: 'rocketflare',
      templateContractVersion: '1',
      templateVersion: '0.15.0',
      repoOwner: 'acme',
      repoName: 'expense-tracker',
      defaultBranch: 'main',
      createdByUserId: user.id,
    })

    const envs = await db
      .select()
      .from(appEnvironments)
      .where(and(eq(appEnvironments.tenantId, tenant.id), eq(appEnvironments.appId, app.id)))
    const byName = Object.fromEntries(envs.map(e => [e.name, e]))
    expect(byName.production).toMatchObject({
      url: 'https://launch.clewro.com',
      workerName: 'launch',
      healthStatus: 'unknown',
    })
    expect(byName.staging).toMatchObject({
      url: 'https://launch-staging.clewro.com',
      workerName: 'launch-staging',
    })
    expect(byName.staging?.resources.r2).toEqual([
      { binding: 'FILES', bucketName: 'launch-files-staging' },
      { binding: 'BACKUP_BUCKET', bucketName: 'launch-files-staging' },
    ])

    const ops = await db
      .select()
      .from(appOperations)
      .where(and(eq(appOperations.tenantId, tenant.id), eq(appOperations.appId, app.id)))
    expect(ops.map(o => o.step).sort()).toEqual([
      'read_repo',
      'register_production',
      'register_staging',
    ])
    expect(
      ops.every(o => o.runId === runId && o.kind === 'import' && o.status === 'succeeded')
    ).toBe(true)
    expect(ops.find(o => o.step === 'read_repo')?.externalIds).toMatchObject({
      repo: 'acme/expense-tracker',
      ref: 'main',
      manifest: '.rocketflare.json',
    })
    expect(ops.find(o => o.step === 'register_production')?.externalIds).toMatchObject({
      environmentId: byName.production?.id,
      placeholders: '<KV_RATE_LIMIT_ID>',
    })

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenant.id), eq(auditEvents.action, 'app.imported')))
    expect(audit).toMatchObject({
      actorType: 'user',
      actorUserId: user.id,
      appId: app.id,
      targetType: 'App',
      targetId: app.id,
    })
    expect(audit?.summary.after).toMatchObject({ slug, repo: 'acme/expense-tracker' })

    // The token asked for is narrowed to this one repo, read-only; every call names itself.
    const tokenCall = gh.calls.find(c => c.url.includes('/access_tokens'))
    expect(JSON.parse(tokenCall?.body ?? '{}')).toEqual({
      repositories: ['expense-tracker'],
      permissions: { contents: 'read' },
    })
    expect(tokenCall?.url).toContain('/app/installations/77/')
    expect(gh.calls.every(c => c.headers.get('user-agent'))).toBe(true)
    const fileCalls = gh.calls.filter(c => c.url.includes('/contents/'))
    expect(fileCalls.every(c => c.url.endsWith('?ref=main'))).toBe(true)
    expect(
      fileCalls.every(c => c.headers.get('authorization') === 'Bearer ghs_fake_installation_token')
    ).toBe(true)
  })

  it('sets LAUNCH_GATE_APP_ID on the repo after the import, and records it (issue #21)', async () => {
    const { tenant, actor } = await adminActor()
    const gh = fakeGitHub(repoFiles({ '.rocketflare.json': rocketflareJson(uniqueSlug()) }))
    const { app } = await importApp(db, cfg, tenant.id, { repo: 'acme/gated' }, actor, {
      fetch: gh.fetch,
      github: github(),
    })
    expect(gh.variables.get('LAUNCH_GATE_APP_ID')).toBe('12345')
    const [row] = await db.select().from(apps).where(eq(apps.id, app.id))
    expect(row?.gateVariableSetAt).toBeInstanceOf(Date)
  })

  it('an installation that may not write variables still imports; the sweep is left to set it', async () => {
    const { tenant, actor } = await adminActor()
    const gh = fakeGitHub(
      repoFiles({ '.rocketflare.json': rocketflareJson(uniqueSlug()) }),
      undefined,
      {
        variables: 'refuse',
      }
    )
    const { app } = await importApp(db, cfg, tenant.id, { repo: 'acme/ungated' }, actor, {
      fetch: gh.fetch,
      github: github(),
    })
    expect(app.status).toBe('live')
    expect(gh.variables.size).toBe(0)
    const [row] = await db.select().from(apps).where(eq(apps.id, app.id))
    expect(row?.gateVariableSetAt).toBeNull()
  })

  it('accepts the launch.plugins.json shape when there is no .rocketflare.json', async () => {
    const { tenant, actor } = await adminActor()
    const slug = uniqueSlug('plugins')
    const manifest = JSON.parse(LAUNCH_PLUGINS_JSON) as { app: { slug: string } }
    manifest.app.slug = slug
    const gh = fakeGitHub(repoFiles({ 'launch.plugins.json': JSON.stringify(manifest) }))
    const { app } = await importApp(
      db,
      cfg,
      tenant.id,
      { repo: 'acme/launch-copy', ref: 'v1.2.3' },
      actor,
      { fetch: gh.fetch, github: github() }
    )
    expect(app).toMatchObject({ slug, displayName: 'Launch', templateVersion: '0.15.0' })
    expect(app.defaultBranch).toBe('v1.2.3')
    // An explicit ref skips the default-branch lookup.
    expect(gh.calls.some(c => /\/repos\/acme\/launch-copy$/.test(new URL(c.url).pathname))).toBe(
      false
    )
  })

  it('uses the stored installation id for the configured org without listing installations', async () => {
    const { tenant, actor } = await adminActor()
    const gh = fakeGitHub(repoFiles({ '.rocketflare.json': rocketflareJson(uniqueSlug()) }), [])
    await importApp(db, cfg, tenant.id, { repo: 'Acme/tracker' }, actor, {
      fetch: gh.fetch,
      github: github({ installationId: 4242, org: 'acme' }),
    })
    expect(gh.calls.some(c => c.url.endsWith('/app/installations?per_page=100'))).toBe(false)
    expect(gh.calls.some(c => c.url.includes('/app/installations/4242/access_tokens'))).toBe(true)
  })

  it("refuses the repo's own manifest: 'launch' is a reserved slug", async () => {
    const { tenant, actor } = await adminActor()
    const gh = fakeGitHub(repoFiles({ 'launch.plugins.json': LAUNCH_PLUGINS_JSON }))
    const err = await rejection(
      importApp(db, cfg, tenant.id, { repo: 'acme/launch' }, actor, {
        fetch: gh.fetch,
        github: github(),
      })
    )
    expect(err).toMatchObject({ statusCode: 422, code: 'invalid_slug' })
    expect(err.message).toMatch(/reserved/)
    expect(await appsIn(tenant.id)).toEqual([])
  })

  it.each([
    ['Bad_Slug', /lower-case/],
    ['9lives', /start with a lower-case letter/],
    ['expenses-staging', /-staging/],
    ['admin', /reserved/],
    [`a${'b'.repeat(40)}`, /at most 40/],
  ])('refuses the slug %s', async (slug, message) => {
    const { tenant, actor } = await adminActor()
    const gh = fakeGitHub(repoFiles({ '.rocketflare.json': rocketflareJson(slug) }))
    const err = await rejection(
      importApp(db, cfg, tenant.id, { repo: 'acme/whatever' }, actor, {
        fetch: gh.fetch,
        github: github(),
      })
    )
    expect(err).toMatchObject({ statusCode: 422, code: 'invalid_slug' })
    expect(err.message).toMatch(message)
    expect(await appsIn(tenant.id)).toEqual([])
  })

  it('a duplicate slug is a 409 — across tenants too, because hostnames are global', async () => {
    const first = await adminActor()
    const second = await adminActor()
    const slug = uniqueSlug('dup')
    const files = repoFiles({ '.rocketflare.json': rocketflareJson(slug) })
    await importApp(db, cfg, first.tenant.id, { repo: 'acme/one' }, first.actor, {
      fetch: fakeGitHub(files).fetch,
      github: github(),
    })
    const err = await rejection(
      importApp(db, cfg, second.tenant.id, { repo: 'acme/two' }, second.actor, {
        fetch: fakeGitHub(files).fetch,
        github: github(),
      })
    )
    expect(err).toMatchObject({ statusCode: 409, code: 'slug_taken' })
    // The transaction rolled back: no app, no environments, no audit row for the second tenant.
    expect(await appsIn(second.tenant.id)).toEqual([])
    expect(
      await db.select().from(auditEvents).where(eq(auditEvents.tenantId, second.tenant.id))
    ).toEqual([])
  })

  it('a repo with no manifest is a 422 manifest_missing', async () => {
    const { tenant, actor } = await adminActor()
    const gh = fakeGitHub(repoFiles({}))
    const err = await rejection(
      importApp(db, cfg, tenant.id, { repo: 'acme/not-an-app' }, actor, {
        fetch: gh.fetch,
        github: github(),
      })
    )
    expect(err).toMatchObject({ statusCode: 422, code: 'manifest_missing' })
    expect(await appsIn(tenant.id)).toEqual([])
  })

  it('a missing staging toml is a 422 wrangler_config_missing naming the file', async () => {
    const { tenant, actor } = await adminActor()
    const gh = fakeGitHub({
      '.rocketflare.json': rocketflareJson(uniqueSlug()),
      'apps/web/wrangler.toml': PRODUCTION_TOML,
    })
    const err = await rejection(
      importApp(db, cfg, tenant.id, { repo: 'acme/half' }, actor, {
        fetch: gh.fetch,
        github: github(),
      })
    )
    expect(err).toMatchObject({ statusCode: 422, code: 'wrangler_config_missing' })
    expect(err.details).toEqual({ files: ['apps/web/wrangler.staging.toml'] })
  })

  it('a manifest that is not JSON is a 422 manifest_invalid', async () => {
    const { tenant, actor } = await adminActor()
    const gh = fakeGitHub(repoFiles({ '.rocketflare.json': '{ not json' }))
    const err = await rejection(
      importApp(db, cfg, tenant.id, { repo: 'acme/broken' }, actor, {
        fetch: gh.fetch,
        github: github(),
      })
    )
    expect(err).toMatchObject({ statusCode: 422, code: 'manifest_invalid' })
  })

  it('an owner the app is not installed on is a 422 github_app_not_installed', async () => {
    const { tenant, actor } = await adminActor()
    const gh = fakeGitHub(repoFiles({ '.rocketflare.json': rocketflareJson(uniqueSlug()) }), [
      { id: 1, login: 'someone-else' },
    ])
    const err = await rejection(
      importApp(db, cfg, tenant.id, { repo: 'acme/app' }, actor, {
        fetch: gh.fetch,
        github: github(),
      })
    )
    expect(err).toMatchObject({ statusCode: 422, code: 'github_app_not_installed' })
  })

  it('an owner team from another organisation is refused before GitHub is asked', async () => {
    const { tenant, actor } = await adminActor()
    const other = await adminActor()
    const [type] = await db
      .insert(groupTypes)
      .values({ tenantId: other.tenant.id, name: 'Teams' })
      .returning()
    const [group] = await db
      .insert(groups)
      .values({ tenantId: other.tenant.id, groupTypeId: type?.id ?? '', name: 'Finance' })
      .returning()
    const gh = fakeGitHub({})
    const err = await rejection(
      importApp(db, cfg, tenant.id, { repo: 'acme/app', ownerGroupId: group?.id }, actor, {
        fetch: gh.fetch,
        github: github(),
      })
    )
    expect(err).toMatchObject({ statusCode: 400, code: 'unknown_group' })
    expect(gh.calls).toEqual([])
  })
})

describe('POST /api/apps/import', () => {
  it('is 401 without a session and 403 for a member', async () => {
    const anonymous = await request(
      '/api/apps/import',
      { method: 'POST' },
      {
        json: { repo: 'acme/app' },
      }
    )
    expect(anonymous.status).toBe(401)

    const { user, tenant } = await createTestTenantWithUser(db, 'member')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const member = await request(
      '/api/apps/import',
      { method: 'POST', headers: { ...cookie, 'X-Requested-With': 'fetch' } },
      { json: { repo: 'acme/app' } }
    )
    expect(member.status).toBe(403)
  })

  it('validates the repo with the shared schema (400 envelope)', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'admin')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const res = await request(
      '/api/apps/import',
      { method: 'POST', headers: { ...cookie, 'X-Requested-With': 'fetch' } },
      { json: { repo: 'not a repo' } }
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ statusCode: 400 })
  })
})
