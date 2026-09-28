/**
 * An app's shared config and grants under `/api/apps` (Launch P5, plan §1.7, §4 5d), mounted by
 * `routes/apps.ts` with `appsRouter.route('/', appConfigRouter)` BEFORE its own `/:slug` routes,
 * behind the `/api/apps` mount's `authMiddleware`. Slice 5d builds it over
 * `services/grants/requests.ts` and `revoke.ts`:
 *
 * - `GET /:id/config` → `appConfigSchema` (anyone who may read the app);
 * - `POST /:id/grants` `requestGrantSchema` → 202 `requestGrantResponseSchema` (the app's owners
 *   and admins; one grant and one `grant.request` per environment; 503 `grants_not_configured`
 *   before any row);
 * - `DELETE /:id/grants/:gid` `revokeGrantSchema` → 202 `grantActionResponseSchema` (the app's
 *   owners, the resource's owners, admins);
 * - `POST /:id/grants/:gid/repush` → 202 `grantActionResponseSchema`.
 *
 * `POST /:id/config/scan` is slice 5e's, in `app-config-scan.ts`.
 *
 * From 5a it registers nothing.
 */
import { createRouter } from '../utils/routes/router'

export const appConfigRouter = createRouter()
