/**
 * "Screenshot preview" (the preview pane's camera) — the `session.preview_screenshot` job's whole
 * policy. The route (`POST /api/sessions/:id/preview-screenshot`) only checks who may, reserves an
 * image id and enqueues; this captures the session's live preview AS THE PERSON SEES IT and lands
 * it as one of the session's images (`attachments.ts`), which the composer then sends like a
 * pasted one.
 *
 * - **The page**: a fresh preview grant for the person who asked (`previewGrantUrl`, the same as the
 *   iframe's) with `to=<path>` — the page the preview bridge last reported — so a fresh browser
 *   exchanges it for the preview cookie and lands where they were, signed in as them in the
 *   preview's sense (the grant names the session, the user and the host).
 * - **The capture**: the app thumbnails' `ScreenshotPort` (`launch/thumbnails/screenshot.ts`,
 *   Browser Rendering's `BROWSER`) at the pane's rendered size, as a PNG — a model reads it, and a
 *   lossy encoding blurs small text.
 * - **The result**: the PNG at `sessions/<id>/attachments/<attachmentId>`. A capture that fails —
 *   no browser, a session whose preview is not running, a page that will not load, a picture over
 *   `SESSION_ATTACHMENT_MAX_BYTES` — writes `<key>.failed` (`SCREENSHOT_FAILED_SUFFIX`) holding a
 *   sentence instead, which the image's `GET` answers as 422 `screenshot_failed`. **It never
 *   throws for those**: the person is watching a spinner for ~25 s, and a queue retry 30 s later
 *   would land after they gave up. Only a missing `FILES` (nowhere to say anything) returns with a
 *   log; the UI's own deadline covers it.
 */
import type { SessionPreviewScreenshotPayload } from '@launch/shared/jobs'
import { SESSION_ATTACHMENT_MAX_BYTES } from '@launch/shared/launch-sessions'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import type { Logger } from '../../utils/core/logger'
import type { ScreenshotPort } from '../launch/thumbnails/screenshot'
import type { StorageService } from '../storage'
import { getSessionRow } from './access'
import { SCREENSHOT_FAILED_SUFFIX, sessionAttachmentKey, sniffImageType } from './attachments'
import { previewGrantUrl } from './preview'

/** How long one capture may take, navigation included — inside the UI's ~25 s wait. */
export const PREVIEW_SCREENSHOT_TIMEOUT_MS = 12_000

/** Statuses whose sandbox serves the preview. */
const PREVIEW_LIVE_STATUSES = ['ready', 'working'] as const

export interface PreviewScreenshotDeps {
  cfg: AppConfig
  /** Null without `BROWSER`: the capture fails, saying so. */
  screenshots: ScreenshotPort | null
  /** Null without `FILES`: nothing can be written at all. */
  storage: StorageService | null
  logger: Logger
}

/** What the job did — for its log line and the tests. */
export type PreviewScreenshotOutcome =
  | { status: 'captured'; bytes: number }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: 'no_storage' }

class CaptureRefused extends Error {}

/** Capture the preview into the reserved image (see the header). Never throws for a failed capture. */
export async function capturePreviewScreenshot(
  db: Database,
  deps: PreviewScreenshotDeps,
  payload: SessionPreviewScreenshotPayload
): Promise<PreviewScreenshotOutcome> {
  const { storage, logger } = deps
  const log = { sessionId: payload.sessionId, attachmentId: payload.attachmentId }
  if (!storage) {
    logger.warn(log, 'session.preview_screenshot: no FILES binding; nothing to write')
    return { status: 'skipped', reason: 'no_storage' }
  }
  const key = sessionAttachmentKey(payload.sessionId, payload.attachmentId)
  try {
    if (!deps.screenshots) {
      throw new CaptureRefused('Screenshots are not available on this deployment.')
    }
    const row = await getSessionRow(db, payload.tenantId, payload.sessionId).catch(() => null)
    if (!row || !(PREVIEW_LIVE_STATUSES as readonly string[]).includes(row.status)) {
      throw new CaptureRefused('The preview is not running.')
    }
    if (!deps.cfg.SESSION_PREVIEW_URL) {
      throw new CaptureRefused('Session previews are not configured on this deployment.')
    }
    const { url } = await previewGrantUrl(deps.cfg, row, payload.userId, {
      path: payload.path,
      port: payload.port,
    })
    const shot = await deps.screenshots.capture({
      url,
      viewport: { width: payload.width, height: payload.height },
      timeoutMs: PREVIEW_SCREENSHOT_TIMEOUT_MS,
      format: 'png',
    })
    if (shot.bytes.byteLength > SESSION_ATTACHMENT_MAX_BYTES) {
      throw new CaptureRefused('The screenshot is too large to attach. Make the preview smaller.')
    }
    if (sniffImageType(shot.bytes) !== 'image/png') {
      throw new Error('the browser did not answer with a PNG')
    }
    await storage.put(key, shot.bytes, {
      contentType: 'image/png',
      metadata: { tenantId: payload.tenantId, sessionId: payload.sessionId, source: 'preview' },
    })
    return { status: 'captured', bytes: shot.bytes.byteLength }
  } catch (err) {
    const reason =
      err instanceof CaptureRefused
        ? err.message
        : 'The preview could not be captured. Check that the page loads, then try again.'
    if (!(err instanceof CaptureRefused)) {
      logger.warn({ ...log, err }, 'session.preview_screenshot: the capture failed')
    }
    await storage.put(`${key}${SCREENSHOT_FAILED_SUFFIX}`, reason, {
      contentType: 'text/plain; charset=utf-8',
      metadata: { tenantId: payload.tenantId, sessionId: payload.sessionId },
    })
    return { status: 'failed', reason }
  }
}
