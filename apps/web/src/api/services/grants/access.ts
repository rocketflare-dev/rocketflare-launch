/**
 * Who may do what to a shared resource (Launch P5, plan §1.3, §4 5b). Not CASL: `SharedResource`
 * gives every member `read` and admins `manage`, and the OWNER group's rights are decided here.
 *
 * - `isResourceOwner`: the viewer is a member of the resource's owner group;
 * - `canManageResource`: may edit the owner group and the policies, create and archive — admins;
 * - `canSeeHolders`: may see which apps hold it, and the var values — owners and admins. The same
 *   people may set values and edit the description and items (`canSetValues` on the detail).
 *
 * Every check names the tenant first: a viewer of another organisation is nobody here, whatever
 * group ids they carry. "Admin" is the approvals engine's `isAdmin` (`isAdminLevel`: owner, admin,
 * support, a global admin) — the roles CASL gives `manage SharedResource`.
 *
 * **Slice 5b owns this file.**
 */
import type { SharedResourceRow } from '../../../db/schema'
import type { GrantViewer } from './types'

type ResourceOwnership = Pick<SharedResourceRow, 'tenantId' | 'ownerGroupId'>

export function isResourceOwner(viewer: GrantViewer, resource: ResourceOwnership): boolean {
  return viewer.tenantId === resource.tenantId && viewer.groupIds.includes(resource.ownerGroupId)
}

export function canManageResource(viewer: GrantViewer, resource: ResourceOwnership): boolean {
  return viewer.tenantId === resource.tenantId && viewer.isAdmin
}

export function canSeeHolders(viewer: GrantViewer, resource: ResourceOwnership): boolean {
  return canManageResource(viewer, resource) || isResourceOwner(viewer, resource)
}
