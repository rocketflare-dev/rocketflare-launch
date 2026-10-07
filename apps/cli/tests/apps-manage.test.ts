/**
 * Issue #6: the commands that CHANGE an app — `apps create|import|set|ship-settings|
 * branch-protection|teardown|sign-in …|thumbnail …` — in-process against a fake server: the body
 * is the shared contract's (checked before any request), a destructive one refuses without
 * `--yes`, `--follow` polls the run to its end, a 403 exits 3 and a 409 / 404 exits 1.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runAppsBranchProtection,
  runAppsCreate,
  runAppsImport,
  runAppsSet,
  runAppsShipSettings,
  runAppsSignInRedirectUris,
  runAppsSignInRegister,
  runAppsSignInRotate,
  runAppsSignInShow,
  runAppsTeardown,
  runAppsThumbnailGet,
  runAppsThumbnailRefresh,
  slugFromName,
} from '../src/commands/apps-manage'
import { EXIT_ERROR, EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import type { Route } from './helpers'
import { jsonResponse, mockFetch, testContext } from './helpers'
import { APP_ID, APPROVAL_ID, appDetail, at, loggedInStore } from './p4-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

const RUN_ID = 'f0000000-0000-4000-8000-000000000001'
const CLIENT_ID = 'c1000000-0000-4000-8000-000000000001'
const SECRET = 'oidc-secret-sentinel-91af'
const noSleep = async () => {}
const forbidden = () =>
  jsonResponse({ error: 'Forbidden', statusCode: 403, code: 'forbidden' }, 403)
const conflict = (error: string, code: string) =>
  jsonResponse({ error, statusCode: 409, code }, 409)
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body))
const appBase = `/api/apps/${APP_ID}`

async function run(
  fn: (ctx: Awaited<ReturnType<typeof testContext>>['ctx']) => Promise<void>,
  routes: Record<string, Route>,
  json = false
) {
  const { fetch, calls } = mockFetch({
    '/api/apps/expenses': () => jsonResponse(appDetail),
    ...routes,
  })
  const t = await testContext({ store: await loggedInStore(cleanups), fetch, json })
  const error: any = await fn(t.ctx).then(
    () => null,
    (e: unknown) => e
  )
  return { ...t, calls, error }
}

const step = (s: string, status: string, over: Record<string, unknown> = {}) => ({
  step: s,
  label: s === 'repo.create' ? 'Create the repository' : 'Deploy Staging',
  status,
  attempt: 1,
  error: null,
  url: null,
  startedAt: at,
  finishedAt: status === 'running' ? null : at,
  ...over,
})
const view = (status: string, steps: unknown[], kind = 'create') => ({
  appId: APP_ID,
  runId: RUN_ID,
  kind,
  status,
  steps,
  canRescaffold: false,
  rescaffoldChecksDatabase: false,
  templateTag: null,
})

describe('apps create', () => {
  it('suggests the slug from the name, sends the contract body and says what happens', async () => {
    expect(slugFromName('Café Expenses 2')).toBe('cafe-expenses-2')
    const created = { app: { ...appDetail, status: 'requested' }, runId: RUN_ID, approvalId: null }
    const r = await run(ctx => runAppsCreate(ctx, 'Expenses', { description: 'Claims' }), {
      '/api/apps': () => jsonResponse(created, 202),
    })
    expect(r.error).toBeNull()
    const call = r.calls.find(c => c.url.pathname === '/api/apps')
    expect(call?.init.method).toBe('POST')
    expect(bodyOf(call?.init as RequestInit)).toEqual({
      displayName: 'Expenses',
      slug: 'expenses',
      description: 'Claims',
      options: { deployStaging: true },
    })
    expect(r.out.content()).toContain('Launching Expenses')
  })

  it('refuses an invalid body before any request, listing the issues (exit 1)', async () => {
    const r = await run(ctx => runAppsCreate(ctx, 'X', { slug: 'Bad Slug!' }), {})
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.error.message).toContain('slug')
    expect(r.calls).toHaveLength(0)
  })

  it('reads --data and lets a flag win; --no-deploy-staging sets the option', async () => {
    const created = { app: appDetail, runId: RUN_ID, approvalId: null }
    const r = await run(
      ctx =>
        runAppsCreate(ctx, undefined, {
          data: '{"displayName":"Expenses","slug":"from-data"}',
          slug: 'expenses',
          deployStaging: false,
        }),
      { '/api/apps': () => jsonResponse(created, 202) }
    )
    expect(r.error).toBeNull()
    expect(bodyOf(r.calls[0]?.init as RequestInit)).toMatchObject({
      slug: 'expenses',
      options: { deployStaging: false },
    })
  })

  it('an approval to wait on is said, and not followed', async () => {
    const created = { app: appDetail, runId: RUN_ID, approvalId: APPROVAL_ID }
    const r = await run(ctx => runAppsCreate(ctx, 'Expenses', { follow: true, sleep: noSleep }), {
      '/api/apps': () => jsonResponse(created, 202),
    })
    expect(r.error).toBeNull()
    expect(r.out.content()).toContain('an administrator has to approve it')
    expect(r.out.content()).toContain(`approvals show ${APPROVAL_ID}`)
    expect(r.calls.some(c => c.url.pathname.endsWith('/pipeline'))).toBe(false)
  })

  it('--follow polls the run to its end; --json is ONE document with the pipeline', async () => {
    const created = { app: appDetail, runId: RUN_ID, approvalId: null }
    const views = [
      view('running', [step('repo.create', 'running'), step('deploy', 'pending')]),
      view('succeeded', [step('repo.create', 'succeeded'), step('deploy', 'succeeded')]),
    ]
    let i = 0
    const r = await run(
      ctx => runAppsCreate(ctx, 'Expenses', { follow: true, sleep: noSleep }),
      {
        '/api/apps': () => jsonResponse(created, 202),
        [`${appBase}/pipeline`]: () => jsonResponse(views[Math.min(i++, 1)]),
      },
      true
    )
    expect(r.error).toBeNull()
    const doc = JSON.parse(r.out.content())
    expect(doc.runId).toBe(RUN_ID)
    expect(doc.pipeline.status).toBe('succeeded')
  })

  it('--follow exits 1 at a failed step, naming it and the retry command', async () => {
    const created = { app: appDetail, runId: RUN_ID, approvalId: null }
    const r = await run(ctx => runAppsCreate(ctx, 'Expenses', { follow: true, sleep: noSleep }), {
      '/api/apps': () => jsonResponse(created, 202),
      [`${appBase}/pipeline`]: () =>
        jsonResponse(view('failed', [step('repo.create', 'failed', { error: 'name taken' })])),
    })
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.error.message).toContain('Create the repository')
    expect(r.error.message).toContain('name taken')
    expect(r.error.hint).toContain('apps pipeline retry expenses')
  })

  it('a taken slug is the server’s sentence (409 → 1); a 403 exits 3', async () => {
    const taken = await run(ctx => runAppsCreate(ctx, 'Expenses'), {
      '/api/apps': () => conflict('That slug is taken', 'slug_taken'),
    })
    expect(exitCodeFor(taken.error)).toBe(EXIT_ERROR)
    expect(taken.error.message).toBe('That slug is taken')
    const denied = await run(ctx => runAppsCreate(ctx, 'Expenses'), { '/api/apps': forbidden })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })
})

describe('apps import / set', () => {
  it('imports owner/name with a ref; --json is the app', async () => {
    const r = await run(
      ctx => runAppsImport(ctx, 'acme/expenses', { ref: 'main' }),
      { '/api/apps/import': () => jsonResponse(appDetail, 201) },
      true
    )
    expect(r.error).toBeNull()
    expect(bodyOf(r.calls[0]?.init as RequestInit)).toEqual({ repo: 'acme/expenses', ref: 'main' })
    expect(JSON.parse(r.out.content()).slug).toBe('expenses')
  })

  it('refuses a repo not in owner/name form before any request', async () => {
    const r = await run(ctx => runAppsImport(ctx, 'expenses'), {})
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.calls).toHaveLength(0)
  })

  it('set PATCHes the flags; "" clears the description; nothing to change is refused', async () => {
    const r = await run(ctx => runAppsSet(ctx, 'expenses', { name: 'Claims', description: '' }), {
      [appBase]: () => jsonResponse({ ...appDetail, displayName: 'Claims' }),
    })
    expect(r.error).toBeNull()
    const patch = r.calls.find(c => c.init.method === 'PATCH')
    expect(patch?.url.pathname).toBe(appBase)
    expect(bodyOf(patch?.init as RequestInit)).toEqual({ displayName: 'Claims', description: null })
    const empty = await run(ctx => runAppsSet(ctx, 'expenses', {}), {})
    expect(exitCodeFor(empty.error)).toBe(EXIT_ERROR)
    expect(empty.calls).toHaveLength(0)
  })
})

describe('apps ship-settings / branch-protection', () => {
  it('no flag prints the stored settings without a write', async () => {
    const r = await run(ctx => runAppsShipSettings(ctx, 'expenses'), {}, true)
    expect(r.error).toBeNull()
    expect(JSON.parse(r.out.content()).shipSettings.sessionShip).toBe('staging')
    expect(r.calls.every(c => (c.init.method ?? 'GET') === 'GET')).toBe(true)
  })

  it('PUTs the stored settings with the change; groups without a team is refused', async () => {
    const r = await run(ctx => runAppsShipSettings(ctx, 'expenses', { ship: 'pr' }), {
      [`${appBase}/ship-settings`]: () => jsonResponse(appDetail),
    })
    expect(r.error).toBeNull()
    const put = r.calls.find(c => c.init.method === 'PUT')
    expect(bodyOf(put?.init as RequestInit)).toEqual({
      sessionShip: 'pr',
      review: { mode: 'none', groupIds: [] },
    })
    const bad = await run(ctx => runAppsShipSettings(ctx, 'expenses', { review: 'groups' }), {})
    expect(exitCodeFor(bad.error)).toBe(EXIT_ERROR)
    expect(bad.error.message).toContain('Name at least one team')
  })

  it('reads the protection, and --apply POSTs it (403 → 3)', async () => {
    const bp = {
      state: 'none',
      requiredChecks: [],
      appCanBypass: false,
      rulesetId: null,
      detail: null,
      gateVariable: null,
    }
    const read = await run(ctx => runAppsBranchProtection(ctx, 'expenses'), {
      [`${appBase}/branch-protection`]: () => jsonResponse(bp),
    })
    expect(read.out.content()).toContain('Nothing protects the default branch')
    expect(read.out.content()).toContain('--apply')
    const denied = await run(ctx => runAppsBranchProtection(ctx, 'expenses', { apply: true }), {
      [`${appBase}/branch-protection`]: (_u, init) =>
        init.method === 'POST' ? forbidden() : jsonResponse(bp),
    })
    expect(exitCodeFor(denied.error)).toBe(EXIT_FORBIDDEN)
  })
})

describe('apps teardown', () => {
  it('refuses without --yes when nobody can be asked, before any write', async () => {
    const r = await run(ctx => runAppsTeardown(ctx, 'expenses', {}), {})
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.error.message).toContain('Refusing to archive expenses')
    expect(r.calls.some(c => c.init.method === 'POST')).toBe(false)
    expect(r.log.lines.join('\n')).toContain('The database — every row')
  })

  it('a “no” at the prompt writes nothing', async () => {
    const r = await run(ctx => runAppsTeardown(ctx, 'expenses', { confirm: async () => false }), {})
    expect(r.error).toBeNull()
    expect(r.calls.some(c => c.init.method === 'POST')).toBe(false)
  })

  it('--yes sends the slug as the confirmation and --follow ends with the run', async () => {
    let i = 0
    const r = await run(
      ctx =>
        runAppsTeardown(ctx, 'expenses', {
          yes: true,
          deleteRepo: true,
          follow: true,
          sleep: noSleep,
        }),
      {
        [`${appBase}/teardown`]: () => jsonResponse({ runId: RUN_ID }, 202),
        [`${appBase}/pipeline`]: url => {
          expect(url.searchParams.get('kind')).toBe('teardown')
          return jsonResponse(
            i++ === 0
              ? view('running', [step('deploy', 'running')], 'teardown')
              : view('succeeded', [step('deploy', 'succeeded')], 'teardown')
          )
        },
      }
    )
    expect(r.error).toBeNull()
    const post = r.calls.find(c => c.init.method === 'POST')
    expect(bodyOf(post?.init as RequestInit)).toEqual({ confirmSlug: 'expenses', deleteRepo: true })
    expect(r.out.content()).toContain('is archived')
  })

  it('an unknown app is a 404 (exit 1)', async () => {
    const r = await run(ctx => runAppsTeardown(ctx, 'nope', { yes: true }), {})
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
  })
})

describe('apps sign-in', () => {
  const client = {
    id: CLIENT_ID,
    clientId: 'app_expenses',
    secretHint: 'ab12',
    secretRotatedAt: null,
    redirectUris: ['https://expenses.apps.test/auth/oidc/callback'],
    postLogoutRedirectUris: [],
    accessPolicy: 'all',
    disabledAt: null,
    createdAt: at,
  }
  const secretBody = {
    client,
    clientId: 'app_expenses',
    clientSecret: SECRET,
    issuer: 'https://launch.test',
    snippet: 'OIDC_ISSUER = "https://launch.test"',
  }

  it('show prints the client without any secret; none yet points at register', async () => {
    const r = await run(ctx => runAppsSignInShow(ctx, 'expenses'), {
      [`${appBase}/oidc-client`]: () => jsonResponse({ client }),
    })
    expect(r.out.content()).toContain('app_expenses')
    expect(r.out.content()).toContain('ab12…')
    const none = await run(ctx => runAppsSignInShow(ctx, 'expenses'), {
      [`${appBase}/oidc-client`]: () => jsonResponse({ client: null }),
    })
    expect(none.out.content()).toContain('apps sign-in register expenses')
  })

  it('register prints the secret ONCE on stdout and never in a log line', async () => {
    const r = await run(ctx => runAppsSignInRegister(ctx, 'expenses'), {
      [`${appBase}/oidc-client`]: () => jsonResponse(secretBody, 201),
    })
    expect(r.error).toBeNull()
    expect(r.out.content().split(SECRET)).toHaveLength(2)
    expect(r.log.lines.join('\n')).not.toContain(SECRET)
    expect(r.log.lines.join('\n')).toContain('shown ONCE')
  })

  it('rotate-secret refuses without --yes; with it, POSTs and prints the new secret', async () => {
    const refused = await run(ctx => runAppsSignInRotate(ctx, 'expenses'), {})
    expect(exitCodeFor(refused.error)).toBe(EXIT_ERROR)
    expect(refused.calls.some(c => c.init.method === 'POST')).toBe(false)
    const r = await run(
      ctx => runAppsSignInRotate(ctx, 'expenses', { yes: true }),
      { [`${appBase}/oidc-client/rotate-secret`]: () => jsonResponse(secretBody) },
      true
    )
    expect(JSON.parse(r.out.content()).clientSecret).toBe(SECRET)
  })

  it('redirect-uris PATCHes valid URIs and refuses an http one before any request', async () => {
    const r = await run(
      ctx =>
        runAppsSignInRedirectUris(ctx, 'expenses', {
          redirect: ['https://expenses.example.com/cb'],
        }),
      { [`${appBase}/oidc-client/redirect-uris`]: () => jsonResponse({ client }) }
    )
    expect(r.error).toBeNull()
    const patch = r.calls.find(c => c.init.method === 'PATCH')
    expect(bodyOf(patch?.init as RequestInit)).toEqual({
      redirectUris: ['https://expenses.example.com/cb'],
    })
    const bad = await run(
      ctx => runAppsSignInRedirectUris(ctx, 'expenses', { redirect: ['http://evil.test/cb'] }),
      {}
    )
    expect(exitCodeFor(bad.error)).toBe(EXIT_ERROR)
    expect(bad.calls).toHaveLength(0)
  })
})

describe('apps thumbnail', () => {
  it('get streams the picture into a 0600 file; refresh says what was queued', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-thumb-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const out = join(dir, 'pic.png')
    const r = await run(ctx => runAppsThumbnailGet(ctx, 'expenses', { out }), {
      [`${appBase}/thumbnail`]: () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
    })
    expect(r.error).toBeNull()
    expect([...(await readFile(out))]).toEqual([1, 2, 3])
    expect((await stat(out)).mode & 0o777).toBe(0o600)
    const again = await run(ctx => runAppsThumbnailGet(ctx, 'expenses', { out }), {
      [`${appBase}/thumbnail`]: () => new Response(new Uint8Array([1])),
    })
    expect(again.error.message).toContain('already exists')

    const refresh = await run(ctx => runAppsThumbnailRefresh(ctx, 'expenses'), {
      [`${appBase}/thumbnail/refresh`]: () =>
        jsonResponse({ queued: ['staging', 'production'] }, 202),
    })
    expect(refresh.out.content()).toContain('Staging and Live')
  })

  it('no picture yet is a 404 (exit 1)', async () => {
    const r = await run(ctx => runAppsThumbnailGet(ctx, 'expenses', { out: '/tmp/never' }), {
      [`${appBase}/thumbnail`]: () =>
        jsonResponse({ error: 'No thumbnail yet', statusCode: 404 }, 404),
    })
    expect(exitCodeFor(r.error)).toBe(EXIT_ERROR)
    expect(r.error.message).toBe('No thumbnail yet')
  })
})
