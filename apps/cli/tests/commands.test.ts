/** Command tests (D26): tables vs `--json`, not-logged-in / forbidden exits, env key, config commands. */
import { afterEach, describe, expect, it } from 'vitest'
import { runConfigGet, runConfigPath, runConfigSet } from '../src/commands/config'
import { runGroupMembers, runGroupsList } from '../src/commands/groups'
import { runStatus } from '../src/commands/status'
import { runWhoami } from '../src/commands/whoami'
import { EXIT_FORBIDDEN, exitCodeFor } from '../src/errors'
import {
  captureError,
  headersOf,
  jsonResponse,
  mockFetch,
  TENANT_ID,
  TEST_KEY,
  tempStore,
  testContext,
  USER_ID,
} from './helpers'

const SERVER = 'http://server.test'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function loggedInStore() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({
    serverUrl: SERVER,
    apiKey: TEST_KEY,
    tenantId: TENANT_ID,
    tenantName: 'Acme',
  })
  return t.store
}

const GROUP_ID = '44444444-3333-4222-8111-000000000001'
const groupsBody = {
  items: [
    {
      id: GROUP_ID,
      tenantId: TENANT_ID,
      groupTypeId: '55555555-3333-4222-8111-000000000002',
      typeName: 'Department',
      name: 'Finance',
      description: null,
      memberCount: 2,
      createdAt: '2026-01-05T10:00:00.000Z',
      updatedAt: '2026-01-05T10:00:00.000Z',
    },
  ],
}

describe('groups', () => {
  it('list renders type, group and member count', async () => {
    const store = await loggedInStore()
    const api = mockFetch({ '/api/groups': () => jsonResponse(groupsBody) })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runGroupsList(ctx)
    const text = out.content()
    expect(text).toMatch(/Type\s+Group\s+People\s+Id/)
    expect(text).toContain('Finance')
    expect(text).toContain('Department')
  })

  it('members lists the people in one group, and --json prints the raw body', async () => {
    const store = await loggedInStore()
    const detail = {
      ...groupsBody.items[0],
      members: [
        {
          userId: USER_ID,
          email: 'alice@example.com',
          name: 'Alice',
          avatarUrl: null,
          addedAt: '2026-02-01T10:00:00.000Z',
        },
      ],
    }
    const api = mockFetch({ [`/api/groups/${GROUP_ID}`]: () => jsonResponse(detail) })
    const { ctx, out } = await testContext({ store, fetch: api.fetch, json: true })
    await runGroupMembers(ctx, GROUP_ID)
    expect(JSON.parse(out.content())).toEqual(detail)
  })

  it('a member gets exit 3 (forbidden) — administering groups is admin+', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/groups': () => jsonResponse({ error: 'Forbidden', statusCode: 403 }, 403),
    })
    const { ctx } = await testContext({ store, fetch: api.fetch })
    const error = await captureError(runGroupsList(ctx))
    expect(exitCodeFor(error)).toBe(EXIT_FORBIDDEN)
  })
})

describe('whoami', () => {
  it('shows user + tenant and never the full key', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/me': () =>
        jsonResponse({
          id: USER_ID,
          email: 'alice@example.com',
          name: 'Alice',
          isGlobalAdmin: false,
        }),
      '/api/tenant': () => jsonResponse({ id: TENANT_ID, name: 'Acme Inc', slug: 'acme' }),
    })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runWhoami(ctx)
    const text = out.content()
    expect(text).toContain('Alice <alice@example.com>')
    expect(text).toContain('Acme Inc')
    expect(text).toContain('launch_test…')
    expect(text).not.toContain(TEST_KEY)
  })

  it('falls back to the stored tenant when /api/tenant is forbidden, and is redacted under --json', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/me': () => jsonResponse({ email: 'alice@example.com', name: 'Alice' }),
      '/api/tenant': () => jsonResponse({ error: 'Forbidden', statusCode: 403 }, 403),
    })
    const { ctx, out } = await testContext({ store, fetch: api.fetch, json: true })
    await runWhoami(ctx)
    const json = JSON.parse(out.content())
    expect(json.user.email).toBe('alice@example.com')
    expect(json.tenant).toBeNull()
    expect(json.apiKey).toBe('launch_test…')
    expect(out.content()).not.toContain(TEST_KEY)
  })
})

describe('status', () => {
  it('reports health and login state', async () => {
    const store = await loggedInStore()
    const api = mockFetch({
      '/api/health': () => jsonResponse({ status: 'ok', version: '1.2.3', env: 'development' }),
    })
    const { ctx, out } = await testContext({ store, fetch: api.fetch })
    await runStatus(ctx)
    expect(out.content()).toContain('ok · v1.2.3 · development')
    expect(out.content()).toContain('signed in')
    expect(headersOf(api.calls).Authorization).toBeUndefined()
  })

  it('fails with a friendly network error (exit 1) when the server is down', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const { ctx } = await testContext({
      store: t.store,
      server: 'http://127.0.0.1:9',
      fetch: () =>
        Promise.reject(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
        ),
    })
    const error = await captureError(runStatus(ctx))
    expect(error.message).toContain('Could not reach http://127.0.0.1:9')
    expect(exitCodeFor(error)).toBe(1)
  })
})

describe('config commands', () => {
  it('get redacts, set validates, path prints the file', async () => {
    const store = await loggedInStore()
    const { ctx, out } = await testContext({ store, json: true })
    await runConfigGet(ctx)
    expect(out.content()).not.toContain(TEST_KEY)
    expect(JSON.parse(out.content()).apiKey).toBe('launch_test…')

    const { ctx: c2, out: o2 } = await testContext({ store })
    await runConfigGet(c2, 'apiKey')
    expect(o2.content().trim()).toBe('launch_test…')

    await expect(runConfigSet(c2, 'serverUrl', 'not a url')).rejects.toThrow(/not a valid URL/)
    await expect(runConfigSet(c2, 'bogus', 'x')).rejects.toThrow(/Unknown config key/)
    await runConfigSet(c2, 'serverUrl', 'https://app.example.com/')
    expect((await store.load()).serverUrl).toBe('https://app.example.com')

    const { ctx: c3, out: o3 } = await testContext({ store })
    await runConfigPath(c3)
    expect(o3.content().trim()).toBe(store.file)
  })
})
