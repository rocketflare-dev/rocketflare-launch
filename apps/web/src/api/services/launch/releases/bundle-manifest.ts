/**
 * Issue #21: check the kit's build-once bundle (`launch-bundle-<tag>.tgz`, the kit's
 * `docs/DEPLOYER.md` "Build once") BEFORE Promote publishes its draft — publishing is what starts
 * production, so a bundle that is not what staging deployed is refused while nothing has happened.
 *
 * Only the `manifest.json` entry is read: the archive is ustar + gzip with its entries sorted, so
 * `manifest.json` comes before `ui/` and `worker/` and the download is cancelled right after it.
 * Its `bundleSha256` is the kit's digest of the bundle's files — computed the same way as Launch's
 * artifact digest of an upload (`deploy/artifact-digest.ts`), so it must equal the digest Launch
 * recorded on the release's STAGING deploy, which uploaded exactly those files. The production
 * job's own `bundle.mjs fetch` still verifies every file against the manifest, and the gateway
 * still refuses a `source: bundle` upload whose digest differs (409) — this is the check that
 * happens before anything is published.
 */
import { z } from 'zod'
import { downloadReleaseAsset, type GitHubOptions } from '../github-app'

/** The fields of the kit's bundle manifest Launch checks; the rest are ignored. */
export const bundleManifestSchema = z
  .object({
    protocol: z.number(),
    tag: z.string(),
    commit: z.string().optional(),
    treeSha: z.string().optional(),
    bundleSha256: z.string(),
  })
  .passthrough()
export type BundleManifest = z.infer<typeof bundleManifestSchema>

const BLOCK = 512
/** The manifest is a few KB; anything bigger is not the kit's. */
const MANIFEST_MAX_BYTES = 1024 * 1024
/** Stop looking for it after this much of the archive. */
const SCAN_MAX_BYTES = 8 * 1024 * 1024

export class BundleManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleManifestError'
  }
}

function text(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length)
  const end = slice.indexOf(0)
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end))
}

/** A ustar entry's name (prefix + name) and size; null for the zero block that ends the archive. */
function header(block: Uint8Array): { name: string; size: number } | null {
  if (block.every(b => b === 0)) return null
  const name = text(block, 0, 100)
  const prefix = text(block, 345, 155)
  const size = Number.parseInt(text(block, 124, 12).trim() || '0', 8)
  if (!Number.isFinite(size) || size < 0) throw new BundleManifestError('The bundle is not a tar archive')
  return { name: prefix ? `${prefix}/${name}` : name, size }
}

/** The `manifest.json` of a gzip'd ustar stream; the stream is cancelled once it is read. */
export async function readBundleManifest(stream: ReadableStream<Uint8Array>): Promise<BundleManifest> {
  const reader = stream
    .pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>)
    .getReader()
  let buffer = new Uint8Array(0)
  let scanned = 0
  let done = false
  /** At least `n` bytes buffered, or false at the end of the stream. */
  const fill = async (n: number): Promise<boolean> => {
    while (buffer.length < n && !done) {
      const chunk = await reader.read()
      if (chunk.done) {
        done = true
        break
      }
      const next = new Uint8Array(buffer.length + chunk.value.length)
      next.set(buffer)
      next.set(chunk.value, buffer.length)
      buffer = next
    }
    return buffer.length >= n
  }
  const take = (n: number): Uint8Array => {
    const out = buffer.subarray(0, n)
    buffer = buffer.subarray(n)
    scanned += n
    return out
  }
  try {
    while (scanned < SCAN_MAX_BYTES) {
      if (!(await fill(BLOCK))) break
      const entry = header(take(BLOCK))
      if (!entry) break
      const padded = Math.ceil(entry.size / BLOCK) * BLOCK
      if (entry.name === 'manifest.json' || entry.name === './manifest.json') {
        if (entry.size > MANIFEST_MAX_BYTES) throw new BundleManifestError('The bundle manifest is too large')
        if (!(await fill(entry.size))) throw new BundleManifestError('The bundle ends inside its manifest')
        let parsed: unknown
        try {
          parsed = JSON.parse(new TextDecoder().decode(take(entry.size)))
        } catch {
          throw new BundleManifestError('The bundle manifest is not JSON')
        }
        const manifest = bundleManifestSchema.safeParse(parsed)
        if (!manifest.success) throw new BundleManifestError('The bundle manifest is not the kit’s')
        return manifest.data
      }
      // Skip the entry's data, a buffer's worth at a time.
      let left = padded
      while (left > 0) {
        if (!(await fill(Math.min(left, 64 * 1024)))) throw new BundleManifestError('The bundle is truncated')
        left -= take(Math.min(left, buffer.length)).length
      }
    }
    throw new BundleManifestError('The bundle has no manifest.json')
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/**
 * Refuse to publish a draft whose bundle is not the build staging deployed: the manifest's `tag`
 * must be the release's and its `bundleSha256` the staging deploy's artifact digest. Throws a
 * sentence for a person (the approval's `apply_error`); a download that fails throws too, so the
 * owed publish is retried rather than made blind.
 */
export async function verifyBundleAsset(
  token: string,
  owner: string,
  repo: string,
  input: { assetId: number; tag: string; stagingDigest: string },
  gh: GitHubOptions = {}
): Promise<BundleManifest> {
  let manifest: BundleManifest
  try {
    manifest = await readBundleManifest(await downloadReleaseAsset(token, owner, repo, input.assetId, gh))
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(`Launch could not read the release bundle of ${input.tag} to check it: ${why}`)
  }
  if (manifest.tag !== input.tag) {
    throw new Error(
      `The release bundle on ${input.tag}'s draft was built for ${manifest.tag}; Launch did not publish it`
    )
  }
  if (manifest.bundleSha256 !== input.stagingDigest) {
    throw new Error(
      `The release bundle on ${input.tag}'s draft (bundleSha256 ${manifest.bundleSha256.slice(0, 12)}…) is not the build staging deployed (${input.stagingDigest.slice(0, 12)}…); Launch did not publish it`
    )
  }
  return manifest
}
