/**
 * `session.preview_screenshot` (Launch, the preview pane's camera): capture a coding session's
 * live preview into one of its images — `capturePreviewScreenshot` in
 * `services/sessions/preview-screenshot.ts` is the whole policy (the grant, the viewport, the PNG,
 * the failure marker). This file only binds it to the platform: the `BROWSER` binding through the
 * thumbnails' `ScreenshotPort` adapter and `FILES` through the storage seam.
 *
 * A failed capture is written as a marker the image's `GET` reports and the job RETURNS (acked):
 * the person is waiting on a spinner, and a retry with backoff would land long after it gave up.
 *
 * `makeSessionPreviewScreenshotHandler(screenshotsFor)` is the seam the tests use to hand in a fake
 * browser.
 */
import type { JobOf } from '@launch/shared/jobs'
import {
  defaultScreenshotPort,
  type ScreenshotPort,
} from '../../services/launch/thumbnails/screenshot'
import { capturePreviewScreenshot } from '../../services/sessions/preview-screenshot'
import { createR2Storage } from '../../services/storage'
import type { AppBindings } from '../../types'
import type { JobContext } from '../jobs'

export function makeSessionPreviewScreenshotHandler(
  screenshotsFor: (env: AppBindings) => ScreenshotPort | null = defaultScreenshotPort
) {
  return async function handleSessionPreviewScreenshot(
    job: JobOf<'session.preview_screenshot'>,
    ctx: JobContext
  ): Promise<void> {
    const outcome = await capturePreviewScreenshot(
      ctx.db,
      {
        cfg: ctx.config,
        screenshots: screenshotsFor(ctx.env),
        storage: ctx.env.FILES ? createR2Storage(ctx.env.FILES) : null,
        logger: ctx.logger,
      },
      job.payload
    )
    ctx.logger.info(
      { sessionId: job.payload.sessionId, attachmentId: job.payload.attachmentId, ...outcome },
      'session.preview_screenshot: done'
    )
  }
}

export const handleSessionPreviewScreenshot = makeSessionPreviewScreenshotHandler()
