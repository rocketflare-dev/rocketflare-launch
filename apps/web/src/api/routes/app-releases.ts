/**
 * An app's releases under `/api/apps` (Launch P4, plan §1.8 / §4d), mounted by `routes/apps.ts`
 * with `appsRouter.route('/', appReleasesRouter)` BEFORE its own `/:slug` routes, behind the
 * `/api/apps` mount's `authMiddleware`. Slice 4d builds it over `services/launch/releases/*`:
 *
 * - `GET /:id/releases` → `releaseListResponseSchema` (members read, `read App`);
 * - `POST /:id/releases` `createReleaseSchema` → 201 `releaseSchema` (the app's owners and
 *   admins, `mayDeployApp`): bump, tag, PR list, audits;
 * - `GET /:id/releases/:rid` → `releaseSchema`;
 * - `POST /:id/releases/:rid/promote` `promoteReleaseSchema` → 202 `promoteReleaseResponseSchema`
 *   (409 unless staging runs this release and is `up`);
 * - `GET /:id/releases/:rid/chain` → `releaseChainSchema`.
 *
 * From 4a it registers nothing.
 */
import { createRouter } from '../utils/routes/router'

export const appReleasesRouter = createRouter()
