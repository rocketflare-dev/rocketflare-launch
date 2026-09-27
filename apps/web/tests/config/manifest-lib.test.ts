/**
 * `scripts/lib/manifest.mjs` — the reader of `launch.plugins.json`, and the one place the
 * git-ignored `launch.plugins.local.json` sidecar is folded in (D31).
 *
 * Why this matters enough to test: every plugin command decides WHERE to record an install from
 * `isKit`, and every reader decides WHAT is installed from the merged surfaces. Get the merge wrong
 * and a plugin is invisible to `plugin check`.
 *
 * The `config` project: no database, and the only I/O is reading the repo's own two files.
 */
import { describe, expect, it } from 'vitest'
import {
  MANIFEST_FILE,
  mergeSidecar,
  pluginSurfaces,
  readManifest,
  SIDECAR_FILE,
} from '../../../../scripts/lib/manifest.mjs'
import { PLUGIN_MANIFEST_FILE } from '../../../../scripts/lib/plugin-lib.mjs'
import { KIT } from '../../../../scripts/lib/rename-lib.mjs'
import type { Manifest, Surface } from '../../../../scripts/lib/upgrade-lib.d.mts'

const surface = (id: string): Surface => ({
  id,
  kind: 'plugin',
  label: id,
  anchor: `apps/web/src/plugins/${id}/plugin.json`,
  paths: [`apps/web/src/plugins/${id}/**`],
  registries: ['apps/web/src/plugins/server.ts'],
})

const base = {
  $purpose: 'x',
  kitVersion: '0.15.0',
  app: null,
  surfaces: [surface('orders')],
} satisfies Manifest

describe('mergeSidecar', () => {
  it('is the manifest itself when there is no sidecar', () => {
    expect(mergeSidecar(base, null)).toBe(base)
    expect(mergeSidecar(base, { surfaces: [] })).toBe(base)
  })

  it('appends the sidecar surfaces without touching anything else', () => {
    const merged = mergeSidecar(base, { surfaces: [surface('analytics')] })
    expect(merged?.surfaces.map(s => s.id)).toEqual(['orders', 'analytics'])
    expect(merged?.kitVersion).toBe(base.kitVersion)
    expect(merged?.app).toBeNull()
    // The committed manifest is not mutated — a writer reads it back to write it out.
    expect(base.surfaces).toHaveLength(1)
  })

  it('lets a local entry replace a committed one of the same id', () => {
    const local = { ...surface('orders'), label: 'local copy' }
    const merged = mergeSidecar(base, { surfaces: [local] })
    expect(merged?.surfaces).toHaveLength(1)
    expect(merged?.surfaces[0]?.label).toBe('local copy')
  })

  it('survives a missing manifest', () => {
    expect(mergeSidecar(null, { surfaces: [surface('analytics')] })).toBeNull()
  })
})

describe('pluginSurfaces', () => {
  it('is only the plugin kind', () => {
    const merged = mergeSidecar(base, { surfaces: [surface('analytics')] })
    const withOther = merged && {
      ...merged,
      surfaces: [...merged.surfaces, { ...surface('x'), kind: 'example' as never }],
    }
    expect(pluginSurfaces(withOther).map(s => s.id)).toEqual(['orders', 'analytics'])
    expect(pluginSurfaces(null)).toEqual([])
  })
})

describe('readManifest', () => {
  it('reads this repository, and agrees with the committed file about which it is', () => {
    const { manifest, isKit, sidecar, manifestPath, sidecarPath } = readManifest()
    // Launch is an app, never the kit: `isKit` is the `app === null` question and nothing else.
    expect(isKit).toBe(false)
    expect(manifest?.app?.slug).toBe('launch')
    expect(manifestPath.endsWith(MANIFEST_FILE)).toBe(true)
    expect(sidecarPath.endsWith(SIDECAR_FILE)).toBe(true)
    // The sidecar is git-ignored, so a developer's checkout may legitimately have one; what must
    // hold either way is that `isKit` reads the COMMITTED file, never the merged view.
    expect(sidecar === null || typeof sidecar === 'object').toBe(true)
  })

  it('is honest about a directory that has no manifest at all', () => {
    const { manifest, isKit, sidecar } = readManifest('/')
    expect(manifest).toBeNull()
    expect(sidecar).toBeNull()
    // Not the kit: an unknown state is not a licence to behave like it.
    expect(isKit).toBe(false)
  })
})

/**
 * A plugin repository's manifest filename is the ECOSYSTEM's (`rocketflare-plugin.json`), identical
 * in every plugin repository, so it is built from `KIT.slug` rather than from Launch's name.
 */
describe('the fixed filenames', () => {
  it('name Launch for the record and the kit for a plugin repository', () => {
    expect(MANIFEST_FILE).toBe('launch.plugins.json')
    expect(SIDECAR_FILE).toBe('launch.plugins.local.json')
    expect(PLUGIN_MANIFEST_FILE).toBe(`${KIT.slug}-plugin.json`)
  })
})
