/**
 * An app's grants (Launch P5, plan §1.7–§1.9, §4 5d), behind `/api/apps/:id/config` and
 * `/api/apps/:id/grants`:
 *
 * - `appConfigView`: `GET /config` (app readers) — the last scan's declared keys grouped by plugin,
 *   the resources they match with the app's grant per environment, `needs`, `unmatched`, every
 *   grant, and `canRequest`;
 * - `requestGrant`: `POST /grants` (the app's owners and admins) — `requireGrantPushWorkflow`
 *   first; per environment one `app_grants` row (`requested`; 409 `grant_already_held` on the live
 *   index, `values_not_set` without an active version, `shared_resource_archived`) and one
 *   `engine.open` of `grant.request` (subject `grant`, the grant id), passing `policy:
 *   resource.policies[env] ?? resolvePolicy(…)` (§1.9). Answers 202 `requestGrantResponseSchema`;
 * - `repushGrant`: `POST /grants/:gid/repush` — a `repair` push of the active version for that one
 *   grant (after a failed push, or a Worker rebuilt by hand).
 *
 * Revoking is `revoke.revokeGrant` (5c), called by the same route file.
 *
 * **Slice 5d owns this file.** From 5a each throws `NotWiredError`.
 */
import type {
  AppConfigView,
  GrantActionResponse,
  RequestGrantRequest,
  RequestGrantResponse,
} from '@launch/shared/launch-grants'
import type { Database } from '../../../db/client'
import type { AuditActor } from '../launch/audit'
import { type GrantDeps, type GrantViewer, NotWiredError } from './types'

export async function appConfigView(
  _db: Database,
  _viewer: GrantViewer,
  _appId: string
): Promise<AppConfigView> {
  throw new NotWiredError('grants/requests.appConfigView', '5d')
}

export async function requestGrant(
  _deps: GrantDeps,
  _viewer: GrantViewer,
  _appId: string,
  _input: RequestGrantRequest,
  _actor: AuditActor
): Promise<RequestGrantResponse> {
  throw new NotWiredError('grants/requests.requestGrant', '5d')
}

export async function repushGrant(
  _deps: GrantDeps,
  _viewer: GrantViewer,
  _appId: string,
  _grantId: string,
  _actor: AuditActor
): Promise<GrantActionResponse> {
  throw new NotWiredError('grants/requests.repushGrant', '5d')
}
