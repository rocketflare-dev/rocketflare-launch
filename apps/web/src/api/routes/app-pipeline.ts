/**
 * The create-an-app pipeline under `/api/apps` (Launch P2, slice 2c): `POST /` (→ 202
 * `createAppResponseSchema`), `GET /:id/pipeline`, `POST /:id/pipeline/retry` and
 * `POST /:id/teardown`, over `services/launch/pipeline/*` and the two Workflow bindings.
 *
 * Mounted by `routes/apps.ts` with `appsRouter.route('/', appPipelineRouter)` BEFORE its own
 * `/:slug` routes, behind the `/api/apps` mount's `authMiddleware`. Slice 2a ships it empty.
 */
import { createRouter } from '../utils/routes/router'

export const appPipelineRouter = createRouter()
