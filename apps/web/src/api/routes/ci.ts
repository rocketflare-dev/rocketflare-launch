/**
 * `/ci` (Launch P2) — the PUBLIC GitHub-OIDC surface a CI job calls, mounted outside `/api` beside
 * `/oidc` with no `authMiddleware`: the caller has no session, it has a GitHub Actions OIDC token.
 * Every handler beneath proves it first — `verifyGitHubOidc` (a bad token or audience is a 401),
 * then `resolveCaller` (a repository, environment, workflow file or ref Launch does not accept is
 * a 403) — and uses only the tenant the resolved app row carries.
 *
 * - `/ci/deploy/*` — the external deployer protocol v1 (the kit's `docs/DEPLOYER.md`), slice 2d.
 * - `/ci/scaffold/*` — the one-shot scaffold job's token and done calls, slice 2b.
 *
 * Body cap: `ciBodyLimit` on `/ci/*` (64 MB for `POST /ci/deploy/:id/upload`, 1 MB elsewhere).
 * An unmatched path falls through to the catch-all, which answers a JSON 404 because `/ci` is in
 * `API_PREFIXES`.
 */
import { createRouter } from '../utils/routes/router'
import { ciDeployRouter } from './ci-deploy'
import { ciScaffoldRouter } from './ci-scaffold'

export const ciRouter = createRouter()

ciRouter.route('/deploy', ciDeployRouter)
ciRouter.route('/scaffold', ciScaffoldRouter)
