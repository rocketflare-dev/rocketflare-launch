/**
 * Named servers (profiles): `servers ls|use|add|rm|rename`, where `login` stores a key (the
 * naming rules), `logout [--all]`, and `whoami`/`status`/`config` naming the active server.
 * In-process, temp `LAUNCH_CONFIG_DIR`, never the real `~/.launch`.
 */
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { runConfigGet, runConfigSet } from '../src/commands/config'
import { loginTarget } from '../src/commands/login'
import { runLogout } from '../src/commands/logout'
import {
  runServersAdd,
  runServersList,
  runServersRemove,
  runServersRename,
  runServersUse,
} from '../src/commands/servers'
import { runStatus } from '../src/commands/status'
import { runWhoami } from '../src/commands/whoami'
import { type CliConfig, createConfigStore } from '../src/config'
import { EXIT_ERROR } from '../src/errors'
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

const LOCAL = 'http://localhost:3001'
const PROD = 'https://launch.example.com'
const PROD_KEY = 'launch_prod_abcdefghijklmnopqrstuvwxyz0123456789'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

async function twoServers() {
  const t = await tempStore()
  cleanups.push(t.cleanup)
  await t.store.save({
    defaultProfile: 'local',
    profiles: {
      local: { serverUrl: LOCAL, apiKey: TEST_KEY, tenantName: 'Dev', user: { email: 'a@x' } },
      prod: { serverUrl: PROD, apiKey: PROD_KEY, tenantName: 'Acme' },
    },
  })
  return t.store
}

describe('servers ls', () => {
  it('lists every server, marks default and active, never prints a full key', async () => {
    const store = await twoServers()
    const { ctx, out } = await testContext({ store, server: 'prod' })
    await runServersList(ctx)
    const text = out.content()
    expect(text).toMatch(/\*\s+local/)
    expect(text).toContain('prod (active)')
    expect(text).toContain('launch_prod…')
    expect(text).not.toContain(PROD_KEY)
    expect(text).not.toContain(TEST_KEY)

    const { ctx: j, out: jo } = await testContext({ store, json: true })
    await runServersList(j)
    const body = JSON.parse(jo.content())
    expect(body.defaultProfile).toBe('local')
    expect(body.active).toBe('local')
    expect(body.servers.map((s: { name: string }) => s.name)).toEqual(['local', 'prod'])
    expect(body.servers[1]).toMatchObject({ apiKey: 'launch_prod…', tenantName: 'Acme' })
    expect(jo.content()).not.toContain(PROD_KEY)
  })
})

describe('servers use / add / rm / rename', () => {
  it('use sets the default; an unknown name is exit 1 listing known names', async () => {
    const store = await twoServers()
    const { ctx } = await testContext({ store })
    await runServersUse(ctx, 'prod')
    expect((await store.load()).defaultProfile).toBe('prod')
    expect((await store.resolve()).apiKey).toBe(PROD_KEY)
    const error = await captureError(runServersUse(ctx, 'staging'))
    expect(error.exitCode).toBe(EXIT_ERROR)
    expect(error.hint).toContain('local, prod')
  })

  it('add registers a URL without a key, refuses duplicates and bad input; the first becomes default', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const { ctx } = await testContext({ store: t.store })
    await runServersAdd(ctx, 'staging', 'https://staging.example.com/')
    const config = await t.store.load()
    expect(config).toEqual({
      defaultProfile: 'staging',
      profiles: { staging: { serverUrl: 'https://staging.example.com' } },
    })
    await expect(runServersAdd(ctx, 'staging', LOCAL)).rejects.toThrow(/already exists/)
    await expect(runServersAdd(ctx, 'x', 'not-a-url')).rejects.toThrow(/not a valid URL/)
    await expect(runServersAdd(ctx, 'has space', LOCAL)).rejects.toThrow(/not a valid server name/)
    await runServersAdd(ctx, 'local', LOCAL)
    expect((await t.store.load()).defaultProfile).toBe('staging')
  })

  it('rm forgets a server and its key; removing the default moves the default', async () => {
    const store = await twoServers()
    const { ctx, log } = await testContext({ store })
    await runServersRemove(ctx, 'local', { yes: true })
    const config = await store.load()
    expect(Object.keys(config.profiles)).toEqual(['prod'])
    expect(config.defaultProfile).toBe('prod')
    expect(await readFile(store.file, 'utf8')).not.toContain(TEST_KEY)
    expect(log.lines.join('\n')).toContain('Default server is now "prod"')
    await expect(runServersRemove(ctx, 'local', { yes: true })).rejects.toThrow(
      /Unknown server "local"/
    )
    await runServersRemove(ctx, 'prod', { yes: true })
    expect(await store.load()).toEqual({ profiles: {} })
  })

  it('rm asks first: a no keeps the server, and no terminal without --yes refuses', async () => {
    const store = await twoServers()
    const { ctx, log } = await testContext({ store })
    const asked: string[] = []
    await runServersRemove(ctx, 'local', {
      confirm: async q => {
        asked.push(q)
        return false
      },
    })
    expect(asked).toEqual(['Forget server "local"?'])
    expect(log.lines.join('\n')).toContain('Nothing changed.')
    expect(Object.keys((await store.load()).profiles)).toContain('local')
    await expect(runServersRemove(ctx, 'local')).rejects.toThrow(/Refusing without confirmation/)
    expect(Object.keys((await store.load()).profiles)).toContain('local')
  })

  it('rename moves the credentials and the default with it', async () => {
    const store = await twoServers()
    const { ctx } = await testContext({ store })
    await runServersRename(ctx, 'local', 'dev')
    const config: CliConfig = await store.load()
    expect(config.defaultProfile).toBe('dev')
    expect(config.profiles.dev?.apiKey).toBe(TEST_KEY)
    expect(config.profiles.local).toBeUndefined()
    await expect(runServersRename(ctx, 'dev', 'prod')).rejects.toThrow(/already exists/)
    await expect(runServersRename(ctx, 'nope', 'x')).rejects.toThrow(/Unknown server/)
  })
})

describe('login naming', () => {
  it('first login is `default`; same URL refreshes its server; a new URL gets a host-derived name', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const empty = await t.store.load()
    expect(loginTarget(await t.store.resolve(), empty)).toEqual({
      serverUrl: LOCAL,
      profile: 'default',
    })

    const store = await twoServers()
    const config = await store.load()
    expect(loginTarget(await store.resolve(), config)).toEqual({
      serverUrl: LOCAL,
      profile: 'local',
    })
    expect(loginTarget(await store.resolve({ serverUrl: `${PROD}/` }), config)).toEqual({
      serverUrl: PROD,
      profile: 'prod',
    })
    expect(loginTarget(await store.resolve({ serverUrl: 'prod' }), config)).toEqual({
      serverUrl: PROD,
      profile: 'prod',
    })
    expect(
      loginTarget(await store.resolve({ serverUrl: 'https://launch.rocketflare.dev' }), config)
    ).toEqual({ serverUrl: 'https://launch.rocketflare.dev', profile: 'launch-rocketflare-dev' })
  })

  it('--name picks the server; an existing one keeps its URL unless a URL is given', async () => {
    const store = await twoServers()
    const config = await store.load()
    expect(loginTarget(await store.resolve(), config, 'prod')).toEqual({
      serverUrl: PROD,
      profile: 'prod',
    })
    expect(
      loginTarget(await store.resolve({ serverUrl: 'http://new.test' }), config, 'prod')
    ).toEqual({ serverUrl: 'http://new.test', profile: 'prod' })
    expect(loginTarget(await store.resolve(), config, 'fresh')).toEqual({
      serverUrl: LOCAL,
      profile: 'fresh',
    })
    expect(() => loginTarget({} as never, config, 'bad name')).toThrow(/not a valid server name/)
  })
})

describe('logout', () => {
  it('clears only the selected server; --all clears every key and keeps the URLs', async () => {
    const store = await twoServers()
    const { ctx } = await testContext({ store, server: 'prod' })
    await runLogout(ctx)
    let config = await store.load()
    expect(config.profiles.prod).toEqual({ serverUrl: PROD })
    expect(config.profiles.local?.apiKey).toBe(TEST_KEY)

    const { ctx: all } = await testContext({ store })
    await runLogout(all, { all: true })
    config = await store.load()
    expect(config.profiles).toEqual({ local: { serverUrl: LOCAL }, prod: { serverUrl: PROD } })
  })

  it('a bare URL with no stored server is a no-op', async () => {
    const store = await twoServers()
    const { ctx, log } = await testContext({ store, server: 'http://elsewhere.test' })
    await runLogout(ctx)
    expect(log.lines.join('\n')).toContain('No stored server')
    expect((await store.load()).profiles.local?.apiKey).toBe(TEST_KEY)
  })
})

describe('active server in whoami / status / config', () => {
  const me = { id: USER_ID, email: 'b@example.com', name: 'Bob' }

  it('whoami uses and names the selected server', async () => {
    const store = await twoServers()
    const api = mockFetch({
      '/api/me': () => jsonResponse(me),
      '/api/tenant': () => jsonResponse({ id: TENANT_ID, name: 'Acme' }),
    })
    const { ctx, out } = await testContext({ store, fetch: api.fetch, server: 'prod' })
    await runWhoami(ctx)
    expect(api.calls[0]?.url.origin).toBe(PROD)
    expect(headersOf(api.calls).Authorization).toBe(`Bearer ${PROD_KEY}`)
    expect(out.content()).toMatch(/Server:.*prod.*launch\.example\.com/)
    expect(out.content()).not.toContain(PROD_KEY)

    const { ctx: j, out: jo } = await testContext({ store, fetch: api.fetch, json: true })
    await runWhoami(j)
    expect(JSON.parse(jo.content())).toMatchObject({ profile: 'local', apiKey: 'launch_test…' })
  })

  it('status names the server; --all checks every one and survives one being down', async () => {
    const store = await twoServers()
    const fetch = async (input: string) => {
      const url = new URL(input)
      if (url.origin === PROD) throw new TypeError('fetch failed')
      return jsonResponse({ status: 'ok', version: '1.2.3' })
    }
    const { ctx, out } = await testContext({ store, fetch })
    await runStatus(ctx)
    expect(out.content()).toMatch(/Server:.*local/)

    const { ctx: j, out: jo } = await testContext({ store, fetch, json: true })
    await runStatus(j, { all: true })
    const body = JSON.parse(jo.content())
    expect(body.servers).toMatchObject([
      {
        name: 'local',
        health: 'ok',
        version: '1.2.3',
        default: true,
        active: true,
        loggedIn: true,
      },
      { name: 'prod', health: 'down', default: false, active: false },
    ])
    expect(jo.content()).not.toContain(PROD_KEY)
  })

  it('config get/set operate on the selected server', async () => {
    const store = await twoServers()
    const { ctx, out } = await testContext({ store, server: 'prod', json: true })
    await runConfigGet(ctx)
    expect(JSON.parse(out.content())).toMatchObject({
      profile: 'prod',
      defaultProfile: 'local',
      serverUrl: PROD,
      apiKey: 'launch_prod…',
    })
    await runConfigSet(ctx, 'tenantName', 'Renamed')
    const config = await store.load()
    expect(config.profiles.prod?.tenantName).toBe('Renamed')
    expect(config.profiles.local?.tenantName).toBe('Dev')

    const { ctx: bare } = await testContext({ store, server: 'http://elsewhere.test' })
    await expect(runConfigSet(bare, 'tenantName', 'x')).rejects.toThrow(/No stored server/)
  })

  it('LAUNCH_PROFILE selects a server for a whole shell', async () => {
    const t = await twoServers()
    const store = createConfigStore({ dir: t.dir, env: { LAUNCH_PROFILE: 'prod' } })
    const { ctx, out } = await testContext({ store, json: true })
    await runConfigGet(ctx, 'serverUrl')
    expect(JSON.parse(out.content())).toEqual({ profile: 'prod', serverUrl: PROD })
  })
})
