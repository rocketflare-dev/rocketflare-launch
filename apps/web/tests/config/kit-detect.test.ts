/**
 * D36 K5: which registered kit an imported repo was built from (`kits/detect.ts`), pure over a
 * file map and catalogue rows — `launch.kit.json` first (its `kit.id`, else its `kit.repo`), then
 * the app manifest's `kit.id` / `kit.name`, a Rocketflare copy from before the contract by its
 * file alone; matching by slug, manifest id or repo, the default preferred; a kit the catalogue
 * lacks is `kit_not_registered`, a repo with neither file `manifest_missing`.
 */
import { readFileSync } from 'node:fs'
import { type KitManifest, parseKitManifest } from '@launch/shared/kit-manifest'
import { describe, expect, it } from 'vitest'
import { detectRepoKit, matchKit, normalRepo } from '@/api/services/launch/kits/detect'
import type { KitRow } from '@/db/schema'

const launchKit: KitManifest = parseKitManifest(
  readFileSync(new URL('../fixtures/launch-kit-0.1/launch.kit.json', import.meta.url), 'utf8')
)

function row(overrides: Partial<KitRow> = {}): KitRow {
  const now = new Date()
  return {
    id: crypto.randomUUID(),
    slug: 'kit',
    name: 'Kit',
    description: null,
    repo: 'acme/kit',
    pin: null,
    manifest: null,
    manifestSource: null,
    contractVersion: null,
    isDefault: false,
    status: 'verified',
    problems: [],
    checkedAt: null,
    latestCheck: null,
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const rocketflare = row({
  slug: 'rocketflare',
  name: 'Rocketflare',
  repo: 'rocketflare-dev/rocketflare',
  isDefault: true,
  status: 'unchecked',
})
const meta = row({
  slug: 'launch-kit',
  name: 'Launch Kit',
  repo: 'rocketflare-dev/launch-kit',
  manifest: launchKit,
  manifestSource: 'repo',
})
const kits = [rocketflare, meta]

const reader = (files: Record<string, string>) => async (path: string) => files[path] ?? null
const json = (value: unknown) => JSON.stringify(value)

async function refusal(promise: Promise<unknown>) {
  try {
    await promise
  } catch (err) {
    return err as { statusCode: number; code: string; message: string }
  }
  throw new Error('expected a refusal')
}

describe('normalRepo / matchKit', () => {
  it('reads a repo in any of its spellings', () => {
    expect(normalRepo('https://github.com/Acme/Kit.git')).toBe('acme/kit')
    expect(normalRepo('git@github.com:acme/kit')).toBe('acme/kit')
    expect(normalRepo('acme/kit/')).toBe('acme/kit')
  })

  it('answers to a slug, a manifest id and a repo; the built-in row before a check is Rocketflare', () => {
    expect(matchKit(kits, 'launch-kit')?.id).toBe(meta.id)
    expect(matchKit(kits, 'https://github.com/rocketflare-dev/launch-kit.git')?.id).toBe(meta.id)
    expect(matchKit(kits, 'rocketflare')?.id).toBe(rocketflare.id)
    expect(matchKit(kits, 'nope')).toBeNull()
  })

  it('prefers the default, then a verified kit, among several answering to one name', () => {
    const failed = row({ slug: 'x-failed', status: 'failed', manifest: launchKit })
    const verified = row({ slug: 'x-verified', manifest: launchKit })
    expect(matchKit([failed, verified], 'launch-kit')?.id).toBe(verified.id)
    const theDefault = row({ slug: 'x-default', isDefault: true, manifest: launchKit })
    expect(matchKit([failed, verified, theDefault], 'launch-kit')?.id).toBe(theDefault.id)
  })
})

describe('detectRepoKit', () => {
  it('reads launch.kit.json first: its kit.id', async () => {
    const found = await detectRepoKit(
      reader({ 'launch.kit.json': json({ kit: { id: 'launch-kit' } }) }),
      kits,
      'acme/shop@main'
    )
    expect(found).toMatchObject({ kit: { id: meta.id }, detectedBy: 'kit-file' })
  })

  it('falls back to launch.kit.json’s repo when its id is not registered under that name', async () => {
    const found = await detectRepoKit(
      reader({
        'launch.kit.json': json({
          kit: { id: 'renamed', repo: 'https://github.com/rocketflare-dev/launch-kit.git' },
        }),
      }),
      kits,
      'acme/shop@main'
    )
    expect(found.kit.id).toBe(meta.id)
  })

  it('reads the app manifest’s kit.id, and a pre-contract copy’s kit.name', async () => {
    const byId = await detectRepoKit(
      reader({ '.launch-app.json': json({ app: { slug: 'shop' }, kit: { id: 'launch-kit' } }) }),
      kits,
      'acme/shop@main'
    )
    expect(byId).toMatchObject({ kit: { id: meta.id }, detectedBy: 'app-manifest' })
    const byName = await detectRepoKit(
      reader({
        '.rocketflare.json': json({ app: { slug: 'shop' }, kit: { name: 'rocketflare' } }),
      }),
      kits,
      'acme/shop@main'
    )
    expect(byName).toMatchObject({ kit: { id: rocketflare.id }, detectedBy: 'app-manifest' })
  })

  it('takes a Rocketflare file that names no kit for a Rocketflare copy', async () => {
    for (const file of ['.rocketflare.json', 'launch.plugins.json']) {
      const found = await detectRepoKit(
        reader({ [file]: json({ app: { slug: 'shop' }, kit: { version: '0.15.0' } }) }),
        kits,
        'acme/shop@main'
      )
      expect(found).toMatchObject({ kit: { id: rocketflare.id }, detectedBy: 'legacy' })
    }
  })

  it('a kit-declared app manifest that names no kit is that kit’s', async () => {
    const found = await detectRepoKit(
      reader({ '.launch-app.json': json({ app: { slug: 'shop' } }) }),
      kits,
      'acme/shop@main'
    )
    expect(found.kit.id).toBe(meta.id)
  })

  it('refuses a kit the catalogue does not have, naming it', async () => {
    const err = await refusal(
      detectRepoKit(
        reader({ 'launch.kit.json': json({ kit: { id: 'acme-internal' } }) }),
        kits,
        'acme/shop@main'
      )
    )
    expect(err).toMatchObject({ statusCode: 422, code: 'kit_not_registered' })
    expect(err.message).toContain('"acme-internal"')
    expect(err.message).toContain('Settings → Kits')
  })

  it('refuses a repo with neither file, and a manifest that is not JSON', async () => {
    expect(await refusal(detectRepoKit(reader({}), kits, 'acme/shop@main'))).toMatchObject({
      statusCode: 422,
      code: 'manifest_missing',
    })
    expect(
      await refusal(detectRepoKit(reader({ 'launch.kit.json': '{' }), kits, 'acme/shop@main'))
    ).toMatchObject({ statusCode: 422, code: 'manifest_invalid' })
  })
})
