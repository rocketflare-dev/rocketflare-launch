// @vitest-isolate
// Installs the FakeCloud as the global fetch and mocks the platform credential store.
/**
 * The Kit version card's API — `/api/platform/setup/template-pin` — through the real app, with the
 * FakeCloud as GitHub (the kit repo is seeded in ANOTHER org, as the public kit is) and
 * `launch_settings` / `admin_credentials` in memory (`credential-store.ts`: both tables are
 * global, and `setup.test.ts` owns them). A tag resolves to its commit (an annotated one through
 * its tag object), a commit — a SHA on a branch, or "latest main" — to its full SHA, and a ref the repo does
 * not have is 422 before anything is stored; every change is `setting.changed` with before and
 * after; reset deletes the row; a non-admin gets 403.
 */
import { generateKeyPairSync } from 'node:crypto'
import {
  DEFAULT_TEMPLATE_PIN,
  kitTagsResponseSchema,
  setupOverviewSchema,
} from '@launch/shared/launch-setup'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditEvents } from '@/db/schema'
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

const db = setupTestDatabase()
const cloud = createFakeCloud()
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const KIT = { owner: 'rocketflare-dev', name: 'rocketflare' }
let release: string
let annotated: string
let mainHead: string
let branchCommit: string
let restoreFetch: () => void
let admin: { cookie: Record<string, string>; tenantId: string }

beforeAll(async () => {
  restoreFetch = cloud.install()
  // The kit: 0.15.4 lightweight, 0.15.5 annotated, main moved on, and a fix on a branch.
  cloud.github.seedRepo(KIT.owner, KIT.name, {
    '.rocketflare.json': '{"kit":{"version":"0.15.4"}}',
  })
  release = cloud.github.tag(KIT.owner, KIT.name, '0.15.4')
  cloud.github.pushCommit(KIT.owner, KIT.name, { 'CHANGELOG.md': '0.15.5\n' }, 'Release 0.15.5')
  annotated = cloud.github.tag(KIT.owner, KIT.name, '0.15.5', { annotated: true })
  mainHead = cloud.github.pushCommit(KIT.owner, KIT.name, { 'fix.md': 'on main\n' }, 'A fix')
  branchCommit = cloud.github.pushCommit(
    KIT.owner,
    KIT.name,
    { 'branch.md': 'unreleased\n' },
    'On a branch',
    'kit-fix'
  )
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
  store.settings.delete('template_pin')
})

function call(path: string, method: string, body?: unknown, cookie = admin.cookie) {
  return request(
    `/api/platform/setup${path}`,
    { method, headers: cookie },
    body === undefined ? {} : { json: body }
  )
}

async function pinAudits() {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, admin.tenantId),
        eq(auditEvents.action, 'setting.changed'),
        eq(auditEvents.targetId, 'template_pin')
      )
    )
}

describe('the kit pin', () => {
  it('reports the default until one is set', async () => {
    const res = await call('', 'GET')
    expect(res.status).toBe(200)
    expect(setupOverviewSchema.parse(await json(res)).templatePin).toEqual({
      pin: DEFAULT_TEMPLATE_PIN,
      isDefault: true,
      default: DEFAULT_TEMPLATE_PIN,
    })
  })

  it('pins a release tag, resolving a lightweight and an annotated tag to their commits', async () => {
    for (const [tag, commit] of [
      ['0.15.4', release],
      ['0.15.5', annotated],
    ] as const) {
      const res = await call('/template-pin', 'PUT', { kind: 'tag', tag })
      expect(res.status, tag).toBe(200)
      const overview = setupOverviewSchema.parse(await json(res))
      const pin = { repo: 'rocketflare-dev/rocketflare', tag, commit }
      expect(overview.templatePin).toMatchObject({ pin, isDefault: false })
      expect(store.settings.get('template_pin')).toEqual(pin)
    }
    // Resolved through GitHub: the annotated tag through its tag object.
    const paths = cloud.callsTo('github').map(c => `${c.method} ${c.path}`)
    expect(paths).toContain('GET /repos/rocketflare-dev/rocketflare/git/ref/tags/0.15.5')
    expect(paths.some(p => p.startsWith('GET /repos/rocketflare-dev/rocketflare/git/tags/'))).toBe(
      true
    )
    // …with a read-only token, revoked afterwards.
    const minted = [...cloud.github.tokens.values()].at(-1)
    expect(minted).toMatchObject({ permissions: { contents: 'read' }, revoked: true })
  })

  it('pins a commit on a branch by its SHA, or the latest main resolved to its full SHA', async () => {
    const pasted = await call('/template-pin', 'PUT', {
      kind: 'commit',
      ref: branchCommit,
    })
    expect(pasted.status).toBe(200)
    expect(store.settings.get('template_pin')).toEqual({
      repo: 'rocketflare-dev/rocketflare',
      commit: branchCommit,
    })
    const main = await call('/template-pin', 'PUT', { kind: 'commit', ref: 'main' })
    expect(setupOverviewSchema.parse(await json(main)).templatePin.pin).toEqual({
      repo: 'rocketflare-dev/rocketflare',
      commit: mainHead,
    })
  })

  it('audits every change as setting.changed, before and after', async () => {
    const before = (await pinAudits()).length
    await call('/template-pin', 'PUT', { kind: 'tag', tag: '0.15.4' })
    await call('/template-pin', 'PUT', { kind: 'commit', ref: 'main' })
    const rows = await pinAudits()
    expect(rows).toHaveLength(before + 2)
    // The main pin made over the 0.15.4 one (an earlier test pinned main over something else).
    type PinSummary = { template_pin?: { tag?: string; commit?: string } | null }
    const last = rows.find(
      r =>
        (r.summary.after as PinSummary).template_pin?.commit === mainHead &&
        (r.summary.before as PinSummary | undefined)?.template_pin?.tag === '0.15.4'
    )
    expect(last?.summary).toEqual({
      before: {
        template_pin: { repo: 'rocketflare-dev/rocketflare', tag: '0.15.4', commit: release },
      },
      after: { template_pin: { repo: 'rocketflare-dev/rocketflare', commit: mainHead } },
    })
  })

  it('refuses a tag or a commit the repo does not have, storing nothing (422)', async () => {
    for (const body of [
      { kind: 'tag', tag: '9.9.9' },
      { kind: 'commit', ref: 'f'.repeat(40) },
      { kind: 'commit', ref: 'no-such-branch' },
    ]) {
      const res = await call('/template-pin', 'PUT', body)
      expect(res.status, JSON.stringify(body)).toBe(422)
      expect(await json(res)).toMatchObject({ statusCode: 422, code: 'kit_ref_not_found' })
    }
    expect(store.settings.has('template_pin')).toBe(false)
  })

  it('validates the body with the shared schema (400)', async () => {
    for (const body of [{ kind: 'tag' }, { kind: 'commit', ref: 'not a sha!' }, { kind: 'x' }]) {
      const res = await call('/template-pin', 'PUT', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await json(res)).toMatchObject({ statusCode: 400, code: 'validation_failed' })
    }
  })

  it('resets to the default by deleting the row, audited', async () => {
    await call('/template-pin', 'PUT', { kind: 'commit', ref: 'main' })
    const res = await call('/template-pin', 'DELETE')
    expect(res.status).toBe(200)
    expect(setupOverviewSchema.parse(await json(res)).templatePin.isDefault).toBe(true)
    expect(store.settings.has('template_pin')).toBe(false)
    const reset = (await pinAudits()).find(
      r => (r.summary.after as { template_pin?: unknown }).template_pin === null
    )
    expect(reset?.summary.before).toEqual({
      template_pin: { repo: 'rocketflare-dev/rocketflare', commit: mainHead },
    })
  })

  it('lists the kit repo’s tags with their commits', async () => {
    const res = await call('/template-pin/tags', 'GET')
    expect(res.status).toBe(200)
    expect(kitTagsResponseSchema.parse(await json(res))).toEqual({
      repo: 'rocketflare-dev/rocketflare',
      tags: [
        { name: '0.15.5', commit: annotated },
        { name: '0.15.4', commit: release },
      ],
    })
  })

  it('needs the GitHub App to look anything up (409)', async () => {
    const saved = store.credentials.get('github_app')
    store.credentials.delete('github_app')
    try {
      const res = await call('/template-pin', 'PUT', { kind: 'tag', tag: '0.15.4' })
      expect(res.status).toBe(409)
      expect(await json(res)).toMatchObject({ code: 'github_app_not_configured' })
    } finally {
      store.credentials.set('github_app', saved)
    }
  })

  it('is 401 without a session and 403 for an organisation owner who is not a global admin', async () => {
    const anon = await request('/api/platform/setup/template-pin', { method: 'DELETE' })
    expect(anon.status).toBe(401)
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    for (const [path, method, body] of [
      ['/template-pin', 'PUT', { kind: 'tag', tag: '0.15.4' }],
      ['/template-pin', 'DELETE', undefined],
      ['/template-pin/tags', 'GET', undefined],
    ] as const) {
      const res = await call(path, method, body, cookie)
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(await json(res)).toMatchObject({ statusCode: 403, code: 'forbidden' })
    }
    expect(store.settings.has('template_pin')).toBe(false)
  })
})
