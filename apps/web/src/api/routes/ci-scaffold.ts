/**
 * `/ci/scaffold` (Launch P2, slice 2b) — the one-shot scaffold job: `POST /token` trades the
 * job's GitHub OIDC token for a one-hour installation token scoped to its one repo plus the plan
 * (`scaffoldTokenResponseSchema`), and `POST /done` (`scaffoldDoneSchema`) wakes the launch run
 * with `SCAFFOLD_FINISHED_EVENT`. Mounted by `routes/ci.ts`; public, GitHub-OIDC authenticated.
 *
 * Slice 2a ships the empty router so the mount exists and `/ci/scaffold/*` answers a JSON 404.
 */
import { createRouter } from '../utils/routes/router'

export const ciScaffoldRouter = createRouter()
