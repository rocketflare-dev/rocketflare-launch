// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform settings (the template pin is a
// deployment-wide setting another file may be moving), so this file needs its own module registry.
/**
 * Kit upgrades for one app (P6 6c, the single-app half) through the real routes:
 *
 * - "Requires upgrade" is computed on READ: the catalogue and the detail carry `kit` — the app's
 *   `template_version` against the template pin's tag — and moving the pin flags the app at once;
 *   a commit pin or an unknown version never does;
 * - `POST /api/apps/:id/upgrade` refuses an archived app, one with no repo, a commit pin, an app
 *   that is not behind and one with an upgrade open, and a member who does not own the app; a
 *   session refusal (the limit) passes through and leaves no upgrade behind; otherwise a `running`
 *   upgrade and a session of kind `upgrade` with auto-ship and the adapter's prompt waiting as its
 *   first turn;
 * - a Release whose tag's `.rocketflare.json` says the target records the version
 *   (`app.kit_version_changed`) and settles the open upgrade `released` — and one done outside
 *   Launch is recorded the same way;
 * - tenant isolation: another organisation's app is a 404, and its upgrades are never listed.
 */
import { appDetailSchema, appListResponseSchema } from '@launch/shared/launch-apps'
import {
  appUpgradeListResponseSchema,
  startUpgradeResponseSchema,
  UPGRADE_ERROR_CODES,
} from '@launch/shared/launch-upgrades'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { upgradePrompt } from '@/api/services/launch/rocketflare/upgrade-prompt'
import { apps, appUpgrades, auditEvents, sessions } from '@/db/schema'
import { setupTestDatabase } from '../helpers/db'
import { fillDeployCredentials } from '../helpers/deploy-gateway'
import { createFakeCloud } from '../helpers/fake-cloud'
import { forgetApps } from '../helpers/launch-apps'
import { addTestAppOwner } from '../helpers/oidc'
import { seedReleasableApp } from '../helpers/releases'
import { json, request } from '../helpers/request'
import { insertSession, type SessionAppFixture, seedSessionApp } from '../helpers/sessions'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)

const db = setupTestDatabase()
const cloud = createFakeCloud()
let restore: () => void
let env: TestEnv
const tenantIds: string[] = []

const COMMIT = 'c'.repeat(40)
const pinAt = (tag: string | null) =>
  store.settings.set(
    'template_pin',
    tag
      ? { repo: 'rocketflare-dev/rocketflare', tag, commit: COMMIT }
      : { repo: 'rocketflare-dev/rocketflare', commit: COMMIT }
  )

beforeAll(() => {
  restore = cloud.install()
})
afterAll(async () => {
  restore()
  await forgetApps(db, tenantIds)
})
beforeEach(() => {
  env = createTestEnv()
  fillDeployCredentials(store, cloud)
  pinAt('0.16.1')
})

/** An owner's app with a repo, on kit `version`. */
async function fixture(version: string | null = '0.16.0', role: 'owner' | 'member' = 'owner') {
  const f = await seedSessionApp(db, cloud, { role })
  tenantIds.push(f.tenant.id)
  await db.update(apps).set({ templateVersion: version }).where(eq(apps.id, f.app.id))
  return { ...f, app: { ...f.app, templateVersion: version } }
}

const upgrade = (f: Pick<SessionAppFixture, 'app' | 'cookie'>, headers = f.cookie) =>
  request(`/api/apps/${f.app.id}/upgrade`, { method: 'POST', headers }, { env, json: {} })

async function detail(f: Pick<SessionAppFixture, 'app' | 'cookie'>) {
  const res = await request(`/api/apps/${f.app.slug}`, { headers: f.cookie }, { env })
  expect(res.status).toBe(200)
  return appDetailSchema.parse(await json(res))
}

async function upgradesOf(f: Pick<SessionAppFixture, 'app' | 'tenant'>) {
  return db
    .select()
    .from(appUpgrades)
    .where(and(eq(appUpgrades.tenantId, f.tenant.id), eq(appUpgrades.appId, f.app.id)))
}

describe('Requires upgrade — computed on read against the pin', () => {
  it('flags an app below the pin in the catalogue and the detail, and moving the pin moves it', async () => {
    const f = await fixture('0.16.0')
    expect((await detail(f)).kit).toEqual({
      current: '0.16.0',
      target: '0.16.1',
      behind: true,
      openUpgrade: null,
    })
    const list = await request('/api/apps', { headers: f.cookie }, { env })
    const item = appListResponseSchema.parse(await json(list)).items.find(a => a.id === f.app.id)
    expect(item?.kit).toMatchObject({ current: '0.16.0', target: '0.16.1', behind: true })

    pinAt('0.16.0')
    expect((await detail(f)).kit).toMatchObject({ target: '0.16.0', behind: false })
    pinAt('v0.17.0')
    expect((await detail(f)).kit).toMatchObject({ target: '0.17.0', behind: true })
  })

  it('a commit pin, or an app whose kit version is unknown, is never behind', async () => {
    const f = await fixture(null)
    expect((await detail(f)).kit).toMatchObject({ current: null, behind: false })
    pinAt(null)
    const g = await fixture('0.10.0')
    expect((await detail(g)).kit).toMatchObject({ target: null, behind: false })
  })
})

describe('POST /api/apps/:id/upgrade', () => {
  it('starts a running upgrade and an upgrade session with auto-ship and the prompt as its first turn → 202', async () => {
    const f = await fixture('0.16.0')
    const res = await upgrade(f)
    expect(res.status, await res.clone().text()).toBe(202)
    const body = startUpgradeResponseSchema.parse(await json(res))
    expect(body.upgrade).toMatchObject({
      appId: f.app.id,
      targetKind: 'kit',
      fromVersion: '0.16.0',
      toVersion: '0.16.1',
      status: 'running',
      sessionId: body.sessionId,
      requestedByUserId: f.user.id,
    })

    const [session] = await db.select().from(sessions).where(eq(sessions.id, body.sessionId))
    expect(session).toMatchObject({
      kind: 'upgrade',
      upgradeId: body.upgradeId,
      autoShip: true,
      status: 'requested',
      title: 'Upgrade kit 0.16.0 → 0.16.1',
      pendingMessage: upgradePrompt({ from: '0.16.0', to: '0.16.1' }),
      pendingMessageUserId: f.user.id,
    })
    expect(session?.pendingMessage).toContain('/rf-upgrade --to 0.16.1')
    expect(session?.pendingMessage).toContain('LAUNCH-UPGRADE: DONE')
    expect(stubs(env).sessionWorkflow?.created.map(c => c.id)).toEqual([body.sessionId])

    // The open upgrade rides the detail, and it is listed.
    expect((await detail(f)).kit?.openUpgrade).toMatchObject({ id: body.upgradeId })
    const listed = await request(`/api/apps/${f.app.id}/upgrades`, { headers: f.cookie }, { env })
    expect(appUpgradeListResponseSchema.parse(await json(listed)).items.map(u => u.id)).toEqual([
      body.upgradeId,
    ])
    // The app's sessions list shows it like any other session.
    const mine = await request(`/api/apps/${f.app.id}/sessions`, { headers: f.cookie }, { env })
    expect(JSON.stringify(await json(mine))).toContain(body.sessionId)

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, f.tenant.id), eq(auditEvents.appId, f.app.id)))
    expect(audit.map(a => a.action).sort()).toEqual(['app.upgrade.started', 'session.created'])
    const started = audit.find(a => a.action === 'app.upgrade.started')
    expect(started?.summary.after).toMatchObject({
      fromVersion: '0.16.0',
      toVersion: '0.16.1',
      sessionId: body.sessionId,
    })
  })

  it('401 without a session', async () => {
    const f = await fixture('0.16.0')
    expect((await upgrade(f, {})).status).toBe(401)
    expect((await request(`/api/apps/${f.app.id}/upgrades`, {}, { env })).status).toBe(401)
    expect(await upgradesOf(f)).toHaveLength(0)
  })

  it('refuses an app that is not behind, a commit pin and an upgrade already open', async () => {
    const current = await fixture('0.16.1')
    const notBehind = await upgrade(current)
    expect(notBehind.status).toBe(409)
    expect(await json(notBehind)).toMatchObject({
      statusCode: 409,
      code: UPGRADE_ERROR_CODES.notBehind,
      error: expect.stringContaining('not behind'),
      details: { current: '0.16.1', target: '0.16.1' },
    })

    const f = await fixture('0.16.0')
    expect((await upgrade(f)).status).toBe(202)
    const again = await upgrade(f)
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({
      code: UPGRADE_ERROR_CODES.open,
      details: { status: 'running' },
    })
    expect(await upgradesOf(f)).toHaveLength(1)

    pinAt(null)
    const g = await fixture('0.16.0')
    const commitPin = await upgrade(g)
    expect(commitPin.status).toBe(409)
    expect(((await json(commitPin)) as { code: string }).code).toBe(UPGRADE_ERROR_CODES.noPinTag)
    expect(await upgradesOf(g)).toHaveLength(0)
  })

  it('refuses an archived app, one with no repository, and a member who does not own the app', async () => {
    const archived = await fixture('0.16.0')
    await db.update(apps).set({ status: 'archived' }).where(eq(apps.id, archived.app.id))
    const a = await upgrade(archived)
    expect(a.status).toBe(409)
    expect(((await json(a)) as { code: string }).code).toBe('app_archived')

    const bare = await fixture('0.16.0')
    await db.update(apps).set({ repoOwner: null, repoName: null }).where(eq(apps.id, bare.app.id))
    const b = await upgrade(bare)
    expect(b.status).toBe(409)
    expect(((await json(b)) as { code: string }).code).toBe('app_has_no_repo')

    const member = await fixture('0.16.0', 'member')
    expect((await upgrade(member)).status).toBe(403)
    // …until they own it.
    await addTestAppOwner(db, member.tenant.id, member.app.id, member.user.id)
    expect((await upgrade(member)).status).toBe(202)
    expect(await upgradesOf(archived)).toHaveLength(0)
    expect(await upgradesOf(bare)).toHaveLength(0)
  })

  it('a session refusal passes through unchanged and leaves no upgrade behind', async () => {
    const f = await fixture('0.16.0')
    // The default policy allows three live sessions per app.
    for (let i = 0; i < 3; i++) await insertSession(db, f, { status: 'ready' })
    const res = await upgrade(f)
    expect(res.status).toBe(409)
    expect(((await json(res)) as { code: string }).code).toBe('session_limit')
    expect(await upgradesOf(f)).toHaveLength(0)
  })

  it("is tenant-isolated: another organisation's app is a 404 and its upgrades are not listed", async () => {
    const f = await fixture('0.16.0')
    const other = await fixture('0.16.0')
    expect((await upgrade(other)).status).toBe(202)
    expect((await upgrade({ app: other.app, cookie: f.cookie })).status).toBe(404)
    const listed = await request(
      `/api/apps/${other.app.id}/upgrades`,
      { headers: f.cookie },
      { env }
    )
    expect(listed.status).toBe(404)
    expect(await upgradesOf({ app: other.app, tenant: f.tenant })).toHaveLength(0)
  })
})

describe('the Release records the kit version at its tag', () => {
  async function releasable(version: string) {
    const f = await fixture()
    const app = await seedReleasableApp(db, cloud, f.tenant.id)
    await db.update(apps).set({ templateVersion: version }).where(eq(apps.id, app.app.id))
    return { ...f, released: app }
  }

  const releaseOf = (f: Awaited<ReturnType<typeof releasable>>) =>
    request(
      `/api/apps/${f.released.app.id}/releases`,
      { method: 'POST', headers: f.cookie },
      { env, json: { bump: 'patch' } }
    )

  it('updates template_version from .rocketflare.json, audits it, and settles the upgrade released', async () => {
    const f = await releasable('0.16.0')
    const [open] = await db
      .insert(appUpgrades)
      .values({
        tenantId: f.tenant.id,
        appId: f.released.app.id,
        fromVersion: '0.16.0',
        toVersion: '0.16.1',
        status: 'pr_open',
        prNumber: 7,
        prUrl: 'https://github.com/x/y/pull/7',
      })
      .returning()
    // The upgrade PR merged: main's manifest says the new kit.
    cloud.github.pushCommit(f.released.owner, f.released.repo, {
      '.rocketflare.json': JSON.stringify({
        kit: { name: 'rocketflare', version: '0.16.1', commit: 'd'.repeat(40) },
      }),
    })

    const res = await releaseOf(f)
    expect(res.status, await res.clone().text()).toBe(201)

    const [app] = await db.select().from(apps).where(eq(apps.id, f.released.app.id))
    expect(app).toMatchObject({ templateVersion: '0.16.1', templateCommit: 'd'.repeat(40) })
    const [settled] = await db
      .select()
      .from(appUpgrades)
      .where(eq(appUpgrades.id, open?.id ?? ''))
    expect(settled).toMatchObject({ status: 'released', prNumber: 7 })
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, f.tenant.id), eq(auditEvents.appId, f.released.app.id)))
    const changed = audit.find(a => a.action === 'app.kit_version_changed')
    expect(changed?.summary).toMatchObject({
      before: { version: '0.16.0' },
      after: { version: '0.16.1', tag: '0.1.1' },
    })
    expect(audit.map(a => a.action)).toContain('app.upgrade.released')
    // Not behind any more.
    expect((await detail({ app: app as never, cookie: f.cookie })).kit).toMatchObject({
      current: '0.16.1',
      behind: false,
      openUpgrade: null,
    })
  })

  it('records an upgrade done outside Launch, and leaves an app whose kit did not move alone', async () => {
    const f = await releasable('0.15.0')
    cloud.github.pushCommit(f.released.owner, f.released.repo, {
      '.rocketflare.json': JSON.stringify({ kit: { version: '0.16.1' } }),
    })
    expect((await releaseOf(f)).status).toBe(201)
    const [app] = await db.select().from(apps).where(eq(apps.id, f.released.app.id))
    expect(app?.templateVersion).toBe('0.16.1')

    // A second release at the same kit: no change, no audit.
    expect((await releaseOf(f)).status).toBe(201)
    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, f.tenant.id),
          eq(auditEvents.appId, f.released.app.id),
          eq(auditEvents.action, 'app.kit_version_changed')
        )
      )
    expect(audit).toHaveLength(1)
  })

  it('a repo with no manifest changes nothing and never fails the Release', async () => {
    const f = await releasable('0.16.0')
    expect((await releaseOf(f)).status).toBe(201)
    const [app] = await db.select().from(apps).where(eq(apps.id, f.released.app.id))
    expect(app?.templateVersion).toBe('0.16.0')
  })
})
