/**
 * Config store tests (D26): temp dir, 0700/0600 permissions, the named servers (profiles) shape,
 * migration of a legacy flat file, selection precedence, key redaction.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createConfigStore,
  DEFAULT_SERVER_URL,
  fileMode,
  profileNameForUrl,
  redactConfig,
  redactKey,
  resolveConfigDir,
} from '../src/config'
import { EXIT_ERROR } from '../src/errors'
import { captureError, TEST_KEY, tempStore } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

describe('resolveConfigDir', () => {
  it('uses $HOME/.launch by default and honours LAUNCH_CONFIG_DIR', () => {
    expect(resolveConfigDir({ HOME: '/home/alice' })).toBe('/home/alice/.launch')
    expect(resolveConfigDir({ HOME: '/home/alice', LAUNCH_CONFIG_DIR: '/etc/launch' })).toBe(
      '/etc/launch'
    )
  })
})

describe('config store', () => {
  it('returns an empty config when the file does not exist', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    expect(await t.store.load()).toEqual({ profiles: {} })
  })

  it('round-trips and writes dir 0700 / file 0600', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const config = {
      defaultProfile: 'prod',
      profiles: {
        prod: {
          serverUrl: 'https://app.example.com',
          apiKey: TEST_KEY,
          tenantId: 't1',
          tenantName: 'Acme',
          user: { email: 'a@example.com', name: 'Alice' },
        },
        local: { serverUrl: 'http://localhost:3001' },
      },
    }
    await t.store.save(config)
    expect(await t.store.load()).toEqual(config)
    expect(await fileMode(t.store.dir)).toBe(0o700)
    expect(await fileMode(t.store.file)).toBe(0o600)
    expect(JSON.parse(await readFile(t.store.file, 'utf8'))).toEqual(config)
  })

  it('tightens an existing loose file to 0600 on save', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    await t.store.save({ profiles: { a: { serverUrl: 'http://a' } } })
    const { chmod } = await import('node:fs/promises')
    await chmod(t.store.file, 0o644)
    await t.store.updateProfile('a', { tenantId: 'x' })
    expect(await fileMode(t.store.file)).toBe(0o600)
  })

  it('updateProfile merges (first one becomes default), clearCredentials keeps serverUrl, clear removes the file', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    await t.store.updateProfile('local', {
      serverUrl: 'http://a/',
      apiKey: TEST_KEY,
      tenantId: 't',
      user: { email: 'e' },
    })
    await t.store.updateProfile('local', { tenantName: 'Acme' })
    await t.store.updateProfile('prod', { serverUrl: 'https://prod.example.com' })
    const loaded = await t.store.load()
    expect(loaded.defaultProfile).toBe('local')
    expect(loaded.profiles.local).toMatchObject({
      serverUrl: 'http://a',
      apiKey: TEST_KEY,
      tenantName: 'Acme',
    })
    await expect(t.store.updateProfile('nourl', { tenantId: 'x' })).rejects.toThrow(/needs a URL/)
    await expect(t.store.updateProfile('bad name', { serverUrl: 'http://x' })).rejects.toThrow(
      /not a valid server name/
    )
    expect(await t.store.clearCredentials('local')).toBe(true)
    expect(await t.store.clearCredentials('local')).toBe(false)
    expect((await t.store.load()).profiles.local).toEqual({ serverUrl: 'http://a' })
    await t.store.clear()
    expect(await fileMode(t.store.file)).toBeNull()
    expect(await t.store.load()).toEqual({ profiles: {} })
  })

  it('rejects an invalid config file', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(t.store.dir, { recursive: true })
    await writeFile(join(t.store.dir, 'config.json'), JSON.stringify({ serverUrl: 'nope' }))
    await expect(t.store.load()).rejects.toThrow(/invalid/)
  })
})

describe('legacy migration', () => {
  it('presents a flat file as the `default` server in memory, writes the new shape on save', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(t.store.dir, { recursive: true })
    const legacy = {
      serverUrl: 'https://old.example.com/',
      apiKey: TEST_KEY,
      tenantId: 't1',
      tenantName: 'Acme',
      user: { email: 'a@example.com' },
    }
    await writeFile(t.store.file, JSON.stringify(legacy))
    const loaded = await t.store.load()
    expect(loaded).toEqual({
      defaultProfile: 'default',
      profiles: {
        default: {
          serverUrl: 'https://old.example.com',
          apiKey: TEST_KEY,
          tenantId: 't1',
          tenantName: 'Acme',
          user: { email: 'a@example.com' },
        },
      },
    })
    // No disk write on load.
    expect(JSON.parse(await readFile(t.store.file, 'utf8'))).toEqual(legacy)
    expect(await t.store.resolve()).toMatchObject({
      profile: 'default',
      profileSource: 'default',
      serverUrl: 'https://old.example.com',
      apiKey: TEST_KEY,
    })
    await t.store.updateProfile('local', { serverUrl: 'http://localhost:3001' })
    const written = JSON.parse(await readFile(t.store.file, 'utf8'))
    expect(written).not.toHaveProperty('serverUrl')
    expect(written).not.toHaveProperty('apiKey')
    expect(Object.keys(written.profiles).sort()).toEqual(['default', 'local'])
    expect(written.defaultProfile).toBe('default')
  })

  it('save() of a legacy-shaped object migrates it too', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    await t.store.save({ serverUrl: 'http://a', apiKey: TEST_KEY })
    expect(JSON.parse(await readFile(t.store.file, 'utf8'))).toEqual({
      defaultProfile: 'default',
      profiles: { default: { serverUrl: 'http://a', apiKey: TEST_KEY } },
    })
  })
})

describe('resolve precedence', () => {
  async function twoServers(env: Record<string, string> = {}) {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    await t.store.save({
      defaultProfile: 'local',
      profiles: {
        local: { serverUrl: 'http://localhost:3001', apiKey: 'local-key', tenantName: 'Dev' },
        prod: { serverUrl: 'https://launch.example.com', apiKey: 'prod-key', tenantName: 'Acme' },
        bare: { serverUrl: 'https://bare.example.com' },
      },
    })
    return { t, store: createConfigStore({ dir: t.store.dir, env }) }
  }

  it('empty file → default URL, no key', async () => {
    const t = await tempStore()
    cleanups.push(t.cleanup)
    expect(await t.store.resolve()).toMatchObject({
      profile: undefined,
      profileSource: 'none',
      serverUrl: DEFAULT_SERVER_URL,
      serverUrlSource: 'default',
      apiKey: undefined,
      apiKeySource: 'none',
    })
  })

  it('--profile > LAUNCH_PROFILE > defaultProfile', async () => {
    const { store } = await twoServers()
    expect(await store.resolve()).toMatchObject({
      profile: 'local',
      profileSource: 'default',
      serverUrl: 'http://localhost:3001',
      serverUrlSource: 'config',
      apiKey: 'local-key',
      apiKeySource: 'config',
      tenantName: 'Dev',
    })
    const { store: withEnv } = await twoServers({ LAUNCH_PROFILE: 'prod' })
    expect(await withEnv.resolve()).toMatchObject({
      profile: 'prod',
      profileSource: 'env',
      apiKey: 'prod-key',
    })
    expect(await withEnv.resolve({ profile: 'local' })).toMatchObject({
      profile: 'local',
      profileSource: 'flag',
      apiKey: 'local-key',
    })
  })

  it('--server <name> selects that server; --server <url> uses the server stored at that URL', async () => {
    const { store } = await twoServers()
    expect(await store.resolve({ serverUrl: 'prod' })).toMatchObject({
      profile: 'prod',
      profileSource: 'flag',
      serverUrl: 'https://launch.example.com',
      serverUrlSource: 'config',
      apiKey: 'prod-key',
    })
    expect(await store.resolve({ serverUrl: 'https://launch.example.com/' })).toMatchObject({
      profile: 'prod',
      profileSource: 'server-url',
      serverUrl: 'https://launch.example.com',
      serverUrlSource: 'flag',
      apiKey: 'prod-key',
    })
    // An unknown URL gets no key: a key only ever goes to its own server.
    expect(await store.resolve({ serverUrl: 'http://elsewhere.test' })).toMatchObject({
      profile: undefined,
      profileSource: 'none',
      serverUrl: 'http://elsewhere.test',
      apiKey: undefined,
      apiKeySource: 'none',
    })
  })

  it('unknown names are exit 1 listing the known servers; --profile with --server is refused', async () => {
    const { store } = await twoServers()
    for (const overrides of [{ profile: 'staging' }, { serverUrl: 'staging' }]) {
      const error = await captureError(store.resolve(overrides))
      expect(error.exitCode).toBe(EXIT_ERROR)
      expect(error.message).toBe('Unknown server "staging"')
      expect(error.hint).toContain('bare, local, prod')
    }
    const { store: badEnv } = await twoServers({ LAUNCH_PROFILE: 'nope' })
    await expect(badEnv.resolve()).rejects.toThrow(/Unknown server "nope"/)
    await expect(store.resolve({ profile: 'prod', serverUrl: 'local' })).rejects.toThrow(/not both/)
  })

  it('LAUNCH_URL beats LAUNCH_PROFILE and the default (keyed by URL); LAUNCH_API_KEY beats every stored key', async () => {
    const { store } = await twoServers({
      LAUNCH_URL: 'https://launch.example.com',
      LAUNCH_PROFILE: 'local',
    })
    expect(await store.resolve()).toMatchObject({
      profile: 'prod',
      serverUrl: 'https://launch.example.com',
      serverUrlSource: 'env',
      apiKey: 'prod-key',
    })
    const { store: ci } = await twoServers({
      LAUNCH_URL: 'http://from-env',
      LAUNCH_API_KEY: 'env-key',
    })
    expect(await ci.resolve()).toMatchObject({
      serverUrl: 'http://from-env',
      serverUrlSource: 'env',
      apiKey: 'env-key',
      apiKeySource: 'env',
    })
    expect(await ci.resolve({ serverUrl: 'http://from-flag' })).toMatchObject({
      serverUrl: 'http://from-flag',
      serverUrlSource: 'flag',
      apiKey: 'env-key',
    })
    expect(await ci.resolve({ profile: 'prod' })).toMatchObject({
      serverUrl: 'https://launch.example.com',
      apiKey: 'env-key',
    })
  })
})

describe('profileNameForUrl', () => {
  it('derives a name from the host and avoids collisions', () => {
    expect(profileNameForUrl('http://localhost:3001')).toBe('localhost-3001')
    expect(profileNameForUrl('https://launch.rocketflare.dev')).toBe('launch-rocketflare-dev')
    expect(profileNameForUrl('https://www.example.com/', ['example-com'])).toBe('example-com-2')
  })
})

describe('redaction', () => {
  it('shows only a prefix', () => {
    expect(redactKey(TEST_KEY)).toBe('launch_test…')
    expect(redactKey('short')).toBe('****')
    expect(redactKey(undefined)).toBe('-')
    const config = {
      profiles: { a: { serverUrl: 'http://a', apiKey: TEST_KEY, tenantId: 't' } },
    }
    expect(redactConfig(config).profiles.a).toEqual({
      serverUrl: 'http://a',
      apiKey: 'launch_test…',
      tenantId: 't',
    })
    expect(JSON.stringify(redactConfig(config))).not.toContain(TEST_KEY)
  })
})
