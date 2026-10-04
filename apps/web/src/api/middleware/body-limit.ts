/**
 * Request body caps (04 §4). Cloudflare already caps bodies at 100–500 MB; 1 MB of JSON is plenty
 * for every kit route and protects the DB/LLM paths. The upload routes (`/api/files`, D23,
 * `/api/ai/documents/upload`, D18, and a coding session's `/api/sessions/:id/attachments`) are
 * the exceptions: they get `MAX_UPLOAD_BYTES` plus multipart overhead, and each handler enforces
 * the exact per-file limit. Over-limit → 413 in the shared envelope.
 *
 * `/ci/*` (Launch P2, the GitHub-OIDC surface) has its own: `ciBodyLimit` allows
 * `MAX_CI_UPLOAD_BYTES` on the deployer's `upload` — a whole build, base64 inside one JSON body
 * (DEPLOYER.md asks a deployer to take at least 50 MB) — and the JSON cap everywhere else.
 */
import { MAX_UPLOAD_BYTES } from '@launch/shared/files'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

export const MAX_JSON_BODY_BYTES = 1024 * 1024

/** Multipart boundaries + part headers; a legitimate 5 MB file must not trip the transport cap. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024

const tooLarge = (c: Context) =>
  c.json({ error: 'Request body too large', statusCode: 413, code: 'payload_too_large' }, 413)

export const jsonBodyLimit = bodyLimit({ maxSize: MAX_JSON_BODY_BYTES, onError: tooLarge })

export const uploadBodyLimit = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES,
  onError: tooLarge,
})

/** Paths that mount `uploadBodyLimit` themselves and must be skipped by the JSON cap. */
export const UPLOAD_PATHS = ['/api/files', '/api/ai/documents/upload'] as const

/** Upload routes with an id in the path: a coding session's images (`POST /api/sessions/:id/attachments`). */
export const UPLOAD_PATH_PATTERNS: readonly RegExp[] = [/^\/api\/sessions\/[^/]+\/attachments\/?$/]

export function isUploadPath(pathname: string): boolean {
  return (
    UPLOAD_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`)) ||
    UPLOAD_PATH_PATTERNS.some(re => re.test(pathname))
  )
}

/** The deployer protocol's `upload` body cap: 64 MB (DEPLOYER.md: "at least 50 MB"). */
export const MAX_CI_UPLOAD_BYTES = 64 * 1024 * 1024

const ciUploadBodyLimit = bodyLimit({ maxSize: MAX_CI_UPLOAD_BYTES, onError: tooLarge })

/** `POST /ci/deploy/:id/upload` — the one `/ci` path that carries a build. */
export function isCiUploadPath(pathname: string): boolean {
  return /^\/ci\/deploy\/[^/]+\/upload\/?$/.test(pathname)
}

/** Mounted on `/ci/*`: 64 MB for the deploy upload, 1 MB for everything else. */
export const ciBodyLimit: MiddlewareHandler = (c, next) =>
  isCiUploadPath(c.req.path) ? ciUploadBodyLimit(c, next) : jsonBodyLimit(c, next)
