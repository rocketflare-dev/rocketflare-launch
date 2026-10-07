/**
 * An app's thumbnail (`services/launch/thumbnails/thumbnails.ts`), mounted by `apps.ts` with
 * `appsRouter.route('/', appThumbnailRouter)` before its `/:slug` routes:
 *
 * | Route                               | Who           | Answers                                    |
 * |-------------------------------------|---------------|--------------------------------------------|
 * | `GET /:id/thumbnail`                | `read App`    | the picture (Live's, else Staging's); 404 `thumbnail_not_found` |
 * | `POST /:id/thumbnail/refresh`       | `manage App`  | 202 `{ queued }`; 409 archived / no URL; 429 within a minute |
 *
 * The GET streams from R2 with the object's ETag and `Cache-Control: private` — the list's `url`
 * carries the capture time, so a new picture is a new URL. Tenant-first like every `/:id` route:
 * another tenant's app is a 404. The refresh only ENQUEUES (`app.thumbnail`, forced).
 */
import type { AppThumbnailRefreshResponse } from '@launch/shared/launch-apps'
import { guardPermission } from '../middleware/permissions'
import { getAppRow } from '../services/launch/apps'
import { readAppThumbnail, requestThumbnailRefresh } from '../services/launch/thumbnails/thumbnails'
import { createR2Storage } from '../services/storage'
import { NotFoundError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const appThumbnailRouter = createRouter()

/**
 * Stream an app's thumbnail picture (Live's, else Staging's), honouring `If-None-Match`. Requires
 * `read App`. 404 `thumbnail_not_found` if none has been captured yet.
 */
appThumbnailRouter.get('/:id/thumbnail', async c => {
  guardPermission(c, 'read', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  // No FILES binding means nothing was ever stored: the same 404 as no picture.
  const object = c.env.FILES
    ? await readAppThumbnail(db, createR2Storage(c.env.FILES), tenantId, app.id)
    : null
  if (!object) throw new NotFoundError('No thumbnail yet', 'thumbnail_not_found')
  const headers: Record<string, string> = {
    'Cache-Control': 'private, max-age=3600',
    ETag: object.etag,
  }
  if (c.req.header('If-None-Match') === object.etag) {
    await object.body.cancel().catch(() => {})
    return c.body(null, 304, headers)
  }
  headers['Content-Type'] = object.contentType
  headers['Content-Length'] = String(object.size)
  headers['Content-Disposition'] = 'inline'
  return c.body(object.body, 200, headers)
})

/**
 * Queue a refresh of an app's thumbnail. Requires `manage App`. 409 for an archived app or one
 * with no URL; 429 if asked again within a minute.
 */
appThumbnailRouter.post('/:id/thumbnail/refresh', async c => {
  guardPermission(c, 'manage', 'App')
  const { db, tenantId } = withAuthAndDb(c)
  const app = await getAppRow(db, tenantId, uuidParam(c, 'id'))
  const queued = await requestThumbnailRefresh(db, c.env.JOBS_QUEUE, app)
  const body: AppThumbnailRefreshResponse = { queued }
  return c.json(body, 202)
})
