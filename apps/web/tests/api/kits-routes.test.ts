// @vitest-isolate
// Installs the FakeCloud as the global fetch and mocks the platform credential and kit stores.
/**
 * The kit catalogue's API (D36 K1) — `/api/platform/kits` — through the real app, with the
 * FakeCloud as GitHub and the platform-wide tables in memory (`credential-store.ts`,
 * `kit-store.ts`: the default kit is read by every file that creates an app). Registering a kit
 * resolves its pin and runs the static conformance check at that commit, storing a failing kit
 * too; Check re-runs it; a re-pin is checked at the new pin; Make default moves the template pin's
 * mirror; Remove refuses the default and a kit with apps; every change is audited; a private kit
 * in an org the App is installed on is read with a token narrowed to that one repo; non-admins
 * get 403.
 */

import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type KitDetail, kitDetailSchema, kitListResponseSchema } from '@launch/shared/kits'
import { setupOverviewSchema } from '@launch/shared/launch-setup'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rocketflareFallbackManifest } from '@/api/services/launch/kits/rocketflare-fallback'
import { auditEvents, type KitRow } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { storeCredential } from '../helpers/credential-store'
import { setupTestDatabase } from '../helpers/db'
import { createFakeCloud } from '../helpers/fake-cloud'
import { json, request } from '../helpers/request'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)
const kitStore = vi.hoisted(() => ({
  kits: new Map<string, KitRow>(),
  appCounts: new Map<string, number>(),
}))
vi.mock('@/api/services/launch/kits/store', async importOriginal =>
  (await import('../helpers/kit-store')).mockKitStoreModule(await importOriginal(), kitStore)
)

const db = setupTestDatabase()
const cloud = createFakeCloud()
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8')

/** A conforming kit of a company's own (another org, public): its own manifest and names. */
const ACME = { owner: 'acme-platform', name: 'acme-kit' }
function acmeKitFiles(): Record<string, string> {
  const base = rocketflareFallbackManifest()
  const manifest = {
    ...base,
    kit: { ...base.kit, id: 'acme-kit', name: 'Acme kit', description: 'Our internal tools' },
    scaffold: { ...base.scaffold, init: 'node scripts/init.mjs {slug} {display} {domain}' },
  }
  const rename = (t: string) => t.replaceAll('rocketflare', 'acmekit')
  return {
    'launch.kit.json': JSON.stringify(manifest, null, 2),
    'scripts/init.mjs': '// init\n',
    'AGENTS.md': '# Acme kit\n',
    '.github/workflows/ci.yml': fixture('kit-ci/0.16.0-ci.yml'),
    '.github/workflows/deploy.yml': fixture('kit-deploy/0.17.8-deploy.yml'),
    'apps/web/wrangler.toml': rename(fixture('rocketflare-0.15/wrangler.toml')),
    'apps/web/wrangler.staging.toml': rename(fixture('rocketflare-0.15/wrangler.staging.toml')),
  }
}

let restoreFetch: () => void
let admin: { cookie: Record<string, string>; tenantId: string }
let acmeRelease: string
let brokenRelease: string

beforeAll(async () => {
  restoreFetch = cloud.install()
  cloud.github.seedRepo(ACME.owner, ACME.name, acmeKitFiles())
  acmeRelease = cloud.github.tag(ACME.owner, ACME.name, '1.0.0')
  // A kit with no deploy workflow: it registers, and fails the check.
  const { '.github/workflows/deploy.yml': _deploy, ...broken } = acmeKitFiles()
  cloud.github.seedRepo(ACME.owner, 'broken-kit', {
    ...broken,
    'launch.kit.json': broken['launch.kit.json']?.replace('"acme-kit"', '"broken-kit"') ?? '',
  })
  brokenRelease = cloud.github.tag(ACME.owner, 'broken-kit', '0.1.0')
  storeCredential(
    store,
    'github_app',
    { appId: String(cloud.opts.appId), privateKey },
    { installationId: cloud.opts.installationId }
  )
  const user = await createTestGlobalAdmin(db)
  const tenant = await createTestTenant(db)
  await linkUserToTenant(db, user.id, tenant.id, 'owner')
  admin = {
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
    tenantId: tenant.id,
  }
})
afterAll(() => restoreFetch())
beforeEach(() => {
  kitStore.kits.clear()
  kitStore.appCounts.clear()
  store.settings.delete('template_pin')
  store.settings.delete('template_pin_check')
})

function call(path: string, method: string, body?: unknown, cookie = admin.cookie) {
  return request(
    `/api/platform/kits${path}`,
    { method, headers: cookie },
    body === undefined ? {} : { json: body }
  )
}

async function add(body: unknown): Promise<KitDetail> {
  const res = await call('', 'POST', body)
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
  return kitDetailSchema.parse(await json(res))
}

async function kitAudits(action: string) {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, admin.tenantId), eq(auditEvents.action, action)))
}

describe('the catalogue', () => {
  it('starts with the built-in Rocketflare kit, the default, on the code default pin', async () => {
    const res = await call('', 'GET')
    expect(res.status).toBe(200)
    const { kits } = kitListResponseSchema.parse(await json(res))
    expect(kits).toHaveLength(1)
    expect(kits[0]).toMatchObject({
      slug: 'rocketflare',
      name: 'Rocketflare',
      repo: 'rocketflare-dev/rocketflare',
      isDefault: true,
      pinIsCodeDefault: true,
      status: 'unchecked',
      appCount: 0,
    })
  })

  it('registers a conforming kit: pin resolved, manifest read, verified, audited', async () => {
    const kit = await add({
      repo: `${ACME.owner}/${ACME.name}`,
      pin: { kind: 'tag', tag: '1.0.0' },
    })
    expect(kit).toMatchObject({
      slug: 'acme-kit',
      name: 'Acme kit',
      description: 'Our internal tools',
      pin: { repo: 'acme-platform/acme-kit', tag: '1.0.0', commit: acmeRelease },
      isDefault: false,
      status: 'verified',
      problems: [],
      contractVersion: '1',
      manifestSource: 'repo',
    })
    expect(kit.manifest?.kit.id).toBe('acme-kit')
    expect((await kitAudits('kit.added')).some(r => r.targetId === kit.id)).toBe(true)

    // Show by slug or id, the manifest included.
    for (const key of ['acme-kit', kit.id]) {
      const res = await call(`/${key}`, 'GET')
      expect(res.status).toBe(200)
      expect(kitDetailSchema.parse(await json(res)).manifest?.scaffold.init).toMatch(/init\.mjs/)
    }
    const listed = kitListResponseSchema.parse(await json(await call('', 'GET'))).kits
    expect(listed.map(k => k.slug)).toEqual(['rocketflare', 'acme-kit'])
  })

  it('stores a kit that fails the check, with one sentence per problem; Check re-runs it', async () => {
    const kit = await add({
      repo: `${ACME.owner}/broken-kit`,
      pin: { kind: 'commit', ref: brokenRelease.slice(0, 7) },
      slug: 'broken',
    })
    expect(kit).toMatchObject({
      slug: 'broken',
      status: 'failed',
      problems: ['.github/workflows/deploy.yml is missing'],
      pin: { commit: brokenRelease },
    })
    expect(kit.pin.tag).toBeUndefined()

    // The kit is fixed on its default branch; Check reads the PINNED commit, so nothing changes…
    const fixed = cloud.github.pushCommit(
      ACME.owner,
      'broken-kit',
      { '.github/workflows/deploy.yml': fixture('kit-deploy/0.17.8-deploy.yml') },
      'Add the deploy workflow'
    )
    const checked = await call('/broken/check', 'POST')
    expect(checked.status).toBe(200)
    expect(kitDetailSchema.parse(await json(checked)).status).toBe('failed')

    // …until it is re-pinned (to the branch's head), which checks at the new pin.
    const res = await call('/broken/pin', 'PUT', { kind: 'commit', ref: 'main' })
    expect(res.status).toBe(200)
    expect(kitDetailSchema.parse(await json(res))).toMatchObject({
      status: 'verified',
      problems: [],
      pin: { commit: fixed },
    })
    expect((await kitAudits('kit.checked')).length).toBeGreaterThan(0)
    expect((await kitAudits('kit.pinned')).length).toBeGreaterThan(0)
  })

  it('refuses a taken slug (409) and a ref the repo does not have (422), storing nothing', async () => {
    await add({ repo: `${ACME.owner}/${ACME.name}`, pin: { kind: 'tag', tag: '1.0.0' } })
    const again = await call('', 'POST', {
      repo: `${ACME.owner}/${ACME.name}`,
      pin: { kind: 'tag', tag: '1.0.0' },
    })
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ code: 'kit_slug_taken' })
    const missing = await call('', 'POST', {
      repo: `${ACME.owner}/${ACME.name}`,
      pin: { kind: 'tag', tag: '9.9.9' },
      slug: 'other',
    })
    expect(missing.status).toBe(422)
    expect(await json(missing)).toMatchObject({ code: 'kit_ref_not_found' })
    expect([...kitStore.kits.values()].map(k => k.slug).sort()).toEqual(['acme-kit', 'rocketflare'])
    const bad = await call('', 'POST', { repo: 'not a repo', pin: { kind: 'latest' } })
    expect(bad.status).toBe(400)
  })

  it('follows the latest release when pinned to it', async () => {
    const kit = await add({ repo: `${ACME.owner}/${ACME.name}`, pin: { kind: 'latest' } })
    expect(kit.pin).toEqual({
      repo: 'acme-platform/acme-kit',
      tag: '1.0.0',
      commit: acmeRelease,
      follow: 'latest',
    })
    expect(kit.latestCheck).toMatchObject({ latest: '1.0.0', error: null })
  })

  it('Check now moves a following kit to a newer release and checks it there', async () => {
    const kit = await add({ repo: `${ACME.owner}/${ACME.name}`, pin: { kind: 'latest' } })
    const same = await call(`/${kit.id}/latest`, 'POST')
    expect(same.status).toBe(200)
    expect(kitDetailSchema.parse(await json(same)).pin.tag).toBe('1.0.0')

    const newer = cloud.github.tag(ACME.owner, ACME.name, '1.1.0')
    const res = await call(`/${kit.slug}/latest`, 'POST')
    expect(res.status).toBe(200)
    const moved = kitDetailSchema.parse(await json(res))
    expect(moved.pin).toMatchObject({ tag: '1.1.0', commit: newer, follow: 'latest' })
    // Checked at the new pin, not left without a manifest.
    expect(moved).toMatchObject({ status: 'verified', manifestSource: 'repo' })
    expect(moved.latestCheck).toMatchObject({ latest: '1.1.0', error: null })
    expect((await kitAudits('kit.pinned')).some(r => r.targetId === kit.id)).toBe(true)

    // A kit pinned to a tag does not follow: 409, nothing looked up.
    await call(`/${kit.id}/pin`, 'PUT', { kind: 'tag', tag: '1.0.0' })
    const refused = await call(`/${kit.id}/latest`, 'POST')
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ code: 'kit_not_following' })
  })
})

describe('the default kit', () => {
  it('moves to another kit, and the template pin (and its mirror) follow it', async () => {
    const kit = await add({
      repo: `${ACME.owner}/${ACME.name}`,
      pin: { kind: 'tag', tag: '1.0.0' },
    })
    const res = await call(`/${kit.id}/default`, 'PUT')
    expect(res.status).toBe(200)
    expect(kitDetailSchema.parse(await json(res)).isDefault).toBe(true)
    const kits = kitListResponseSchema.parse(await json(await call('', 'GET'))).kits
    expect(kits.filter(k => k.isDefault).map(k => k.slug)).toEqual(['acme-kit'])
    expect(store.settings.get('template_pin')).toEqual({
      repo: 'acme-platform/acme-kit',
      tag: '1.0.0',
      commit: acmeRelease,
    })
    const overview = await request('/api/platform/setup', { method: 'GET', headers: admin.cookie })
    expect(setupOverviewSchema.parse(await json(overview)).templatePin).toMatchObject({
      pin: { repo: 'acme-platform/acme-kit', tag: '1.0.0' },
      isDefault: false,
    })
    expect(await kitAudits('kit.default_set')).not.toHaveLength(0)

    // The default kit has no code default to reset to.
    const reset = await request('/api/platform/setup/template-pin', {
      method: 'DELETE',
      headers: admin.cookie,
    })
    expect(reset.status).toBe(409)
    expect(await json(reset)).toMatchObject({ code: 'default_kit_not_builtin' })

    // Back to Rocketflare: no stored pin, so the mirror is cleared.
    const back = await call('/rocketflare/default', 'PUT')
    expect(back.status).toBe(200)
    expect(store.settings.has('template_pin')).toBe(false)
  })
})

describe('removing a kit', () => {
  it('refuses the default and a kit apps were made from; removes the rest, audited', async () => {
    const def = await call('/rocketflare', 'DELETE')
    expect(def.status).toBe(409)
    expect(await json(def)).toMatchObject({ code: 'kit_is_default' })

    const kit = await add({
      repo: `${ACME.owner}/${ACME.name}`,
      pin: { kind: 'tag', tag: '1.0.0' },
    })
    kitStore.appCounts.set(kit.id, 2)
    const used = await call(`/${kit.id}`, 'DELETE')
    expect(used.status).toBe(409)
    expect(await json(used)).toMatchObject({ code: 'kit_has_apps', details: { apps: 2 } })

    kitStore.appCounts.clear()
    const res = await call(`/${kit.id}`, 'DELETE')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ removed: true })
    expect(kitStore.kits.has(kit.id)).toBe(false)
    expect((await kitAudits('kit.removed')).some(r => r.targetId === kit.id)).toBe(true)
    expect((await call(`/${kit.id}`, 'GET')).status).toBe(404)
  })
})

describe('a private kit', () => {
  it('is read through the installation on its owner, with a token narrowed to the one repo', async () => {
    const repo = cloud.github.seedRepo(cloud.opts.org, 'company-kit', acmeKitFiles())
    repo.private = true
    cloud.github.tag(cloud.opts.org, 'company-kit', '2.0.0')
    const before = cloud.callsTo('github').length
    const kit = await add({
      repo: `${cloud.opts.org}/company-kit`,
      pin: { kind: 'tag', tag: '2.0.0' },
      slug: 'company',
    })
    expect(kit.status).toBe('verified')
    const mints = cloud
      .callsTo('github')
      .slice(before)
      .filter(c => c.method === 'POST' && c.path.endsWith('/access_tokens'))
    expect(mints).toHaveLength(1)
    expect(mints[0]?.body).toMatchObject({
      repositories: ['company-kit'],
      permissions: { contents: 'read' },
    })
  })
})

describe('who may', () => {
  it('is 401 without a session and 403 for an owner who is not a platform admin', async () => {
    expect((await request('/api/platform/kits', { method: 'GET' })).status).toBe(401)
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    for (const [path, method] of [
      ['', 'GET'],
      ['', 'POST'],
      ['/rocketflare/check', 'POST'],
      ['/rocketflare/default', 'PUT'],
      ['/rocketflare', 'DELETE'],
    ] as const) {
      const res = await call(path, method, method === 'POST' ? {} : undefined, cookie)
      expect(res.status, `${method} ${path}`).toBe(403)
    }
  })
})
