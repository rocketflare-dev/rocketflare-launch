/**
 * D36 K2: which adapter an app is driven by, against the real database (`kits/adapter.ts`
 * `adapterFor`): the manifest snapshot on the app (`apps.kit_manifest`) first, else its kit row's
 * snapshot, else the Rocketflare fallback — and what reads it: the health probe's paths, the kit
 * status ("behind" only for a kit with an `upgrade` block), the app detail's required check.
 *
 * The kit row is a NON-default one with a unique slug (the meta-kit's manifest), so nothing that
 * creates an app or reads the default kit sees it; it is removed after the suite.
 */
import { readFileSync } from 'node:fs'
import { type KitManifest, parseKitManifest } from '@launch/shared/kit-manifest'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { checkAppHealth } from '@/api/services/launch/health'
import { adapterFor, adapterForAppId, rocketflareAdapter } from '@/api/services/launch/kits/adapter'
import { rocketflareFallbackManifest } from '@/api/services/launch/kits/rocketflare-fallback'
import { deleteKit, insertKit } from '@/api/services/launch/kits/store'
import { kitStatuses } from '@/api/services/launch/upgrades'
import { type AppRow, apps } from '@/db/schema'
import { createTestTenant } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { forgetApps, seedApp, uniqueSlug } from '../helpers/launch-apps'

const db = setupTestDatabase()
const tenantIds: string[] = []
const kitIds: string[] = []

const launchKit: KitManifest = parseKitManifest(
  readFileSync(new URL('../fixtures/launch-kit-0.1/launch.kit.json', import.meta.url), 'utf8')
)

afterAll(async () => {
  await forgetApps(db, tenantIds)
  for (const id of kitIds) await deleteKit(db, id)
})

async function kitRow(manifest: KitManifest) {
  const row = await insertKit(db, {
    slug: uniqueSlug('kit'),
    name: manifest.kit.name,
    repo: 'rocketflare-dev/launch-kit',
    pin: { tag: '0.2.0', commit: 'b'.repeat(40) },
    manifest,
    manifestSource: 'repo',
    contractVersion: '1',
    status: 'verified',
    isDefault: false,
  })
  kitIds.push(row.id)
  return row
}

async function appOn(set: Partial<Pick<AppRow, 'kitId' | 'kitManifest'>>): Promise<AppRow> {
  const tenant = await createTestTenant(db)
  tenantIds.push(tenant.id)
  const { app } = await seedApp(db, tenant.id)
  const [row] = await db
    .update(apps)
    .set({ ...set, templateVersion: '0.1.0' })
    .where(and(eq(apps.tenantId, tenant.id), eq(apps.id, app.id)))
    .returning()
  if (!row) throw new Error('no app')
  return row
}

describe('adapterFor', () => {
  it('an app on a kit row with a manifest is driven by that manifest', async () => {
    const kit = await kitRow(launchKit)
    const app = await appOn({ kitId: kit.id, kitManifest: null })
    const adapter = await adapterFor(db, app)
    expect(adapter.id).toBe('launch-kit')
    expect(adapter.paths.manifest).toBe('.launch-app.json')
    expect((await adapterForAppId(db, app.tenantId, app.id)).id).toBe('launch-kit')
  })

  it('the app’s own snapshot wins over its kit’s (the kit was re-pinned since)', async () => {
    const kit = await kitRow(launchKit)
    const app = await appOn({ kitId: kit.id, kitManifest: rocketflareFallbackManifest() })
    expect((await adapterFor(db, app)).id).toBe('rocketflare')
  })

  it('no snapshot and no kit, or a kit with none read yet: the Rocketflare fallback', async () => {
    expect(await adapterFor(db, await appOn({ kitId: null, kitManifest: null }))).toBe(
      rocketflareAdapter
    )
    const unchecked = await insertKit(db, {
      slug: uniqueSlug('kit'),
      name: 'Unchecked',
      repo: 'acme/kit',
      isDefault: false,
    })
    kitIds.push(unchecked.id)
    expect(await adapterFor(db, await appOn({ kitId: unchecked.id, kitManifest: null }))).toBe(
      rocketflareAdapter
    )
  })
})

describe('what reads the adapter', () => {
  it('the health probe asks the kit’s own live and ready routes', async () => {
    const own = { ...launchKit, health: { live: '/healthz', ready: '/readyz' } }
    const app = await appOn({ kitId: null, kitManifest: own })
    const asked: string[] = []
    const fetchStub = (async (input: RequestInfo | URL) => {
      asked.push(String(input))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await checkAppHealth(db, app.tenantId, app.id, { fetch: fetchStub })
    expect(asked.sort()).toEqual([
      `https://${app.slug}-staging.apps.test/healthz`,
      `https://${app.slug}-staging.apps.test/readyz`,
      `https://${app.slug}.apps.test/healthz`,
      `https://${app.slug}.apps.test/readyz`,
    ])
  })

  it('an app is behind its OWN kit’s pin — and never behind when its kit declares no upgrade', async () => {
    const kit = await kitRow(launchKit)
    const upgradable = await appOn({ kitId: kit.id, kitManifest: null })
    const noUpgrade = await appOn({
      kitId: kit.id,
      kitManifest: { ...launchKit, upgrade: undefined },
    })
    const a = (await kitStatuses(db, upgradable.tenantId, [upgradable])).get(upgradable.id)
    expect(a).toMatchObject({
      current: '0.1.0',
      target: '0.2.0',
      behind: true,
      notesUrl: 'https://github.com/rocketflare-dev/launch-kit/blob/0.2.0/docs/upgrades/0.2.0.md',
    })
    const b = (await kitStatuses(db, noUpgrade.tenantId, [noUpgrade])).get(noUpgrade.id)
    expect(b).toMatchObject({ current: '0.1.0', target: null, behind: false, notesUrl: null })
  })
})
