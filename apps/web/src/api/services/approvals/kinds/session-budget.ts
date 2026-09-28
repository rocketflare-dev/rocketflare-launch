/**
 * `session.budget` (Launch P4, plan §4c): a blocked coding session asks for more budget. The
 * requester is the session's creator; `applyInTx` is `extendBudget`, `applyAfter` is
 * `wakeOrRestart` (the session resumes).
 *
 * Slice 4c owns this file; 4a registered it in `kinds/index.ts` with a default policy and a
 * title, and effects that throw `NotWiredError`.
 */
import { DEFAULT_APPROVAL_POLICIES } from '@launch/shared/launch-approvals'
import { type KindHandler, NotWiredError } from '../types'

export const sessionBudgetHandler: KindHandler<'session.budget'> = {
  kind: 'session.budget',
  async defaultPolicy() {
    return DEFAULT_APPROVAL_POLICIES['session.budget']
  },
  describe(request) {
    return `More budget for session ${request.context.kind === 'session.budget' ? (request.context.sessionTitle ?? request.context.sessionId) : request.subjectId}`
  },
  async applyInTx() {
    throw new NotWiredError('session.budget applyInTx', '4c')
  },
  async applyAfter() {
    throw new NotWiredError('session.budget applyAfter', '4c')
  },
}
