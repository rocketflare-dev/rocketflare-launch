/**
 * Issue #12 (build once, the kit's `docs/DEPLOYER.md` "Build once (release bundle)"): one digest
 * for what a deploy job uploaded, so Launch can tell whether production received the bytes
 * staging ran.
 *
 * Computed the way the kit's `bundleDigest` computes a release bundle's `bundleSha256`: each file
 * at its bundle path — a module `rel` at `worker/<rel>`, an asset `/<rel>` at `ui/<rel>` — hashed
 * (sha256 of the decoded bytes), the `<sha256>  <path>\n` lines sorted by path in byte order, and
 * sha256 over them. It equals the bundle's `bundleSha256` when the upload carries the same file set
 * (the deployer drops `.assetsignore`, which a bundle keeps); either way it is the same for two
 * uploads of the same bytes, which is all the staging/production comparison needs.
 */
import type { DeployUpload } from '@launch/shared/launch-pipeline'
import { decodeBase64 } from './worker-upload'

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes))
}

/** Byte order (what `LC_ALL=C sort` gives), not UTF-16 code-unit order. */
function byteOrder(a: string, b: string): number {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number)
  return x.length - y.length
}

/** The bundle path → sha256 of every file the upload carries. */
export async function artifactFiles(
  upload: Pick<DeployUpload, 'modules' | 'assets'>
): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const [rel, b64] of Object.entries(upload.modules)) {
    files[`worker/${rel}`] = await sha256(decodeBase64(b64, `module ${rel}`))
  }
  for (const [path, b64] of Object.entries(upload.assets ?? {})) {
    files[`ui/${path.replace(/^\/+/, '')}`] = await sha256(decodeBase64(b64, `asset ${path}`))
  }
  return files
}

/** sha256 over the sorted `sha256sum` lines of `files` (the kit's `bundleDigest`). */
export async function digestOfFiles(files: Record<string, string>): Promise<string> {
  const lines = Object.keys(files)
    .sort(byteOrder)
    .map(p => `${files[p]}  ${p}\n`)
    .join('')
  return sha256(encoder.encode(lines))
}

/** The upload's artifact digest: lower-case sha256 hex. */
export async function deployArtifactDigest(
  upload: Pick<DeployUpload, 'modules' | 'assets'>
): Promise<string> {
  return digestOfFiles(await artifactFiles(upload))
}
