/**
 * Turning a checked build into an UNDEPLOYED Worker version (Launch P2, the deploy gateway's
 * `upload`) — ported from the S5 spike's `uploadAssets` and `upload`. Nothing here decides what
 * may be bound: `binding-check.ts` already did, and this module uploads exactly its `bindings`.
 *
 * 1. **Assets** (DEPLOYER.md: every file under `[assets] directory`, `/`-rooted, base64): a
 *    manifest of `sha256(base64 + extension)[:32]` and the decoded size → an upload session →
 *    each bucket Cloudflare asks for, base64, under the SESSION jwt → the completion jwt.
 * 2. **The version** (the Workers Versions API, multipart like a script): the modules the job's
 *    `wrangler deploy --dry-run --outdir` wrote, typed by extension (`workerModuleType`: `.js`/
 *    `.mjs` ES module, `.cjs` CommonJS, `.wasm`, `.bin` data, `.txt`/`.html`/`.sql` text), and
 *    metadata with the checked bindings, `RELEASE_VERSION` set to the job's `version`, and
 *    `keep_bindings: ['secret_text']` so the secrets Launch put on the Worker survive the deploy.
 *
 * Nothing serves the version until `activate` deploys it at 100%, so a later failure (a refused
 * migration, a job that never activates) leaves production on what it was serving.
 */
import type { DeployUpload } from '@launch/shared/launch-pipeline'
import { BadRequestError } from '../../../utils/core/errors'
import type {
  AssetsManifest,
  AssetUploadFile,
  CloudflareClient,
  WorkerMetadata,
  WorkerModule,
} from '../cloudflare'
import type { BindingCheckResult } from './binding-check'

type Table = Record<string, unknown>
const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v)

/** An asset's media type, by extension — what Cloudflare serves it as. */
export function assetContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const types: Record<string, string> = {
    html: 'text/html',
    htm: 'text/html',
    js: 'application/javascript',
    mjs: 'application/javascript',
    css: 'text/css',
    json: 'application/json',
    map: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    txt: 'text/plain',
    xml: 'application/xml',
    webmanifest: 'application/manifest+json',
    woff: 'font/woff',
    woff2: 'font/woff2',
    wasm: 'application/wasm',
    pdf: 'application/pdf',
  }
  return types[ext] ?? 'application/octet-stream'
}

/** Bytes a base64 string decodes to, without decoding it. */
export function base64Size(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - padding
}

function decodeBase64(b64: string, what: string): Uint8Array {
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    throw new BadRequestError(`${what} is not base64`, 'deploy_upload_invalid')
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** A module path relative to the outdir: no absolute path, no `..`, no backslash. */
function isSafeModulePath(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    name.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  )
}

/** The assets manifest wrangler builds: `/path` → `{ hash: sha256(b64 + ext)[:32], size }`. */
export async function assetsManifest(
  assets: Record<string, string>
): Promise<{ manifest: AssetsManifest; files: Map<string, AssetUploadFile> }> {
  const manifest: AssetsManifest = {}
  const files = new Map<string, AssetUploadFile>()
  for (const [path, b64] of Object.entries(assets)) {
    if (!path.startsWith('/') || path.includes('..')) {
      throw new BadRequestError(`Asset path ${path} must be /-rooted`, 'deploy_upload_invalid')
    }
    const ext = path.split('.').pop() ?? ''
    const hash = (await sha256Hex(b64 + ext)).slice(0, 32)
    manifest[path] = { hash, size: base64Size(b64) }
    files.set(hash, { hash, base64: b64, contentType: assetContentType(path) })
  }
  return { manifest, files }
}

/**
 * Upload the build's static assets for `scriptName` and return the completion jwt a version binds,
 * or null when there are none. Every bucket Cloudflare names is sent; the last answer's jwt wins.
 */
export async function uploadAssets(
  cf: CloudflareClient,
  accountId: string,
  scriptName: string,
  assets: Record<string, string>
): Promise<string | null> {
  if (Object.keys(assets).length === 0) return null
  const { manifest, files } = await assetsManifest(assets)
  const session = await cf.assetsUploadSession(accountId, scriptName, manifest)
  let completion = session.jwt
  for (const bucket of session.buckets ?? []) {
    const batch = bucket.map(hash => {
      const file = files.get(hash)
      if (!file) throw new Error(`Cloudflare asked for an asset hash the build does not have`)
      return file
    })
    const { jwt } = await cf.uploadAssetBucket(accountId, session.jwt, batch)
    if (jwt) completion = jwt
  }
  return completion
}

/** The `[assets]` settings a version carries (not `directory` or `binding`). */
function assetsConfig(config: Table): Record<string, unknown> {
  const assets = isTable(config.assets) ? config.assets : {}
  const out: Record<string, unknown> = {}
  for (const key of ['html_handling', 'not_found_handling', 'run_worker_first']) {
    if (assets[key] !== undefined) out[key] = assets[key]
  }
  return out
}

/** The build's modules as upload parts. `main` must be one of them. */
export function workerModules(upload: Pick<DeployUpload, 'main' | 'modules'>): WorkerModule[] {
  if (!(upload.main in upload.modules)) {
    throw new BadRequestError(
      `The entry module ${upload.main} is not among the uploaded modules`,
      'deploy_upload_invalid'
    )
  }
  return Object.entries(upload.modules).map(([name, b64]) => {
    if (!isSafeModulePath(name)) {
      throw new BadRequestError(`Module path ${name} is not relative`, 'deploy_upload_invalid')
    }
    return { name, content: decodeBase64(b64, `Module ${name}`) }
  })
}

export interface VersionMetadataInput {
  config: Table
  check: Pick<BindingCheckResult, 'bindings'>
  upload: Pick<DeployUpload, 'main' | 'version'>
  ticketId: string
  assetsJwt: string | null
}

/**
 * The version's metadata part: the checked bindings plus `RELEASE_VERSION`, secrets kept, the
 * toml's compatibility and script settings. Never a DO `migrations` block — a version cannot apply
 * one, and `binding-check.ts` refused any newer than the placeholder's.
 */
export function versionMetadata(input: VersionMetadataInput): WorkerMetadata {
  const { config, check, upload, ticketId, assetsJwt } = input
  const flags = Array.isArray(config.compatibility_flags)
    ? config.compatibility_flags.filter((f): f is string => typeof f === 'string')
    : []
  return {
    main_module: upload.main,
    ...(typeof config.compatibility_date === 'string'
      ? { compatibility_date: config.compatibility_date }
      : {}),
    compatibility_flags: flags,
    bindings: [
      ...check.bindings,
      { type: 'plain_text', name: 'RELEASE_VERSION', text: upload.version },
    ],
    keep_bindings: ['secret_text'],
    annotations: {
      'workers/message': `launch deploy ticket ${ticketId}`,
      'workers/tag': upload.version,
    },
    ...(isTable(config.placement) ? { placement: config.placement } : {}),
    ...(isTable(config.limits) ? { limits: config.limits } : {}),
    ...(isTable(config.observability) ? { observability: config.observability } : {}),
    ...(assetsJwt ? { assets: { jwt: assetsJwt, config: assetsConfig(config) } } : {}),
  }
}

/** Upload assets, then the version. Returns the Cloudflare version id. */
export async function uploadVersion(
  cf: CloudflareClient,
  accountId: string,
  input: {
    workerName: string
    config: Table
    check: Pick<BindingCheckResult, 'bindings'>
    upload: Pick<DeployUpload, 'main' | 'version' | 'modules' | 'assets'>
    ticketId: string
  }
): Promise<string> {
  const modules = workerModules(input.upload)
  const assetsJwt = await uploadAssets(cf, accountId, input.workerName, input.upload.assets)
  const metadata = versionMetadata({ ...input, assetsJwt })
  const version = await cf.createVersion(accountId, input.workerName, metadata, modules)
  return version.id
}
