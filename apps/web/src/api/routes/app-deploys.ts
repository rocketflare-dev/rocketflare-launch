/**
 * An app's deploys under `/api/apps` (Launch P2, slice 2d): `GET /:id/deploys`,
 * `POST /:id/deploys/:ticketId/decide` (app owners and admins) and `POST /:id/deploys/production`
 * (a pre-approval plus the `deploy.yml` dispatch), over `services/launch/deploy/*`.
 *
 * Mounted by `routes/apps.ts` with `appsRouter.route('/', appDeploysRouter)` BEFORE its own
 * `/:slug` routes, behind the `/api/apps` mount's `authMiddleware`. Slice 2a ships it empty.
 */
import { createRouter } from '../utils/routes/router'

export const appDeploysRouter = createRouter()
