/**
 * A coding session's images (the composer's paste, drop and attach), mounted by
 * `routes/sessions.ts` with `sessionsRouter.route('/', sessionAttachmentsRouter)`, behind the
 * `/api/sessions` mount's `authMiddleware`. Every route resolves the session with
 * `getVisibleSession` (`services/sessions/access.ts`) first: another person's session, or another
 * tenant's, is a 404, and an image is only ever looked up under ITS session's R2 prefix
 * (`services/sessions/attachments.ts` — there is no table).
 *
 * - `POST /:id/attachments` (multipart, one `file` part) → 201
 *   `sessionAttachmentUploadResponseSchema` `{ id, contentType, bytes }`: PNG, JPEG, GIF or WebP,
 *   checked by its magic bytes as well as its declared type (415 `unsupported_media_type`), at
 *   most `SESSION_ATTACHMENT_MAX_BYTES` (413). The same right as `POST /:id/turns`: `update
 *   Session`, a session the caller drives (never a reviewer's read-only grant), its credential's
 *   owner on a personal account (409 `session_credential_owner_only`), and a session that can
 *   take a message (`TURN_ACCEPTING_STATUSES`, else 409 `session_not_active`) — never a kit
 *   upgrade's (403 `upgrade_session_read_only`, first). Exempt from the
 *   1 MB JSON cap (`UPLOAD_PATH_PATTERNS`); `uploadBodyLimit` is mounted here. 503
 *   `storage_not_configured` without `FILES`.
 * - `GET /:id/attachments/:aid` → the image, streamed: `Content-Type` as stored, `nosniff`,
 *   `inline`, `Cache-Control: private` (an id names one immutable object). Read like the session's
 *   other read routes (`read Session`, issue #5's reviewer included). 404 `attachment_not_found`
 *   — also while a preview screenshot is still being taken — and 422 `screenshot_failed` (its
 *   sentence as the message) once one could not be.
 * - `POST /:id/preview-screenshot` `previewScreenshotRequestSchema` `{ path?, port?, width,
 *   height }` → 202 `{ attachmentId }`: reserves an image id and enqueues
 *   `session.preview_screenshot` on `JOBS_QUEUE` (`services/sessions/preview-screenshot.ts` does
 *   the capture); the client polls the image's `GET`. The upload's right (no kit upgrade's), and a session whose
 *   preview runs (`ready`, `working` — else 409 `preview_not_running`). 503
 *   `previews_not_configured` (no `SESSION_PREVIEW_URL`), `screenshots_not_configured` (no
 *   `BROWSER`) and `storage_not_configured` (no `FILES`) before the enqueue; a missing
 *   `JOBS_QUEUE` throws `JobsQueueNotConfiguredError`, as every enqueue does.
 *
 * Nothing here runs a turn: the ids go into `POST /:id/turns`' `attachments`, and the turn copies
 * the bytes into the container (`stageAttachments`).
 */
import {
  type PreviewScreenshotResponse,
  previewScreenshotRequestSchema,
  type SessionAttachmentUploadResponse,
} from '@launch/shared/launch-sessions'
import { uploadBodyLimit } from '../middleware/body-limit'
import { guardPermission } from '../middleware/permissions'
import { enqueueJob } from '../services/jobs'
import { getVisibleSession, sessionViewerOf } from '../services/sessions/access'
import {
  requireSessionStorage,
  SCREENSHOT_FAILED_SUFFIX,
  sessionAttachmentKey,
  storeSessionAttachment,
} from '../services/sessions/attachments'
import {
  assertCredentialOwner,
  assertTakesMessages,
  TURN_ACCEPTING_STATUSES,
} from '../services/sessions/chat'
import type { AppContext } from '../types'
import {
  ApiError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../utils/core/errors'
import { newId } from '../utils/core/ids'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const sessionAttachmentsRouter = createRouter()

/** The session the caller may see (else the SAME 404 as a missing one), and who they are. */
async function visibleSession(c: AppContext, action: 'read' | 'update') {
  const auth = guardPermission(c, action, 'Session')
  const ctx = withAuthAndDb(c)
  // Issue #5: a pending merge's reviewer may READ the images, never add one.
  const row = await getVisibleSession(
    ctx.db,
    ctx.tenantId,
    uuidParam(c, 'id'),
    sessionViewerOf(auth),
    { readOnly: action === 'read' }
  )
  return { ...ctx, row }
}

// ---- POST /api/sessions/:id/attachments ------------------------------------------------------

sessionAttachmentsRouter.post('/:id/attachments', uploadBodyLimit, async c => {
  const { user, row } = await visibleSession(c, 'update')
  // The same checks as `/turns`: an image is only ever half of a message.
  assertTakesMessages(row)
  assertCredentialOwner(row, user.id)
  if (!(TURN_ACCEPTING_STATUSES as readonly string[]).includes(row.status)) {
    throw new ConflictError(`This session is ${row.status}`, 'session_not_active')
  }
  const storage = requireSessionStorage(c.env)
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    throw new BadRequestError('Expected multipart form data with a `file` field', 'file_required')
  }
  const stored = await storeSessionAttachment(storage, row, file, file.type)
  return c.json<SessionAttachmentUploadResponse>(stored, 201)
})

// ---- GET /api/sessions/:id/attachments/:aid --------------------------------------------------

sessionAttachmentsRouter.get('/:id/attachments/:aid', async c => {
  const { row } = await visibleSession(c, 'read')
  const attachmentId = uuidParam(c, 'aid')
  const storage = requireSessionStorage(c.env)
  const key = sessionAttachmentKey(row.id, attachmentId)
  const object = await storage.get(key)
  if (!object) {
    // A preview screenshot that could not be taken leaves its sentence beside the key.
    const failed = await storage.get(`${key}${SCREENSHOT_FAILED_SUFFIX}`)
    if (failed) {
      const reason = await new Response(failed.body).text()
      throw new ApiError(422, reason || 'The screenshot could not be taken', 'screenshot_failed')
    }
    throw new NotFoundError('Image not found', 'attachment_not_found')
  }
  return c.body(object.body, 200, {
    'Content-Type': object.contentType,
    'Content-Length': String(object.size),
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400, immutable',
    ETag: object.etag,
  })
})

// ---- POST /api/sessions/:id/preview-screenshot -----------------------------------------------

/** Statuses whose sandbox serves the preview. */
const PREVIEW_RUNNING = ['ready', 'working'] as const

sessionAttachmentsRouter.post(
  '/:id/preview-screenshot',
  validate('json', previewScreenshotRequestSchema),
  async c => {
    const { cfg, tenantId, user, row } = await visibleSession(c, 'update')
    // A screenshot is an image for the next message: none on a kit upgrade.
    assertTakesMessages(row)
    assertCredentialOwner(row, user.id)
    if (!cfg.SESSION_PREVIEW_URL) {
      throw new ServiceUnavailableError(
        'Session previews are not configured on this deployment (SESSION_PREVIEW_URL)',
        'previews_not_configured'
      )
    }
    if (!c.env.BROWSER) {
      throw new ServiceUnavailableError(
        'Screenshots need Browser Rendering (the BROWSER binding) on this deployment',
        'screenshots_not_configured'
      )
    }
    requireSessionStorage(c.env)
    if (!(PREVIEW_RUNNING as readonly string[]).includes(row.status)) {
      throw new ConflictError('The preview is not running', 'preview_not_running')
    }
    const { path, port, width, height } = c.req.valid('json')
    const attachmentId = newId()
    await enqueueJob(c.env.JOBS_QUEUE, {
      type: 'session.preview_screenshot',
      payload: {
        tenantId,
        sessionId: row.id,
        userId: user.id,
        attachmentId,
        path: path ?? null,
        port,
        width,
        height,
      },
    })
    return c.json<PreviewScreenshotResponse>({ attachmentId }, 202)
  }
)
