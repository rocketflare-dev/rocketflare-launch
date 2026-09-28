/**
 * A shared resource's pushes under `/api/shared-resources` (Launch P5, plan §1.10, §4 5c), mounted
 * by `shared-resources.ts` with `.route('/', …)` before its own routes, behind the mount's
 * `authMiddleware`. The resource's owners and admins only (the service checks, 404 otherwise).
 * Slice 5c builds it over `services/grants/push.ts`:
 *
 * - `GET /:id/pushes?environment=&limit=` → `grantPushListResponseSchema`, newest first;
 * - `GET /:id/pushes/:pushId` → `grantPushSchema` (with every target);
 * - `POST /:id/pushes/:pushId/retry` → 202 `grantPushSchema` (a `partial` / `failed` push starts
 *   again as `<pushId>-rN`; 409 `push_in_progress` while one runs).
 *
 * From 5a it registers nothing.
 */
import { createRouter } from '../utils/routes/router'

export const sharedResourcePushesRouter = createRouter()
