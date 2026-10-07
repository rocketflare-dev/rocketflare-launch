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
 *   other read routes (`read Session`, issue #5's reviewer included). 404 `attachment_not_found`.
 *
 * Nothing here runs a turn: the ids go into `POST /:id/turns`' `attachments`, and the turn copies
 * the bytes into the container (`stageAttachments`).
 */
import type { SessionAttachmentUploadResponse } from '@launch/shared/launch-sessions'
import { uploadBodyLimit } from '../middleware/body-limit'
import { guardPermission } from '../middleware/permissions'
import { getVisibleSession, sessionViewerOf } from '../services/sessions/access'
import {
  requireSessionStorage,
  sessionAttachmentKey,
  storeSessionAttachment,
} from '../services/sessions/attachments'
import {
  assertCredentialOwner,
  assertTakesMessages,
  TURN_ACCEPTING_STATUSES,
} from '../services/sessions/chat'
import type { AppContext } from '../types'
import { BadRequestError, ConflictError, NotFoundError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

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

/**
 * Upload an image for a session's next message (PNG, JPEG, GIF or WebP, checked by magic bytes).
 * Requires `update Session` on a session the caller drives, its credential owner on a personal
 * account. 403 `upgrade_session_read_only` on a kit upgrade session; 409
 * `session_credential_owner_only` or `session_not_active`; 413 over
 * `SESSION_ATTACHMENT_MAX_BYTES`; 415 `unsupported_media_type`; 503 `storage_not_configured`.
 */
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

/**
 * Stream one of a session's attached images. Requires `read Session`; a pending merge's reviewer
 * may call it too. 404 `attachment_not_found`.
 */
sessionAttachmentsRouter.get('/:id/attachments/:aid', async c => {
  const { row } = await visibleSession(c, 'read')
  const attachmentId = uuidParam(c, 'aid')
  const storage = requireSessionStorage(c.env)
  const key = sessionAttachmentKey(row.id, attachmentId)
  const object = await storage.get(key)
  if (!object) {
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
