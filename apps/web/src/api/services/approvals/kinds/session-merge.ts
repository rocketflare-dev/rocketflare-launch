/**
 * `session.merge` (issue #5, `docs/plans/i5-ship-to-staging.md` §1.11–§1.12): a coding session's
 * PR passed CI and waits for a person in Launch before it merges. The subject is the session and
 * the requester its CREATOR; `land.review#N` opens it idempotently with the app's review policy
 * (`reviewPolicyFor`, passed as `OpenApprovalInput.policy`) and excludes everyone who wrote a
 * `user.message` in the session, plus the creator.
 *
 * - `defaultPolicy` / `describe`: built here already (the engine and the policy page read them).
 * - `applyInTx`: CAS `landing.stage` `approval → merging`.
 * - `applyAfter` / `onClosed`: `wakeOrRestart` the session; a reject, expiry or cancel makes the
 *   landing reopen with `review_rejected` / `review_expired` and the decision's comment as the note.
 *
 * S1 registered it with typed stubs for the three effects; slice S2 fills them (and owns this file).
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { NotWiredError } from '../../i5-not-wired'
import type { KindHandler } from '../types'

export const sessionMergeHandler: KindHandler<'session.merge'> = {
  kind: 'session.merge',
  async defaultPolicy() {
    return DEFAULT_APPROVAL_POLICIES['session.merge']
  },
  describe(request) {
    if (request.context.kind !== 'session.merge') return `Merge session ${request.subjectId}`
    const { prTitle, prNumber, title, shortId } = request.context
    return `Merge “${prTitle}” (#${prNumber}) from session ${title ?? shortId}`
  },
  /** S2 fills it: CAS the landing `approval → merging` inside the decide transaction. */
  async applyInTx() {
    throw new NotWiredError('session.merge applyInTx', 'S2')
  },
  /** S2 fills it: wake (or restart) the session's Workflow so `land.merge#N` runs. */
  async applyAfter() {
    throw new NotWiredError('session.merge applyAfter', 'S2')
  },
  /** S2 fills it: wake the session so its landing reopens (`review_rejected` / `review_expired`). */
  async onClosed() {
    throw new NotWiredError('session.merge onClosed', 'S2')
  },
}
