/**
 * `app.access` (Launch P4, plan §4c): a member the app's sign-in policy refused asks its owners.
 * `applyInTx` adds the user grant (`addGrant`); there is no vendor effect. The request-access page
 * is unchanged for the requester; the P1 migrated rows are requests of this kind.
 *
 * Slice 4c owns this file; 4a registered it in `kinds/index.ts` with a default policy and a
 * title, and effects that throw `NotWiredError`.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { type KindHandler, NotWiredError } from '../types'

export const appAccessHandler: KindHandler<'app.access'> = {
  kind: 'app.access',
  async defaultPolicy() {
    return DEFAULT_APPROVAL_POLICIES['app.access']
  },
  describe(request) {
    return `Access to an app for ${request.context.kind === 'app.access' ? request.context.userId : request.subjectId}`
  },
  async applyInTx() {
    throw new NotWiredError('app.access applyInTx', '4c')
  },
  async applyAfter() {
    throw new NotWiredError('app.access applyAfter', '4c')
  },
}
