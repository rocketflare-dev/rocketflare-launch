/**
 * `app.thumbnail` (Launch): screenshot one app environment's root URL into its thumbnail —
 * `captureAppThumbnail` in `services/launch/thumbnails/thumbnails.ts` is the whole policy (which
 * URL, the debounce, the size cap, the R2 key). This file only binds it to the platform: the
 * `BROWSER` binding through the `ScreenshotPort` adapter, `FILES` through the storage seam, and a
 * realtime nudge whose `defer` is AWAITED before the handler returns (a consumer has no
 * `waitUntil`).
 *
 * A permanent miss (no binding, archived app, refused URL) returns and is acked; a capture that
 * throws is retried by the consumer with backoff until `max_retries`, then dropped quietly.
 *
 * `makeAppThumbnailHandler(screenshotsFor)` is the seam the tests use to hand in a fake browser.
 */
import type { JobOf } from '@launch/shared/jobs'
import {
  defaultScreenshotPort,
  type ScreenshotPort,
} from '../../services/launch/thumbnails/screenshot'
import { captureAppThumbnail } from '../../services/launch/thumbnails/thumbnails'
import { createR2Storage } from '../../services/storage'
import type { AppBindings } from '../../types'
import type { JobContext } from '../jobs'

export function makeAppThumbnailHandler(
  screenshotsFor: (env: AppBindings) => ScreenshotPort | null = defaultScreenshotPort
) {
  return async function handleAppThumbnail(
    job: JobOf<'app.thumbnail'>,
    ctx: JobContext
  ): Promise<void> {
    const pending: Promise<unknown>[] = []
    const realtime = {
      env: ctx.env,
      defer: (fn: () => Promise<unknown>) => {
        pending.push(
          fn().catch(err =>
            ctx.logger.warn({ err: String(err) }, 'app.thumbnail: realtime nudge failed')
          )
        )
      },
    }
    await captureAppThumbnail(
      ctx.db,
      {
        screenshots: screenshotsFor(ctx.env),
        storage: ctx.env.FILES ? createR2Storage(ctx.env.FILES) : null,
        logger: ctx.logger,
        realtime,
      },
      job.payload
    )
    await Promise.all(pending)
  }
}

export const handleAppThumbnail = makeAppThumbnailHandler()
