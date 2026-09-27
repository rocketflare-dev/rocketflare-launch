/**
 * `/ci/deploy` (Launch P2, slice 2d) — the external deployer protocol v1: `POST /start`,
 * `GET /:id`, `POST /:id/upload`, `POST /:id/activate`, `POST /:id/finish`, over
 * `services/launch/deploy/*`. Contracts: `deployStartSchema`, `deployUploadSchema` and friends in
 * `@launch/shared/launch-pipeline`. Mounted by `routes/ci.ts`; public, GitHub-OIDC authenticated.
 *
 * Slice 2a ships the empty router so the mount exists and `/ci/deploy/*` answers a JSON 404.
 */
import { createRouter } from '../utils/routes/router'

export const ciDeployRouter = createRouter()
