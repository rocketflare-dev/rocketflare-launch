/**
 * `grant.request` (Launch P5, plan §1.7–§1.9, §4 5d): an app asks to hold a shared resource in one
 * environment. The subject is the `app_grants` row; `requestGrant` (`services/grants/requests.ts`)
 * opens it with the resource's own `policies[env]` when set (`OpenApprovalInput.policy`).
 *
 * - `defaultPolicy`: `DEFAULT_APPROVAL_POLICIES['grant.request']` — nobody by the policy's own
 *   lists, because the approvers are the kind's `eligibleExtra`;
 * - `eligibleExtra`: the members of the resource's owner group;
 * - `applyInTx`: the grant goes `requested → active`, pending its push (`pushed_version_id`
 *   null), audited `grant.approved` in the decider's name;
 * - `applyAfter`: `startPush({ reason: 'grant', grantId, approvalId })` — idempotent by
 *   `approval_id`, so the sweep's retry finds the push it already started;
 * - `onClosed`: the grant goes `rejected` (rejected or cancelled) or `expired`.
 *
 * **Slice 5d owns this file.** From 5a `defaultPolicy` and `describe` are real and the effects
 * throw `NotWiredError`.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { NotWiredError } from '../../grants/types'
import type { KindHandler } from '../types'

export const grantRequestHandler: KindHandler<'grant.request'> = {
  kind: 'grant.request',
  async defaultPolicy() {
    return DEFAULT_APPROVAL_POLICIES['grant.request']
  },
  describe(request) {
    if (request.context.kind !== 'grant.request') return `Shared config for ${request.subjectId}`
    const { resourceName, appSlug, environment } = request.context
    return `${resourceName} for ${appSlug} (${environment})`
  },
  async eligibleExtra() {
    throw new NotWiredError('grant.request eligibleExtra', '5d')
  },
  async applyInTx() {
    throw new NotWiredError('grant.request applyInTx', '5d')
  },
  async applyAfter() {
    throw new NotWiredError('grant.request applyAfter', '5d')
  },
  async onClosed() {
    throw new NotWiredError('grant.request onClosed', '5d')
  },
}
