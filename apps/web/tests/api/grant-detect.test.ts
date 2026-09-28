// @vitest-isolate
// Installs a FakeCloud as the global fetch and mocks the platform credential store.
/**
 * Detecting declared config needs (Launch P5, slice 5e): `scanAppConfig` reads the app's repo
 * through the GitHub App (the fake M365 connector installed in it), matches the declared keys to
 * the tenant's shared resources by exact name, records `app_config_scans` and tells the app's owners
 * ONCE what to request; `scanShipConfig` answers the same at a PR head for the `ship.config_needs`
 * event and stores nothing.
 *
 * What it pins: a match (and an archived resource matching nothing); `grant_needed` once to the
 * named owners and the owner group, not again on a re-scan, again for a resource newly needed; no
 * need (and no notification) when a live grant exists, a need again when it was only rejected; a
 * failed read recorded on the row with the previous scan kept; the three call sites (import,
 * Release at the tag, `POST /config/scan`) and the ship event; tenant isolation.
 */
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { appConfigSchema, GRANT_NOTIFICATION_TYPES } from '@launch/shared/launch-grants'
import { sessionBranchName } from '@launch/shared/launch-sessions'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ScanDeps, scanAppConfig, scanShipConfig } from '@/api/services/grants/detect'
import { importApp } from '@/api/services/launch/import'
import { createRelease } from '@/api/services/launch/releases/release'
import { GitHubRepoHost } from '@/api/services/sessions/repo/github-repo-host'
import { ship } from '@/api/services/sessions/ship'
import type { ShipTurnRunner } from '@/api/services/sessions/turn'
import { createR2Storage } from '@/api/services/storage'
import { loadConfig } from '@/config'
import { appConfigScans, apps, notifications, sessionEvents } from '@/db/schema'
import { actorOf, approvalDeps } from '../helpers/approvals'
import {
  createTestSession,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { fillDeployCredentials } from '../helpers/deploy-gateway'
import { createFakeCloud } from '../helpers/fake-cloud'
import { seedGrant, seedSharedResource } from '../helpers/grants'
import { forgetApps, uniqueSlug } from '../helpers/launch-apps'
import { addTestAppOwner, createTestGroup } from '../helpers/oidc'
import { request } from '../helpers/request'
import {
  createFakeSessionPorts,
  insertSession,
  type SessionAppFixture,
  seedSessionApp,
} from '../helpers/sessions'
import { createTestEnv } from '../mocks/bindings'

const store = vi.hoisted(() => ({
  credentials: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
}))
vi.mock('@/api/services/launch/credentials', async importOriginal =>
  (await import('../helpers/credential-store')).mockCredentialsModule(await importOriginal(), store)
)
const db = setupTestDatabase()
const env = createTestEnv()
const cfg = loadConfig(env)
const cloud = createFakeCloud()
const { privateKey: APP_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})
const github = {
  auth: { appId: String(cloud.opts.appId), privateKey: APP_PEM },
  installationId: cloud.opts.installationId,
  org: cloud.opts.org,
}
const tenantIds: string[] = []
let restore: () => void

beforeAll(() => {
  restore = cloud.install()
})
afterAll(async () => {
  restore()
  await forgetApps(db, tenantIds)
})
beforeEach(() => {
  fillDeployCredentials(store, cloud)
})

const M365_ANCHOR = 'apps/web/src/plugins/m365-connector/plugin.json'
const M365_PLUGIN_JSON = readFileSync(
  path.resolve(__dirname, '../fixtures/plugins/m365-connector/plugin.json'),
  'utf8'
)
const M365_KEYS = ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET']

/** `launch.plugins.json` + the connector's `plugin.json`, as `pnpm plugin add` leaves them. */
function m365Files(slug: string): Record<string, string> {
  return {
    'launch.plugins.json': JSON.stringify({
      kitVersion: '0.15.0',
      app: { slug, display: `App ${slug}`, domain: 'apps.test' },
      surfaces: [
        { id: 'm365-connector', kind: 'plugin', label: 'M365', anchor: M365_ANCHOR, paths: [] },
      ],
    }),
    [M365_ANCHOR]: M365_PLUGIN_JSON,
  }
}

function deps(overrides: Partial<ScanDeps> = {}): ScanDeps {
  return { ...approvalDeps(db, env), fetch: cloud.fetch, github, ...overrides }
}

async function fixture(opts: { install?: boolean } = {}) {
  const f = await seedSessionApp(db, cloud)
  tenantIds.push(f.tenant.id)
  if (opts.install !== false) {
    cloud.github.pushCommit(f.repo.owner, f.repo.repo, m365Files(f.app.slug), 'Add M365')
  }
  // Alice owns the app by name; Bob through its owner group; Carol's group owns the resource.
  const alice = await createTestUser(db)
  const bob = await createTestUser(db)
  const carol = await createTestUser(db)
  for (const u of [alice, bob, carol]) await linkUserToTenant(db, u.id, f.tenant.id, 'member')
  await addTestAppOwner(db, f.tenant.id, f.app.id, alice.id)
  const team = await createTestGroup(db, f.tenant.id, 'Shop team', [bob.id])
  await db.update(apps).set({ ownerGroupId: team.id }).where(eq(apps.id, f.app.id))
  const identity = await createTestGroup(db, f.tenant.id, 'IT Identity', [carol.id])
  const m365 = await seedSharedResource(db, f.tenant.id, { ownerGroupId: identity.id })
  return { f, alice, bob, carol, identity, m365 }
}

async function scanRow(appId: string) {
  const [row] = await db.select().from(appConfigScans).where(eq(appConfigScans.appId, appId))
  return row ?? null
}

async function neededFor(tenantId: string, userId: string) {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.userId, userId),
        eq(notifications.type, GRANT_NOTIFICATION_TYPES.needed)
      )
    )
}

function scan(f: SessionAppFixture, ref: string | null = null, extra: Partial<ScanDeps> = {}) {
  return scanAppConfig(deps(extra), {
    tenantId: f.tenant.id,
    appId: f.app.id,
    ref,
    trigger: 'rescan',
  })
}

describe('scanAppConfig', () => {
  it('matches the declared keys to M365, records the need and notifies the owners once', async () => {
    const { f, alice, bob, carol, identity, m365 } = await fixture()
    // Neither an unrelated resource nor an ARCHIVED one with the same keys matches.
    await seedSharedResource(db, f.tenant.id, {
      ownerGroupId: identity.id,
      slug: uniqueSlug('openai'),
      items: [{ key: 'OPENAI_API_KEY', kind: 'secret' }],
    })
    await seedSharedResource(db, f.tenant.id, {
      ownerGroupId: identity.id,
      slug: uniqueSlug('old-m365'),
      archivedAt: new Date(),
    })

    const row = await scan(f)
    expect(row.error).toBeNull()
    expect(row.ref).toBe('main')
    expect(row.needs).toEqual([m365.id])
    expect(row.declared.filter(d => d.pluginId === 'm365-connector')).toEqual([
      expect.objectContaining({ key: 'M365_TENANT_ID', secret: false }),
      expect.objectContaining({ key: 'M365_CLIENT_ID', secret: false }),
      { key: 'M365_CLIENT_SECRET', secret: true, pluginId: 'm365-connector' },
    ])
    expect(row.declared.some(d => d.key === 'ANTHROPIC_API_KEY' && d.pluginId === 'kit')).toBe(true)
    expect(await scanRow(f.app.id)).toMatchObject({ needs: [m365.id], error: null })

    // Alice (named) and Bob (owner group) are told; Carol (the resource's team) is not.
    for (const who of [alice, bob]) {
      const sent = await neededFor(f.tenant.id, who.id)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.data).toEqual({
        appId: f.app.id,
        appSlug: f.app.slug,
        resourceIds: [m365.id],
      })
      expect(sent[0]?.title).toContain('M365')
      expect(sent[0]?.body).toContain('M365_CLIENT_SECRET')
    }
    expect(await neededFor(f.tenant.id, carol.id)).toHaveLength(0)

    // The read went through a token narrowed to the repo, read-only, and revoked.
    const minted = [...cloud.github.tokens.values()].filter(t =>
      t.repositories?.includes(f.repo.repo)
    )
    expect(minted.length).toBeGreaterThan(0)
    for (const t of minted) {
      expect(t.permissions).toEqual({ contents: 'read' })
      expect(t.revoked).toBe(true)
    }

    // A re-scan finds the same need: nobody is told twice.
    await scan(f)
    expect(await neededFor(f.tenant.id, alice.id)).toHaveLength(1)
    expect(await neededFor(f.tenant.id, bob.id)).toHaveLength(1)
  })

  it('a resource newly needed on a later scan is notified, the old one is not repeated', async () => {
    const { f, alice, identity, m365 } = await fixture()
    await scan(f)
    const crm = await seedSharedResource(db, f.tenant.id, {
      ownerGroupId: identity.id,
      slug: uniqueSlug('crm'),
      displayName: 'CRM',
      items: [{ key: 'CRM_TOKEN', kind: 'secret' }],
    })
    const crmAnchor = 'apps/web/src/plugins/crm/plugin.json'
    const files = m365Files(f.app.slug)
    const manifest = JSON.parse(files['launch.plugins.json'] as string)
    manifest.surfaces.push({ id: 'crm', kind: 'plugin', anchor: crmAnchor })
    cloud.github.pushCommit(f.repo.owner, f.repo.repo, {
      'launch.plugins.json': JSON.stringify(manifest),
      [crmAnchor]: JSON.stringify({ id: 'crm', vars: [{ key: 'CRM_TOKEN', secret: true }] }),
    })

    const row = await scan(f)
    expect(row.needs.sort()).toEqual([m365.id, crm.id].sort())
    const sent = await neededFor(f.tenant.id, alice.id)
    expect(sent).toHaveLength(2)
    expect(sent.map(n => (n.data as { resourceIds: string[] }).resourceIds)).toEqual(
      expect.arrayContaining([[m365.id], [crm.id]])
    )
  })

  it('a live grant in any environment covers the need; a rejected one does not', async () => {
    const { f, alice, m365 } = await fixture()
    await seedGrant(db, {
      tenantId: f.tenant.id,
      appId: f.app.id,
      resourceId: m365.id,
      environment: 'staging',
      status: 'requested',
    })
    expect((await scan(f)).needs).toEqual([])
    expect(await neededFor(f.tenant.id, alice.id)).toHaveLength(0)

    const second = await fixture()
    await seedGrant(db, {
      tenantId: second.f.tenant.id,
      appId: second.f.app.id,
      resourceId: second.m365.id,
      environment: 'production',
      status: 'rejected',
    })
    expect((await scan(second.f)).needs).toEqual([second.m365.id])
    expect(await neededFor(second.f.tenant.id, second.alice.id)).toHaveLength(1)
  })

  it('an app with no plugins declares only the kit keys and needs nothing', async () => {
    const { f, alice } = await fixture({ install: false })
    cloud.github.pushCommit(f.repo.owner, f.repo.repo, {
      'launch.plugins.json': JSON.stringify({ kitVersion: '0.15.0', surfaces: [] }),
    })
    const row = await scan(f)
    expect(row.needs).toEqual([])
    expect(row.declared.every(d => d.pluginId === 'kit')).toBe(true)
    expect(await neededFor(f.tenant.id, alice.id)).toHaveLength(0)
  })

  it('a failed read is recorded on the row, keeping the previous scan, and never throws', async () => {
    const { f, m365 } = await fixture()
    const good = await scan(f)
    cloud.failNext(`/contents/${M365_ANCHOR.split('/')[0]}`, 500, { message: 'GitHub is down' })
    const failed = await scan(f)
    expect(failed.error).toMatch(/GitHub|500/)
    expect(failed.needs).toEqual([m365.id])
    expect(failed.declared).toEqual(good.declared)
    expect(failed.ref).toBe(good.ref)

    // The first-ever scan failing still leaves a row saying why.
    const other = await fixture()
    store.credentials.clear()
    const first = await scan(other.f, null, { github: undefined })
    expect(first.error).toMatch(/GitHub App/)
    expect(first.declared).toEqual([])
    expect(await scanRow(other.f.app.id)).toMatchObject({ error: first.error, needs: [] })
  })

  it("is tenant-isolated: another organisation's resources never match, its app is a 404", async () => {
    const { f, alice } = await fixture({ install: true })
    // Tenant B has an M365 resource; tenant A (a fresh one, below) has none.
    const a = await seedSessionApp(db, cloud)
    tenantIds.push(a.tenant.id)
    cloud.github.pushCommit(a.repo.owner, a.repo.repo, m365Files(a.app.slug))
    const row = await scan(a)
    expect(row.needs).toEqual([])
    expect(row.declared.filter(d => d.pluginId === 'm365-connector')).toHaveLength(3)

    // Scanning A's app as B's tenant finds no app and writes nothing.
    await expect(
      scanAppConfig(deps(), {
        tenantId: f.tenant.id,
        appId: a.app.id,
        ref: null,
        trigger: 'rescan',
      })
    ).rejects.toMatchObject({ statusCode: 404 })
    const [rowForB] = await db
      .select()
      .from(appConfigScans)
      .where(and(eq(appConfigScans.tenantId, f.tenant.id), eq(appConfigScans.appId, a.app.id)))
    expect(rowForB).toBeUndefined()
    expect(await neededFor(f.tenant.id, alice.id)).toHaveLength(0)
  })
})

describe('scanShipConfig', () => {
  it('answers the needs at a PR head and stores nothing', async () => {
    const { f, alice, m365 } = await fixture({ install: false })
    const branch = 'session/abc123'
    const repo = cloud.github.repo(f.repo.owner, f.repo.repo)
    repo?.refs.set(`heads/${branch}`, repo.refs.get('heads/main') as string)
    const files = m365Files(f.app.slug)
    files['apps/web/src/plugins/extra/plugin.json'] = JSON.stringify({
      id: 'extra',
      vars: ['EXTRA_URL'],
    })
    const manifest = JSON.parse(files['launch.plugins.json'] as string)
    manifest.surfaces.push({
      id: 'extra',
      kind: 'plugin',
      anchor: 'apps/web/src/plugins/extra/plugin.json',
    })
    files['launch.plugins.json'] = JSON.stringify(manifest)
    const sha = cloud.github.pushCommit(f.repo.owner, f.repo.repo, files, 'Install', branch)

    const data = await scanShipConfig(deps(), { tenantId: f.tenant.id, appId: f.app.id, sha })
    expect(data).toEqual({
      needs: [
        {
          resourceId: m365.id,
          slug: m365.slug,
          displayName: m365.displayName,
          keys: M365_KEYS,
        },
      ],
      // A plugin key with no resource is reported; the kit's optional ones are not.
      unmatched: ['EXTRA_URL'],
      sha,
    })
    expect(await scanRow(f.app.id)).toBeNull()
    expect(await neededFor(f.tenant.id, alice.id)).toHaveLength(0)
  })
})

describe('the call sites', () => {
  it('ship: a PR whose plugins need M365 gets a ship.config_needs event', async () => {
    const { f, m365 } = await fixture({ install: false })
    const row = await insertSession(db, f, {
      status: 'ready',
      requestedAction: 'ship',
      turnCount: 2,
    })
    const branch = sessionBranchName(row.shortId)
    const repoHost = new GitHubRepoHost(db, cfg, { fetch: cloud.fetch, github })
    const ports = createFakeSessionPorts({ repoHost }).script(sandbox =>
      sandbox
        .onExec(/^bash -c 'pnpm lint/, { exitCode: 0, stdout: 'ok' })
        .onExec('git diff --cached --quiet', { exitCode: 1 })
        .onExec('git commit', () => {
          cloud.github.pushCommit(
            f.repo.owner,
            f.repo.repo,
            m365Files(f.app.slug),
            'Install M365',
            branch
          )
          return { exitCode: 0 }
        })
        .onExec('git rev-parse HEAD', () => ({
          stdout:
            cloud.github.repo(f.repo.owner, f.repo.repo)?.refs.get(`heads/${branch}`) ??
            'f'.repeat(40),
        }))
    )
    const runTurn: ShipTurnRunner = async ({ session }) => {
      const turn = session.turnCount + 1
      await db.insert(sessionEvents).values({
        sessionId: session.id,
        tenantId: session.tenantId,
        seq: 1000 + turn,
        turn,
        type: 'text',
        data: { text: '{"title": "Install M365", "body": "b", "gatePassed": true}' },
      })
      return { outcome: 'completed', turn }
    }
    const outcome = await ship(
      db,
      {
        cfg,
        ports,
        storage: createR2Storage(env.FILES),
        runTurn,
        scanConfig: input => scanShipConfig(deps(), input),
      },
      { tenantId: f.tenant.id, sessionId: row.id }
    )
    expect(outcome).toMatchObject({ status: 'shipped' })
    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, row.id))
      .orderBy(sessionEvents.seq)
    const needs = events.filter(e => e.type === 'ship.config_needs')
    expect(needs).toHaveLength(1)
    expect(needs[0]?.data).toMatchObject({
      needs: [{ resourceId: m365.id, keys: M365_KEYS }],
    })
    // After the PR, never instead of it.
    const types = events.map(e => e.type)
    expect(types.indexOf('ship.config_needs')).toBeGreaterThan(types.indexOf('ship.pr'))
    expect(await scanRow(f.app.id)).toBeNull()
  })

  it('ship: a failing scan ships anyway, with no event', async () => {
    const { f } = await fixture({ install: false })
    const row = await insertSession(db, f, { status: 'ready', requestedAction: 'ship' })
    const branch = sessionBranchName(row.shortId)
    const ports = createFakeSessionPorts({
      repoHost: new GitHubRepoHost(db, cfg, { fetch: cloud.fetch, github }),
    }).script(sandbox =>
      sandbox
        .onExec(/^bash -c 'pnpm lint/, { exitCode: 0 })
        .onExec('git diff --cached --quiet', { exitCode: 1 })
        .onExec('git commit', () => {
          cloud.github.pushCommit(f.repo.owner, f.repo.repo, { 'a.txt': 'a' }, 'A', branch)
          return { exitCode: 0 }
        })
        .onExec('git rev-parse HEAD', () => ({
          stdout:
            cloud.github.repo(f.repo.owner, f.repo.repo)?.refs.get(`heads/${branch}`) ??
            'f'.repeat(40),
        }))
    )
    const runTurn: ShipTurnRunner = async ({ session }) => ({
      outcome: 'completed',
      turn: session.turnCount + 1,
      text: '{"title": "T", "body": "b", "gatePassed": true}',
    })
    const outcome = await ship(
      db,
      {
        cfg,
        ports,
        storage: null,
        runTurn,
        scanConfig: async () => {
          throw new Error('GitHub is down')
        },
      },
      { tenantId: f.tenant.id, sessionId: row.id }
    )
    expect(outcome).toMatchObject({ status: 'shipped' })
    const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, row.id))
    expect(events.some(e => e.type === 'ship.config_needs')).toBe(false)
  })

  it('Release: the scan runs at the new tag', async () => {
    const { f, alice, m365 } = await fixture()
    cloud.github.pushCommit(f.repo.owner, f.repo.repo, {
      'package.json': '{\n  "name": "app",\n  "version": "0.1.0"\n}\n',
    })
    const release = await createRelease(
      { ...approvalDeps(db, env), fetch: cloud.fetch },
      {
        tenantId: f.tenant.id,
        app: f.app,
        bump: 'patch',
        userId: alice.id,
        actor: actorOf(alice),
      }
    )
    expect(release.tag).toBe('0.1.1')
    expect(await scanRow(f.app.id)).toMatchObject({
      ref: '0.1.1',
      sha: release.sha,
      needs: [m365.id],
      error: null,
    })
    expect(await neededFor(f.tenant.id, alice.id)).toHaveLength(1)
  })

  it('import: the scan runs after commit, and tells whoever imported an app with no owners', async () => {
    const { f, identity } = await fixture({ install: false })
    const m365 = await seedSharedResource(db, f.tenant.id, {
      ownerGroupId: identity.id,
      slug: uniqueSlug('m365'),
    })
    const slug = uniqueSlug('imp')
    const token = cloud.github.issueToken().token
    const { createOrgRepo } = await import('@/api/services/launch/github-app')
    await createOrgRepo(token, cloud.opts.org, { name: slug }, { fetch: cloud.fetch })
    const toml = readFileSync(
      path.resolve(__dirname, '../fixtures/rocketflare-0.15/wrangler.toml'),
      'utf8'
    )
    const stagingToml = readFileSync(
      path.resolve(__dirname, '../fixtures/rocketflare-0.15/wrangler.staging.toml'),
      'utf8'
    )
    cloud.github.pushCommit(cloud.opts.org, slug, {
      ...m365Files(slug),
      'apps/web/wrangler.toml': toml,
      'apps/web/wrangler.staging.toml': stagingToml,
    })
    const importer = await createTestUser(db)
    await linkUserToTenant(db, importer.id, f.tenant.id, 'admin')
    const { app } = await importApp(
      db,
      cfg,
      f.tenant.id,
      { repo: `${cloud.opts.org}/${slug}` },
      actorOf(importer),
      { fetch: cloud.fetch, github }
    )
    const row = await scanRow(app.id)
    expect(row).toMatchObject({ ref: 'main', error: null })
    expect(row?.needs).toContain(m365.id)
    const sent = await neededFor(f.tenant.id, importer.id)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.data).toMatchObject({ appId: app.id, appSlug: slug })
  })

  it('POST /api/apps/:id/config/scan: owners and admins re-scan; members 403; other tenants 404', async () => {
    const { f, alice, carol, m365 } = await fixture()
    const cookieOf = async (userId: string, tenantId = f.tenant.id) =>
      sessionCookieHeader(await createTestSession(db, userId, tenantId))
    const post = async (appId: string, cookie: Record<string, string>) =>
      request(`/api/apps/${appId}/config/scan`, { method: 'POST', headers: cookie }, { env })

    // Nobody signed in is a 401; Carol, a member who does not own the app, a 403 envelope.
    expect((await post(f.app.id, {})).status).toBe(401)
    const denied = await post(f.app.id, await cookieOf(carol.id))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ statusCode: 403, code: 'forbidden' })
    expect(await scanRow(f.app.id)).toBeNull()

    const ok = await post(f.app.id, await cookieOf(alice.id))
    expect(ok.status, await ok.clone().text()).toBe(200)
    const body = appConfigSchema.parse(await ok.json())
    expect(body.needs).toEqual([m365.id])
    expect(body.scan).toMatchObject({ ref: 'main', error: null })
    // The real view (5d's `appConfigView`) matches the three keys to M365 with no grant yet.
    expect(body.matched.map(m => m.resource.id)).toEqual([m365.id])
    expect(body.matched[0]?.keys.sort()).toEqual(
      ['M365_CLIENT_ID', 'M365_CLIENT_SECRET', 'M365_TENANT_ID'].sort()
    )
    expect(body.matched[0]?.grants).toEqual({ staging: null, production: null })
    expect(body.canRequest).toBe(true)

    // The tenant's owner (an admin) may too.
    expect((await post(f.app.id, f.cookie)).status).toBe(200)

    // Another organisation's app is a 404, and nothing is written for it.
    const other = await seedSessionApp(db, cloud)
    tenantIds.push(other.tenant.id)
    expect((await post(other.app.id, f.cookie)).status).toBe(404)
    expect(await scanRow(other.app.id)).toBeNull()
  })
})
