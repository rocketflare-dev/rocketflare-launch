/**
 * Who may do what to a shared resource (Launch P5, plan §1.3, §4 5b). Not CASL: `SharedResource`
 * gives every member `read` and admins `manage`, and the OWNER group's rights are decided here.
 *
 * - `isResourceOwner`: the viewer is a member of the resource's owner group;
 * - `canManageResource`: may edit the owner group and the policies, create and archive — admins;
 * - `canSeeHolders`: may see which apps hold it, and the var values — owners and admins.
 *
 * **Slice 5b owns this file.** From 5a each throws `NotWiredError`.
 */
import type { SharedResourceRow } from '../../../db/schema'
import { type GrantViewer, NotWiredError } from './types'

export function isResourceOwner(
  _viewer: GrantViewer,
  _resource: Pick<SharedResourceRow, 'tenantId' | 'ownerGroupId'>
): boolean {
  throw new NotWiredError('grants/access.isResourceOwner', '5b')
}

export function canManageResource(
  _viewer: GrantViewer,
  _resource: Pick<SharedResourceRow, 'tenantId' | 'ownerGroupId'>
): boolean {
  throw new NotWiredError('grants/access.canManageResource', '5b')
}

export function canSeeHolders(
  _viewer: GrantViewer,
  _resource: Pick<SharedResourceRow, 'tenantId' | 'ownerGroupId'>
): boolean {
  throw new NotWiredError('grants/access.canSeeHolders', '5b')
}
