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
 *
 * Follow latest: choosing it resolves the newest release (highest X.Y.Z — a pre-release never
 * counts) and stores it with `follow: 'latest'`; Check now and the five-minute cron's
 * `kit.followLatest` move it when a newer release appears (compare-and-set, audited with
 * `after.by`), write nothing when the tag is the same, leave a pin that does not follow alone,
 * and record a GitHub failure on `template_pin_check` — the route answering 502, the cron not
 * throwing.
 */
import { generateKeyPairSync } from 'node:crypto'
import {
  DEFAULT_TEMPLATE_PIN,
  kitTagsResponseSchema,
  setupOverviewSchema,
} from '@launch/shared/launch-setup'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchScheduled } from '@/api/scheduled'
import { kitFollowLatestTask } from '@/api/services/launch/kit-pin'
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
import { createExecutionContext, createTestEnv, waitOnExecutionContext } from '../mocks/bindings'

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
  // A pre-release above every release: never "latest".
  cloud.github.tag(KIT.owner, KIT.name, '0.16.0-rc.1')
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
  store.settings.delete('template_pin_check')
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
      latestCheck: null,
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

  it('lists the kit repo’s tags newest release first, and names the latest release', async () => {
    const res = await call('/template-pin/tags', 'GET')
    expect(res.status).toBe(200)
    expect(kitTagsResponseSchema.parse(await json(res))).toEqual({
      repo: 'rocketflare-dev/rocketflare',
      tags: [
        { name: '0.15.5', commit: annotated },
        { name: '0.15.4', commit: release },
        // Not a release: after them, and never the latest.
        { name: '0.16.0-rc.1', commit: annotated },
      ],
      latest: '0.15.5',
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

// ---- Follow latest -------------------------------------------------------------------------------

const FOLLOW_5 = () => ({
  repo: 'rocketflare-dev/rocketflare',
  tag: '0.15.5',
  commit: annotated,
  follow: 'latest',
})

async function followAudits() {
  type Summary = { after?: { by?: string; template_pin?: { tag?: string } } }
  return (await pinAudits()).filter(r => (r.summary as Summary).after?.by !== undefined) as Array<
    Awaited<ReturnType<typeof pinAudits>>[number] & { summary: Summary }
  >
}

async function runCron(minIntervalMs = 0) {
  const ctx = createExecutionContext()
  const reports = await dispatchScheduled('*/5 * * * *', createTestEnv(), ctx, {
    '*/5 * * * *': [kitFollowLatestTask({ auditTenantId: admin.tenantId, minIntervalMs })],
  })
  await waitOnExecutionContext(ctx)
  return reports
}

describe('Follow latest', () => {
  it('resolves the newest release (not the pre-release) and stores it with follow: latest', async () => {
    const res = await call('/template-pin', 'PUT', { kind: 'latest' })
    expect(res.status).toBe(200)
    const overview = setupOverviewSchema.parse(await json(res))
    expect(store.settings.get('template_pin')).toEqual(FOLLOW_5())
    expect(overview.templatePin.pin).toEqual(FOLLOW_5())
    expect(overview.templatePin.latestCheck).toMatchObject({
      repo: 'rocketflare-dev/rocketflare',
      latest: '0.15.5',
      error: null,
    })
    type After = { template_pin?: { follow?: string } }
    const chosen = (await pinAudits()).find(
      r => (r.summary.after as After).template_pin?.follow === 'latest'
    )
    expect(chosen?.summary.after).toEqual({ template_pin: FOLLOW_5() })
  })

  it('a stored pin from before follow (and before commit pins) still parses', async () => {
    store.settings.set('template_pin', {
      repo: 'rocketflare-dev/rocketflare',
      tag: '0.15.4',
      commit: release,
    })
    const res = await call('', 'GET')
    expect(setupOverviewSchema.parse(await json(res)).templatePin).toMatchObject({
      pin: { tag: '0.15.4', commit: release },
      isDefault: false,
      latestCheck: null,
    })
  })

  it('Check now is 409 unless the pin follows latest, with no GitHub call', async () => {
    store.settings.set('template_pin', {
      repo: 'rocketflare-dev/rocketflare',
      tag: '0.15.4',
      commit: release,
    })
    const before = cloud.callsTo('github').length
    const res = await call('/template-pin/check', 'POST')
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ code: 'template_pin_not_following' })
    expect(cloud.callsTo('github')).toHaveLength(before)
  })

  it('Check now with nothing newer writes no pin and no audit, but records the check', async () => {
    store.settings.set('template_pin', FOLLOW_5())
    const audits = (await followAudits()).length
    const res = await call('/template-pin/check', 'POST')
    expect(res.status).toBe(200)
    expect(store.settings.get('template_pin')).toEqual(FOLLOW_5())
    expect(await followAudits()).toHaveLength(audits)
    expect(setupOverviewSchema.parse(await json(res)).templatePin.latestCheck).toMatchObject({
      latest: '0.15.5',
      error: null,
    })
  })

  it('a GitHub failure is a clear 502, recorded on the check; the pin is untouched', async () => {
    store.settings.set('template_pin', FOLLOW_5())
    cloud.failNext(/GET .*\/repos\/rocketflare-dev\/rocketflare\/tags/, 500)
    const res = await call('/template-pin/check', 'POST')
    expect(res.status).toBe(502)
    const body = (await json(res)) as { code: string; error: string }
    expect(body.code).toBe('github_lookup_failed')
    expect(body.error).toMatch(/^GitHub could not answer: /)
    expect(store.settings.get('template_pin')).toEqual(FOLLOW_5())
    expect(store.settings.get('template_pin_check')).toMatchObject({
      latest: null,
      error: body.error,
    })
  })

  describe('the cron (kit.followLatest)', () => {
    it('leaves a pin that does not follow alone, without a GitHub call', async () => {
      const pinned = { repo: 'rocketflare-dev/rocketflare', tag: '0.15.4', commit: release }
      store.settings.set('template_pin', pinned)
      const before = cloud.callsTo('github').length
      const reports = await runCron()
      expect(reports.map(r => [r.task, r.status])).toEqual([['kit.followLatest', 'ok']])
      expect(store.settings.get('template_pin')).toEqual(pinned)
      expect(store.settings.has('template_pin_check')).toBe(false)
      expect(cloud.callsTo('github')).toHaveLength(before)
    })

    it('writes nothing when the newest release is the pinned one', async () => {
      store.settings.set('template_pin', FOLLOW_5())
      const audits = (await followAudits()).length
      await runCron()
      expect(store.settings.get('template_pin')).toEqual(FOLLOW_5())
      expect(await followAudits()).toHaveLength(audits)
      expect(store.settings.get('template_pin_check')).toMatchObject({
        latest: '0.15.5',
        error: null,
      })
    })

    it('a failure is logged, recorded and not thrown; the next tick retries', async () => {
      store.settings.set('template_pin', FOLLOW_5())
      cloud.failNext(/GET .*\/repos\/rocketflare-dev\/rocketflare\/tags/, 503)
      const reports = await runCron(60 * 60 * 1000)
      expect(reports.map(r => [r.task, r.status])).toEqual([['kit.followLatest', 'ok']])
      expect(store.settings.get('template_pin')).toEqual(FOLLOW_5())
      expect(store.settings.get('template_pin_check')).toMatchObject({
        error: expect.stringMatching(/GitHub could not answer/),
      })
      // A failed check is not throttled: the next tick looks again (and succeeds).
      await runCron(60 * 60 * 1000)
      expect(store.settings.get('template_pin_check')).toMatchObject({
        latest: '0.15.5',
        error: null,
      })
      // A good one is: within the hour, no GitHub call.
      const before = cloud.callsTo('github').length
      await runCron(60 * 60 * 1000)
      expect(cloud.callsTo('github')).toHaveLength(before)
    })

    // Last: it adds a newer release to the kit repo.
    it('moves the pin to a newer release, audited by the cron, once; Check now does the same', async () => {
      store.settings.set('template_pin', FOLLOW_5())
      cloud.github.pushCommit(KIT.owner, KIT.name, { 'CHANGELOG.md': '0.15.6\n' }, 'Release 0.15.6')
      const newer = cloud.github.tag(KIT.owner, KIT.name, '0.15.6')
      const audits = (await followAudits()).length

      await runCron()
      const moved = {
        repo: 'rocketflare-dev/rocketflare',
        tag: '0.15.6',
        commit: newer,
        follow: 'latest',
      }
      expect(store.settings.get('template_pin')).toEqual(moved)
      const rows = await followAudits()
      expect(rows).toHaveLength(audits + 1)
      expect(rows.find(r => r.summary.after?.by === 'cron')).toMatchObject({
        actorType: 'system',
        summary: {
          before: { template_pin: FOLLOW_5() },
          after: { template_pin: moved, by: 'cron' },
        },
      })
      // Idempotent: a second tick has nothing to move.
      await runCron()
      expect(await followAudits()).toHaveLength(audits + 1)

      // Check now from an older follow pin: the same move, audited as the admin's.
      store.settings.set('template_pin', FOLLOW_5())
      const res = await call('/template-pin/check', 'POST')
      expect(res.status).toBe(200)
      expect(setupOverviewSchema.parse(await json(res)).templatePin.pin).toEqual(moved)
      expect((await followAudits()).find(r => r.summary.after?.by === 'check_now')).toMatchObject({
        actorType: 'user',
        summary: { after: { template_pin: moved, by: 'check_now' } },
      })
    })
  })
})
