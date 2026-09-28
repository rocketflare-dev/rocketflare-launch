/**
 * `/api/shared-resources` (Launch P5, spec/09, `docs/plans/p5-grants.md` §4 5b) — shared config:
 * the bundles, their values and who holds them, over `services/grants/{resources,values,access}.ts`.
 * Behind `authMiddleware`; every member may `read SharedResource` (they need the names to ask),
 * admins `manage` it, and the OWNER group's rights are decided by the service. Slice 5b builds it:
 *
 * - `GET /` → `sharedResourceListResponseSchema` (`?archived=true` for the archived ones);
 * - `POST /` `createSharedResourceSchema` → 201 `sharedResourceDetailSchema` (admins; 409
 *   `shared_resource_slug_taken`);
 * - `GET /:id` → `sharedResourceDetailSchema` (`holders` and var values for owners and admins);
 * - `PATCH /:id` `patchSharedResourceSchema` → `sharedResourceDetailSchema` (owners: name,
 *   description, items; admins also the owner group and the policies — 403 `not_resource_admin`);
 * - `PUT /:id/values/:env` `putSharedResourceValuesSchema` → 202 (a rotation started) or 200
 *   `putSharedResourceValuesResponseSchema` (owners and admins; 403 `not_resource_owner`);
 * - `DELETE /:id` → 204, archived (admins; 409 `resource_has_holders`).
 *
 * The push routes (`GET /:id/pushes[/:pushId]`, `POST /:id/pushes/:pushId/retry`) are slice 5c's,
 * in `shared-resource-pushes.ts`, mounted first below so neither slice edits the other's file.
 *
 * From 5a the list answers empty, so the page, the nav and the CLI render before 5b; nothing else
 * is registered.
 */
import {
  type SharedResourceListResponse,
  sharedResourceListQuerySchema,
} from '@launch/shared/launch-grants'
import { guardPermission } from '../middleware/permissions'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'
import { sharedResourcePushesRouter } from './shared-resource-pushes'

export const sharedResourcesRouter = createRouter()

// Slice 5c: `GET /:id/pushes`, `GET /:id/pushes/:pushId`, `POST /:id/pushes/:pushId/retry`.
sharedResourcesRouter.route('/', sharedResourcePushesRouter)

sharedResourcesRouter.get('/', validate('query', sharedResourceListQuerySchema), c => {
  guardPermission(c, 'read', 'SharedResource')
  const body: SharedResourceListResponse = { items: [] }
  return c.json(body)
})
