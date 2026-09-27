/**
 * `launch.plugins.json` is the record of the plugins installed in Launch (D31): `pnpm plugin`
 * reads it to know what is installed, where each plugin came from and how to upgrade it. This
 * suite holds it to that job. The `config` project — no database, no network.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import rawManifest from '../../../../launch.plugins.json'
import { MANIFEST_FILE, readManifest } from '../../../../scripts/lib/manifest.mjs'
import type { Manifest } from '../../../../scripts/lib/upgrade-lib.d.mts'
import { RESERVED_PLUGIN_IDS } from '../helpers/plugins'

// A JSON import widens every literal to `string`; the manifest's shape is the lib's contract.
const committed = rawManifest as unknown as Manifest

/** What the tooling sees: the committed file with the git-ignored `--local` sidecar folded in. */
const manifest = (readManifest().manifest ?? committed) as Manifest

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  // `pnpm plugin remove --apply` deletes directories before any `git add`.
  .filter(f => existsSync(path.join(REPO_ROOT, f)))

describe(MANIFEST_FILE, () => {
  it('is the file the plugin tooling reads', () => {
    expect(MANIFEST_FILE).toBe('launch.plugins.json')
    expect(readManifest().manifestPath).toBe(path.join(REPO_ROOT, MANIFEST_FILE))
  })

  it('records plugins only, with no kit provenance', () => {
    const keys = Object.keys(committed).filter(k => !k.startsWith('$'))
    expect(keys.sort()).toEqual(['app', 'kitVersion', 'surfaces'])
    expect(committed.$purpose).toMatch(/pnpm plugin/)
    for (const s of committed.surfaces) expect(s.kind, s.id).toBe('plugin')
  })

  it('names the app, so a plugin is translated into Launch on the way in', () => {
    expect(committed.app).toEqual({ slug: 'launch', display: 'Launch', domain: 'clewro.com' })
    expect(readManifest().isKit).toBe(false)
  })

  it('pins the kit plugin API level as a bare version', () => {
    expect(committed.kitVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('plugin surfaces', () => {
  it('ids are unique', () => {
    const ids = manifest.surfaces.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every anchor is a tracked file under apps/web/src/plugins', () => {
    for (const s of manifest.surfaces) {
      expect(s.anchor, `${s.id} anchor`).toMatch(/^apps\/web\/src\/plugins\/[^/]+\//)
      expect(tracked, `${s.id} anchor`).toContain(s.anchor)
      expect(statSync(path.join(REPO_ROOT, s.anchor)).isFile(), `${s.id} anchor is a file`).toBe(
        true
      )
    }
  })

  it('every plugin says where it came from, so it can be upgraded', () => {
    for (const s of manifest.surfaces) {
      expect(s.source?.repo, `${s.id} source.repo`).toBeTruthy()
      expect(s.source?.version, `${s.id} source.version`).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('every registry it names still exists', () => {
    for (const s of manifest.surfaces) {
      for (const ref of s.registries)
        expect(tracked, `${s.id}: ${ref}`).toContain(ref.split('#')[0])
    }
  })

  it('every installed plugin directory is a declared surface', () => {
    const dir = path.join(REPO_ROOT, 'apps/web/src/plugins')
    const installed = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      // `plugins/api/**` is the host's plugin API, not an installed plugin (D31).
      .filter(e => !RESERVED_PLUGIN_IDS.has(e.name))
      .map(e => e.name)
    const declared = new Set(manifest.surfaces.map(s => s.id))
    expect(
      installed.filter(id => !declared.has(id)),
      'run `pnpm plugin add` rather than copying a plugin in by hand'
    ).toEqual([])
  })
})
