/**
 * Revoking a grant (Launch P5, plan §1.13, §4 5c): the app's owners, the resource's owners or an
 * admin (403 otherwise). The grant goes `active → revoking` (compare-and-set; 409
 * `grant_not_active` from anything else), a `revoke` push removes the names from the Worker, and
 * the push's finish sets `revoked` (`revoked_at`, `revoked_by_user_id`). Audited `grant.revoked`.
 * The app then answers 503 by the kit's missing-config convention. `DELETE
 * /api/apps/:id/grants/:gid` (5d's route) calls it.
 *
 * **Slice 5c owns this file.** From 5a it throws `NotWiredError`.
 */
import type { AppGrantRow } from '../../../db/schema'
import type { AuditActor } from '../launch/audit'
import { type GrantDeps, type GrantViewer, NotWiredError } from './types'

export interface RevokeGrantInput {
  appId: string
  grantId: string
  reason?: string | null
  actor: AuditActor
}

export async function revokeGrant(
  _deps: GrantDeps,
  _viewer: GrantViewer,
  _input: RevokeGrantInput
): Promise<{ grant: AppGrantRow; pushId: string | null }> {
  throw new NotWiredError('grants/revoke.revokeGrant', '5c')
}
