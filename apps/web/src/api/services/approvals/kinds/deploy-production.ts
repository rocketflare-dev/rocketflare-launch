/**
 * `deploy.production` (Launch P4, plan §4d): the production gate. Subject `release` (Promote):
 * `applyInTx` inserts the intent bound to `refs/tags/X.Y.Z` and the approval, `applyAfter`
 * publishes the GitHub Release (idempotent by `getReleaseByTag`). Subject `deploy_ticket` (a
 * job-originated run): `applyInTx` is `decidePending(source: 'approval')`, 409 `deploy_run_gone`
 * when the ticket is no longer pending. Subject `app` (Deploy to production without a release):
 * an intent on the default branch plus `dispatchWorkflow`. `onClosed`: the release `rejected`, a
 * ticket expired or rejected.
 *
 * Slice 4d owns this file; 4a registered it in `kinds/index.ts` with a default policy and a
 * title, and effects that throw `NotWiredError`.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { type KindHandler, NotWiredError } from '../types'

export const deployProductionHandler: KindHandler<'deploy.production'> = {
  kind: 'deploy.production',
  async defaultPolicy() {
    return DEFAULT_APPROVAL_POLICIES['deploy.production']
  },
  describe(request) {
    return `Deploy ${request.context.kind === 'deploy.production' ? (request.context.version ?? request.context.ref ?? 'a build') : request.subjectId} to production`
  },
  async applyInTx() {
    throw new NotWiredError('deploy.production applyInTx', '4d')
  },
  async applyAfter() {
    throw new NotWiredError('deploy.production applyAfter', '4d')
  },
}
