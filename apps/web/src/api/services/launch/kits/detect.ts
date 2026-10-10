/**
 * Which registered kit an imported repo was built from (D36 K5). Pure over a file reader (the
 * repo at the import's ref) and the catalogue's rows, so `import.ts` and its tests share it.
 *
 * 1. **`launch.kit.json`** at the root — a copy of a contract kit keeps the kit's manifest: its
 *    `kit.id`, else its `kit.repo`, names the kit (`kit-file`).
 * 2. Else **the app manifest** — the first of every registered kit's `scaffold.appManifest`, then
 *    Rocketflare's `.rocketflare.json` and `launch.plugins.json`: its `kit.id`, else (a copy made
 *    before the contract) `kit.name` (`app-manifest`). One that names no kit is a Rocketflare
 *    copy when it is a Rocketflare file (`legacy`), else the kit that declares that file.
 * 3. **Matching**: a kit row answers to its slug, its manifest's `kit.id` (the built-in
 *    Rocketflare row with no snapshot yet answers to `rocketflare`) and its repo. Several →
 *    the default, then a verified one, then the catalogue's order.
 *
 * A repo naming a kit the catalogue does not have is 422 `kit_not_registered`, with the name, so
 * an admin knows what to add; a repo with neither file is 422 `manifest_missing`.
 */
import { KIT_MANIFEST_PATH } from '@launch/shared/kit-manifest'
import { KIT_NOT_REGISTERED } from '@launch/shared/kits'
import type { ImportKitSource } from '@launch/shared/launch-apps'
import { ApiError } from '../../../utils/core/errors'
import type { KitFileReader } from './manifest'
import {
  ROCKETFLARE_FALLBACK_INPUT,
  ROCKETFLARE_KIT_ID,
  ROCKETFLARE_LEGACY_APP_MANIFESTS,
} from './rocketflare-fallback'
import type { KitRow } from './store'

/** The app-manifest names a Rocketflare copy carries, in the order they are read. */
const ROCKETFLARE_APP_MANIFESTS: readonly string[] = [
  ROCKETFLARE_FALLBACK_INPUT.scaffold.appManifest,
  ...ROCKETFLARE_LEGACY_APP_MANIFESTS,
]

export interface DetectedKit {
  kit: KitRow
  detectedBy: ImportKitSource
  /** The kit id (or repo) the repo named; `rocketflare` for a legacy copy. */
  named: string
}

/** `https://github.com/acme/kit.git`, `git@github.com:acme/kit`, `acme/kit` → `acme/kit`. */
export function normalRepo(repo: string): string {
  return repo
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

const ROCKETFLARE_REPO = normalRepo(ROCKETFLARE_FALLBACK_INPUT.kit.repo)

/** The names a kit row answers to: its slug, its manifest's `kit.id`, its repo. */
function namesOf(row: KitRow): Set<string> {
  const names = new Set([row.slug.toLowerCase(), normalRepo(row.repo)])
  if (row.manifest?.kit.id) names.add(row.manifest.kit.id.toLowerCase())
  if (row.manifest?.kit.repo) names.add(normalRepo(row.manifest.kit.repo))
  // The built-in row before any check read a snapshot: it IS Rocketflare by its repo.
  if (!row.manifest && normalRepo(row.repo) === ROCKETFLARE_REPO) names.add(ROCKETFLARE_KIT_ID)
  return names
}

/** The best of several rows: the default, then a verified one, then the catalogue's order. */
function best(rows: KitRow[]): KitRow | null {
  return rows.find(r => r.isDefault) ?? rows.find(r => r.status === 'verified') ?? rows[0] ?? null
}

/** The kit row named `name` (an id, a slug or a repo), or null. */
export function matchKit(kits: readonly KitRow[], name: string): KitRow | null {
  const key = name.includes('/') ? normalRepo(name) : name.trim().toLowerCase()
  return best(kits.filter(row => namesOf(row).has(key)))
}

interface KitNaming {
  id?: unknown
  name?: unknown
  repo?: unknown
}

/** The JSON object in `text`, or a 422 naming the file. */
function parseJson(text: string, file: string): { kit?: KitNaming } {
  try {
    const doc = JSON.parse(text) as unknown
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc as { kit?: KitNaming }
  } catch {
    // fall through to the refusal
  }
  throw new ApiError(422, `${file} is not a JSON object`, 'manifest_invalid', { file })
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

function notRegistered(label: string, named: string, file: string): ApiError {
  return new ApiError(
    422,
    `${label} was built from the kit "${named}" (its ${file} says so), which Launch has not registered. A platform administrator adds it under Settings → Kits, then import again.`,
    KIT_NOT_REGISTERED,
    { kit: named, file }
  )
}

/** The app-manifest paths to look for, the registered kits' own first. */
export function appManifestCandidates(kits: readonly KitRow[]): string[] {
  const declared = kits.map(k => k.manifest?.scaffold.appManifest).filter(p => p !== undefined)
  return [...new Set([...declared, ...ROCKETFLARE_APP_MANIFESTS])]
}

/** Which registered kit the repo behind `read` was built from (see the header). */
export async function detectRepoKit(
  read: KitFileReader,
  kits: readonly KitRow[],
  label: string
): Promise<DetectedKit> {
  const kitFile = await read(KIT_MANIFEST_PATH)
  if (kitFile !== null) {
    const naming = parseJson(kitFile, KIT_MANIFEST_PATH).kit ?? {}
    const id = text(naming.id)
    const repo = text(naming.repo)
    if (id || repo) {
      const kit = (id ? matchKit(kits, id) : null) ?? (repo ? matchKit(kits, repo) : null)
      const named = (id ?? repo) as string
      if (!kit) throw notRegistered(label, named, KIT_MANIFEST_PATH)
      return { kit, detectedBy: 'kit-file', named }
    }
  }

  const candidates = appManifestCandidates(kits)
  for (const path of candidates) {
    const manifest = await read(path)
    if (manifest === null) continue
    const naming = parseJson(manifest, path).kit ?? {}
    const named = text(naming.id) ?? text(naming.name)
    if (named) {
      const kit = matchKit(kits, named)
      if (!kit) throw notRegistered(label, named, path)
      return { kit, detectedBy: 'app-manifest', named }
    }
    if (ROCKETFLARE_APP_MANIFESTS.includes(path)) {
      const kit = matchKit(kits, ROCKETFLARE_KIT_ID)
      if (!kit) throw notRegistered(label, ROCKETFLARE_KIT_ID, path)
      return { kit, detectedBy: 'legacy', named: ROCKETFLARE_KIT_ID }
    }
    const kit = best(kits.filter(k => k.manifest?.scaffold.appManifest === path))
    if (kit) return { kit, detectedBy: 'app-manifest', named: kit.slug }
  }
  throw new ApiError(
    422,
    `${label} has no ${KIT_MANIFEST_PATH} and no app manifest (${candidates.join(', ')}) — was it built from a kit Launch knows?`,
    'manifest_missing',
    { files: [KIT_MANIFEST_PATH, ...candidates] }
  )
}
