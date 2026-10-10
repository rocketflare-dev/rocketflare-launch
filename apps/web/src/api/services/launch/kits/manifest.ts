/**
 * Which manifest a kit has at a commit (D36 §3): its own `launch.kit.json`, else — for a
 * Rocketflare release that predates the file — the built-in fallback, else a typed error.
 *
 * Everything reads through a {@link KitFileReader} (a path → its text at the pinned commit, null
 * when absent), so the resolution and the conformance check are pure over the reader and tests
 * hand in a map. `kitFileReader` builds the real one over the GitHub contents API with an
 * installation token (`kits/github.ts` mints it, for a public or a private kit repo).
 */
import { KIT_MANIFEST_PATH, type KitManifest, parseKitManifest } from '@launch/shared/kit-manifest'
import type { KitManifestSource } from '@launch/shared/kits'
import { ZodError } from 'zod'
import { type GitHubOptions, getRepoFile } from '../github-app'
import { ROCKETFLARE_KIT_ID, rocketflareFallbackManifest } from './rocketflare-fallback'

/** A repo path → its text at the pinned commit, or null when the file does not exist. */
export type KitFileReader = (path: string) => Promise<string | null>

/** The file a Rocketflare kit (and every copy of it) records its provenance in. */
export const ROCKETFLARE_PROVENANCE_PATH = '.rocketflare.json'

export interface ResolvedKitManifest {
  manifest: KitManifest
  source: KitManifestSource
}

/** Why a kit has no usable manifest — `code` is the API's, `message` one sentence. */
export class KitManifestError extends Error {
  constructor(
    readonly code: 'kit_manifest_missing' | 'kit_manifest_invalid',
    message: string
  ) {
    super(message)
    this.name = 'KitManifestError'
  }
}

/** A zod failure as one sentence: the first few issues, each `path: message`. */
export function zodSentence(err: ZodError): string {
  return err.issues
    .slice(0, 4)
    .map(i => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}

/**
 * Is this repo the Rocketflare KIT itself (not a copy of it)? Its `.rocketflare.json` names the kit
 * `rocketflare` and records no `app` — a copy's rename fills `app` in.
 */
export function isRocketflareKit(provenance: string | null): boolean {
  if (provenance === null) return false
  try {
    const doc = JSON.parse(provenance) as { kit?: { name?: unknown }; app?: unknown }
    return doc?.kit?.name === ROCKETFLARE_KIT_ID && (doc.app === null || doc.app === undefined)
  } catch {
    return false
  }
}

/**
 * The kit's manifest at the reader's commit. `launch.kit.json` wins when present (and must
 * parse — a broken one is never papered over by the fallback); absent, a Rocketflare kit gets the
 * built-in fallback; anything else is `kit_manifest_missing`.
 */
export async function readKitManifest(read: KitFileReader): Promise<ResolvedKitManifest> {
  const text = await read(KIT_MANIFEST_PATH)
  if (text !== null) {
    try {
      return { manifest: parseKitManifest(text), source: 'repo' }
    } catch (err) {
      const why =
        err instanceof ZodError
          ? zodSentence(err)
          : err instanceof SyntaxError
            ? 'not valid JSON'
            : String(err)
      throw new KitManifestError('kit_manifest_invalid', `${KIT_MANIFEST_PATH} is invalid: ${why}`)
    }
  }
  if (isRocketflareKit(await read(ROCKETFLARE_PROVENANCE_PATH))) {
    return { manifest: rocketflareFallbackManifest(), source: 'fallback' }
  }
  throw new KitManifestError(
    'kit_manifest_missing',
    `No ${KIT_MANIFEST_PATH} at the kit's root, and it is not a Rocketflare release Launch knows`
  )
}

/** A reader over the GitHub contents API at `commit`, memoised per path for one check. */
export function kitFileReader(
  token: string,
  repo: string,
  commit: string,
  opts: Pick<GitHubOptions, 'fetch' | 'apiBase'> = {}
): KitFileReader {
  const [owner = '', name = ''] = repo.split('/')
  const cache = new Map<string, Promise<string | null>>()
  return path => {
    let hit = cache.get(path)
    if (!hit) {
      hit = getRepoFile(token, owner, name, path, commit, opts)
      cache.set(path, hit)
    }
    return hit
  }
}
