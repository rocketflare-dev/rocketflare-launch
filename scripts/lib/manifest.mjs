/**
 * Reading `launch.plugins.json` — the record of the plugins installed in Launch (D31).
 *
 * A plugin is recorded as a SURFACE, and there are two files it can be recorded in:
 *
 *   - `launch.plugins.json` itself, committed, so the whole team and CI see it;
 *   - with `--local`, the git-ignored `launch.plugins.local.json` sidecar — an authoring
 *     convenience for a plugin being developed against a working copy.
 *
 * So `readManifest()` returns the MERGED view plus the two facts a caller needs to write back
 * correctly: whether this is the kit (never, in Launch — the `app` block is always set), and
 * whether a sidecar exists. Readers should not care which file a surface came from.
 *
 * Launch was seeded from the Rocketflare kit and no longer tracks it; this file used to be the
 * kit's `.rocketflare.json` and now holds only the plugin surfaces, `kitVersion` (the kit's plugin
 * API level a plugin's `minKit` is checked against) and the app's names.
 *
 * Pure except for `readManifest` itself, which reads the two files.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isKitManifest } from './upgrade-lib.mjs'

/** The one place the file names are spelled. */
export const MANIFEST_FILE = 'launch.plugins.json'
export const SIDECAR_FILE = 'launch.plugins.local.json'

/** The repository root, from this file's location — the same anchor every other script uses. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Fold the sidecar into the manifest. Only `surfaces` merges: everything else in the manifest
 * (`kitVersion`, the app's names) describes the checkout and is not something a local install may
 * restate.
 *
 * A sidecar surface with an id the manifest already has REPLACES it, because the local file is the
 * more specific statement — that is what lets an author point a vendored plugin at a working copy
 * without editing the committed manifest.
 */
export function mergeSidecar(manifest, sidecar) {
  const extra = sidecar?.surfaces ?? []
  if (!manifest || extra.length === 0) return manifest
  const overridden = new Set(extra.map(s => s.id))
  return {
    ...manifest,
    surfaces: [...manifest.surfaces.filter(s => !overridden.has(s.id)), ...extra],
  }
}

/** Every surface of `kind: 'plugin'`, in merge order. */
export function pluginSurfaces(manifest) {
  return (manifest?.surfaces ?? []).filter(s => s.kind === 'plugin')
}

function readJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${error.message}`)
  }
}

/**
 * `{ manifest, isKit, sidecar }` for a checkout.
 *
 * `manifest` is null when there is no `launch.plugins.json` at all; `isKit` is then false, because
 * an unknown state is not a licence to behave like the kit. `sidecar` is the raw sidecar object or null — a caller that is about to
 * WRITE needs to know whether the file exists, which the merged manifest cannot tell it.
 */
export function readManifest(rootDir = REPO_ROOT) {
  const manifestPath = path.join(rootDir, MANIFEST_FILE)
  const sidecarPath = path.join(rootDir, SIDECAR_FILE)
  const manifest = readJson(manifestPath)
  const sidecar = readJson(sidecarPath)
  return {
    manifest: mergeSidecar(manifest, sidecar),
    isKit: isKitManifest(manifest),
    sidecar,
    manifestPath,
    sidecarPath,
  }
}
